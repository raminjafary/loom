import type { Contract } from '@loom/api-contract'
import { createDatabase, seedWorkspace, truncateDomainTables } from '@loom/db'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import WebSocket from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, devAuth, type App } from './index.js'
import { loadConfig } from './config.js'

/**
 * Drives the real /ws/runner protocol with a fake Runner client (raw `ws`,
 * no Claude Agent SDK) — this proves the server-side plumbing (pairing,
 * check_path, start_run dispatch, agent_event ingest, the approval
 * round-trip) works correctly, independent of and much cheaper than a real
 * Claude Agent SDK invocation. apps/runner's own smoke test covers the real
 * SDK integration separately, on trivial prompts only.
 *
 * Requires `docker compose up -d`.
 */

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long-value',
} as NodeJS.ProcessEnv)

const { db, close: closeDb } = createDatabase(config.DATABASE_URL)

let app: App
let client: ContractRouterClient<Contract>
let wsUrl: string

beforeAll(async => {
 const row = await seedWorkspace(db, `runner-gateway-${Date.now}`)
 app = await buildApp(config, devAuth({ userId: 'dev-user', workspaceId: row.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const address = app.fastify.server.address
 if (address === null || typeof address === 'string') throw new Error('no bound port')
 client = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${address.port}/rpc` }))
 wsUrl = `ws://127.0.0.1:${address.port}/ws/runner`
})

beforeEach(async => {
 await truncateDomainTables(db)
})

afterAll(async => {
 await app.close
 await closeDb
})

const nextFrame = (
 socket: WebSocket,
 predicate: (v: Record<string, unknown>) => boolean,
 timeoutMs = 5000,
) =>
 new Promise<Record<string, unknown>>((resolve, reject) => {
 const timer = setTimeout( => {
 socket.off('message', onMessage)
 reject(new Error(`no matching frame within ${timeoutMs}ms`))
 }, timeoutMs)
 function onMessage(raw: WebSocket.RawData) {
 let parsed: unknown
 try {
 parsed = JSON.parse(raw.toString)
 } catch {
 return
 }
 const record = parsed as Record<string, unknown>
 if (!predicate(record)) return
 clearTimeout(timer)
 socket.off('message', onMessage)
 resolve(record)
 }
 socket.on('message', onMessage)
 })

/** A fake Runner: pairs over the real protocol, then answers whatever the test scripts. */
const pairFakeRunner = async (
 name: string,
 allowedRoots: string[] = ['/tmp'],
): Promise<{ socket: WebSocket; runnerId: string }> => {
 const { runnerId, rawToken } = await client.runner.createPairingToken({ name })
 const socket = new WebSocket(wsUrl)
 await new Promise<void>((resolve, reject) => {
 socket.once('open', => resolve)
 socket.once('error', reject)
 })
 socket.send(JSON.stringify({ type: 'hello', token: rawToken, allowedRoots }))
 await nextFrame(socket, (v) => v.type === 'hello_ack')
 return { socket, runnerId }
}

const bindViaFakeRunner = async (
 socket: WebSocket,
 runnerId: string,
 path = '/tmp/repo',
): Promise<{ id: string; defaultBranch: string }> => {
 const checkPath = nextFrame(socket, (v) => v.type === 'check_path')
 const bindPromise = client.repository.bindExisting({
 runnerId,
 path,
 displayName: 'test repo',
 })
 const frame = await checkPath
 socket.send(
 JSON.stringify({
 type: 'check_path_result',
 requestId: frame.requestId,
 ok: true,
 defaultBranch: 'main',
 }),
)
 return bindPromise
}

const testPersona = {
 name: 'fake-worker',
 systemPrompt: 'irrelevant for this test',
 model: 'test-model',
 tools: ['Read'],
}

describe('runner-gateway: pairing and repository binding', => {
 it('rejects an unknown pairing token', async => {
 const socket = new WebSocket(wsUrl)
 const closed = new Promise<number>((resolve) => socket.once('close', resolve))
 await new Promise<void>((resolve, reject) => {
 socket.once('open', => resolve)
 socket.once('error', reject)
 })
 socket.send(JSON.stringify({ type: 'hello', token: 'not-a-real-token', allowedRoots: [] }))
 expect(await closed).toBe(1008)
 })

 it('pairs and binds a repository via a live check_path round-trip', async => {
 const { socket, runnerId } = await pairFakeRunner('binding-test')
 const repo = await bindViaFakeRunner(socket, runnerId)
 expect(repo.defaultBranch).toBe('main')

 const listed = await client.repository.list
 expect(listed.map((r) => r.id)).toContain(repo.id)

 socket.close
 })

 it('surfaces a Runner-reported path failure as a validation error, not a crash', async => {
 const { socket, runnerId } = await pairFakeRunner('rejecting-runner')
 const checkPath = nextFrame(socket, (v) => v.type === 'check_path')
 const bindPromise = client.repository.bindExisting({
 runnerId,
 path: '/tmp/not-a-repo',
 displayName: 'nope',
 })
 const frame = await checkPath
 socket.send(
 JSON.stringify({ type: 'check_path_result', requestId: frame.requestId, ok: false, error: 'not a git repository' }),
)
 await expect(bindPromise).rejects.toThrow
 socket.close
 })
})

describe('runner-gateway: agent run event ingest', => {
 it('dispatches start_run and renders streamed events as thread messages', async => {
 const { socket, runnerId } = await pairFakeRunner('run-test')
 const repo = await bindViaFakeRunner(socket, runnerId)

 const created = await client.channel.create({ name: 'agent-run-test' })

 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({
 threadId: created.rootThread.id,
 repositoryId: repo.id,
 persona: testPersona,
 })
 const startFrame = await startRun
 expect(startFrame.cwd).toBe('/tmp/repo')
 expect((startFrame.persona as { model: string }).model).toBe('test-model')

 const run = await runPromise
 expect(run.status).toBe('running')

 socket.send(
 JSON.stringify({
 type: 'agent_event',
 runId: run.id,
 event: { kind: 'assistant_text', text: 'hello from the fake runner' },
 }),
)
 socket.send(
 JSON.stringify({
 type: 'agent_event',
 runId: run.id,
 event: { kind: 'run_completed', totalCostUsd: 0.0042, result: 'done' },
 }),
)

 // Poll rather than a fixed sleep: event ingest is async on the server side.
 let page = await client.message.list({ threadId: created.rootThread.id })
 for (let i = 0; i < 20 && page.messages.length < 2; i += 1) {
 await new Promise((r) => setTimeout(r, 50))
 page = await client.message.list({ threadId: created.rootThread.id })
 }

 expect(page.messages.some((m) => m.body.text.includes('hello from the fake runner'))).toBe(
 true,
)
 expect(page.messages.some((m) => m.body.text.includes('Run completed'))).toBe(true)

 const finished = await client.agentRun.get({ agentRunId: run.id })
 expect(finished.status).toBe('completed')
 expect(finished.totalCostUsd).toBeCloseTo(0.0042)

 socket.close
 })

 it('runs the full approval round-trip: request → listPending → decide → relayed back to the Runner', async => {
 const { socket, runnerId } = await pairFakeRunner('approval-test')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'approval-test' })

 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({
 threadId: created.rootThread.id,
 repositoryId: repo.id,
 persona: testPersona,
 })
 await startRun
 const run = await runPromise

 socket.send(
 JSON.stringify({
 type: 'permission_request',
 runId: run.id,
 toolUseId: 'tool-use-1',
 toolName: 'Bash',
 input: { command: 'rm -rf /tmp/something' },
 }),
)

 let pending = await client.approval.listPending({ agentRunId: run.id })
 for (let i = 0; i < 20 && pending.length === 0; i += 1) {
 await new Promise((r) => setTimeout(r, 50))
 pending = await client.approval.listPending({ agentRunId: run.id })
 }
 expect(pending).toHaveLength(1)
 const request = pending[0]
 if (!request) throw new Error('expected a pending approval')
 expect(request.toolName).toBe('Bash')
 // The card must show the exact argv, never a model-authored summary.
 expect(request.input).toEqual({ command: 'rm -rf /tmp/something' })

 const awaitingRun = await client.agentRun.get({ agentRunId: run.id })
 expect(awaitingRun.status).toBe('awaiting_approval')

 const permissionResponse = nextFrame(socket, (v) => v.type === 'permission_response')
 const resolved = await client.approval.decide({
 approvalRequestId: request.id,
 decision: 'approve',
 })
 expect(resolved.status).toBe('approved')

 const relayed = await permissionResponse
 expect(relayed.toolUseId).toBe('tool-use-1')
 expect(relayed.decision).toBe('allow')

 const runAfter = await client.agentRun.get({ agentRunId: run.id })
 expect(runAfter.status).toBe('running')

 socket.close
 })

 it('rejects resolving the same approval twice', async => {
 const { socket, runnerId } = await pairFakeRunner('double-decide-test')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'double-decide' })

 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({
 threadId: created.rootThread.id,
 repositoryId: repo.id,
 persona: testPersona,
 })
 await startRun
 const run = await runPromise

 socket.send(
 JSON.stringify({
 type: 'permission_request',
 runId: run.id,
 toolUseId: 'tool-use-2',
 toolName: 'Write',
 input: { path: '/tmp/x' },
 }),
)

 let pending = await client.approval.listPending({ agentRunId: run.id })
 for (let i = 0; i < 20 && pending.length === 0; i += 1) {
 await new Promise((r) => setTimeout(r, 50))
 pending = await client.approval.listPending({ agentRunId: run.id })
 }
 const request = pending[0]
 if (!request) throw new Error('expected a pending approval')

 await client.approval.decide({ approvalRequestId: request.id, decision: 'deny' })
 await expect(
 client.approval.decide({ approvalRequestId: request.id, decision: 'approve' }),
).rejects.toThrow

 socket.close
 })
})
