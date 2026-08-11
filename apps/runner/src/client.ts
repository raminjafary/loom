import {
 classifyToolEffect,
 isRiskyTool,
 prepareTranscriptLine,
 TRANSCRIPT_CHUNK_LINES,
} from '@loom/domain'
import {
 RunnerFrameSchema,
 ServerFrameSchema,
 type RunnerFrame,
 type WireAgentEvent,
 type WirePersonaSpec,
} from '@loom/runner-protocol'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { runAgent } from './claude-agent-adapter.js'
import { depCacheEnv, depCacheFromEnv, warmDepCache } from './dep-cache.js'
import {
 drainUsage,
 egressConfigFromEnv,
 leaseEgressToken,
 revokeEgressToken,
 setUpstreamOauthToken,
} from './egress-client.js'
import { readHostClaudeOAuth } from './host-claude-auth.js'
import { provisionSkills } from './capabilities.js'
import { createPlannerTool } from './planner-tool.js'
import { mergeRunBranch } from './merge.js'
import { initRepository, listDirectory } from './directory.js'
import { checkPath, resolveWithinRoot } from './path-check.js'
import { clearRunState, listRunStates, saveRunState, type RunState } from './run-state.js'
import { createNotesTool } from './notes-tool.js'
import { createSendQueue } from './send-queue.js'
import {
 commitRunWork,
 discardRunWorkspace,
 finishReconcile,
 getDiff,
 prepareReconcileWorkspace,
 prepareRunWorkspace,
 pushRunBranch,
 updateBranchFrom,
} from './run-workspace.js'
import {
 checkImageFreshness,
 runAgentInSandbox,
 sandboxConfigFromEnv,
 sandboxEnabled,
 staleSandboxImageAcknowledged,
 unsandboxedAcknowledged,
} from './sandbox.js'

export interface RunnerClientOptions {
 readonly serverWsUrl: string
 readonly pairingToken: string
 readonly allowedRoots: readonly string[]
 readonly log?: (message: string) => void
}

export const connectRunner = (options: RunnerClientOptions): { close: => void } => {
 const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`))
 const pendingPermissions = new Map<string, (decision: 'allow' | 'deny') => void>
 /**
 * Note writes and reads awaiting the server's answer, keyed by
 * a request id this Runner mints.
 *
 * Unlike `pendingPermissions`, these are given a **timeout**. An approval may
 * legitimately wait as long as a human takes; a note is answered by the server
 * within a round-trip, so an unanswered one means the socket dropped — and a note
 * tool that never returns would hang the agent loop that called it, turning a
 * bookkeeping failure into a stalled run. That inversion is the thing to avoid:
 * notes exist to make runs cheaper.
 */
 const pendingNotes = new Map<
 string,
 (result: { ok: boolean; reason?: string | undefined }) => void
 >
 const pendingNoteReads = new Map<
 string,
 (result: { ok: boolean; ledger?: string | undefined; error?: string | undefined }) => void
 >
 const NOTE_TIMEOUT_MS = Number(process.env.LOOM_NOTE_TIMEOUT_MS ?? 30_000)

 let noteRequestCounter = 0
 const nextNoteRequestId = : string => {
 noteRequestCounter += 1
 return `note-${Date.now}-${noteRequestCounter}`
 }
 // Per-run clone state, needed to answer a later get_diff request — keyed by
 // runId since a Runner may have several runs in flight concurrently.
 const runWorkspaces = new Map<
 string,
 { clonePath: string; defaultBranch: string; sourcePath: string; branchName: string; homePath: string }
 >
 // Per-run heartbeat timers — started as soon as
 // start_run arrives (covers a hang during workspace prep too), cleared once
 // the run reaches a terminal outcome.
 const heartbeats = new Map<string, ReturnType<typeof setInterval>>
 // Per-run abort handles — registered before the
 // clone starts so a cancel arriving during workspace prep is not ignored.
 const aborts = new Map<string, AbortController>
 // Durable per-run state — the SDK session id, the clone, and
 // the event seq watermark, so a Runner restart can continue rather than lose the run.
 const runStates = new Map<string, RunState>
 const HEARTBEAT_INTERVAL_MS = Number(process.env.LOOM_HEARTBEAT_INTERVAL_MS ?? 20_000)

 // Sandbox + egress config. `egress` is null when this Runner
 // has no control secret, which is the deliberate unsandboxed escape hatch —
 // see runAgentForRun below for what that costs.
 const sandbox = sandboxConfigFromEnv
 const useSandbox = sandboxEnabled
 const egress = egressConfigFromEnv
 const USAGE_POLL_MS = Number(process.env.LOOM_USAGE_POLL_MS ?? 5_000)
 // Bounded above the server's own warm timeout so the Runner is not the one that
 // gives up first and leaves a container running.
 const WARM_TIMEOUT_MS = Number(process.env.LOOM_WARM_TIMEOUT_MS ?? 1_500_000)

 /**
 * Whether the sandbox image was built from the sources this Runner is running
 *. Memoized: neither the image nor this process's own files change
 * while it lives, and the check costs a container spawn.
 *
 * `agent-host.ts` sits beside this file, so the entry is resolved relative to this
 * module rather than to a cwd the Runner does not control.
 */
 const AGENT_HOST_ENTRY = fileURLToPath(new URL('./agent-host.ts', import.meta.url))
 let freshnessPromise: ReturnType<typeof checkImageFreshness> | null = null
 const imageFreshness = (config: typeof sandbox) => {
 freshnessPromise ??= checkImageFreshness(config, AGENT_HOST_ENTRY)
 return freshnessPromise
 }

 let socket: WebSocket | null = null
 let closed = false

 // Per-run event counter — the server's idempotency key. Kept
 // here rather than derived from anything observable so a retransmit of an
 // already-sent event reuses its original seq and is dropped server-side.
 const eventSeqs = new Map<string, number>

 /**
 * A run's terminal event, held until its work is committed (see flushRunTerminalEvent).
 */
 const pendingTerminalEvents = new Map<string, WireAgentEvent>

 // Backpressure and disconnect handling — see send-queue.ts
 // for what each knob protects against.
 const sendQueue = createSendQueue<RunnerFrame>({
 isOpen: => socket !== null && socket.readyState === WebSocket.OPEN,
 bufferedAmount: => socket?.bufferedAmount ?? 0,
 write: (frame) => socket?.send(JSON.stringify(frame)),
 // Only run-scoped events are worth holding through a disconnect. A `heartbeat`
 // replayed later would vouch for liveness at a moment that has passed, and a
 // `check_path_result` answers a request that is long gone.
 shouldHold: (frame) => frame.type === 'agent_event',
 highWaterBytes: Number(process.env.LOOM_SEND_HIGH_WATER_BYTES ?? 1_000_000),
 outboxLimit: Number(process.env.LOOM_OUTBOX_LIMIT ?? 1_000),
 log,
 isStopped: => closed,
 })

 const send = (frame: RunnerFrame) => sendQueue.send(frame)
 const awaitSendCapacity = => sendQueue.awaitCapacity

 /**
 * The raw transcript tier's batching (the event-tiering design: "batched writes (chunked
 * JSONL, flushed on size/interval)").
 *
 * Size is `TRANSCRIPT_CHUNK_LINES`; the interval is here because only the Runner
 * knows when a run has gone quiet — a run blocked on a human approval for ten
 * minutes should not leave its last few lines unwritten that whole time.
 *
 * Redaction happens here, on the host, before the line ever reaches the socket
 * (the credential broker, "redacted at write"). Doing it server-side would mean the unredacted
 * text had already crossed a network and sat in a log buffer.
 */
 const rawBuffers = new Map<string, string[]>
 const rawChunkIndexes = new Map<string, number>
 const RAW_FLUSH_MS = Number(process.env.LOOM_TRANSCRIPT_FLUSH_MS ?? 10_000)

 const flushRawTranscript = (runId: string): void => {
 const lines = rawBuffers.get(runId)
 if (!lines || lines.length === 0) return
 rawBuffers.set(runId, [])
 const chunkIndex = rawChunkIndexes.get(runId) ?? 0
 rawChunkIndexes.set(runId, chunkIndex + 1)
 send({ type: 'raw_transcript_chunk', runId, chunkIndex, lines })
 }

 const recordRawLine = async (runId: string, line: string): Promise<void> => {
 const buffer = rawBuffers.get(runId) ?? []
 buffer.push(prepareTranscriptLine(line))
 rawBuffers.set(runId, buffer)
 if (buffer.length < TRANSCRIPT_CHUNK_LINES) return
 await awaitSendCapacity
 flushRawTranscript(runId)
 }

 const rawFlushTimer = setInterval( => {
 for (const runId of rawBuffers.keys) flushRawTranscript(runId)
 }, RAW_FLUSH_MS)

 const sendAgentEvent = (runId: string, event: WireAgentEvent) => {
 const seq = (eventSeqs.get(runId) ?? 0) + 1
 eventSeqs.set(runId, seq)
 send({ type: 'agent_event', runId, seq, event })

 // Persisted with the state, not just held: a resumed run continues this sequence,
 // and restarting it at 1 would make every new event collide with an old one on the
 // server's (run, seq) index and vanish.
 const state = runStates.get(runId)
 if (state) {
 const next = {...state, lastEventSeq: seq }
 runStates.set(runId, next)
 void saveRunState(next).catch( => {})
 }
 }

 /**
 * Forwards proxy-metered spend to the server, and enforces the budget cap's
 * "hard kill" half. The proxy can refuse further calls but cannot
 * reach a Runner, so stopping the run has to happen here.
 *
 * Drain-on-read means a record handed over is gone from the proxy's queue, so
 * anything received is forwarded even if the run has already ended — dropping it
 * would silently lose spend that really happened.
 */
 const pumpUsage = async : Promise<void> => {
 if (!egress) return
 const records = await drainUsage(egress)
 for (const record of records) {
 send({
 type: 'cost_report',
 runId: record.runId,
 spentUsd: record.spentUsd,
 capUsd: record.capUsd,
 exhausted: record.exhausted,
 })
 if (!record.exhausted) continue

 const abort = aborts.get(record.runId)
 if (!abort || abort.signal.aborted) continue
 log(`run ${record.runId} exceeded its budget cap — killing`)
 sendAgentEvent(record.runId, {
 kind: 'run_failed',
 message: `Run stopped: budget cap of $${record.capUsd?.toFixed(2) ?? '0'} reached (spent $${record.spentUsd.toFixed(4)}).`,
 })
 abort.abort
 }
 }

 /**
 * Keeps the proxy's upstream credential current. The token lives in
 * the host's keychain, which the proxy container cannot read, so the Runner — already
 * the trusted host-side component — pushes it. Claude Code rotates it every few hours;
 * re-reading is enough, the Runner never refreshes it itself.
 */
 const refreshUpstreamAuth = async : Promise<void> => {
 if (!egress) return
 const oauth = await readHostClaudeOAuth
 await setUpstreamOauthToken(egress, oauth?.accessToken ?? null)
 }

 const upstreamAuthTimer = egress
 ? setInterval( => {
 void refreshUpstreamAuth.catch((error) =>
 log(`upstream auth refresh failed: ${error instanceof Error ? error.message: String(error)}`),
)
 }, Number(process.env.LOOM_UPSTREAM_AUTH_REFRESH_MS ?? 300_000))
: null

 const usageTimer = egress
 ? setInterval( => {
 void pumpUsage.catch((error) => log(`usage poll failed: ${error instanceof Error ? error.message: String(error)}`))
 }, USAGE_POLL_MS)
: null


 /**
 * Releases the terminal event a run has been holding, after its work is committed.
 *
 * The order matters: the server marks a run `completed` when this arrives, and the
 * Inbox reacts by fetching the diff. Sending it before the commit produced exactly
 * that bug — a completed run whose diff was zero bytes.
 */
 const flushRunTerminalEvent = (runId: string): void => {
 // The transcript's tail goes first, for the same reason the commit does: the
 // server marks the run terminal on this event and a client may immediately ask
 // for the raw transcript, which would then be missing its last chunk.
 flushRawTranscript(runId)
 const event = pendingTerminalEvents.get(runId)
 if (!event) return
 pendingTerminalEvents.delete(runId)
 sendAgentEvent(runId, event)
 }

 /**
 * Commits whatever the agent left behind, so the end-of-run diff and any later push
 * are not empty (see commitRunWork). Failures are logged, not fatal: a run that
 * finished is still a run, and a human can inspect the clone by hand.
 */
 const commitWork = async (runId: string, personaName: string): Promise<void> => {
 const workspace = runWorkspaces.get(runId)
 if (!workspace) return
 try {
 const { committed } = await commitRunWork(workspace.clonePath, { personaName, runId })
 if (committed) log(`committed run ${runId}'s work on ${workspace.branchName}`)
 } catch (error) {
 log(`failed to commit run ${runId}'s work: ${error instanceof Error ? error.message: String(error)}`)
 }
 }

 /**
 * A reconciler run's terminal step, in place of `commitWork`.
 *
 * A reconciler's workspace is a paused rebase, so "commit whatever is in the working
 * tree" is the wrong ending: it would make an ordinary commit on top of a rebase git
 * still considers in progress. `finishReconcile` completes the rebase instead, and
 * refuses on any surviving conflict marker.
 *
 * A refusal is reported as a `reconcile_failed` frame rather than a run failure. The
 * distinction is the whole design: the reconciler is *allowed* to decline a conflict
 * that encodes a real disagreement, and the mechanical queue behind it then does
 * exactly what it does today — hands the branch back to its owning run.
 */
 const finishReconcileRun = async (runId: string, reconcileOf: string): Promise<void> => {
 const workspace = runWorkspaces.get(runId)
 if (!workspace) return
 try {
 const result = await finishReconcile(workspace.clonePath)
 if (!result.ok) {
 log(`reconcile ${runId} did not resolve ${workspace.branchName}: ${result.reason}`)
 send({ type: 'reconcile_result', runId, parentRunId: reconcileOf, ok: false, reason: result.reason })
 return
 }
 // The reconciled branch is written back into the *parent's* clone, because that
 // is the clone the merge queue merges from. Without this the queue would re-merge
 // the untouched branch and conflict again, forever.
 const parent = runWorkspaces.get(reconcileOf)
 if (!parent) {
 send({
 type: 'reconcile_result',
 runId,
 parentRunId: reconcileOf,
 ok: false,
 reason: 'the run that owns this branch is no longer held by this Runner',
 })
 return
 }
 await updateBranchFrom(parent.clonePath, workspace.clonePath, workspace.branchName)
 log(`reconciled ${workspace.branchName} at ${result.commitSha.slice(0, 8)}`)
 send({
 type: 'reconcile_result',
 runId,
 parentRunId: reconcileOf,
 ok: true,
 commitSha: result.commitSha,
 })
 } catch (error) {
 send({
 type: 'reconcile_result',
 runId,
 parentRunId: reconcileOf,
 ok: false,
 reason: error instanceof Error ? error.message: String(error),
 })
 }
 }

 /**
 * Chooses how a run's agent loop executes. Sandboxed is the default and the
 * only configuration the sandbox spec considers acceptable; the in-process path exists
 * because it is what Phase 1 shipped before the sandbox did, and it is still
 * the fastest way to debug the adapter itself.
 *
 * The in-process path is genuinely less safe, not merely less isolated: the
 * agent runs with the Runner's own privileges, and the Runner is the component
 * that holds git credentials and push authority. It is logged loudly
 * for that reason.
 */
 const runAgentForRun = async (input: {
 runId: string
 persona: WirePersonaSpec
 task?: string
 clonePath: string
 homePath: string
 abort: AbortController
 resumeSessionId?: string
 /** The tree's ledger, rendered server-side. */
 contextLedger?: string
 }): Promise<void> => {
 // Async, and awaited by whoever produces events (the SDK loop in-process, the
 // container's stdout reader when sandboxed) — that await is the backpressure.
 const onEvent = async (event: WireAgentEvent) => {
 if (event.kind === 'run_completed' || event.kind === 'run_failed') {
 pendingTerminalEvents.set(input.runId, event)
 return
 }
 await awaitSendCapacity
 sendAgentEvent(input.runId, event)
 }
 const onRawMessage = (line: string) => recordRawLine(input.runId, line)
 const onSessionId = (sessionId: string) => {
 const state = runStates.get(input.runId)
 if (!state) return
 const next = {...state, sessionId }
 runStates.set(input.runId, next)
 void saveRunState(next).catch((error) =>
 log(`failed to persist session for ${input.runId}: ${error instanceof Error ? error.message: String(error)}`),
)
 }
 const onPermissionRequest = (
 toolUseId: string,
 toolName: string,
 toolInput: Record<string, unknown>,
): Promise<'allow' | 'deny'> => {
 send({ type: 'permission_request', runId: input.runId, toolUseId, toolName, input: toolInput })
 return new Promise((resolve) => {
 pendingPermissions.set(toolUseId, resolve)
 })
 }

 /**
 * The notes channel's two halves. Both go to the server,
 * because the ledger is workspace-side state — the first decision, so
 * that notes never enter a diff and never reach the merge queue.
 *
 * A timeout resolves as a refusal rather than rejecting: the model gets a tool
 * result saying the note was not recorded, which is true and actionable, whereas
 * a rejection surfaces as an opaque tool error.
 */
 const onNote = (note: {
 kind: string
 title: string
 body: string
 paths?: string[] | undefined
 }): Promise<{ ok: true } | { ok: false; reason: string }> => {
 const requestId = nextNoteRequestId
 send({ type: 'note_written', runId: input.runId, requestId, note })
 return new Promise((resolve) => {
 const timer = setTimeout( => {
 pendingNotes.delete(requestId)
 resolve({ ok: false, reason: 'the platform did not answer in time — it was not saved' })
 }, NOTE_TIMEOUT_MS)
 pendingNotes.set(requestId, (result) => {
 clearTimeout(timer)
 resolve(
 result.ok
 ? { ok: true }
: { ok: false, reason: result.reason ?? 'the platform refused it' },
)
 })
 })
 }

 const onNotesRequest = : Promise<
 { ok: true; ledger: string } | { ok: false; error: string }
 > => {
 const requestId = nextNoteRequestId
 send({ type: 'notes_requested', runId: input.runId, requestId })
 return new Promise((resolve) => {
 const timer = setTimeout( => {
 pendingNoteReads.delete(requestId)
 resolve({ ok: false, error: 'the platform did not answer in time' })
 }, NOTE_TIMEOUT_MS)
 pendingNoteReads.set(requestId, (result) => {
 clearTimeout(timer)
 resolve(
 result.ok
 ? { ok: true, ledger: result.ledger ?? '' }
: { ok: false, error: result.error ?? 'the platform could not read them' },
)
 })
 })
 }

 // Skills are written into the run's HOME before the SDK starts, so the
 // registry — not the clone — is where a run's skills come from. HOME is
 // run-scoped and destroyed with the run, so nothing outlives it.
 // A Planner gets exactly one channel it can act through; everything else it
 // might want happens because the server decided to, not because it asked.
 const plannerTool = input.persona.planner ? createPlannerTool: null
 // The notes channel is given to every run, planner included: a note is not a
 // capability, so it does not weaken `tools: []` (see notes-tool.ts).
 const notesTool = createNotesTool({ writeNote: onNote, readNotes: onNotesRequest })
 // Sandboxed, the tool lives inside the container and its result arrives as a
 // frame; unsandboxed, it is the in-process handle above. One holder either way.
 let sandboxPlan: { title: string; task: string; personaName: string; paths?: string[] }[] | null =
 null
 const flushPlan = => {
 const subtasks = sandboxPlan ?? plannerTool?.taken
 if (!subtasks || subtasks.length === 0) return
 send({ type: 'plan_submitted', runId: input.runId, subtasks })
 }

 const skillNames = await provisionSkills(input.homePath, input.persona.capabilities ?? [])
 if (skillNames.length > 0) log(`provisioned ${skillNames.length} skill(s) for run ${input.runId}`)

 if (!useSandbox || !egress) {
 // Refused rather than warned. The warning was in the log; the consequence would be
 // in the operator's keychain.
 if (!unsandboxedAcknowledged) {
 sendAgentEvent(input.runId, {
 kind: 'run_failed',
 message:
 'Refusing to run unsandboxed. Without a sandbox the agent executes with this ' +
 "Runner's user privileges — it can read the login keychain, SSH keys, cloud " +
 'credentials, and every repository on this machine. Start the egress proxy and ' +
 'leave LOOM_SANDBOX_ENABLED=1, or, if you genuinely accept that exposure, set ' +
 'LOOM_ALLOW_UNSANDBOXED=i-understand-the-agent-gets-my-privileges.',
 })
 return
 }
 log(
 `WARNING: running ${input.runId} UNSANDBOXED — the agent has this Runner's privileges`,
)
 await runAgent({
 persona: input.persona,
 cwd: input.clonePath,
...(plannerTool ? { plannerTool: plannerTool.server }: {}),
 notesTool,
...(input.task === undefined ? {}: { task: input.task }),
...(input.contextLedger === undefined ? {}: { contextLedger: input.contextLedger }),
...(input.resumeSessionId === undefined ? {}: { resumeSessionId: input.resumeSessionId }),
 abortController: input.abort,
 isRiskyTool,
 classifyEffect: (toolName, toolInput) =>
 classifyToolEffect(toolName, toolInput, input.clonePath, resolveWithinRoot),
 onEvent,
 onRawMessage,
 onSessionId,
 onPermissionRequest,
 })
 flushPlan
 return
 }

 // Before the lease, so a refusal never leaves one issued. Memoized across runs —
 // the answer cannot change while this process lives, and it costs a container spawn.
 const freshness = await imageFreshness(sandbox)
 if (!freshness.ok) {
 if (!staleSandboxImageAcknowledged) {
 sendAgentEvent(input.runId, {
 kind: 'run_failed',
 message:
 `Refusing to run: ${freshness.reason} An out-of-date image does not fail — ` +
 'it runs older agent-side code, so the model is quietly never offered whatever ' +
 'the newer sources added, and the run completes looking entirely normal. Set ' +
 'LOOM_ALLOW_STALE_SANDBOX_IMAGE=1 if you are pinning an image deliberately.',
 })
 return
 }
 log(`WARNING: ${freshness.reason} (LOOM_ALLOW_STALE_SANDBOX_IMAGE=1 is set)`)
 }

 // Refreshed immediately before the run rather than only on a timer: the token
 // rotates every few hours, and a run starting just after a rotation would otherwise
 // use a stale one.
 await refreshUpstreamAuth

 // The lease is taken before the container starts, so the sandbox never exists
 // in a state where it could reach the model API without one.
 const egressToken = await leaseEgressToken(egress, {
 runId: input.runId,
 // Enforced at the proxy, snapshotted onto the run so a
 // mid-run persona edit cannot raise the ceiling of a run already in flight.
 budgetCapUsd: input.persona.budgetCapUsd,
 })

 try {
 await runAgentInSandbox(sandbox, {
 runId: input.runId,
 persona: input.persona,
...(input.task === undefined ? {}: { task: input.task }),
...(input.contextLedger === undefined ? {}: { contextLedger: input.contextLedger }),
 clonePath: input.clonePath,
 homePath: input.homePath,
 egressToken,
 egressDataUrl: egress.dataUrl,
...(input.resumeSessionId === undefined ? {}: { resumeSessionId: input.resumeSessionId }),
 abortController: input.abort,
 onEvent,
 onRawMessage,
...(input.persona.planner ? { onPlan: (subtasks) => (sandboxPlan = subtasks) }: {}),
 onNote,
 onNotesRequest,
 onSessionId,
 onPermissionRequest,
 log,
 })
 // Sent after the loop, not from inside the tool handler: a plan submitted by
 // a run that then failed or was cancelled should not spawn children, and
 // only the loop ending tells us which happened.
 flushPlan
 } finally {
 // Drained before revoking: the final turn's spend is usually still queued
 // when the container exits, and revoking first would not lose it but
 // reporting late would let a run look cheaper than it was.
 await pumpUsage.catch( => {})
 await revokeEgressToken(egress, input.runId).catch((error) =>
 log(`failed to revoke lease for ${input.runId}: ${error instanceof Error ? error.message: String(error)}`),
)
 }
 }

 const connect = => {
 if (closed) return
 const ws = new WebSocket(options.serverWsUrl)
 socket = ws

 ws.on('open', => {
 log(`connected to ${options.serverWsUrl}`)
 // Resumable runs are declared in the handshake so the server can reconcile
 // before anything else happens. Read from disk each
 // connect rather than from memory, so a fresh process reports what it really has.
 void listRunStates
.then((states) => {
 for (const state of states) {
 runStates.set(state.runId, state)
 eventSeqs.set(state.runId, state.lastEventSeq)
 runWorkspaces.set(state.runId, {
 clonePath: state.clonePath,
 defaultBranch: state.defaultBranch,
 sourcePath: state.sourcePath,
 branchName: state.branchName,
 homePath: state.homePath,
 })
 }
 send({
 type: 'hello',
 token: options.pairingToken,
 allowedRoots: [...options.allowedRoots],
 resumableRunIds: states.map((state) => state.runId),
 })
 })
.catch( => {
 // A state directory this Runner cannot read is not a reason to refuse to
 // pair — it just means nothing is resumable.
 send({ type: 'hello', token: options.pairingToken, allowedRoots: [...options.allowedRoots], resumableRunIds: [] })
 })
 })

 ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
 let parsed: unknown
 try {
 parsed = JSON.parse(raw.toString)
 } catch {
 return
 }

 const result = ServerFrameSchema.safeParse(parsed)
 if (!result.success) return
 const frame = result.data

 switch (frame.type) {
 case 'hello_ack':
 log(`paired as runner ${frame.runnerId}`)
 // Only now, not on socket open: an event sent before the server has
 // resolved this Runner's identity has no run to attach to and is
 // rejected, which would turn a held event into a lost one.
 sendQueue.flush
 return

 case 'error':
 log(`server error: ${frame.message}`)
 return

 case 'check_path':
 void checkPath(frame.path, options.allowedRoots).then((result) => {
 send(
 result.ok
 ? {
 type: 'check_path_result',
 requestId: frame.requestId,
 ok: true,
 defaultBranch: result.defaultBranch,
 }
: { type: 'check_path_result', requestId: frame.requestId, ok: false, error: result.error },
)
 })
 return

 case 'list_directory':
 void listDirectory(frame.path, options.allowedRoots).then((result) =>
 send(
 result.ok
 ? {
 type: 'list_directory_result',
 requestId: frame.requestId,
 ok: true,
 path: result.path,
 parent: result.parent,
 entries: result.entries,
 truncated: result.truncated,
 }
: { type: 'list_directory_result', requestId: frame.requestId, ok: false, error: result.error },
),
)
 return

 case 'init_repository':
 void initRepository(frame.parentPath, frame.name, options.allowedRoots).then((result) =>
 send(
 result.ok
 ? {
 type: 'init_repository_result',
 requestId: frame.requestId,
 ok: true,
 path: result.path,
 defaultBranch: result.defaultBranch,
 }
: { type: 'init_repository_result', requestId: frame.requestId, ok: false, error: result.error },
),
)
 return

 case 'start_run': {
 const runId = frame.runId
 log(`preparing workspace for run ${runId} from ${frame.cwd}`)

 heartbeats.set(
 runId,
 setInterval( => send({ type: 'heartbeat', runId }), HEARTBEAT_INTERVAL_MS),
)

 const abort = new AbortController
 aborts.set(runId, abort)

 const reconcile = frame.reconcile
 // A reconciler opens onto a paused rebase in a clone of the conflicted run's
 // clone; every other run opens onto a fresh branch. Same run machinery from
 // here on — sandbox, budget, notes, approval gate all apply unchanged.
 const prepare = reconcile
 ? ( => {
 const parent = runWorkspaces.get(reconcile.parentRunId)
 if (!parent) {
 return Promise.reject(
 new Error(
 `cannot reconcile ${reconcile.branchName}: this Runner no longer holds run ${reconcile.parentRunId}'s clone`,
),
)
 }
 return prepareReconcileWorkspace(
 parent.clonePath,
 frame.cwd,
 frame.defaultBranch,
 reconcile.branchName,
 runId,
)
 })
: prepareRunWorkspace(frame.cwd, runId)

 void prepare
.then(({ clonePath, branchName, homePath }) => {
 // A cancel that landed while the clone was still running has no
 // agent loop to abort yet — honor it here instead of starting one.
 if (abort.signal.aborted) return

 runWorkspaces.set(runId, {
 clonePath,
 defaultBranch: frame.defaultBranch,
 sourcePath: frame.cwd,
 branchName,
 homePath,
 })
 const state: RunState = {
 runId,
 persona: frame.persona,
...(frame.task === undefined ? {}: { task: frame.task }),
 clonePath,
 homePath,
 branchName,
 defaultBranch: frame.defaultBranch,
 sourcePath: frame.cwd,
 lastEventSeq: 0,
 }
 runStates.set(runId, state)
 void saveRunState(state).catch((error) =>
 log(`failed to persist state for ${runId}: ${error instanceof Error ? error.message: String(error)}`),
)
 send({ type: 'run_workspace_ready', runId, clonePath, branchName })
 log(`starting run ${runId} in ${clonePath}`)
 return runAgentForRun({
 runId,
 persona: frame.persona,
...(frame.task === undefined ? {}: { task: frame.task }),
 // Deliberately not persisted into RunState: the ledger is a snapshot
 // of other runs' notes, and a resumed run should read the ledger as
 // it is *now* (via read_notes), not replay a stale copy of it.
...(frame.contextLedger === undefined ? {}: { contextLedger: frame.contextLedger }),
 clonePath,
 homePath,
 abort,
 })
 })
.then(async => {
 if (reconcile) await finishReconcileRun(runId, reconcile.parentRunId)
 else await commitWork(runId, frame.persona.name)
 flushRunTerminalEvent(runId)
 log(`run ${runId} finished`)
 })
.catch((error) => {
 // A cancel during clone surfaces here as a rejected prepare; the
 // server already recorded the run as cancelled, so stay quiet.
 if (abort.signal.aborted) return
 log(`run ${runId} failed to prepare workspace: ${error instanceof Error ? error.message: String(error)}`)
 sendAgentEvent(runId, {
 kind: 'run_failed',
 message: `Failed to prepare run workspace: ${error instanceof Error ? error.message: String(error)}`,
 })
 })
.finally( => {
 const timer = heartbeats.get(runId)
 if (timer) {
 clearInterval(timer)
 heartbeats.delete(runId)
 }
 aborts.delete(runId)
 // State is cleared only on a terminal outcome. Surviving a crash is the
 // whole point, so it must not be removed just because this process is
 // done with the run.
 runStates.delete(runId)
 pendingTerminalEvents.delete(runId)
 eventSeqs.delete(runId)
 rawBuffers.delete(runId)
 rawChunkIndexes.delete(runId)
 void clearRunState(runId).catch( => {})
 })
 return
 }

 /**
 * Continue a run this Runner already has state for. The
 * persona and task come from the state file, not the frame, so a persona edited
 * while the Runner was down cannot change what a resumed run is doing.
 */
 case 'resume_run': {
 const state = runStates.get(frame.runId)
 if (!state) {
 // The server believed this run resumable; it is not. Reported rather than
 // ignored, or the run would sit active until the reaper noticed.
 log(`cannot resume ${frame.runId} — no local state`)
 sendAgentEvent(frame.runId, {
 kind: 'run_failed',
 message: 'Run could not be resumed: the Runner no longer has its workspace state.',
 })
 return
 }
 if (aborts.has(frame.runId)) {
 // Already running here — a duplicate reconcile, not a second run.
 return
 }

 // Continue the sequence from the server's watermark rather than the local
 // one: the server is authoritative about what it actually ingested, and any
 // events sent but not recorded would otherwise collide.
 eventSeqs.set(frame.runId, Math.max(frame.fromEventSeq, state.lastEventSeq))

 log(
 `resuming run ${frame.runId} in ${state.clonePath}${state.sessionId ? ` (session ${state.sessionId})`: ' (no session — restarting the agent loop)'}`,
)

 const abort = new AbortController
 aborts.set(frame.runId, abort)
 heartbeats.set(
 frame.runId,
 setInterval( => send({ type: 'heartbeat', runId: frame.runId }), HEARTBEAT_INTERVAL_MS),
)

 void runAgentForRun({
 runId: frame.runId,
 persona: state.persona,
...(state.task === undefined ? {}: { task: state.task }),
 clonePath: state.clonePath,
 homePath: state.homePath,
 abort,
...(state.sessionId === undefined ? {}: { resumeSessionId: state.sessionId }),
 })
.then(async => {
 await commitWork(frame.runId, state.persona.name)
 flushRunTerminalEvent(frame.runId)
 log(`resumed run ${frame.runId} finished`)
 })
.catch((error) => {
 if (abort.signal.aborted) return
 sendAgentEvent(frame.runId, {
 kind: 'run_failed',
 message: `Resumed run failed: ${error instanceof Error ? error.message: String(error)}`,
 })
 })
.finally( => {
 const timer = heartbeats.get(frame.runId)
 if (timer) {
 clearInterval(timer)
 heartbeats.delete(frame.runId)
 }
 aborts.delete(frame.runId)
 runStates.delete(frame.runId)
 pendingTerminalEvents.delete(frame.runId)
 eventSeqs.delete(frame.runId)
 rawBuffers.delete(frame.runId)
 rawChunkIndexes.delete(frame.runId)
 void clearRunState(frame.runId).catch( => {})
 })
 return
 }

 case 'cancel_run': {
 const abort = aborts.get(frame.runId)
 if (!abort) return
 log(`cancelling run ${frame.runId}`)
 abort.abort
 return
 }

 case 'permission_response': {
 const resolve = pendingPermissions.get(frame.toolUseId)
 if (resolve) {
 pendingPermissions.delete(frame.toolUseId)
 resolve(frame.decision)
 }
 return
 }

 case 'note_result': {
 const resolve = pendingNotes.get(frame.requestId)
 if (resolve) {
 pendingNotes.delete(frame.requestId)
 resolve(frame)
 }
 return
 }

 case 'notes_result': {
 const resolve = pendingNoteReads.get(frame.requestId)
 if (resolve) {
 pendingNoteReads.delete(frame.requestId)
 resolve(frame)
 }
 return
 }

 case 'get_diff': {
 const workspace = runWorkspaces.get(frame.runId)
 if (!workspace) {
 send({ type: 'diff_result', requestId: frame.requestId, ok: false, error: 'Run has no workspace' })
 return
 }
 void getDiff(workspace.clonePath, workspace.defaultBranch)
.then((diff) => send({ type: 'diff_result', requestId: frame.requestId, ok: true, diff }))
.catch((error) =>
 send({
 type: 'diff_result',
 requestId: frame.requestId,
 ok: false,
 error: error instanceof Error ? error.message: String(error),
 }),
)
 return
 }

 case 'discard_run': {
 const workspace = runWorkspaces.get(frame.runId)
 if (!workspace) {
 send({ type: 'discard_result', requestId: frame.requestId, ok: false, error: 'Run has no workspace' })
 return
 }
 void discardRunWorkspace(workspace.clonePath, workspace.homePath)
.then( => {
 runWorkspaces.delete(frame.runId)
 send({ type: 'discard_result', requestId: frame.requestId, ok: true })
 })
.catch((error) =>
 send({
 type: 'discard_result',
 requestId: frame.requestId,
 ok: false,
 error: error instanceof Error ? error.message: String(error),
 }),
)
 return
 }

 /**
 * One merge-queue entry. Like get_diff and push_run,
 * this resolves the run through `runWorkspaces` — so it shares their
 * limitation: a Runner that restarted after the run finished no longer holds
 * the clone's location and answers "Run has no workspace". Reported as a
 * `runner_error` the human can act on rather than as a merge that quietly
 * never happened.
 */
 case 'warm_cache': {
 // Nothing to warm into if the operator has not enabled a cache — reported
 // rather than silently succeeding, since "warmed" would then be a lie.
 const cache = depCacheFromEnv
 if (!cache) {
 send({
 type: 'warm_cache_result',
 requestId: frame.requestId,
 ok: false,
 detail: 'this Runner has no dependency cache enabled (LOOM_DEP_CACHE_ENABLED=1)',
 })
 return
 }
 log(`warming the dependency cache for ${frame.repositoryPath}`)
 // A throwaway clone, not the bound repository: the install runs in a
 // container with this path mounted, and the operator's own working tree is
 // not somewhere to do that even read-only.
 void prepareRunWorkspace(frame.repositoryPath, `warm-${frame.requestId}`)
.then(async (workspace) => {
 try {
 return await warmDepCache({
 runtime: sandbox.runtime,
 image: sandbox.image,
 network: sandbox.network,
 cacheRoot: cache.root,
 clonePath: workspace.clonePath,
 command: frame.installCommand,
 env: egress
 ? {
 HTTP_PROXY: egress.dataUrl,
 HTTPS_PROXY: egress.dataUrl,
...depCacheEnv,
 }
: depCacheEnv,
 timeoutMs: WARM_TIMEOUT_MS,
 })
 } finally {
 await discardRunWorkspace(workspace.clonePath).catch( => {})
 }
 })
.then((result) => {
 log(`warm ${result.ok ? 'succeeded': 'failed'} for ${frame.repositoryPath}`)
 send({
 type: 'warm_cache_result',
 requestId: frame.requestId,
 ok: result.ok,
...(result.ok ? {}: { detail: result.detail }),
 })
 })
.catch((error: unknown) =>
 send({
 type: 'warm_cache_result',
 requestId: frame.requestId,
 ok: false,
 detail: error instanceof Error ? error.message: String(error),
 }),
)
 return
 }

 case 'merge_run': {
 const workspace = runWorkspaces.get(frame.runId)
 if (!workspace) {
 send({
 type: 'merge_result',
 requestId: frame.requestId,
 ok: false,
 reason: 'runner_error',
 detail: 'this Runner no longer holds the run\'s workspace',
 })
 return
 }
 void mergeRunBranch({
 sourcePath: workspace.sourcePath,
 clonePath: workspace.clonePath,
 branchName: workspace.branchName,
 defaultBranch: workspace.defaultBranch,
 verifyCommand: frame.verifyCommand,
 log,
 })
.then((result) =>
 send(
 result.ok
 ? {
 type: 'merge_result',
 requestId: frame.requestId,
 ok: true,
 commitSha: result.commitSha,
 verified: result.verified,
...(result.note === undefined ? {}: { note: result.note }),
 }
: {
 type: 'merge_result',
 requestId: frame.requestId,
 ok: false,
 reason: result.reason,
 detail: result.detail,
 },
),
)
.catch((error) =>
 send({
 type: 'merge_result',
 requestId: frame.requestId,
 ok: false,
 reason: 'runner_error',
 detail: error instanceof Error ? error.message: String(error),
 }),
)
 return
 }

 case 'push_run': {
 const workspace = runWorkspaces.get(frame.runId)
 if (!workspace) {
 send({ type: 'push_result', requestId: frame.requestId, ok: false, error: 'Run has no workspace' })
 return
 }
 void pushRunBranch(
 workspace.sourcePath,
 workspace.clonePath,
 workspace.branchName,
 workspace.defaultBranch,
 frame.acknowledgeCiChange,
)
.then((result) =>
 send(
 result.ok
 ? {
 type: 'push_result',
 requestId: frame.requestId,
 ok: true,
...(result.prUrl === undefined ? {}: { prUrl: result.prUrl }),
...(result.compareUrl === undefined ? {}: { compareUrl: result.compareUrl }),
...(result.warning === undefined ? {}: { warning: result.warning }),
 }
: { type: 'push_result', requestId: frame.requestId, ok: false, error: result.error },
),
)
.catch((error) =>
 send({
 type: 'push_result',
 requestId: frame.requestId,
 ok: false,
 error: error instanceof Error ? error.message: String(error),
 }),
)
 return
 }
 }
 })

 ws.on('close', => {
 log('disconnected')
 if (!closed) {
 setTimeout(connect, 2000)
 }
 })

 ws.on('error', (error: Error) => {
 log(`connection error: ${error.message}`)
 })
 }

 connect

 return {
 close: => {
 closed = true
 clearInterval(rawFlushTimer)
 if (usageTimer) clearInterval(usageTimer)
 if (upstreamAuthTimer) clearInterval(upstreamAuthTimer)
 socket?.close
 },
 }
}

// Re-exported so a caller can validate a raw frame if needed (e.g. tests).
export { RunnerFrameSchema }
