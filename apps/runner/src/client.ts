import { classifyToolEffect, isRiskyTool } from '@loom/domain'
import {
 RunnerFrameSchema,
 ServerFrameSchema,
 type RunnerFrame,
 type WireAgentEvent,
 type WirePersonaSpec,
} from '@loom/runner-protocol'
import WebSocket from 'ws'
import { runAgent } from './claude-agent-adapter.js'
import {
 drainUsage,
 egressConfigFromEnv,
 leaseEgressToken,
 revokeEgressToken,
 setUpstreamOauthToken,
} from './egress-client.js'
import { readHostClaudeOAuth } from './host-claude-auth.js'
import { checkPath, resolveWithinRoot } from './path-check.js'
import { clearRunState, listRunStates, saveRunState, type RunState } from './run-state.js'
import {
 commitRunWork,
 discardRunWorkspace,
 getDiff,
 prepareRunWorkspace,
 pushRunBranch,
} from './run-workspace.js'
import { runAgentInSandbox, sandboxConfigFromEnv, sandboxEnabled } from './sandbox.js'

export interface RunnerClientOptions {
 readonly serverWsUrl: string
 readonly pairingToken: string
 readonly allowedRoots: readonly string[]
 readonly log?: (message: string) => void
}

export const connectRunner = (options: RunnerClientOptions): { close: => void } => {
 const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`))
 const pendingPermissions = new Map<string, (decision: 'allow' | 'deny') => void>
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

 const send = (frame: RunnerFrame) => socket?.send(JSON.stringify(frame))

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
 }): Promise<void> => {
 const onEvent = (event: WireAgentEvent) => {
 if (event.kind === 'run_completed' || event.kind === 'run_failed') {
 pendingTerminalEvents.set(input.runId, event)
 return
 }
 sendAgentEvent(input.runId, event)
 }
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

 if (!useSandbox || !egress) {
 log(
 `WARNING: running ${input.runId} UNSANDBOXED — the agent has this Runner's privileges`,
)
 await runAgent({
 persona: input.persona,
 cwd: input.clonePath,
...(input.task === undefined ? {}: { task: input.task }),
...(input.resumeSessionId === undefined ? {}: { resumeSessionId: input.resumeSessionId }),
 abortController: input.abort,
 isRiskyTool,
 classifyEffect: (toolName, toolInput) =>
 classifyToolEffect(toolName, toolInput, input.clonePath, resolveWithinRoot),
 onEvent,
 onSessionId,
 onPermissionRequest,
 })
 return
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
 clonePath: input.clonePath,
 homePath: input.homePath,
 egressToken,
 egressDataUrl: egress.dataUrl,
...(input.resumeSessionId === undefined ? {}: { resumeSessionId: input.resumeSessionId }),
 abortController: input.abort,
 onEvent,
 onSessionId,
 onPermissionRequest,
 log,
 })
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

 case 'start_run': {
 const runId = frame.runId
 log(`preparing workspace for run ${runId} from ${frame.cwd}`)

 heartbeats.set(
 runId,
 setInterval( => send({ type: 'heartbeat', runId }), HEARTBEAT_INTERVAL_MS),
)

 const abort = new AbortController
 aborts.set(runId, abort)

 void prepareRunWorkspace(frame.cwd, runId)
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
 clonePath,
 homePath,
 abort,
 })
 })
.then(async => {
 await commitWork(runId, frame.persona.name)
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
 if (usageTimer) clearInterval(usageTimer)
 if (upstreamAuthTimer) clearInterval(upstreamAuthTimer)
 socket?.close
 },
 }
}

// Re-exported so a caller can validate a raw frame if needed (e.g. tests).
export { RunnerFrameSchema }
