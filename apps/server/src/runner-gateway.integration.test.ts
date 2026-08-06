import type { Contract } from '@loom/api-contract'
import { expireStaleApprovals, reapStuckRuns } from '@loom/application'
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
let testPersonaId: string
/** Pairing tokens by Runner name, so a test can reconnect as the same Runner. */
const pairingTokens = new Map<string, string>

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
 // agent_persona is truncated above too — recreated per test, same reason
 // the fake Runner is re-paired per test rather than reused.
 const persona = await client.persona.create({ markdownSource: TEST_PERSONA_MARKDOWN })
 testPersonaId = persona.id
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
 pairingTokens.set(name, rawToken)
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

const TEST_PERSONA_MARKDOWN = `---
name: fake-worker
description: A test persona, not a real worker.
model: test-model
tools: [Read]
---

irrelevant for this test`

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
 personaId: testPersonaId,
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
 seq: 1,
 event: { kind: 'assistant_text', text: 'hello from the fake runner' },
 }),
)
 socket.send(
 JSON.stringify({
 type: 'agent_event',
 runId: run.id,
 seq: 2,
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
 personaId: testPersonaId,
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

 /**
 * Idempotency. A Runner that
 * reconnects mid-run, or any retried delivery, replays events it already sent;
 * without the (run, seq) key each replay would append a second copy of the
 * same tool call to the thread and re-apply its status transition.
 */
 it('ignores a replayed agent_event rather than double-appending it', async => {
 const { socket, runnerId } = await pairFakeRunner('idempotency-test')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'idempotency' })

 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({
 threadId: created.rootThread.id,
 repositoryId: repo.id,
 personaId: testPersonaId,
 })
 await startRun
 const run = await runPromise

 const event = {
 type: 'agent_event',
 runId: run.id,
 seq: 1,
 event: { kind: 'tool_call', toolUseId: 't1', toolName: 'Read', input: { file_path: '/tmp/a' } },
 }
 socket.send(JSON.stringify(event))
 socket.send(JSON.stringify(event))
 // A different seq carrying identical content is a genuinely new event, not a
 // replay — dedupe is on the key, deliberately not on the payload.
 socket.send(JSON.stringify({...event, seq: 2 }))

 let page = await client.message.list({ threadId: created.rootThread.id })
 for (let i = 0; i < 20 && page.messages.length < 2; i += 1) {
 await new Promise((r) => setTimeout(r, 50))
 page = await client.message.list({ threadId: created.rootThread.id })
 }
 // Settle: give a mistakenly-accepted third append time to show up.
 await new Promise((r) => setTimeout(r, 200))
 page = await client.message.list({ threadId: created.rootThread.id })

 expect(page.messages.filter((m) => m.body.text.includes('Read: /tmp/a'))).toHaveLength(2)

 socket.close
 })

 /**
 * Approval SLA. Driven by calling the sweep with a zero SLA
 * rather than by waiting: the production interval is minutes long, and a test
 * that sleeps for it proves nothing extra.
 */
 it('auto-denies an undecided approval past the SLA and lets the run continue', async => {
 const { socket, runnerId } = await pairFakeRunner('sla-test')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'sla-test' })

 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({
 threadId: created.rootThread.id,
 repositoryId: repo.id,
 personaId: testPersonaId,
 })
 await startRun
 const run = await runPromise

 socket.send(
 JSON.stringify({
 type: 'permission_request',
 runId: run.id,
 toolUseId: 'tool-use-sla',
 toolName: 'Bash',
 input: { command: 'curl evil.example' },
 }),
)

 let pending = await client.approval.listPending({ agentRunId: run.id })
 for (let i = 0; i < 20 && pending.length === 0; i += 1) {
 await new Promise((r) => setTimeout(r, 50))
 pending = await client.approval.listPending({ agentRunId: run.id })
 }
 expect(pending).toHaveLength(1)

 const permissionResponse = nextFrame(socket, (v) => v.type === 'permission_response')
 await expireStaleApprovals(app.deps, { approvalSlaMs: 0 })

 // Auto-deny, never auto-approve: nobody vouched for this call.
 const relayed = await permissionResponse
 expect(relayed.toolUseId).toBe('tool-use-sla')
 expect(relayed.decision).toBe('deny')

 expect(await client.approval.listPending({ agentRunId: run.id })).toEqual([])
 // Resumable, not terminal — the SDK's callback resolved, so the loop goes on.
 expect((await client.agentRun.get({ agentRunId: run.id })).status).toBe('running')

 const page = await client.message.list({ threadId: created.rootThread.id })
 expect(page.messages.some((m) => m.body.text.includes('auto-denied'))).toBe(true)

 socket.close
 })

 /**
 * The no-progress reaper must not kill a run that is legitimately waiting on a
 * human — otherwise the SLA above never gets to fire, and every approval a
 * human thinks about becomes a dead run.
 */
 it('does not reap a run for lack of progress while it awaits approval', async => {
 const { socket, runnerId } = await pairFakeRunner('reaper-approval-test')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'reaper-approval' })

 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({
 threadId: created.rootThread.id,
 repositoryId: repo.id,
 personaId: testPersonaId,
 })
 await startRun
 const run = await runPromise

 socket.send(
 JSON.stringify({
 type: 'permission_request',
 runId: run.id,
 toolUseId: 'tool-use-reap',
 toolName: 'Write',
 input: { file_path: '/tmp/x' },
 }),
)
 let pending = await client.approval.listPending({ agentRunId: run.id })
 for (let i = 0; i < 20 && pending.length === 0; i += 1) {
 await new Promise((r) => setTimeout(r, 50))
 pending = await client.approval.listPending({ agentRunId: run.id })
 }
 expect(pending).toHaveLength(1)

 // Zero no-progress timeout would reap any other run instantly; a generous
 // heartbeat timeout isolates the signal under test to no-progress alone.
 await reapStuckRuns(app.deps, { heartbeatTimeoutMs: 3_600_000, noProgressTimeoutMs: 0 })

 expect((await client.agentRun.get({ agentRunId: run.id })).status).toBe('awaiting_approval')

 socket.close
 })

 /**
 * The kill switch, end to end over the real protocol: the Runner
 * receives a `cancel_run`, the run goes terminal, and the gate it was blocked
 * on is resolved rather than left in the Inbox pointing at a dead run.
 */
 it('cancels an in-flight run and its pending gate when the workspace is paused', async => {
 const { socket, runnerId } = await pairFakeRunner('kill-switch-test')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'kill-switch' })

 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({
 threadId: created.rootThread.id,
 repositoryId: repo.id,
 personaId: testPersonaId,
 })
 await startRun
 const run = await runPromise

 socket.send(
 JSON.stringify({
 type: 'permission_request',
 runId: run.id,
 toolUseId: 'tool-use-kill',
 toolName: 'Bash',
 input: { command: 'sleep 9000' },
 }),
)
 let pending = await client.approval.listPending({ agentRunId: run.id })
 for (let i = 0; i < 20 && pending.length === 0; i += 1) {
 await new Promise((r) => setTimeout(r, 50))
 pending = await client.approval.listPending({ agentRunId: run.id })
 }
 expect(pending).toHaveLength(1)

 const cancelFrame = nextFrame(socket, (v) => v.type === 'cancel_run')
 try {
 const paused = await client.runControl.pauseAll
 expect(paused.cancelledRunIds).toEqual([run.id])

 expect((await cancelFrame).runId).toBe(run.id)
 expect((await client.agentRun.get({ agentRunId: run.id })).status).toBe('cancelled')
 expect(await client.approval.listPending({ agentRunId: run.id })).toEqual([])
 } finally {
 // `truncateDomainTables` spares `workspace` (see packages/db/src/testing.ts),
 // so the pause flag would otherwise leak into every later test in this file.
 await client.runControl.resume
 }

 socket.close
 })

 /**
 * Run resumption reconciliation. Both branches matter: a Runner
 * that still holds a run's state gets told to resume it, and one that does not has the
 * run failed immediately with a real reason rather than left for the reaper's generic
 * "no heartbeat" minutes later.
 */
 it('tells a reconnecting Runner to resume a run it still holds', async => {
 const { socket, runnerId } = await pairFakeRunner('resume-yes')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'resume-yes' })

 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({
 threadId: created.rootThread.id,
 repositoryId: repo.id,
 personaId: testPersonaId,
 })
 await startRun
 const run = await runPromise

 socket.send(
 JSON.stringify({
 type: 'agent_event',
 runId: run.id,
 seq: 7,
 event: { kind: 'assistant_text', text: 'partial work' },
 }),
)
 // Settle the ingest so highestSeq is observable below.
 let page = await client.message.list({ threadId: created.rootThread.id })
 for (let i = 0; i < 20 && !page.messages.some((m) => m.body.text.includes('partial work')); i += 1) {
 await new Promise((r) => setTimeout(r, 50))
 page = await client.message.list({ threadId: created.rootThread.id })
 }
 socket.close

 // Reconnect as the same Runner, declaring the run resumable.
 const reconnected = new WebSocket(wsUrl)
 await new Promise<void>((resolve, reject) => {
 reconnected.once('open', => resolve)
 reconnected.once('error', reject)
 })
 const resumeFrame = nextFrame(reconnected, (v) => v.type === 'resume_run')
 reconnected.send(
 JSON.stringify({
 type: 'hello',
 token: pairingTokens.get('resume-yes'),
 allowedRoots: ['/tmp'],
 resumableRunIds: [run.id],
 }),
)

 const frame = await resumeFrame
 expect(frame.runId).toBe(run.id)
 // The server's own watermark, so the Runner continues the sequence instead of
 // restarting at 1 and having every new event dropped as a duplicate.
 expect(frame.fromEventSeq).toBe(7)
 expect((await client.agentRun.get({ agentRunId: run.id })).status).toBe('running')

 reconnected.close
 })

 it('fails a run when its Runner reconnects without it', async => {
 const { socket, runnerId } = await pairFakeRunner('resume-no')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'resume-no' })

 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({
 threadId: created.rootThread.id,
 repositoryId: repo.id,
 personaId: testPersonaId,
 })
 await startRun
 const run = await runPromise
 socket.close

 const reconnected = new WebSocket(wsUrl)
 await new Promise<void>((resolve, reject) => {
 reconnected.once('open', => resolve)
 reconnected.once('error', reject)
 })
 reconnected.send(
 JSON.stringify({
 type: 'hello',
 token: pairingTokens.get('resume-no'),
 allowedRoots: ['/tmp'],
 resumableRunIds: [],
 }),
)

 let after = await client.agentRun.get({ agentRunId: run.id })
 for (let i = 0; i < 30 && after.status !== 'failed'; i += 1) {
 await new Promise((r) => setTimeout(r, 50))
 after = await client.agentRun.get({ agentRunId: run.id })
 }
 expect(after.status).toBe('failed')
 expect(after.errorMessage).toMatch(/workspace state was lost/i)

 const page = await client.message.list({ threadId: created.rootThread.id })
 expect(page.messages.some((m) => m.body.text.includes('Runner restarted'))).toBe(true)

 reconnected.close
 })

 it('rejects resolving the same approval twice', async => {
 const { socket, runnerId } = await pairFakeRunner('double-decide-test')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'double-decide' })

 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({
 threadId: created.rootThread.id,
 repositoryId: repo.id,
 personaId: testPersonaId,
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
