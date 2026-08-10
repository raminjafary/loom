import type { Contract } from '@loom/api-contract'
import {
 advanceMergeQueue,
 expireStaleApprovals,
 reapStuckRuns,
 startAgentRun,
} from '@loom/application'
import {
 agentRunActor,
 asAgentPersonaId,
 asAgentRunId,
 asRepositoryId,
 asThreadId,
 asWorkspaceId,
 type Notification,
} from '@loom/domain'
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

/**
 * Notifications. The real
 * adapter hands its payload to an external push service, so the port is
 * substituted here — what these tests prove is the *fan-out*: that the events a
 * human must not miss actually reach `NotificationPort`. The adapter's own
 * behaviour is covered in notifications.test.ts, and delivery to a real browser
 * is a live check.
 */
const delivered: Notification[] = []

beforeAll(async => {
 const row = await seedWorkspace(db, `runner-gateway-${Date.now}`)
 app = await buildApp(config, devAuth({ userId: 'dev-user', workspaceId: row.id }), {
 notifications: {
 clientConfig: => ({ transport: 'web_push', publicKey: 'test-public-key' }),
 deliver: async (notification) => {
 delivered.push(notification)
 },
 },
 })
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const address = app.fastify.server.address
 if (address === null || typeof address === 'string') throw new Error('no bound port')
 client = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${address.port}/rpc` }))
 wsUrl = `ws://127.0.0.1:${address.port}/ws/runner`
})

beforeEach(async => {
 delivered.length = 0
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

/**
 * The retention hook and the ship criterion clause "is notified when
 * it needs them". Every case here is one where a human who is not watching would
 * otherwise learn nothing: a gate blocking a run, a finished branch waiting for
 * review, a reaped run that produced no terminal event of its own.
 */
describe('runner-gateway: notification fan-out', => {
 const settle = async (predicate: => boolean, attempts = 20): Promise<void> => {
 for (let i = 0; i < attempts && !predicate; i += 1) {
 await new Promise((r) => setTimeout(r, 50))
 }
 }

 const startRunViaFakeRunner = async (
 name: string,
): Promise<{ socket: WebSocket; runId: string; threadId: string }> => {
 const { socket, runnerId } = await pairFakeRunner(name)
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name })
 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({
 threadId: created.rootThread.id,
 repositoryId: repo.id,
 personaId: testPersonaId,
 })
 await startRun
 const run = await runPromise
 return { socket, runId: run.id, threadId: created.rootThread.id }
 }

 it('notifies a human when a gate is waiting on them', async => {
 const { socket, runId } = await startRunViaFakeRunner('notify-approval')

 socket.send(
 JSON.stringify({
 type: 'permission_request',
 runId,
 toolUseId: 'tool-use-notify',
 toolName: 'Bash',
 input: { command: 'rm -rf /tmp/secret' },
 }),
)

 await settle( => delivered.length > 0)

 const notification = delivered.find((n) => n.kind === 'approval_needed')
 expect(notification).toBeDefined
 expect(notification?.runId).toBe(runId)
 expect(notification?.body).toContain('Bash')
 // The exact argv belongs on the approval card, in the app —
 // a notification a human could "decide" from is the failure mode, so the
 // command must not travel in one.
 expect(JSON.stringify(notification)).not.toContain('/tmp/secret')

 socket.close
 })

 it('notifies a human that a finished run has a branch to review', async => {
 const { socket, runId } = await startRunViaFakeRunner('notify-finished')

 socket.send(
 JSON.stringify({
 type: 'run_workspace_ready',
 runId,
 clonePath: '/tmp/clone',
 branchName: 'loom/notify-finished',
 }),
)
 socket.send(
 JSON.stringify({
 type: 'agent_event',
 runId,
 seq: 1,
 event: { kind: 'run_completed', totalCostUsd: 0.25, result: 'done' },
 }),
)

 await settle( => delivered.some((n) => n.kind === 'run_finished'))

 const notification = delivered.find((n) => n.kind === 'run_finished')
 expect(notification).toBeDefined
 // Read from the run *after* its terminal transition — the branch name and
 // the metered cost are what make this notification worth acting on.
 expect(notification?.body).toContain('loom/notify-finished')
 expect(notification?.body).toContain('$0.25')

 socket.close
 })

 it('notifies a human when a run is reaped, since it sends no terminal event of its own', async => {
 const { socket, runId } = await startRunViaFakeRunner('notify-reaped')

 await reapStuckRuns(app.deps, { heartbeatTimeoutMs: 0, noProgressTimeoutMs: 0 })

 const notification = delivered.find((n) => n.kind === 'run_failed')
 expect(notification).toBeDefined
 expect(notification?.runId).toBe(runId)
 expect(notification?.body).toMatch(/heartbeat/)

 socket.close
 })

 it('does not notify when a human stops the work themselves', async => {
 const { socket } = await startRunViaFakeRunner('notify-paused')

 await client.runControl.pauseAll
 await settle( => delivered.length > 0, 6)

 // Pushing "your run stopped" at the person who just stopped it is how
 // notifications become noise, so the kill switch stays silent.
 expect(delivered).toEqual([])

 await client.runControl.resume
 socket.close
 })

 it('still transitions a run when notification delivery throws', async => {
 const { socket, runId } = await startRunViaFakeRunner('notify-failure')

 // A dead push service must not be able to leave a run stuck: the Inbox is
 // the fallback and is unaffected either way, so delivery is best-effort.
 const throwingDeps: typeof app.deps = {
...app.deps,
 notifications: {
 clientConfig: => ({ transport: 'web_push', publicKey: 'k' }),
 deliver: async => {
 throw new Error('push service unreachable')
 },
 },
 }

 await reapStuckRuns(throwingDeps, { heartbeatTimeoutMs: 0, noProgressTimeoutMs: 0 })

 expect((await client.agentRun.get({ agentRunId: runId })).status).toBe('failed')

 socket.close
 })
})

/**
 * The foundation: a workspace may run several agents at once, and
 * a run may spawn children. Both are exercised here rather than in unit tests
 * because the interesting parts are the guards, and the guards read real rows.
 *
 * Child runs are not on the contract: the only thing that should spawn one is a
 * Planner, which does not exist yet, and a human starting a "child" by hand
 * would mean nothing. So these drive the use-case directly against the app's real
 * deps — the same convention the reaper and SLA tests above use.
 */
describe('runner-gateway: concurrency and child runs', => {
 const WIDE_PERSONA_MARKDOWN = `---
name: wide-worker
description: A test persona with more tools than the narrow one.
model: claude-opus-5
tools: [Read, Bash]
harness:
 budgetCapUsd: 50
---

irrelevant for this test`

 const startOne = async (socket: WebSocket, threadId: string, repositoryId: string) => {
 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({ threadId, repositoryId, personaId: testPersonaId })
 await startRun
 return runPromise
 }

 it('runs several agents at once, and refuses past the workspace limit', async => {
 const { socket, runnerId } = await pairFakeRunner('concurrency')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'concurrency' })

 // The configured default is 3 (see config.ts on why it is deliberately small).
 const first = await startOne(socket, created.rootThread.id, repo.id)
 const second = await startOne(socket, created.rootThread.id, repo.id)
 const third = await startOne(socket, created.rootThread.id, repo.id)
 expect([first.status, second.status, third.status]).toEqual(['running', 'running', 'running'])

 // Order is asserted, not just membership, and asserted twice: this list is
 // rendered as clickable rows that re-poll, so an unordered query moves a row
 // out from under a human mid-click. That happened live before the `orderBy`
 // landed.
 const expected = [first.id, second.id, third.id]
 expect((await client.agentRun.listActive).map((run) => run.id)).toEqual(expected)
 expect((await client.agentRun.listActive).map((run) => run.id)).toEqual(expected)

 // Not silently queued: a human who asks for a fourth must be told why not.
 await expect(
 client.agentRun.start({
 threadId: created.rootThread.id,
 repositoryId: repo.id,
 personaId: testPersonaId,
 }),
).rejects.toThrow

 socket.close
 })

 it('records a child run under its parent, with a relation', async => {
 const { socket, runnerId } = await pairFakeRunner('child-run')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'child-run' })
 const parent = await startOne(socket, created.rootThread.id, repo.id)

 const startChild = nextFrame(socket, (v) => v.type === 'start_run')
 const child = await startAgentRun(app.deps, {
 workspaceId: asWorkspaceId(parent.workspaceId),
 // The parent itself, not a human — which is the point of a Planner, and is
 // only safe because of the attenuation asserted below.
 actor: agentRunActor(asAgentRunId(parent.id)),
 threadId: asThreadId(created.rootThread.id),
 repositoryId: asRepositoryId(repo.id),
 personaId: asAgentPersonaId(testPersonaId),
 parentRunId: asAgentRunId(parent.id),
 })
 await startChild

 expect(child.parentRunId).toBe(parent.id)
 expect(child.relation).toBe('delegation')

 const children = await client.agentRun.listChildren({ agentRunId: parent.id })
 expect(children.map((run) => run.id)).toEqual([child.id])
 // A root run has no parent and no relation — null, not a sentinel.
 expect((await client.agentRun.get({ agentRunId: parent.id })).parentRunId).toBeNull

 socket.close
 })

 it('refuses a child that reaches for more than its parent has', async => {
 const { socket, runnerId } = await pairFakeRunner('attenuation')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'attenuation' })
 const wide = await client.persona.create({ markdownSource: WIDE_PERSONA_MARKDOWN })

 // Parent runs the narrow persona (tools: [Read], model claude-sonnet-5 via the
 // shared fixture); the child asks for Bash and a higher tier.
 const parent = await startOne(socket, created.rootThread.id, repo.id)

 await expect(
 startAgentRun(app.deps, {
 workspaceId: asWorkspaceId(parent.workspaceId),
 actor: agentRunActor(asAgentRunId(parent.id)),
 threadId: asThreadId(created.rootThread.id),
 repositoryId: asRepositoryId(repo.id),
 personaId: asAgentPersonaId(wide.id),
 parentRunId: asAgentRunId(parent.id),
 }),
).rejects.toThrow

 expect(await client.agentRun.listChildren({ agentRunId: parent.id })).toEqual([])

 socket.close
 })

 it('refuses a run spawning a child of some other run', async => {
 const { socket, runnerId } = await pairFakeRunner('foreign-parent')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'foreign-parent' })
 const one = await startOne(socket, created.rootThread.id, repo.id)
 const two = await startOne(socket, created.rootThread.id, repo.id)

 // Otherwise a run could graft work onto a tree it is not part of, and
 // attenuation would be measured against the wrong parent.
 await expect(
 startAgentRun(app.deps, {
 workspaceId: asWorkspaceId(one.workspaceId),
 actor: agentRunActor(asAgentRunId(one.id)),
 threadId: asThreadId(created.rootThread.id),
 repositoryId: asRepositoryId(repo.id),
 personaId: asAgentPersonaId(testPersonaId),
 parentRunId: asAgentRunId(two.id),
 }),
).rejects.toThrow

 socket.close
 })

 it('refuses a child run while the workspace is paused', async => {
 const { socket, runnerId } = await pairFakeRunner('paused-child')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'paused-child' })
 const parent = await startOne(socket, created.rootThread.id, repo.id)

 await client.runControl.pauseAll
 try {
 // A pause a Planner could spawn its way around is not a pause.
 await expect(
 startAgentRun(app.deps, {
 workspaceId: asWorkspaceId(parent.workspaceId),
 actor: agentRunActor(asAgentRunId(parent.id)),
 threadId: asThreadId(created.rootThread.id),
 repositoryId: asRepositoryId(repo.id),
 personaId: asAgentPersonaId(testPersonaId),
 parentRunId: asAgentRunId(parent.id),
 }),
).rejects.toThrow
 } finally {
 await client.runControl.resume
 }

 socket.close
 })
})

/**
 * The serialized merge queue. Driven over the real protocol
 * and against real Postgres, because two of the properties that matter are not
 * expressible in a unit test: the unique partial index that makes "one merge per
 * repository" true rather than intended, and the sweep's behaviour when a claim
 * loses that race.
 */
describe('runner-gateway: serialized merge queue', => {
 /** Drives a run all the way to `completed` with a branch, which is what the queue accepts. */
 const finishRun = async (
 socket: WebSocket,
 threadId: string,
 repositoryId: string,
 branchName: string,
) => {
 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({ threadId, repositoryId, personaId: testPersonaId })
 await startRun
 const run = await runPromise

 socket.send(
 JSON.stringify({ type: 'run_workspace_ready', runId: run.id, clonePath: `/tmp/${branchName}`, branchName }),
)
 socket.send(
 JSON.stringify({
 type: 'agent_event',
 runId: run.id,
 seq: 1,
 event: { kind: 'run_completed', totalCostUsd: 0.01, result: 'done' },
 }),
)

 for (let i = 0; i < 40; i += 1) {
 const current = await client.agentRun.get({ agentRunId: run.id })
 if (current.status === 'completed' && current.branchName === branchName) return current
 await new Promise((r) => setTimeout(r, 50))
 }
 throw new Error(`run ${run.id} never reached completed with a branch`)
 }

 /** Answers one `merge_run` frame with whatever the test scripts, and reports what it was asked. */
 const answerMerge = async (
 socket: WebSocket,
 reply: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
 const frame = await nextFrame(socket, (v) => v.type === 'merge_run', 10_000)
 socket.send(JSON.stringify({ type: 'merge_result', requestId: frame.requestId,...reply }))
 return frame
 }

 const sweep = => advanceMergeQueue(app.deps, { mergeStuckMs: 1_800_000 })

 it('merges a queued branch and records the commit, the disposition and the verification', async => {
 const { socket, runnerId } = await pairFakeRunner('merge-happy')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'merge-happy' })
 const run = await finishRun(socket, created.rootThread.id, repo.id, 'loom/merge-1')

 await client.repository.setVerifyCommand({ repositoryId: repo.id, verifyCommand: 'true' })

 const entry = await client.mergeQueue.enqueue({ agentRunId: run.id })
 expect(entry.status).toBe('queued')
 // Queueing must not merge anything by itself — that immediacy is the race the
 // queue replaces.
 expect((await client.agentRun.get({ agentRunId: run.id })).branchDisposition).toBeNull

 const swept = sweep
 const asked = await answerMerge(socket, {
 ok: true,
 commitSha: 'abc1234567890',
 verified: true,
 })
 // The repository's command reaches the Runner, rather than the Runner reading
 // its own idea of how this repository is tested.
 expect(asked.verifyCommand).toBe('true')
 await swept

 const [merged] = await client.mergeQueue.list
 expect(merged?.status).toBe('merged')
 expect(merged?.mergedCommitSha).toBe('abc1234567890')
 expect(merged?.verified).toBe(true)
 expect((await client.agentRun.get({ agentRunId: run.id })).branchDisposition).toBe('merged')

 socket.close
 })

 it('merges in queue order, one at a time, never two branches at once', async => {
 const { socket, runnerId } = await pairFakeRunner('merge-order')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'merge-order' })

 const first = await finishRun(socket, created.rootThread.id, repo.id, 'loom/order-1')
 const second = await finishRun(socket, created.rootThread.id, repo.id, 'loom/order-2')
 const third = await finishRun(socket, created.rootThread.id, repo.id, 'loom/order-3')

 await client.mergeQueue.enqueue({ agentRunId: first.id })
 await client.mergeQueue.enqueue({ agentRunId: second.id })
 await client.mergeQueue.enqueue({ agentRunId: third.id })

 const mergedBranches: string[] = []
 for (const expected of [first.id, second.id, third.id]) {
 const swept = sweep
 const frame = await answerMerge(socket, { ok: true, commitSha: `sha-${expected}`, verified: false })
 // One merge_run per sweep — a second in-flight frame here would mean the
 // serialization is decorative.
 expect(frame.runId).toBe(expected)
 await swept
 mergedBranches.push(frame.runId as string)
 }
 expect(mergedBranches).toEqual([first.id, second.id, third.id])

 const entries = await client.mergeQueue.list
 expect(entries.map((e) => e.status)).toEqual(['merged', 'merged', 'merged'])
 // Unverified, and saying so: no verify command was configured for this repo.
 expect(entries.every((e) => e.verified === false)).toBe(true)

 socket.close
 })

 it('starts nothing new while a merge is in flight', async => {
 const { socket, runnerId } = await pairFakeRunner('merge-inflight')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'merge-inflight' })
 const first = await finishRun(socket, created.rootThread.id, repo.id, 'loom/inflight-1')
 const second = await finishRun(socket, created.rootThread.id, repo.id, 'loom/inflight-2')

 await client.mergeQueue.enqueue({ agentRunId: first.id })
 await client.mergeQueue.enqueue({ agentRunId: second.id })

 // Hold the first merge open, then sweep repeatedly. Entry two must not be
 // claimed: it rebases onto the *result* of entry one, which does not exist yet.
 const swept = sweep
 const held = await nextFrame(socket, (v) => v.type === 'merge_run', 10_000)
 expect(held.runId).toBe(first.id)

 const seen: unknown[] = []
 socket.on('message', (raw: WebSocket.RawData) => {
 const parsed = JSON.parse(raw.toString) as Record<string, unknown>
 if (parsed.type === 'merge_run' && parsed.requestId !== held.requestId) seen.push(parsed)
 })
 await sweep
 await sweep
 expect(seen).toEqual([])

 const midway = await client.mergeQueue.list
 expect(midway.map((e) => e.status)).toEqual(['merging', 'queued'])

 socket.send(JSON.stringify({ type: 'merge_result', requestId: held.requestId, ok: true, commitSha: 'x', verified: false }))
 await swept

 socket.close
 })

 it('hands a conflicting branch back to its run and lets the next one through', async => {
 const { socket, runnerId } = await pairFakeRunner('merge-conflict')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'merge-conflict' })
 const first = await finishRun(socket, created.rootThread.id, repo.id, 'loom/conflict-1')
 const second = await finishRun(socket, created.rootThread.id, repo.id, 'loom/conflict-2')

 await client.mergeQueue.enqueue({ agentRunId: first.id })
 await client.mergeQueue.enqueue({ agentRunId: second.id })

 const failing = sweep
 await answerMerge(socket, { ok: false, reason: 'conflict', detail: 'src/app.ts' })
 await failing

 const afterFailure = await client.mergeQueue.list
 expect(afterFailure[0]?.status).toBe('failed')
 expect(afterFailure[0]?.failureReason).toBe('conflict')
 // "Hand the branch back to its owning run": the disposition stays unset,
 // so the human can fix it and re-queue, or push, or discard.
 expect((await client.agentRun.get({ agentRunId: first.id })).branchDisposition).toBeNull

 // And a failed entry must not wedge the queue behind it.
 const next = sweep
 const frame = await answerMerge(socket, { ok: true, commitSha: 'ok', verified: false })
 expect(frame.runId).toBe(second.id)
 await next

 // The human is told, since a queued merge is exactly the case where nobody is
 // watching the thread.
 expect(delivered.some((n) => n.kind === 'merge_failed')).toBe(true)

 socket.close
 })

 it('refuses to queue the same branch twice, or to discard one already queued', async => {
 const { socket, runnerId } = await pairFakeRunner('merge-guard')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'merge-guard' })
 const run = await finishRun(socket, created.rootThread.id, repo.id, 'loom/guard-1')

 await client.mergeQueue.enqueue({ agentRunId: run.id })
 await expect(client.mergeQueue.enqueue({ agentRunId: run.id })).rejects.toThrow(/queued/i)
 // Discarding would delete the clone the queue is about to rebase.
 await expect(client.agentRun.discard({ agentRunId: run.id })).rejects.toThrow(/queued/i)
 await expect(client.agentRun.keep({ agentRunId: run.id })).rejects.toThrow(/queued/i)

 socket.close
 })

 it('cancels a queued entry, and refuses to cancel one already merging', async => {
 const { socket, runnerId } = await pairFakeRunner('merge-cancel')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'merge-cancel' })
 const first = await finishRun(socket, created.rootThread.id, repo.id, 'loom/cancel-1')
 const second = await finishRun(socket, created.rootThread.id, repo.id, 'loom/cancel-2')

 const one = await client.mergeQueue.enqueue({ agentRunId: first.id })
 const two = await client.mergeQueue.enqueue({ agentRunId: second.id })

 const cancelled = await client.mergeQueue.cancel({ entryId: two.id })
 expect(cancelled.status).toBe('cancelled')
 // A cancelled entry releases its run: keeping the branch is available again.
 expect((await client.agentRun.keep({ agentRunId: second.id })).branchDisposition).toBe('kept')

 const swept = sweep
 const frame = await nextFrame(socket, (v) => v.type === 'merge_run', 10_000)
 expect(frame.runId).toBe(first.id)
 // Mid-merge, a cancel would leave the queue's state disagreeing with the
 // repository's — the rebase is already running on the Runner.
 await expect(client.mergeQueue.cancel({ entryId: one.id })).rejects.toThrow(/already running/i)
 socket.send(JSON.stringify({ type: 'merge_result', requestId: frame.requestId, ok: true, commitSha: 'y', verified: false }))
 await swept

 socket.close
 })

 it('fails an entry whose Runner never answers, rather than leaving the queue wedged', async => {
 const { socket, runnerId } = await pairFakeRunner('merge-stuck')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'merge-stuck' })
 const run = await finishRun(socket, created.rootThread.id, repo.id, 'loom/stuck-1')
 await client.mergeQueue.enqueue({ agentRunId: run.id })

 // Claim it, then abandon it exactly as a server dying mid-merge would. The
 // unique partial index means nothing else can claim while that row stands, so
 // without the stuck check this repository's queue would stall forever.
 const swept = sweep
 const held = await nextFrame(socket, (v) => v.type === 'merge_run', 10_000)
 expect((await client.mergeQueue.list)[0]?.status).toBe('merging')

 await advanceMergeQueue(app.deps, { mergeStuckMs: 0 })
 const [entry] = await client.mergeQueue.list
 expect(entry?.status).toBe('failed')
 expect(entry?.failureReason).toBe('runner_error')

 // The Runner then answers late, after the queue already gave up and told the
 // human so. First resolution wins: a success arriving now must not flip the
 // entry to merged, or set a disposition on a branch that was handed back.
 socket.send(
 JSON.stringify({ type: 'merge_result', requestId: held.requestId, ok: true, commitSha: 'late', verified: true }),
)
 await swept
 const [afterLate] = await client.mergeQueue.list
 expect(afterLate?.status).toBe('failed')
 expect(afterLate?.mergedCommitSha).toBeNull
 expect((await client.agentRun.get({ agentRunId: run.id })).branchDisposition).toBeNull

 socket.close
 })
})

/**
 * The raw transcript tier. Driven over the real protocol
 * against the real filesystem blob store, because the two properties that matter
 * are both about what crosses a boundary: that chunks reassemble in the order the
 * Runner sent them, and that discarding a branch really removes the transcript
 * rather than merely stopping it being listed.
 */
describe('runner-gateway: raw transcript tier', => {
 const startWithWorkspace = async (socket: WebSocket, threadId: string, repositoryId: string) => {
 const startRun = nextFrame(socket, (v) => v.type === 'start_run')
 const runPromise = client.agentRun.start({ threadId, repositoryId, personaId: testPersonaId })
 await startRun
 const run = await runPromise
 socket.send(
 JSON.stringify({
 type: 'run_workspace_ready',
 runId: run.id,
 clonePath: '/tmp/transcript-clone',
 branchName: 'loom/transcript',
 }),
)
 return run
 }

 const waitFor = async (predicate: => Promise<boolean>) => {
 for (let i = 0; i < 40; i += 1) {
 if (await predicate) return true
 await new Promise((r) => setTimeout(r, 50))
 }
 return false
 }

 it('reassembles chunks in the order they were sent, not the order they arrived', async => {
 const { socket, runnerId } = await pairFakeRunner('transcript-order')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'transcript-order' })
 const run = await startWithWorkspace(socket, created.rootThread.id, repo.id)

 // Sent out of order on purpose. The chunk *key* carries the ordering, so a
 // late chunk cannot land in the wrong place — object stores sort by key, which
 // is why transcriptChunkKey pads its index.
 socket.send(JSON.stringify({ type: 'raw_transcript_chunk', runId: run.id, chunkIndex: 1, lines: ['second'] }))
 socket.send(JSON.stringify({ type: 'raw_transcript_chunk', runId: run.id, chunkIndex: 0, lines: ['first'] }))
 socket.send(JSON.stringify({ type: 'raw_transcript_chunk', runId: run.id, chunkIndex: 2, lines: ['third'] }))

 const arrived = await waitFor(async => {
 const t = await client.agentRun.getRawTranscript({ agentRunId: run.id })
 return t.lines.length === 3
 })
 expect(arrived).toBe(true)

 const transcript = await client.agentRun.getRawTranscript({ agentRunId: run.id })
 expect(transcript.lines).toEqual(['first', 'second', 'third'])
 expect(transcript.chunks).toBe(3)

 socket.close
 })

 // A retransmitted chunk overwrites its own blob rather than appending a second
 // copy — the store's addressing giving tier 3 the property the unique (run, seq)
 // index gives tier 2.
 it('is idempotent on retransmission', async => {
 const { socket, runnerId } = await pairFakeRunner('transcript-idempotent')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'transcript-idempotent' })
 const run = await startWithWorkspace(socket, created.rootThread.id, repo.id)

 const chunk = { type: 'raw_transcript_chunk', runId: run.id, chunkIndex: 0, lines: ['a', 'b'] }
 socket.send(JSON.stringify(chunk))
 socket.send(JSON.stringify(chunk))

 await waitFor(async => (await client.agentRun.getRawTranscript({ agentRunId: run.id })).lines.length > 0)
 await new Promise((r) => setTimeout(r, 200))

 const transcript = await client.agentRun.getRawTranscript({ agentRunId: run.id })
 expect(transcript.lines).toEqual(['a', 'b'])

 socket.close
 })

 /**
 * The event-tiering design calls this tier "policy-bound". Discarding a branch is a human saying
 * they do not want the work kept, and the verbatim record of it is part of that.
 */
 it('deletes the transcript when the branch is discarded', async => {
 const { socket, runnerId } = await pairFakeRunner('transcript-discard')
 const repo = await bindViaFakeRunner(socket, runnerId)
 const created = await client.channel.create({ name: 'transcript-discard' })
 const run = await startWithWorkspace(socket, created.rootThread.id, repo.id)

 socket.send(
 JSON.stringify({ type: 'raw_transcript_chunk', runId: run.id, chunkIndex: 0, lines: ['kept for now'] }),
)
 await waitFor(async => (await client.agentRun.getRawTranscript({ agentRunId: run.id })).lines.length > 0)

 socket.send(
 JSON.stringify({
 type: 'agent_event',
 runId: run.id,
 seq: 1,
 event: { kind: 'run_completed', totalCostUsd: 0.01, result: 'done' },
 }),
)
 await waitFor(async => (await client.agentRun.get({ agentRunId: run.id })).status === 'completed')

 const discardFrame = nextFrame(socket, (v) => v.type === 'discard_run')
 const discarding = client.agentRun.discard({ agentRunId: run.id })
 const frame = await discardFrame
 socket.send(JSON.stringify({ type: 'discard_result', requestId: frame.requestId, ok: true }))
 await discarding

 const after = await client.agentRun.getRawTranscript({ agentRunId: run.id })
 expect(after.lines).toEqual([])
 expect(after.chunks).toBe(0)

 socket.close
 })
})
