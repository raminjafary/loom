import type { AgentDeps, RunDispatchPort } from '@loom/application'
import {
 agentRunActor,
 authorCorpusInstruction,
 systemActor,
 renderMasteryDirective,
 type MapSubjectKind,
 type MasteryDirective,
} from '@loom/domain'

/**
 * Everything a mastery run is told beyond "learn this subject": what it was asked to
 * look for, and — for an author — where the record it is learning from actually is.
 *
 * One function so the two cannot be added independently and one of them forgotten, which
 * is the shape of every field this gateway has previously dropped.
 */
const renderMasteryFraming = (mastery: {
 subjectKind: MapSubjectKind
 subjectRef: string
 directive?: MasteryDirective
}): string =>
 [
 mastery.subjectKind === 'author' ? authorCorpusInstruction(mastery.subjectRef): '',
 mastery.directive ? renderMasteryDirective(mastery.directive): '',
 ]
.filter((part) => part !== '')
.join('\n\n')
import {
 applyPlanDelta,
 applySubmittedPlan,
 readAtlasLeads,
 readContextLedger,
 reconcileRunnerRuns,
 recordAgentEvent,
 recordAgentNote,
 recordMapFragment,
 recordMasteryCheckpoint,
 resolveMapRevision,
 recordRunCost,
 recordRawTranscriptChunk,
 recordReconcileResult,
 recordRunHeartbeat,
 recordRunWorkspace,
 askClarifyingQuestion,
 handOverToSuccessor,
 handoffLimits,
 recordWarmUp,
 resolveTreeRunId,
 startAgentRun,
 requestApproval,
} from '@loom/application'
import {
 asAgentPersonaId,
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
 | { ok: true; commitSha: string; verified: boolean; changedPaths: string[]; note?: string }
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

 async startRun({
 runnerId,
 runId,
 persona,
 cwd,
 defaultBranch,
 repositoryId,
 task,
 contextLedger,
 mapContext,
 mastery,
 reconcile,
 review,
 steering,
 }) {
 send(runnerId, {
 type: 'start_run',
 runId,
 persona: {...persona, tools: [...persona.tools] },
 cwd,
 defaultBranch,
...(repositoryId === undefined ? {}: { repositoryId }),
...(task === undefined ? {}: { task }),
...(contextLedger === undefined ? {}: { contextLedger }),
 // A field added to the port and not destructured here is dropped in silence —
 // there is no type error for an argument you decline to read. That is exactly
 // how `mastery` was lost on its first live run: the map row was created, the
 // revision resolved, and the model was never offered `record_map`.
...(mapContext === undefined ? {}: { mapContext }),
 /**
 * The directive is **rendered here**, not on the Runner.
 *
 * Same reason `mapContext` is pre-rendered: the wording is what makes a focus
 * produce a concept rather than a directory listing, and a second formatter on
 * the Runner would be a second place for it to drift. An author subject also
 * carries where its corpus *is* — a run that does not know to read `git log`
 * reads the working tree and produces a repository map with a person's name on it.
 */
...(mastery === undefined
 ? {}
: {
 mastery: {
 subjectKind: mastery.subjectKind,
 subjectRef: mastery.subjectRef,
...(renderMasteryFraming(mastery) === ''
 ? {}
: { directive: renderMasteryFraming(mastery) }),
 },
 }),
...(reconcile === undefined ? {}: { reconcile }),
...(review === undefined ? {}: { review }),
...(steering ? { steering: true }: {}),
 })
 },

 async cancelRun({ runnerId, runId }) {
 // Silent when the Runner is gone: a disconnected Runner has no live agent
 // loop to abort, and the caller (pauseAllRuns) cancels the run in the
 // database either way — see RunDispatchPort.cancelRun.
 if (!connections.has(runnerId)) return
 send(runnerId, { type: 'cancel_run', runId })
 },

 async deliverToRun({ runnerId, runId, text }) {
 // Silent when the Runner is gone, for the same reason cancelRun is: there is no
 // live agent loop to deliver into, and the ledger already holds the note.
 if (!connections.has(runnerId)) return
 send(runnerId, { type: 'deliver_context', runId, text })
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

 async warmCache({ runnerId, repositoryId, repositoryPath, defaultBranch, installCommand }) {
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
 repositoryId,
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
 | { ok: true; commitSha: string; verified: boolean; changedPaths: string[]; note?: string }
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
 // A mastery run's map is waiting on this: it was opened `pending` at dispatch,
 // because the commit only exists once the Runner has cloned.
 // A no-op for every other run.
 if (frame.headSha !== undefined) {
 await resolveMapRevision(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 revision: frame.headSha,
 })
 }
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
 frame.ok
 ? // Carried on success too: a warm that
 // filled the cache but captured no prepared tree is a success with
 // something to say, and dropping the detail here made it unsayable.
 { ok: true,...(frame.detail ? { detail: frame.detail }: {}) }
: { ok: false, detail: frame.detail ?? 'the warm step failed' },
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
 changedPaths: frame.changedPaths ?? [],
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
 * A re-planning turn's delta. Re-validated
 * in the domain like a plan, and applied against the Planner this run was
 * started to re-enter — resolved from the run's own parent, never from the
 * payload, so a delta cannot reach a tree it was not started against.
 */
 case 'plan_delta_submitted':
 await applyPlanDelta(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 delta: { rationale: frame.rationale, ops: frame.ops },
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

 /**
 * A run handing its work to a successor.
 *
 * The successor is started **before** the predecessor is retired, and the
 * predecessor is retired only if that succeeded — a tree with no live run and a
 * branch nobody owns is the one outcome worse than a degraded agent carrying on,
 * which is why this is the last thing mastery builds.
 *
 * The successor is a child of the predecessor with `relation: 'handoff'`: same tree,
 * same persona, same ledger. Mastery: "continuity for the human is the tree, not the
 * process."
 */
 case 'handoff_requested': {
 try {
 const predecessor = await deps.agentRuns.findById(
 workspaceId,
 asAgentRunId(frame.runId),
)
 if (!predecessor) throw new Error('the run handing over no longer exists')

 const personaIdByName = async (name: string) => {
 const personas = await deps.personas.listByWorkspace(workspaceId)
 const persona = personas.find((entry) => entry.name === name)
 if (!persona) throw new Error(`no persona named ${name} to take over`)
 return persona.id
 }

 /**
 * Captured for the warm-up below. The rendered brief is what the successor
 * was actually handed — platform facts outside the fence, the predecessor's
 * words inside it — so recording anything else in the venue would put a
 * transcript beside the handover that does not match it.
 */
 let handedBrief = ''
 let handedPersonaId: string | null = null

 const result = await handOverToSuccessor(
 {
 agentRuns: deps.agentRuns as never,
 agentRunEvents: deps.agentRunEvents,
 resolveTreeRunId: async => resolveTreeRunId(deps, predecessor),
 startSuccessor: async ({ brief, task }) => {
 const successor = await startAgentRun(deps, {
 workspaceId,
 /**
 * The predecessor is the actor, and the successor is its child.
 *
 * Not `systemActor`, which `startAgentRun` refuses outright: a human
 * may always start a run and an agent may start one only as a child of
 * itself, and that second rule is exactly what a handoff is. It is also
 * the honest attribution — the predecessor asked for this by calling
 * `hand_over`, so the successor inherits its attenuation rather than
 * arriving from nowhere with the platform's authority.
 */
 actor: agentRunActor(predecessor.id),
 threadId: predecessor.threadId,
 repositoryId: predecessor.repositoryId,
 /**
 * By name, resolved to the id: the run carries a persona *snapshot*
 * with no id on it, and a name is the address this platform resolves
 * everything else by. A persona renamed since the predecessor started
 * would fail here rather than start a successor with a different
 * identity, which is the right failure.
 */
 personaId: (handedPersonaId = await personaIdByName(predecessor.persona.name)),
 parentRunId: predecessor.id,
 relation: 'handoff',
 /**
 * The brief goes in as the task, ahead of the original goal. It is
 * fenced inside `renderHandoffBrief`, and the platform's own facts sit
 * outside that fence and above it — the ordering is the mitigation.
 */
 task: task === null ? brief: `${brief}\n\nThe original task was: ${task}`,
 })
 handedBrief = brief
 return successor.id
 },
 announce: async ({ successorRunId, reason }) => {
 await deps.messages.append({
 workspaceId,
 threadId: predecessor.threadId,
 author: systemActor,
 body: {
 kind: 'system',
 text:
 `${predecessor.persona.name} handed this work to a fresh run because ` +
 `${reason}. The successor is on the same branch and the same budget; ` +
 `run ${successorRunId}.`,
 },
 })
 },
 // The operator's cap, not the platform default. This is the refusal half of the rule, so it has to read
 // the same setting the nudge does or a workspace could be told one number
 // and enforced against another.
 limits: handoffLimits(await deps.runControl.get(workspaceId)),
 },
 { workspaceId, agentRunId: asAgentRunId(frame.runId), brief: frame.brief },
)

 /**
 * The handover, written down in the venue.
 *
 * After the handoff and best-effort, which is the whole of the design decision.
 * Mastery reads as though the brief should *travel* through the Colosseum, but this
 * is the one item in the section that can lose work: making it depend on a
 * second subsystem to deliver its payload would put "a tree with no live run and
 * a branch nobody owns" behind an unrelated failure. So the venue is the record,
 * and a venue that could not be written still leaves a successor working.
 */
 if (result.ok && result.successorRunId !== null && handedPersonaId !== null) {
 try {
 await recordWarmUp(deps, {
 workspaceId,
 threadId: predecessor.threadId,
 repositoryId: predecessor.repositoryId,
 personaId: asAgentPersonaId(handedPersonaId),
 personaName: predecessor.persona.name,
 predecessorRunId: predecessor.id,
 successorRunId: result.successorRunId,
 brief: handedBrief,
 subject: predecessor.task ?? 'this work',
 })
 } catch {
 // Deliberately swallowed — see above.
 }
 }

 send(from, {
 type: 'handoff_result',
 requestId: frame.requestId,
 ok: result.ok,
...(result.ok ? {}: { reason: result.reason }),
 })
 } catch (error) {
 send(from, {
 type: 'handoff_result',
 requestId: frame.requestId,
 ok: false,
 reason: error instanceof Error ? error.message: String(error),
 })
 }
 return
 }

 /**
 * One fragment of a mastery run's map. Same shape as `note_written`
 * and for the same reasons: the Runner is holding a tool call open on the reply,
 * a refusal is returned rather than thrown so the model can act on it, and a
 * genuine fault is caught here rather than escaping into the socket handler.
 */
 case 'map_written': {
 try {
 const result = await recordMapFragment(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 fragment: frame.fragment,
 })
 send(from, {
 type: 'map_result',
 requestId: frame.requestId,
 ok: result.ok,
...(result.ok
 ? {
 nodesWritten: result.nodesWritten,
 edgesWritten: result.edgesWritten,
 superseded: result.superseded,
 }
: { reason: result.reason }),
 })
 } catch (error) {
 send(from, {
 type: 'map_result',
 requestId: frame.requestId,
 ok: false,
 reason: error instanceof Error ? error.message: String(error),
 })
 }
 return
 }

 /**
 * A mastery run's measured progress. Fire-and-forget: nothing is
 * waiting on a reply, and a checkpoint that fails to record must never be able to
 * stop the run whose progress it was describing.
 */
 case 'mastery_progress': {
 try {
 await recordMasteryCheckpoint(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 filesRead: frame.filesRead,
 filesInScope: frame.filesInScope,
 })
 } catch {
 // Deliberately swallowed — see above.
 }
 return
 }

 /**
 * A run asking the atlas what other subjects in this workspace know.
 *
 * Rendered here rather than on the Runner: the cap, the ranking and the untrusted
 * fence are security properties, and a Runner assembling its own answer
 * would be a second place for them to drift. It is also the only side that has the
 * database — a sandboxed run has no network by design.
 */
 case 'atlas_requested': {
 try {
 const leads = await readAtlasLeads(deps, {
 workspaceId,
 agentRunId: asAgentRunId(frame.runId),
 topic: frame.topic,
 })
 send(from, { type: 'atlas_result', requestId: frame.requestId, ok: true, leads })
 } catch (error) {
 send(from, {
 type: 'atlas_result',
 requestId: frame.requestId,
 ok: false,
 error: error instanceof Error ? error.message: String(error),
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
 }).catch((error: unknown) => {
 /**
 * A frame handler that throws must not become an unhandled rejection.
 *
 * Every frame here is input from a Runner, and some of them are refusals by
 * design — a plan delta from a run that was never started to steer anything
 *, a note for a run that has since been deleted. Those are
 * *answers*, not faults in this process, and before this the socket's fire-
 * and-forget `void` turned any of them into a rejection with nothing
 * attached to it: no runner id, no frame, and under a strict process handler,
 * an exit.
 *
 * Logged rather than closing the socket: one bad frame is not a reason to
 * drop a Runner holding live runs.
 */
 fastify.log.error({ error, runnerId }, 'runner frame handler failed')
 })
 })

 socket.on('close', disconnect)
 socket.on('error', disconnect)
 })
 }

 return { register, dispatch }
}
