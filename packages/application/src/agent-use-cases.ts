import {
 BUILTIN_PERSONAS,
 ForbiddenError,
 NotFoundError,
 ValidationError,
 agentRunActor,
 isHuman,
 isRiskyTool,
 parsePersonaMarkdown,
 systemActor,
 type Actor,
 type AgentEvent,
 type AgentPersona,
 type AgentPersonaId,
 type AgentRun,
 type AgentRunId,
 type AgentRunStatus,
 type ApprovalRequest,
 type ApprovalRequestId,
 type PersonaGroup,
 type PersonaGroupId,
 type PersonaSpec,
 type Repository,
 type RepositoryId,
 type Runner,
 type RunnerId,
 type ThreadId,
 type WorkspaceId,
 type WorkspaceRunControl,
} from '@loom/domain'
import type {
 AgentRunEventRepositoryPort,
 AgentRunRepositoryPort,
 ApprovalRepositoryPort,
 PersonaGroupRepositoryPort,
 PersonaRepositoryPort,
 RepositoryRepositoryPort,
 RunDispatchPort,
 RunnerRepositoryPort,
 WorkspaceRunControlRepositoryPort,
} from './agent-ports.js'
import type { Deps } from './use-cases.js'

export interface AgentDeps extends Deps {
 readonly runners: RunnerRepositoryPort
 readonly repositories: RepositoryRepositoryPort
 readonly agentRuns: AgentRunRepositoryPort
 readonly agentRunEvents: AgentRunEventRepositoryPort
 readonly approvals: ApprovalRepositoryPort
 readonly personas: PersonaRepositoryPort
 readonly personaGroups: PersonaGroupRepositoryPort
 readonly runControl: WorkspaceRunControlRepositoryPort
 readonly dispatch: RunDispatchPort
}

/** Administrative action, human-only, same reasoning as createChannel. */
export const createRunnerPairingToken = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; name: string },
): Promise<{ runnerId: string; rawToken: string }> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may pair a Runner')
 }
 const pairing = await deps.runners.createPairing({
 workspaceId: input.workspaceId,
 name: input.name,
 })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'runner.paired',
 subjectType: 'runner',
 subjectId: pairing.runnerId,
 metadata: { name: input.name },
 })

 return pairing
}

/**
 * Phase 1 scope cut: binds an existing repo by absolute path on
 * an already-connected Runner. No directory picker, no `git init` flow yet.
 * Repo binding is deliberately a human-only action, same reasoning as
 * createChannel — it is administrative, not something an agent run does to
 * itself.
 */
export const bindRepository = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 runnerId: RunnerId
 path: string
 displayName: string
 },
): Promise<Repository> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may bind a repository')
 }

 const runner = await deps.runners.findById(input.workspaceId, input.runnerId)
 if (!runner) throw new NotFoundError('Runner')
 if (!runner.connected) throw new ValidationError('Runner is not currently connected')

 const check = await deps.dispatch.checkPath({ runnerId: input.runnerId, path: input.path })
 if (!check.ok) throw new ValidationError(check.error)

 return deps.repositories.create({
 workspaceId: input.workspaceId,
 runnerId: input.runnerId,
 displayName: input.displayName,
 absolutePath: input.path,
 defaultBranch: check.defaultBranch,
 })
}

/** What a real client needs to render a runner-picker; no actor restriction, same as listRepositories. */
export const listRunners = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<Runner[]> => deps.runners.listByWorkspace(input.workspaceId)

/** Human-only, same reasoning as bindRepository — a persona is an administrative artifact, not something a run edits about itself. */
export const createPersona = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; markdownSource: string },
): Promise<AgentPersona> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may create a persona')
 }
 const parsed = parsePersonaMarkdown(input.markdownSource)
 const existing = await deps.personas.listByWorkspace(input.workspaceId)
 if (existing.some((p) => p.name === parsed.name)) {
 throw new ValidationError(`Persona "${parsed.name}" already exists`)
 }
 return deps.personas.create({
 workspaceId: input.workspaceId,
 name: parsed.name,
 description: parsed.description,
 markdownSource: input.markdownSource,
 model: parsed.model,
 tools: parsed.tools,
 harnessEffort: parsed.harnessEffort,
 harnessMaxTurns: parsed.harnessMaxTurns,
 harnessAutoApprove: parsed.harnessAutoApprove,
 })
}

/**
 * Called from apps/server/src/app.ts only when `ensureWorkspace` reports
 * `created: true` — i.e. exactly once, on the request that actually creates
 * the workspace row. Not actor-gated: this is system
 * provisioning, not a human action.
 */
export const seedBuiltinPersonas = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<void> => {
 for (const persona of BUILTIN_PERSONAS) {
 await deps.personas.create({
 workspaceId: input.workspaceId,
 name: persona.name,
 description: persona.description,
 markdownSource: persona.markdownSource,
 model: persona.model,
 tools: persona.tools,
 harnessEffort: persona.harnessEffort,
 harnessMaxTurns: persona.harnessMaxTurns,
 harnessAutoApprove: persona.harnessAutoApprove,
 })
 }
}

export const listPersonas = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<AgentPersona[]> => deps.personas.listByWorkspace(input.workspaceId)

export const getPersona = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; personaId: AgentPersonaId },
): Promise<AgentPersona> => {
 const persona = await deps.personas.findById(input.workspaceId, input.personaId)
 if (!persona) throw new NotFoundError('AgentPersona')
 return persona
}

export const updatePersona = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 personaId: AgentPersonaId
 markdownSource: string
 },
): Promise<AgentPersona> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may update a persona')
 }
 const parsed = parsePersonaMarkdown(input.markdownSource)
 return deps.personas.update(input.workspaceId, input.personaId, {
 description: parsed.description,
 markdownSource: input.markdownSource,
 model: parsed.model,
 tools: parsed.tools,
 harnessEffort: parsed.harnessEffort,
 harnessMaxTurns: parsed.harnessMaxTurns,
 harnessAutoApprove: parsed.harnessAutoApprove,
 })
}

/**
 * Validates every member id resolves within the workspace — a group
 * referencing a persona that doesn't exist (typo, deleted persona) is a
 * client error, not a silently-stored dangling reference.
 */
const assertPersonaIdsExist = async (
 deps: AgentDeps,
 workspaceId: WorkspaceId,
 personaIds: string[],
): Promise<void> => {
 for (const id of personaIds) {
 const persona = await deps.personas.findById(workspaceId, id as AgentPersonaId)
 if (!persona) throw new ValidationError(`Persona ${id} does not exist in this workspace`)
 }
}

/** Organizational only — human-only, same reasoning as createPersona. */
export const createPersonaGroup = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; name: string; personaIds: string[] },
): Promise<PersonaGroup> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may create a persona group')
 }
 const existing = await deps.personaGroups.listByWorkspace(input.workspaceId)
 if (existing.some((g) => g.name === input.name)) {
 throw new ValidationError(`Persona group "${input.name}" already exists`)
 }
 await assertPersonaIdsExist(deps, input.workspaceId, input.personaIds)
 return deps.personaGroups.create({
 workspaceId: input.workspaceId,
 name: input.name,
 personaIds: input.personaIds,
 })
}

export const listPersonaGroups = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<PersonaGroup[]> => deps.personaGroups.listByWorkspace(input.workspaceId)

export const updatePersonaGroup = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 personaGroupId: PersonaGroupId
 name: string
 personaIds: string[]
 },
): Promise<PersonaGroup> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may update a persona group')
 }
 await assertPersonaIdsExist(deps, input.workspaceId, input.personaIds)
 return deps.personaGroups.update(input.workspaceId, input.personaGroupId, {
 name: input.name,
 personaIds: input.personaIds,
 })
}

export const deletePersonaGroup = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; personaGroupId: PersonaGroupId },
): Promise<void> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may delete a persona group')
 }
 await deps.personaGroups.delete(input.workspaceId, input.personaGroupId)
}

export const listRepositories = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<Repository[]> => deps.repositories.listByWorkspace(input.workspaceId)

/** What a real client needs to render an approval card and call decideApproval with a real id. */
export const listPendingApprovals = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId },
): Promise<ApprovalRequest[]> => deps.approvals.listPendingByRun(input.workspaceId, input.agentRunId)

export const getAgentRun = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId },
): Promise<AgentRun> => {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')
 return run
}

/**
 * Lets a client resume watching whatever run is already active, on load —
 * without this, a page reload during a run leaves no path back to its
 * approval card until the run happens to finish (found live during
 * The persona model verification).
 */
export const getActiveAgentRun = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<AgentRun | null> => deps.agentRuns.findActiveByWorkspace(input.workspaceId)

/**
 * Starts one agent run against a bound repository's working copy. The
 * persona is looked up by id and denormalized into a frozen `PersonaSpec`
 * snapshot on the run — the run must keep executing with the persona as it
 * was at start time even if the stored persona is edited later.
 */
export const startAgentRun = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 threadId: ThreadId
 repositoryId: RepositoryId
 personaId: AgentPersonaId
 /** What a human asked for via `@mention`; absent for the sidebar-picker path. */
 task?: string
 },
): Promise<AgentRun> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may start an agent run')
 }

 // Kill switch — checked before anything is
 // written, so a paused workspace leaves no half-created run behind.
 const control = await deps.runControl.get(input.workspaceId)
 if (control.paused) {
 throw new ValidationError('Agent runs are paused for this workspace — resume them first')
 }

 // Single-active-run limit, preserved not lifted: a
 // second mention while a run is active must error clearly, never silently
 // replace what's being watched.
 const active = await deps.agentRuns.findActiveByWorkspace(input.workspaceId)
 if (active) {
 throw new ValidationError('An agent run is already active in this workspace — wait for it to finish first')
 }

 const thread = await deps.threads.findById(input.workspaceId, input.threadId)
 if (!thread) throw new NotFoundError('Thread')

 const repository = await deps.repositories.findById(input.workspaceId, input.repositoryId)
 if (!repository) throw new NotFoundError('Repository')

 const runner = await deps.runners.findById(input.workspaceId, repository.runnerId)
 if (!runner) throw new NotFoundError('Runner')
 if (!runner.connected) throw new ValidationError('Runner is not currently connected')

 const persona = await deps.personas.findById(input.workspaceId, input.personaId)
 if (!persona) throw new NotFoundError('AgentPersona')

 const personaSpec: PersonaSpec = {
 name: persona.name,
 systemPrompt: parsePersonaMarkdown(persona.markdownSource).systemPrompt,
 model: persona.model,
 tools: persona.tools,
 autoApprove: persona.harnessAutoApprove,
 }

 const run = await deps.agentRuns.create({
 workspaceId: input.workspaceId,
 threadId: input.threadId,
 repositoryId: input.repositoryId,
 runnerId: repository.runnerId,
 persona: personaSpec,
 })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'agent_run.started',
 subjectType: 'agent_run',
 subjectId: run.id,
 metadata: { repositoryId: repository.id, personaId: persona.id, model: personaSpec.model },
 })

 try {
 await deps.dispatch.startRun({
 runnerId: repository.runnerId,
 runId: run.id,
 persona: personaSpec,
 cwd: repository.absolutePath,
 defaultBranch: repository.defaultBranch,
...(input.task === undefined ? {}: { task: input.task }),
 })
 } catch (error) {
 const errorMessage = error instanceof Error ? error.message: String(error)
 const failed = await deps.agentRuns.updateStatus(input.workspaceId, run.id, {
 status: 'failed',
 errorMessage,
 })

 // Every other failure mode posts a visible system message (run_failed,
 // approval needed,...) — a dispatch failure (e.g. Runner disconnected)
 // was the one silent exception, leaving no trace a human could see.
 const message = await deps.messages.append({
 workspaceId: input.workspaceId,
 threadId: input.threadId,
 author: systemActor,
 body: { kind: 'system', text: `Run failed to start: ${errorMessage}` },
 })
 await deps.events.publish({
 type: 'message.created',
 workspaceId: input.workspaceId,
 threadId: input.threadId,
 message,
 })

 return failed
 }

 return deps.agentRuns.updateStatus(input.workspaceId, run.id, { status: 'running' })
}

/**
 * Called by runner-gateway.ts when the Runner reports its clone is ready
 * — a distinct event from any status transition, since the
 * run may still be `pending`/`running` when this arrives.
 */
export const recordRunWorkspace = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 clonePath: string
 branchName: string
 },
): Promise<AgentRun> =>
 deps.agentRuns.recordWorkspace(input.workspaceId, input.agentRunId, {
 clonePath: input.clonePath,
 branchName: input.branchName,
 })

/** Called by runner-gateway.ts on every `heartbeat` frame. */
export const recordRunHeartbeat = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId },
): Promise<void> => deps.agentRuns.recordHeartbeat(input.workspaceId, input.agentRunId)

/** Backs the Inbox view — runs a human hasn't finished with yet. */
export const listRunsNeedingAttention = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<AgentRun[]> => deps.agentRuns.listNeedsAttention(input.workspaceId)

/** Asks the Runner for the run's branch diff on demand, for end-of-run review. */
export const getAgentRunDiff = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId },
): Promise<string> => {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')
 if (!run.clonePath) {
 throw new ValidationError('Run has no workspace yet — it may still be starting')
 }

 const result = await deps.dispatch.getDiff({ runnerId: run.runnerId, runId: run.id })
 if (!result.ok) throw new ValidationError(result.error)
 return result.diff
}

const TERMINAL_RUN_STATUSES: readonly AgentRunStatus[] = ['completed', 'failed', 'cancelled']

const requireDisposableRun = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; agentRunId: AgentRunId },
): Promise<AgentRun> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError("Only a human may decide a run's branch disposition")
 }
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')
 if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
 throw new ValidationError('Run must finish before its branch can be kept or discarded')
 }
 if (run.branchDisposition) {
 throw new ValidationError(`Run's branch was already ${run.branchDisposition}`)
 }
 return run
}

const postRunSystemMessage = async (
 deps: AgentDeps,
 run: AgentRun,
 text: string,
): Promise<void> => {
 const message = await deps.messages.append({
 workspaceId: run.workspaceId,
 threadId: run.threadId,
 author: systemActor,
 body: { kind: 'system', text },
 })
 await deps.events.publish({
 type: 'message.created',
 workspaceId: run.workspaceId,
 threadId: run.threadId,
 message,
 })
}

export const getRunControl = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<WorkspaceRunControl> => deps.runControl.get(input.workspaceId)

/**
 * Cancels one in-flight run and tells its Runner to abort. Shared by the kill
 * switch and (eventually) any other forced stop. A Runner that can't be reached
 * does not block the cancellation: the run is marked `cancelled` regardless,
 * because a stop that a disconnected Runner could veto is not a stop. Its
 * orphaned process is then the dead-run reaper's problem, not this path's.
 */
const cancelRun = async (deps: AgentDeps, run: AgentRun, reason: string): Promise<void> => {
 try {
 await deps.dispatch.cancelRun({ runnerId: run.runnerId, runId: run.id })
 } catch {
 // Deliberately swallowed — see above.
 }

 // Any gate this run was blocked on is dead too. Left pending it would show up
 // in the Inbox forever, pointing at a run that can never act on the decision.
 const pending = await deps.approvals.listPendingByRun(run.workspaceId, run.id)
 for (const approval of pending) {
 await deps.approvals.resolve(run.workspaceId, approval.id, {
 status: 'denied',
 resolvedByUserId: null,
 })
 }

 const cancelled = await deps.agentRuns.updateStatus(run.workspaceId, run.id, {
 status: 'cancelled',
 errorMessage: reason,
 completedAt: new Date,
 })
 await postRunSystemMessage(deps, cancelled, `Run cancelled: ${reason}.`)
}

/**
 * The global kill switch. Sets the workspace's pause flag *first*, so a run started
 * concurrently with this sweep is rejected by `startAgentRun` rather than
 * slipping in behind it, then cancels everything already in flight.
 */
export const pauseAllRuns = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor },
): Promise<{ control: WorkspaceRunControl; cancelledRunIds: string[] }> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may pause agent runs')
 }
 if (input.actor.kind !== 'user') throw new ForbiddenError('Only a human may pause agent runs')

 const control = await deps.runControl.set(input.workspaceId, {
 paused: true,
 pausedByUserId: input.actor.userId,
 })

 const active = await deps.agentRuns.listActiveByWorkspace(input.workspaceId)
 for (const run of active) {
 await cancelRun(deps, run, 'workspace paused by an operator')
 }

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'workspace.runs_paused',
 subjectType: 'workspace',
 subjectId: input.workspaceId,
 metadata: { cancelledRunIds: active.map((run) => run.id) },
 })

 return { control, cancelledRunIds: active.map((run) => run.id) }
}

/**
 * Lifts the pause. Deliberately does *not* restart anything the pause
 * cancelled — see WorkspaceRunControl's note: an operator who hit the switch
 * wanted the work stopped, and reviving it here would undo that decision on
 * their behalf.
 */
export const resumeAllRuns = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor },
): Promise<WorkspaceRunControl> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may resume agent runs')
 }

 const control = await deps.runControl.set(input.workspaceId, {
 paused: false,
 pausedByUserId: null,
 })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'workspace.runs_resumed',
 subjectType: 'workspace',
 subjectId: input.workspaceId,
 })

 return control
}

/**
 * Keeps a finished run's branch as-is — no push,
 * no host action; "merge" needs the push policy and isn't built yet.
 */
export const keepAgentRun = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; agentRunId: AgentRunId },
): Promise<AgentRun> => {
 const run = await requireDisposableRun(deps, input)
 const updated = await deps.agentRuns.setBranchDisposition(input.workspaceId, run.id, 'kept')
 await postRunSystemMessage(deps, run, `Branch ${run.branchName ?? '(unknown)'} kept.`)
 return updated
}

/**
 * Discards a finished run's branch: the Runner deletes the on-disk clone
 * (skipped if the run never got one — e.g. it failed before cloning).
 */
export const discardAgentRun = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; agentRunId: AgentRunId },
): Promise<AgentRun> => {
 const run = await requireDisposableRun(deps, input)

 if (run.clonePath) {
 const result = await deps.dispatch.discardRun({ runnerId: run.runnerId, runId: run.id })
 if (!result.ok) throw new ValidationError(result.error)
 }

 const updated = await deps.agentRuns.setBranchDisposition(input.workspaceId, run.id, 'discarded')
 await postRunSystemMessage(deps, run, `Branch ${run.branchName ?? '(unknown)'} discarded.`)
 return updated
}

/**
 * Host-side pushes a finished run's branch to the bound repo's `origin` and
 * best-effort opens a PR/MR. Unlike discard, a push failure
 * leaves the run undecided — nothing was mutated, so it must stay retriable
 * (e.g. after fixing a CI-config rejection) rather than getting stuck.
 */
export const pushAgentRun = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 agentRunId: AgentRunId
 acknowledgeCiChange?: boolean
 },
): Promise<AgentRun> => {
 const run = await requireDisposableRun(deps, input)
 if (!run.clonePath) throw new ValidationError('Run has no workspace to push')

 const result = await deps.dispatch.pushRun({
 runnerId: run.runnerId,
 runId: run.id,
 acknowledgeCiChange: input.acknowledgeCiChange ?? false,
 })
 if (!result.ok) throw new ValidationError(result.error)

 const updated = await deps.agentRuns.setBranchDisposition(input.workspaceId, run.id, 'pushed')
 const outcome = result.prUrl
 ? `PR opened: ${result.prUrl}`
: result.compareUrl
 ? `Open a PR: ${result.compareUrl}`
: 'No PR/MR was opened (unrecognized git host).'
 const warning = result.warning ? ` (${result.warning})`: ''
 await postRunSystemMessage(
 deps,
 run,
 `Branch ${run.branchName ?? '(unknown)'} pushed. ${outcome}${warning}`,
)
 return updated
}

/**
 * Dead-run reaper — a periodic sweep, not a
 * request-scoped use-case; called from a `setInterval` in apps/server, never
 * through the contract. Two independent signals, per the own framing
 * ("heartbeat + stuck detection"): a stale heartbeat means the Runner
 * connection/process is gone; a stale `lastEventAt` with a live heartbeat
 * means the Runner is still connected but the agent loop made no progress.
 * Either one is enough to reap. Both fall back to `createdAt` so a run that
 * never got a first heartbeat/event (hung during workspace prep) is still
 * caught.
 */
export const reapStuckRuns = async (
 deps: AgentDeps,
 options: { heartbeatTimeoutMs: number; noProgressTimeoutMs: number },
): Promise<void> => {
 const runs = await deps.agentRuns.listAllActive
 const now = Date.now

 for (const run of runs) {
 const sinceHeartbeat = now - (run.lastHeartbeatAt ?? run.createdAt).getTime
 const sinceEvent = now - (run.lastEventAt ?? run.createdAt).getTime

 const heartbeatStale = sinceHeartbeat > options.heartbeatTimeoutMs
 // A run blocked on a human is not making progress *by design*, so the
 // no-progress signal must not apply to it — otherwise the reaper kills every
 // approval a human takes their time over, and the approval SLA below never
 // gets to run. The heartbeat signal still applies: a dead Runner is dead
 // whatever the run was waiting for.
 const noProgress = run.status !== 'awaiting_approval' && sinceEvent > options.noProgressTimeoutMs
 if (!heartbeatStale && !noProgress) continue

 const reason = heartbeatStale
 ? `no heartbeat for over ${Math.round(options.heartbeatTimeoutMs / 1000)}s`
: `no progress for over ${Math.round(options.noProgressTimeoutMs / 1000)}s`

 const failed = await deps.agentRuns.updateStatus(run.workspaceId, run.id, {
 status: 'failed',
 errorMessage: `Run reaped: ${reason}`,
 completedAt: new Date,
 })
 await postRunSystemMessage(deps, failed, `Run failed: ${reason}.`)
 }
}

/**
 * Approval SLA (the runtime-safety rules: "approval SLA (timeout → auto-deny →
 * resumable)"). A periodic sweep like `reapStuckRuns`, called from the same
 * interval in apps/server and never through the contract.
 *
 * Auto-deny rather than auto-approve, always: an unattended gate is exactly the
 * case where nobody vouched for the call, and the whole point of effect-based classification is that
 * an ungated risky effect is the failure mode. Denying also keeps the run
 * *resumable* — the SDK's canUseTool callback resolves, the model sees a denied
 * tool result, and the loop continues instead of blocking forever.
 *
 * `resolvedByUserId` is null here: no human decided this. That is visible in the
 * row rather than attributed to whoever happened to be logged in.
 */
export const expireStaleApprovals = async (
 deps: AgentDeps,
 options: { approvalSlaMs: number },
): Promise<void> => {
 const pending = await deps.approvals.listAllPending
 const now = Date.now

 for (const approval of pending) {
 if (now - approval.createdAt.getTime <= options.approvalSlaMs) continue

 const run = await deps.agentRuns.findById(approval.workspaceId, approval.agentRunId)
 // A run that is already terminal (reaped, cancelled by the kill switch)
 // has no loop left to unblock — resolve the row so it stops showing up in
 // this sweep and in the Inbox, but don't dispatch or touch the status.
 const runIsLive = run !== null && !TERMINAL_RUN_STATUSES.includes(run.status)

 await deps.approvals.resolve(approval.workspaceId, approval.id, {
 status: 'denied',
 resolvedByUserId: null,
 })

 if (!runIsLive) continue

 try {
 await deps.dispatch.sendApprovalDecision({
 runnerId: run.runnerId,
 toolUseId: approval.toolUseId,
 decision: 'deny',
 })
 } catch {
 // Runner gone: the row is resolved either way, and the run's stale
 // heartbeat is what the dead-run reaper acts on. Swallowing here keeps one
 // unreachable Runner from aborting the sweep for every other workspace.
 }

 await deps.agentRuns.updateStatus(approval.workspaceId, run.id, { status: 'running' })
 await postRunSystemMessage(
 deps,
 run,
 `Approval for ${approval.toolName} auto-denied after ${Math.round(options.approvalSlaMs / 60_000)} min with no decision.`,
)
 }
}

// Tried in order; the first string field present is shown as the call's
// headline target. Full args aren't hidden — they're what a risky call's
// approval card renders verbatim — this is just what makes
// the plain activity line scannable instead of a raw JSON dump.
const PRIMARY_ARG_FIELDS = ['command', 'file_path', 'notebook_path', 'pattern', 'path', 'url', 'query']

const primaryArg = (input: Readonly<Record<string, unknown>>): string | null => {
 for (const field of PRIMARY_ARG_FIELDS) {
 const value = input[field]
 if (typeof value === 'string') return value
 }
 return null
}

const eventToMessageText = (event: AgentEvent): string => {
 switch (event.kind) {
 case 'assistant_text':
 return event.text
 case 'tool_call': {
 const primary = primaryArg(event.input)
 return primary ? `→ ${event.toolName}: ${primary}`: `→ ${event.toolName} ${JSON.stringify(event.input)}`
 }
 case 'tool_result':
 return event.isError
 ? `✗ ${event.summary}`
: `✓ ${event.summary}`
 case 'run_completed':
 return `Run completed ($${event.totalCostUsd.toFixed(4)}): ${event.result}`
 case 'run_failed':
 return `Run failed: ${event.message}`
 }
}

/**
 * Structured-tier ingest — called by
 * apps/server/src/runner-gateway.ts when a Runner pushes an event. Every
 * event is rendered as a message so it's visible in the thread; richer
 * collapsed/condensed tool-call rendering is a UI concern for later, not
 * something this use-case needs to know about.
 */
export const recordAgentEvent = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId; seq: number; event: AgentEvent },
): Promise<void> => {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')

 // Idempotency gate, before any
 // side effect. A retransmitted event — Runner reconnect, a retried delivery —
 // must not append a second copy of the same tool call to the thread, nor
 // re-apply a terminal status transition. The append is the check: the unique
 // (run, seq) index rejects the duplicate and reports it as already ingested.
 const fresh = await deps.agentRunEvents.append({
 workspaceId: input.workspaceId,
 agentRunId: input.agentRunId,
 seq: input.seq,
 kind: input.event.kind,
 payload: input.event as unknown as Record<string, unknown>,
 })
 if (!fresh) return

 // Dead-run reaper input — any event at all counts as progress,
 // distinct from the heartbeat's plain connection-liveness signal.
 await deps.agentRuns.recordEventActivity(input.workspaceId, input.agentRunId)

 const author = input.event.kind === 'run_completed' || input.event.kind === 'run_failed'
 ? systemActor
: agentRunActor(input.agentRunId)

 const message = await deps.messages.append({
 workspaceId: input.workspaceId,
 threadId: run.threadId,
 author,
 body: { kind: author.kind === 'system' ? 'system': 'text', text: eventToMessageText(input.event) },
 })

 await deps.events.publish({
 type: 'message.created',
 workspaceId: input.workspaceId,
 threadId: run.threadId,
 message,
 })

 if (input.event.kind === 'run_completed') {
 await deps.agentRuns.updateStatus(input.workspaceId, input.agentRunId, {
 status: 'completed',
 totalCostUsd: input.event.totalCostUsd,
 completedAt: new Date,
 })
 } else if (input.event.kind === 'run_failed') {
 await deps.agentRuns.updateStatus(input.workspaceId, input.agentRunId, {
 status: 'failed',
 errorMessage: input.event.message,
 completedAt: new Date,
 })
 }
}

/**
 * Called by runner-gateway.ts when the Runner's canUseTool callback fires for
 * a risky tool. Persists the request and posts a visible card into the
 * thread; the human resolves it via decideApproval below — never here.
 */
export const requestApproval = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 toolUseId: string
 toolName: string
 input: Record<string, unknown>
 },
): Promise<ApprovalRequest> => {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')

 const approval = await deps.approvals.create({
 workspaceId: input.workspaceId,
 agentRunId: input.agentRunId,
 toolUseId: input.toolUseId,
 toolName: input.toolName,
 input: input.input,
 })

 await deps.agentRuns.updateStatus(input.workspaceId, input.agentRunId, {
 status: 'awaiting_approval',
 })

 // This chat line is just a pointer — the exact argv, never a
 // model-authored summary, renders in the approval card
 // itself (ApprovalCard.vue), which is where a human actually decides.
 // Dumping the raw payload and internal id here too would just be noise.
 const message = await deps.messages.append({
 workspaceId: input.workspaceId,
 threadId: run.threadId,
 author: systemActor,
 body: {
 kind: 'system',
 text: `Approval needed for ${input.toolName} — see the approval card below.`,
 },
 })

 await deps.events.publish({
 type: 'message.created',
 workspaceId: input.workspaceId,
 threadId: run.threadId,
 message,
 })

 return approval
}

/**
 * Hard rule: only a human actor may resolve an approval. An
 * agent-authored message can never open this gate — that is the entire fix
 * for the forgery flaw the security review found.
 */
export const decideApproval = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 approvalRequestId: ApprovalRequestId
 decision: 'approve' | 'deny'
 },
): Promise<ApprovalRequest> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may resolve an approval request')
 }

 const approval = await deps.approvals.findById(input.workspaceId, input.approvalRequestId)
 if (!approval) throw new NotFoundError('ApprovalRequest')
 if (approval.status !== 'pending') {
 throw new ValidationError('Approval request has already been resolved')
 }

 const run = await deps.agentRuns.findById(input.workspaceId, approval.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')

 // isHuman above already guarantees this, but TS can't narrow across the
 // function call — asserting explicitly rather than casting.
 if (input.actor.kind !== 'user') throw new ForbiddenError('Only a human may resolve an approval request')

 const resolved = await deps.approvals.resolve(input.workspaceId, input.approvalRequestId, {
 status: input.decision === 'approve' ? 'approved': 'denied',
 resolvedByUserId: input.actor.userId,
 })

 await deps.dispatch.sendApprovalDecision({
 runnerId: run.runnerId,
 toolUseId: approval.toolUseId,
 decision: input.decision === 'approve' ? 'allow': 'deny',
 })

 await deps.agentRuns.updateStatus(input.workspaceId, run.id, { status: 'running' })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: `approval_request.${input.decision}d`,
 subjectType: 'approval_request',
 subjectId: approval.id,
 metadata: { toolName: approval.toolName },
 })

 return resolved
}

export { isRiskyTool }
