import type { AgentDeps, RunDispatchPort } from '@loom/application'
import {
 applySubmittedPlan,
 readContextLedger,
 reconcileRunnerRuns,
 recordAgentEvent,
 recordAgentNote,
 recordRunCost,
 recordRawTranscriptChunk,
 recordReconcileResult,
 recordRunHeartbeat,
 recordRunWorkspace,
 askClarifyingQuestion,
 requestApproval,
} from '@loom/application'
import {
 asAgentRunId,
 asRunnerId,
 asWorkspaceId,
 type AgentEvent,
 type MergeFailureReason,
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

interface PendingList {
 resolve(result: import('@loom/application').ListDirectoryResult): void
 reject(error: Error): void
}

interface PendingInit {
 resolve(
 result: { ok: true; path: string; defaultBranch: string } | { ok: false; error: string },
): void
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

interface PendingWarm {
 resolve(result: { ok: true } | { ok: false; detail: string }): void
 reject(error: Error): void
}

interface PendingMerge {
 resolve(
 result:
 | { ok: true; commitSha: string; verified: boolean; note?: string }
 | { ok: false; reason: MergeFailureReason; detail: string },
): void
 reject(error: Error): void
}

/**
 * A merge runs a repository's whole test suite, so it gets a
 * budget measured in minutes rather than the seconds every other dispatch call
 * needs. Still bounded: an entry with no answer would otherwise sit `merging` and
 * block its repository's queue until the sweep's stuck check notices.
 */
const MERGE_TIMEOUT_MS = Number(process.env.LOOM_MERGE_TIMEOUT_MS ?? 900_000)
/**
 * Warming installs a whole dependency tree over the network, which on a cold cache is
 * the slowest thing this system does — repository binding calls it "minutes and gigabytes". Bounded
 * well above a merge's timeout for that reason, and bounded at all so a Runner that
 * dies mid-install does not leave the caller waiting forever.
 */
const WARM_TIMEOUT_MS = Number(process.env.LOOM_WARM_TIMEOUT_MS ?? 1_800_000)

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
 const pendingLists = new Map<string, PendingList>
 const pendingInits = new Map<string, PendingInit>
 const pendingDiffs = new Map<string, PendingDiff>
 const pendingDiscards = new Map<string, PendingDiscard>
 const pendingPushes = new Map<string, PendingPush>
 const pendingMerges = new Map<string, PendingMerge>
 const pendingWarms = new Map<string, PendingWarm>

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

 async listDirectory({ runnerId, path }) {
 if (!connections.has(runnerId)) {
 return { ok: false, error: 'Runner is not currently connected' }
 }
 const requestId = randomUUID
 return new Promise<import('@loom/application').ListDirectoryResult>((resolve, reject) => {
 const timer = setTimeout( => {
 pendingLists.delete(requestId)
 reject(new Error('Runner did not respond to list_directory in time'))
 }, CHECK_PATH_TIMEOUT_MS)
 pendingLists.set(requestId, {
 resolve: (r) => {
 clearTimeout(timer)
 resolve(r)
 },
 reject: (e) => {
 clearTimeout(timer)
 reject(e)
 },
 })
 send(runnerId, { type: 'list_directory', requestId, path })
 })
 },

 async initRepository({ runnerId, parentPath, name }) {
 if (!connections.has(runnerId)) {
 return { ok: false, error: 'Runner is not currently connected' }
 }
 const requestId = randomUUID
 return new Promise<
 { ok: true; path: string; defaultBranch: string } | { ok: false; error: string }
 >((resolve, reject) => {
 const timer = setTimeout( => {
 pendingInits.delete(requestId)
 reject(new Error('Runner did not respond to init_repository in time'))
 }, CHECK_PATH_TIMEOUT_MS)
 pendingInits.set(requestId, {
 resolve: (r) => {
 clearTimeout(timer)
 resolve(r)
 },
 reject: (e) => {
 clearTimeout(timer)
 reject(e)
 },
 })
 send(runnerId, { type: 'init_repository', requestId, parentPath, name })
 })
 },

 async startRun({ runnerId, runId, persona, cwd, defaultBranch, task, contextLedger, reconcile }) {
 send(runnerId, {
 type: 'start_run',
 runId,
 persona: {...persona, tools: [...persona.tools] },
 cwd,
 defaultBranch,
...(task === undefined ? {}: { task }),
...(contextLedger === undefined ? {}: { contextLedger }),
...(reconcile === undefined ? {}: { reconcile }),
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

 async sendQuestionAnswer({ runnerId, toolUseId, answer }) {
 send(runnerId, { type: 'question_answered', toolUseId, answer })
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

 async warmCache({ runnerId, repositoryPath, defaultBranch, installCommand }) {
 if (!connections.has(runnerId)) {
 return { ok: false, detail: 'Runner is not currently connected' }
 }
 const requestId = randomUUID
 return new Promise<{ ok: true } | { ok: false; detail: string }>((resolve, reject) => {
 const timer = setTimeout( => {
 pendingWarms.delete(requestId)
 reject(new Error('Runner did not respond to warm_cache in time'))
 }, WARM_TIMEOUT_MS)
 pendingWarms.set(requestId, {
 resolve: (r) => {
 clearTimeout(timer)
 resolve(r)
 },
 reject: (e) => {
 clearTimeout(timer)
 reject(e)
 },
 })
 send(runnerId, {
 type: 'warm_cache',
 requestId,
 repositoryPath,
 defaultBranch,
 installCommand,
 })
 })
 },

 async mergeRun({ runnerId, runId, verifyCommand }) {
 if (!connections.has(runnerId)) {
 return { ok: false, reason: 'runner_error', detail: 'Runner is not currently connected' }
 }
 const requestId = randomUUID
 return new Promise<
 | { ok: true; commitSha: string; verified: boolean; note?: string }
 | { ok: false; reason: MergeFailureReason; detail: string }
 >((resolve, reject) => {
 const timer = setTimeout( => {
 pendingMerges.delete(requestId)
 reject(new Error('Runner did not respond to merge_run in time'))
 }, MERGE_TIMEOUT_MS)
 pendingMerges.set(requestId, {
 resolve: (r) => {
 clearTimeout(timer)
 resolve(r)
 },
 reject: (e) => {
 clearTimeout(timer)
 reject(e)
 },
 })
 send(runnerId, { type: 'merge_run', requestId, runId, verifyCommand })
 })
 },
 }

 const deps: AgentDeps = {...baseDeps, dispatch }

 /**
 * `from` is the Runner the frame arrived on. Needed because two frame kinds
 * (`note_written`, `notes_requested`) are *requests* the Runner is waiting on a
 * reply to, unlike every other Runner→server frame, which either reports something
 * or answers a request the server made. Taken from the connection rather than from
 * the frame's own run for the obvious reason: a frame must not be able to nominate
 * which Runner the answer is sent to.
 */
 const handleFrame = async (
 workspaceId: WorkspaceId,
 from: RunnerId,
 raw: string,
): Promise<void> => {
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

 case 'list_directory_result': {
 const pending = pendingLists.get(frame.requestId)
 if (!pending) return
 pendingLists.delete(frame.requestId)
 pending.resolve(
 frame.ok
 ? {
 ok: true,
 path: frame.path ?? '',
 parent: frame.parent ?? null,
 entries: frame.entries ?? [],
 truncated: frame.truncated ?? false,
 }
: { ok: false, error: frame.error ?? 'Runner rejected the path' },
)
 return
 }

 case 'init_repository_result': {
 const pending = pendingInits.get(frame.requestId)
 if (!pending) return
 pendingInits.delete(frame.requestId)
 pending.resolve(
 frame.ok
 ? { ok: true, path: frame.path ?? '', defaultBranch: frame.defaultBranch ?? 'main' }
: { ok: false, error: frame.error ?? 'Runner failed to create the repository' },
)
 return
 }

 case 'agent_event': {
 const event = frame.event as AgentEvent
 await recordAgentEvent(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 seq: frame.seq,
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

 case 'question_asked':
 // Same gate as a tool approval, carrying a prompt.
 await askClarifyingQuestion(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 toolUseId: frame.toolUseId,
 question: frame.question,
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

 case 'warm_cache_result': {
 const pending = pendingWarms.get(frame.requestId)
 if (!pending) return
 pendingWarms.delete(frame.requestId)
 pending.resolve(
 frame.ok ? { ok: true }: { ok: false, detail: frame.detail ?? 'the warm step failed' },
)
 return
 }

 case 'merge_result': {
 const pending = pendingMerges.get(frame.requestId)
 if (!pending) return
 pendingMerges.delete(frame.requestId)
 pending.resolve(
 frame.ok
 ? {
 ok: true,
 commitSha: frame.commitSha ?? '',
 verified: frame.verified ?? false,
...(frame.note === undefined ? {}: { note: frame.note }),
 }
: {
 ok: false,
 // A result frame with no reason is a Runner/server version skew, not
 // a merge outcome — reported as a Runner problem rather than being
 // guessed at as a conflict.
 reason: frame.reason ?? 'runner_error',
 detail: frame.detail ?? 'Runner failed to merge the branch',
 },
)
 return
 }

 case 'plan_submitted':
 await applySubmittedPlan(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 subtasks: frame.subtasks,
 })
 return

 /**
 * One note a run wrote. Answered either way, and that is
 * load-bearing: the Runner is holding the agent's tool call open on this
 * reply, so a silent drop would stall the run that wrote the note.
 *
 * `recordAgentNote` returns a refusal rather than throwing it, so a malformed
 * or over-cap note becomes a tool result the model can act on. A genuine
 * fault (the run is gone) still throws, and is caught here rather than
 * escaping into the socket handler — for the same reason.
 */
 case 'note_written': {
 try {
 const result = await recordAgentNote(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 note: frame.note,
 })
 send(from, {
 type: 'note_result',
 requestId: frame.requestId,
 ok: result.ok,
...(result.ok ? {}: { reason: result.reason }),
 })
 } catch (error) {
 send(from, {
 type: 'note_result',
 requestId: frame.requestId,
 ok: false,
 reason: error instanceof Error ? error.message: String(error),
 })
 }
 return
 }

 /** A run asking for its tree's ledger mid-flight. */
 case 'notes_requested': {
 try {
 const ledger = await readContextLedger(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 })
 send(from, { type: 'notes_result', requestId: frame.requestId, ok: true, ledger })
 } catch (error) {
 send(from, {
 type: 'notes_result',
 requestId: frame.requestId,
 ok: false,
 error: error instanceof Error ? error.message: String(error),
 })
 }
 return
 }

 case 'raw_transcript_chunk':
 await recordRawTranscriptChunk(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 chunkIndex: frame.chunkIndex,
 lines: frame.lines,
 })
 return

 /**
 * A reconciler run's verdict on a conflicted branch.
 * Unsolicited — the server started the run and let go — so there is no pending
 * request to resolve, unlike `merge_result`.
 */
 case 'reconcile_result':
 await recordReconcileResult(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 parentRunId: asAgentRunId(frame.parentRunId),
 ok: frame.ok,
...(frame.commitSha === undefined ? {}: { commitSha: frame.commitSha }),
...(frame.reason === undefined ? {}: { reason: frame.reason }),
 })
 return

 case 'heartbeat':
 await recordRunHeartbeat(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 // Both or neither: a tokens figure with no window to measure it against is
 // not a ratio, and the schema keeps them together for that reason.
 context:
 frame.contextTokens !== undefined && frame.contextMaxTokens !== undefined
 ? { tokens: frame.contextTokens, maxTokens: frame.contextMaxTokens }
: undefined,
 })
 return

 case 'cost_report':
 await recordRunCost(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 spentUsd: frame.spentUsd,
 })
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

 // Reconcile before anything else this Runner might send. A run it can
 // resume gets a `resume_run`; one it cannot is failed now with a real
 // reason instead of waiting minutes for the reaper's generic message.
 // Registered in `connections` above, so `send` can reach it.
 const { resumable } = await reconcileRunnerRuns(deps, {
 workspaceId: asWorkspaceId(resolved.workspaceId),
 runnerId,
 resumableRunIds: helloResult.data.resumableRunIds ?? [],
 })
 for (const run of resumable) {
 send(runnerId, { type: 'resume_run', runId: run.runId, fromEventSeq: run.fromEventSeq })
 }
 return
 }

 const conn = connections.get(runnerId)
 if (!conn) return
 await handleFrame(conn.workspaceId, runnerId, text)
 })
 })

 socket.on('close', disconnect)
 socket.on('error', disconnect)
 })
 }

 return { register, dispatch }
}
