import type { AgentDeps, RunDispatchPort } from '@loom/application'
import { requestApproval, recordAgentEvent, recordRunHeartbeat, recordRunWorkspace } from '@loom/application'
import {
 asAgentRunId,
 asRunnerId,
 asWorkspaceId,
 type AgentEvent,
 type RunnerId,
 type WorkspaceId,
} from '@loom/domain'
import { resolveRunnerByToken, setRunnerConnection, type Database } from '@loom/db'
import websocket from '@fastify/websocket'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type WebSocket from 'ws'
import { RunnerFrameSchema, type ServerFrame } from '@loom/runner-protocol'

const CHECK_PATH_TIMEOUT_MS = 10_000

interface ConnectedRunner {
 readonly socket: WebSocket
 readonly workspaceId: WorkspaceId
}

interface PendingCheck {
 resolve(result: { ok: true; defaultBranch: string } | { ok: false; error: string }): void
 reject(error: Error): void
}

interface PendingDiff {
 resolve(result: { ok: true; diff: string } | { ok: false; error: string }): void
 reject(error: Error): void
}

interface PendingDiscard {
 resolve(result: { ok: true } | { ok: false; error: string }): void
 reject(error: Error): void
}

interface PendingPush {
 resolve(
 result:
 | { ok: true; prUrl?: string; compareUrl?: string; warning?: string }
 | { ok: false; error: string },
): void
 reject(error: Error): void
}

/**
 * Runner-facing WS endpoint: corrected placement, lives on
 * apps/server rather than apps/ws-gateway because it needs the application
 * layer and a DB connection to persist agent_run/approval_request rows —
 * exactly what the stateless client gateway deliberately doesn't have.
 *
 * Dual role, both normal for a bidirectional protocol gateway: it's a
 * *driving* entry point when a Runner pushes an event (calls use-cases
 * directly, same as router.ts does for HTTP), and it *implements*
 * `RunDispatchPort` (the driven side) so use-cases can push commands out to a
 * Runner without knowing sockets exist.
 */
export const createRunnerGateway = (
 db: Database,
 // `dispatch` is deliberately absent: this factory produces it. Passing the
 // rest of AgentDeps in lets handleFrame call use-cases once `dispatch`
 // exists below, without a construction cycle.
 baseDeps: Omit<AgentDeps, 'dispatch'>,
): { register(fastify: FastifyInstance): Promise<void>; dispatch: RunDispatchPort } => {
 const connections = new Map<string, ConnectedRunner>
 const pendingChecks = new Map<string, PendingCheck>
 const pendingDiffs = new Map<string, PendingDiff>
 const pendingDiscards = new Map<string, PendingDiscard>
 const pendingPushes = new Map<string, PendingPush>

 const send = (runnerId: RunnerId, frame: ServerFrame): void => {
 const conn = connections.get(runnerId)
 if (!conn) throw new Error(`Runner ${runnerId} is not connected`)
 conn.socket.send(JSON.stringify(frame))
 }

 const dispatch: RunDispatchPort = {
 async checkPath({ runnerId, path }) {
 if (!connections.has(runnerId)) {
 return { ok: false, error: 'Runner is not currently connected' }
 }
 const requestId = randomUUID
 const result = await new Promise<
 { ok: true; defaultBranch: string } | { ok: false; error: string }
 >((resolve, reject) => {
 const timer = setTimeout( => {
 pendingChecks.delete(requestId)
 reject(new Error('Runner did not respond to check_path in time'))
 }, CHECK_PATH_TIMEOUT_MS)
 pendingChecks.set(requestId, {
 resolve: (r) => {
 clearTimeout(timer)
 resolve(r)
 },
 reject: (e) => {
 clearTimeout(timer)
 reject(e)
 },
 })
 send(runnerId, { type: 'check_path', requestId, path })
 })
 return result
 },

 async startRun({ runnerId, runId, persona, cwd, defaultBranch, task }) {
 send(runnerId, {
 type: 'start_run',
 runId,
 persona: {...persona, tools: [...persona.tools] },
 cwd,
 defaultBranch,
...(task === undefined ? {}: { task }),
 })
 },

 async cancelRun({ runnerId, runId }) {
 // Silent when the Runner is gone: a disconnected Runner has no live agent
 // loop to abort, and the caller (pauseAllRuns) cancels the run in the
 // database either way — see RunDispatchPort.cancelRun.
 if (!connections.has(runnerId)) return
 send(runnerId, { type: 'cancel_run', runId })
 },

 async sendApprovalDecision({ runnerId, toolUseId, decision }) {
 send(runnerId, { type: 'permission_response', toolUseId, decision })
 },

 async getDiff({ runnerId, runId }) {
 if (!connections.has(runnerId)) {
 return { ok: false, error: 'Runner is not currently connected' }
 }
 const requestId = randomUUID
 return new Promise<{ ok: true; diff: string } | { ok: false; error: string }>(
 (resolve, reject) => {
 const timer = setTimeout( => {
 pendingDiffs.delete(requestId)
 reject(new Error('Runner did not respond to get_diff in time'))
 }, CHECK_PATH_TIMEOUT_MS)
 pendingDiffs.set(requestId, {
 resolve: (r) => {
 clearTimeout(timer)
 resolve(r)
 },
 reject: (e) => {
 clearTimeout(timer)
 reject(e)
 },
 })
 send(runnerId, { type: 'get_diff', requestId, runId })
 },
)
 },

 async discardRun({ runnerId, runId }) {
 if (!connections.has(runnerId)) {
 return { ok: false, error: 'Runner is not currently connected' }
 }
 const requestId = randomUUID
 return new Promise<{ ok: true } | { ok: false; error: string }>((resolve, reject) => {
 const timer = setTimeout( => {
 pendingDiscards.delete(requestId)
 reject(new Error('Runner did not respond to discard_run in time'))
 }, CHECK_PATH_TIMEOUT_MS)
 pendingDiscards.set(requestId, {
 resolve: (r) => {
 clearTimeout(timer)
 resolve(r)
 },
 reject: (e) => {
 clearTimeout(timer)
 reject(e)
 },
 })
 send(runnerId, { type: 'discard_run', requestId, runId })
 })
 },

 async pushRun({ runnerId, runId, acknowledgeCiChange }) {
 if (!connections.has(runnerId)) {
 return { ok: false, error: 'Runner is not currently connected' }
 }
 const requestId = randomUUID
 return new Promise<
 | { ok: true; prUrl?: string; compareUrl?: string; warning?: string }
 | { ok: false; error: string }
 >((resolve, reject) => {
 const timer = setTimeout( => {
 pendingPushes.delete(requestId)
 reject(new Error('Runner did not respond to push_run in time'))
 }, CHECK_PATH_TIMEOUT_MS)
 pendingPushes.set(requestId, {
 resolve: (r) => {
 clearTimeout(timer)
 resolve(r)
 },
 reject: (e) => {
 clearTimeout(timer)
 reject(e)
 },
 })
 send(runnerId, { type: 'push_run', requestId, runId, acknowledgeCiChange })
 })
 },
 }

 const deps: AgentDeps = {...baseDeps, dispatch }

 const handleFrame = async (workspaceId: WorkspaceId, raw: string): Promise<void> => {
 let parsed: unknown
 try {
 parsed = JSON.parse(raw)
 } catch {
 return
 }
 const result = RunnerFrameSchema.safeParse(parsed)
 if (!result.success) return
 const frame = result.data

 switch (frame.type) {
 case 'hello':
 // Handled during the connection handshake, not here.
 return

 case 'check_path_result': {
 const pending = pendingChecks.get(frame.requestId)
 if (!pending) return
 pendingChecks.delete(frame.requestId)
 pending.resolve(
 frame.ok
 ? { ok: true, defaultBranch: frame.defaultBranch ?? 'main' }
: { ok: false, error: frame.error ?? 'Runner rejected the path' },
)
 return
 }

 case 'agent_event': {
 const event = frame.event as AgentEvent
 await recordAgentEvent(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 event,
 })
 return
 }

 case 'permission_request':
 await requestApproval(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 toolUseId: frame.toolUseId,
 toolName: frame.toolName,
 input: frame.input,
 })
 return

 case 'run_workspace_ready':
 await recordRunWorkspace(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 clonePath: frame.clonePath,
 branchName: frame.branchName,
 })
 return

 case 'diff_result': {
 const pending = pendingDiffs.get(frame.requestId)
 if (!pending) return
 pendingDiffs.delete(frame.requestId)
 pending.resolve(
 frame.ok
 ? { ok: true, diff: frame.diff ?? '' }
: { ok: false, error: frame.error ?? 'Runner failed to produce a diff' },
)
 return
 }

 case 'discard_result': {
 const pending = pendingDiscards.get(frame.requestId)
 if (!pending) return
 pendingDiscards.delete(frame.requestId)
 pending.resolve(
 frame.ok ? { ok: true }: { ok: false, error: frame.error ?? 'Runner failed to discard the run' },
)
 return
 }

 case 'push_result': {
 const pending = pendingPushes.get(frame.requestId)
 if (!pending) return
 pendingPushes.delete(frame.requestId)
 pending.resolve(
 frame.ok
 ? {
 ok: true,
...(frame.prUrl === undefined ? {}: { prUrl: frame.prUrl }),
...(frame.compareUrl === undefined ? {}: { compareUrl: frame.compareUrl }),
...(frame.warning === undefined ? {}: { warning: frame.warning }),
 }
: { ok: false, error: frame.error ?? 'Runner failed to push the run' },
)
 return
 }

 case 'heartbeat':
 await recordRunHeartbeat(deps, { workspaceId, agentRunId: asAgentRunId(frame.runId) })
 return
 }
 }

 const register = async (fastify: FastifyInstance): Promise<void> => {
 await fastify.register(websocket)

 fastify.get('/ws/runner', { websocket: true }, (socket) => {
 let runnerId: RunnerId | null = null

 const disconnect = => {
 if (runnerId) {
 connections.delete(runnerId)
 // Best-effort: a closing DB pool during shutdown (or any transient
 // failure) must not surface as an unhandled rejection — the
 // in-memory connection is already gone either way, which is what
 // actually matters for routing further dispatch calls.
 setRunnerConnection(db, runnerId, { connected: false }).catch( => {})
 }
 }

 socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
 void (async => {
 const text = raw.toString

 if (!runnerId) {
 // First frame must be `hello` — anything else before pairing is rejected.
 let parsed: unknown
 try {
 parsed = JSON.parse(text)
 } catch {
 socket.close(1008, 'expected hello frame')
 return
 }
 const helloResult = RunnerFrameSchema.safeParse(parsed)
 if (!helloResult.success || helloResult.data.type !== 'hello') {
 socket.close(1008, 'expected hello frame')
 return
 }

 const resolved = await resolveRunnerByToken(db, helloResult.data.token)
 if (!resolved) {
 socket.send(JSON.stringify({ type: 'error', message: 'invalid pairing token' }))
 socket.close(1008, 'invalid pairing token')
 return
 }

 runnerId = asRunnerId(resolved.id)
 connections.set(runnerId, {
 socket,
 workspaceId: asWorkspaceId(resolved.workspaceId),
 })
 await setRunnerConnection(db, resolved.id, {
 connected: true,
 allowedRoots: helloResult.data.allowedRoots,
 })
 socket.send(JSON.stringify({ type: 'hello_ack', runnerId }))
 return
 }

 const conn = connections.get(runnerId)
 if (!conn) return
 await handleFrame(conn.workspaceId, text)
 })
 })

 socket.on('close', disconnect)
 socket.on('error', disconnect)
 })
 }

 return { register, dispatch }
}
