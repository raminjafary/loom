import {
  BUILTIN_PERSONAS,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  agentRunActor,
  attenuateChildPersona,
  buildNotification,
  describeMergeFailure,
  isHuman,
  isMergeQueueEntryTerminal,
  isRiskyTool,
  parsePersonaMarkdown,
  selectNextMergeEntry,
  systemActor,
  type Actor,
  type AgentEvent,
  type AgentPersona,
  type AgentPersonaId,
  type AgentRun,
  type AgentRunId,
  type AgentRunRelation,
  type AgentRunStatus,
  type ApprovalRequest,
  type ApprovalRequestId,
  type MergeFailureReason,
  type MergeQueueEntry,
  type MergeQueueEntryId,
  type NotificationKind,
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
  MergeQueueRepositoryPort,
  PersonaGroupRepositoryPort,
  PersonaRepositoryPort,
  RepositoryRepositoryPort,
  RunDispatchPort,
  RunnerRepositoryPort,
  WorkspaceRunControlRepositoryPort,
} from './agent-ports.js'
import type { NotificationDeps } from './notification-use-cases.js'
import type { Deps } from './use-cases.js'

export interface AgentDeps extends Deps, NotificationDeps {
  readonly runners: RunnerRepositoryPort
  readonly repositories: RepositoryRepositoryPort
  readonly agentRuns: AgentRunRepositoryPort
  readonly agentRunEvents: AgentRunEventRepositoryPort
  readonly approvals: ApprovalRepositoryPort
  readonly mergeQueue: MergeQueueRepositoryPort
  readonly personas: PersonaRepositoryPort
  readonly personaGroups: PersonaGroupRepositoryPort
  readonly runControl: WorkspaceRunControlRepositoryPort
  readonly dispatch: RunDispatchPort
  readonly limits: RunLimits
}

/**
 * Policy values, not infrastructure — hence a plain object in deps rather than a
 * port. They are here rather than read from the environment inside a use-case so
 * that the application layer keeps knowing nothing about `process.env`, and a test
 * can set them without touching the environment.
 */
export interface RunLimits {
  /**
   * How many runs may be non-terminal in one workspace at once (PLAN.md §7 Phase 2).
   * Phase 1's hard limit of one is just this set to 1.
   */
  readonly maxConcurrentRunsPerWorkspace: number
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
 * Phase 1 scope cut (PLAN.md §5a): binds an existing repo by absolute path on
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
    harnessBudgetCapUsd: parsed.harnessBudgetCapUsd,
  })
}

/**
 * Called from apps/server/src/app.ts only when `ensureWorkspace` reports
 * `created: true` — i.e. exactly once, on the request that actually creates
 * the workspace row (PLAN.md §3a). Not actor-gated: this is system
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
      harnessBudgetCapUsd: persona.harnessBudgetCapUsd,
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
    harnessBudgetCapUsd: parsed.harnessBudgetCapUsd,
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

/** Organizational only (PLAN.md §3a) — human-only, same reasoning as createPersona. */
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
 * approval card until the run happens to finish (found live during PLAN.md
 * §3a verification).
 *
 * Kept alongside `listActiveAgentRuns` now that a workspace may have several:
 * this answers "which one should I show by default", which is still a question a
 * client asks on load.
 */
export const getActiveAgentRun = (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId },
): Promise<AgentRun | null> => deps.agentRuns.findActiveByWorkspace(input.workspaceId)

/**
 * Every run currently executing in the workspace (PLAN.md §7 Phase 2). Distinct
 * from the Inbox's `listNeedsAttention`, which answers "what is blocked on me" —
 * this answers "what is running", and with concurrency those diverge.
 */
export const listActiveAgentRuns = (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId },
): Promise<AgentRun[]> => deps.agentRuns.listActiveByWorkspace(input.workspaceId)

/** One run's children (PLAN.md §5) — what the Phase 2 tree view is drawn from. */
export const listChildAgentRuns = (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId; agentRunId: AgentRunId },
): Promise<AgentRun[]> => deps.agentRuns.listByParent(input.workspaceId, input.agentRunId)

/**
 * Starts one agent run against a bound repository's working copy. The
 * persona is looked up by id and denormalized into a frozen `PersonaSpec`
 * snapshot on the run — the run must keep executing with the persona as it
 * was at start time even if the stored persona is edited later.
 *
 * `parentRunId` makes this a child run (PLAN.md §5, Phase 2). Two things then
 * apply that do not for a human-started run: the child's capabilities are
 * attenuated against its parent's, and the actor may be the parent run rather
 * than a human — which is the whole point of a Planner, and is safe *only*
 * because of that attenuation.
 */
export const startAgentRun = async (
  deps: AgentDeps,
  input: {
    workspaceId: WorkspaceId
    actor: Actor
    threadId: ThreadId
    repositoryId: RepositoryId
    personaId: AgentPersonaId
    /** What a human asked for via `@mention` (PLAN.md §3a); absent for the sidebar-picker path. */
    task?: string
    /** Set when one run spawns another (PLAN.md §5). */
    parentRunId?: AgentRunId
    relation?: AgentRunRelation
  },
): Promise<AgentRun> => {
  const parent = input.parentRunId
    ? await deps.agentRuns.findById(input.workspaceId, input.parentRunId)
    : null
  if (input.parentRunId && !parent) throw new NotFoundError('Parent AgentRun')

  // A human may always start a run. An agent run may start one *only* as a child
  // of itself — anything else would let a run manufacture work outside the tree
  // that attenuation is defined over, which is the same forgery surface §6 A1
  // closes for approvals.
  if (!isHuman(input.actor)) {
    if (input.actor.kind !== 'agent_run' || parent === null) {
      throw new ForbiddenError('Only a human may start an agent run')
    }
    if (input.actor.agentRunId !== parent.id) {
      throw new ForbiddenError('An agent run may only spawn children of itself')
    }
  }

  // Kill switch (PLAN.md §6 runtime safety) — checked before anything is
  // written, so a paused workspace leaves no half-created run behind. Applies to
  // child runs too: a pause that a Planner could spawn its way around is not a
  // pause.
  const control = await deps.runControl.get(input.workspaceId)
  if (control.paused) {
    throw new ValidationError('Agent runs are paused for this workspace — resume them first')
  }

  // Concurrency limit (PLAN.md §7 Phase 2 — swarm). Phase 1 allowed exactly one
  // active run workspace-wide; a swarm is N workers on one goal, so the limit is
  // now a number rather than a special case. It is still a *limit*: unbounded
  // concurrency multiplies both spend and the human attention §11 is about, and a
  // Planner that can spawn without bound is how a runaway loop gets expensive.
  const active = await deps.agentRuns.listActiveByWorkspace(input.workspaceId)
  if (active.length >= deps.limits.maxConcurrentRunsPerWorkspace) {
    throw new ValidationError(
      `This workspace already has ${active.length} active run(s), its configured maximum — wait for one to finish first`,
    )
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
    budgetCapUsd: persona.harnessBudgetCapUsd,
  }

  // Capability attenuation (PLAN.md §5). Checked against the parent's *snapshot*,
  // not its stored persona: the snapshot is what the parent is actually running
  // with, and editing a persona mid-run must not widen what its children may ask
  // for.
  if (parent) {
    const verdict = attenuateChildPersona(parent.persona, personaSpec)
    if (!verdict.ok) throw new ValidationError(verdict.reason)
  }

  const run = await deps.agentRuns.create({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    repositoryId: input.repositoryId,
    runnerId: repository.runnerId,
    persona: personaSpec,
    ...(parent ? { parentRunId: parent.id, relation: input.relation ?? 'delegation' } : {}),
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
      ...(input.task === undefined ? {} : { task: input.task }),
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const failed = await deps.agentRuns.updateStatus(input.workspaceId, run.id, {
      status: 'failed',
      errorMessage,
    })

    // Every other failure mode posts a visible system message (run_failed,
    // approval needed, ...) — a dispatch failure (e.g. Runner disconnected)
    // was the one silent exception, leaving no trace a human could see.
    const message = await deps.messages.append({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      author: systemActor(),
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
 * (PLAN.md §5a) — a distinct event from any status transition, since the
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

/**
 * Called by runner-gateway.ts on every `cost_report` frame — spend the egress
 * proxy metered and the Runner relayed (PLAN.md §6 A6, §9).
 *
 * This overwrites whatever the SDK later self-reports in `run_completed`, which
 * is the intent: A6's point is that a run's own account of what it cost is not
 * the number to bill or to enforce a cap against. The proxy saw the requests.
 */
export const recordRunCost = async (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId; agentRunId: AgentRunId; spentUsd: number },
): Promise<void> => deps.agentRuns.recordCost(input.workspaceId, input.agentRunId, input.spentUsd)

/**
 * Reconciles a Runner's in-flight runs when it (re)connects (PLAN.md §7 Phase 1, "run
 * resumption after Runner restart").
 *
 * Two outcomes per non-terminal run assigned to that Runner:
 *
 * - The Runner still holds state for it → resumable. Returned so the gateway can send
 *   `resume_run` with the server's highest ingested event seq.
 * - The Runner does not → the work is gone. Failed immediately with a clear reason,
 *   rather than left for the dead-run reaper to kill minutes later with a generic
 *   "no heartbeat" message. Same end state, far better explanation, and the Inbox stops
 *   showing a run nobody is working on.
 *
 * Runs whose Runner never reconnects are still the reaper's job; this only knows about
 * the Runner in front of it.
 */
export const reconcileRunnerRuns = async (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId; runnerId: RunnerId; resumableRunIds: readonly string[] },
): Promise<{ resumable: { runId: AgentRunId; fromEventSeq: number }[] }> => {
  const active = await deps.agentRuns.listActiveByWorkspace(input.workspaceId)
  const resumable: { runId: AgentRunId; fromEventSeq: number }[] = []

  for (const run of active) {
    if (run.runnerId !== input.runnerId) continue

    if (input.resumableRunIds.includes(run.id)) {
      const fromEventSeq = await deps.agentRunEvents.highestSeq(input.workspaceId, run.id)
      resumable.push({ runId: run.id, fromEventSeq })
      continue
    }

    const failed = await deps.agentRuns.updateStatus(input.workspaceId, run.id, {
      status: 'failed',
      errorMessage: 'Runner reconnected without this run — its workspace state was lost',
      completedAt: new Date(),
    })
    await postRunSystemMessage(
      deps,
      failed,
      'Run interrupted: the Runner restarted and could not recover this run.',
    )
  }

  return { resumable }
}

/** Called by runner-gateway.ts on every `heartbeat` frame (PLAN.md §6 dead-run reaper). */
export const recordRunHeartbeat = async (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId; agentRunId: AgentRunId },
): Promise<void> => deps.agentRuns.recordHeartbeat(input.workspaceId, input.agentRunId)

/** Backs the Inbox view (PLAN.md §3) — runs a human hasn't finished with yet. */
export const listRunsNeedingAttention = (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId },
): Promise<AgentRun[]> => deps.agentRuns.listNeedsAttention(input.workspaceId)

/** Asks the Runner for the run's branch diff on demand, for end-of-run review (PLAN.md §5a). */
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
  // A branch waiting in the merge queue is spoken for. Without this, discarding it
  // would delete the clone the queue is about to rebase, and queueing it twice
  // would ask the queue to merge the same commits into a branch that already has
  // them. The database's partial unique index blocks the second case regardless;
  // this is what turns that into an explanation rather than a constraint error.
  const open = (await deps.mergeQueue.listByRepository(input.workspaceId, run.repositoryId)).filter(
    (entry) => entry.agentRunId === run.id && !isMergeQueueEntryTerminal(entry.status),
  )
  if (open.length > 0) {
    throw new ValidationError(
      `Run's branch is already ${open[0]?.status === 'merging' ? 'being merged' : 'queued for merge'}`,
    )
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
    author: systemActor(),
    body: { kind: 'system', text },
  })
  await deps.events.publish({
    type: 'message.created',
    workspaceId: run.workspaceId,
    threadId: run.threadId,
    message,
  })
}

/**
 * Tells a human who is *not looking* that a run needs them (PLAN.md §3's
 * retention hook, §7's "is notified when it needs them"). Every visible
 * transition already posts a thread message via `postRunSystemMessage`; that
 * message is only seen by someone watching, and the whole point of §3's
 * correction is that nobody watches for long.
 *
 * Failures are swallowed, deliberately: a run must not stay stuck in
 * `awaiting_approval` because a push service was unreachable, and the human's
 * fallback — the Inbox — is unaffected either way. The adapter logs; this layer
 * has nothing to log with.
 */
const notifyRun = async (
  deps: AgentDeps,
  run: AgentRun,
  kind: NotificationKind,
  extra: { toolName?: string; detail?: string } = {},
): Promise<void> => {
  try {
    await deps.notifications.deliver(
      buildNotification({
        workspaceId: run.workspaceId,
        runId: run.id,
        kind,
        personaName: run.persona.name,
        branchName: run.branchName,
        totalCostUsd: run.totalCostUsd,
        ...extra,
      }),
    )
  } catch {
    // See above — best-effort by design.
  }
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
    completedAt: new Date(),
  })
  await postRunSystemMessage(deps, cancelled, `Run cancelled: ${reason}.`)
  // No notification here on purpose: every path into this function is a human
  // deliberately stopping the work (the kill switch), and pushing "your run
  // stopped" back at the person who just stopped it trains people to ignore
  // notifications. Same reasoning for a failed `startAgentRun` dispatch — they
  // are looking at the error already.
}

/**
 * The global kill switch (PLAN.md §6 runtime safety: "One button. Nothing had
 * one."). Sets the workspace's pause flag *first*, so a run started
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
 * Keeps a finished run's branch as-is (PLAN.md §7 ship criterion) — no push,
 * no host action; "merge" needs §6 A2's push policy and isn't built yet.
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
 * best-effort opens a PR/MR (PLAN.md §6 A2). Unlike discard, a push failure
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
  const warning = result.warning ? ` (${result.warning})` : ''
  await postRunSystemMessage(
    deps,
    run,
    `Branch ${run.branchName ?? '(unknown)'} pushed. ${outcome}${warning}`,
  )
  return updated
}

/**
 * Sets what the merge queue runs before merging a branch into this repository
 * (PLAN.md §7 Phase 2's "run tests"). Human-only, same reasoning as
 * `bindRepository`: it is administrative configuration, and — since the command
 * executes against an agent's branch — it is also a security-relevant setting no
 * run should be able to change about itself.
 *
 * Empty is normalized to null so "  " and "not configured" cannot mean different
 * things to `planMergeVerification`.
 */
export const setRepositoryVerifyCommand = async (
  deps: AgentDeps,
  input: {
    workspaceId: WorkspaceId
    actor: Actor
    repositoryId: RepositoryId
    verifyCommand: string | null
  },
): Promise<Repository> => {
  if (!isHuman(input.actor)) {
    throw new ForbiddenError("Only a human may change a repository's verification command")
  }
  const repository = await deps.repositories.findById(input.workspaceId, input.repositoryId)
  if (!repository) throw new NotFoundError('Repository')

  const normalized = input.verifyCommand?.trim()
  const updated = await deps.repositories.setVerifyCommand(
    input.workspaceId,
    input.repositoryId,
    normalized && normalized.length > 0 ? normalized : null,
  )

  await deps.audit.record({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'repository.verify_command_set',
    subjectType: 'repository',
    subjectId: repository.id,
    metadata: { configured: updated.verifyCommand !== null },
  })

  return updated
}

/**
 * Queues a finished run's branch for merge into its repository's default branch
 * (PLAN.md §7 Phase 2's serialized merge queue, §5a's "merge" case).
 *
 * Queueing is all this does. The merge itself happens in `advanceMergeQueue`, one
 * repository-entry at a time — which is the entire point: "sibling branches
 * converge through the merge queue, not a race" (§5a), and a merge that ran
 * immediately on click would be exactly the race.
 *
 * Human-only and terminal-only, same gate as keep/discard/push.
 */
export const enqueueMergeRun = async (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId; actor: Actor; agentRunId: AgentRunId },
): Promise<MergeQueueEntry> => {
  const run = await requireDisposableRun(deps, input)
  if (!run.branchName) throw new ValidationError('Run has no branch to merge')
  if (!run.clonePath) throw new ValidationError('Run has no workspace to merge from')

  const entry = await deps.mergeQueue.enqueue({
    workspaceId: input.workspaceId,
    repositoryId: run.repositoryId,
    agentRunId: run.id,
    branchName: run.branchName,
    enqueuedByUserId: input.actor.kind === 'user' ? input.actor.userId : null,
  })

  await deps.audit.record({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'merge_queue.enqueued',
    subjectType: 'merge_queue_entry',
    subjectId: entry.id,
    metadata: { agentRunId: run.id, branchName: run.branchName },
  })

  await postRunSystemMessage(deps, run, `${run.branchName} queued for merge.`)
  return entry
}

export const listMergeQueue = (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId },
): Promise<MergeQueueEntry[]> => deps.mergeQueue.listByWorkspace(input.workspaceId)

/**
 * Removes an entry a human queued but no longer wants merged. Only while it is
 * still `queued`: once it is `merging` a rebase is in flight on the Runner, and
 * cancelling the row would leave the queue's state disagreeing with the repository's.
 */
export const cancelMergeQueueEntry = async (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId; actor: Actor; entryId: MergeQueueEntryId },
): Promise<MergeQueueEntry> => {
  if (!isHuman(input.actor)) {
    throw new ForbiddenError('Only a human may cancel a queued merge')
  }
  const entry = await deps.mergeQueue.findById(input.workspaceId, input.entryId)
  if (!entry) throw new NotFoundError('MergeQueueEntry')
  if (entry.status === 'merging') {
    throw new ValidationError('This merge is already running and cannot be cancelled')
  }
  if (isMergeQueueEntryTerminal(entry.status)) {
    throw new ValidationError(`This merge is already ${entry.status}`)
  }

  const cancelled = await deps.mergeQueue.finish(input.workspaceId, entry.id, {
    status: 'cancelled',
  })
  if (!cancelled) throw new ValidationError('This merge was resolved before it could be cancelled')
  await deps.audit.record({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'merge_queue.cancelled',
    subjectType: 'merge_queue_entry',
    subjectId: entry.id,
  })
  return cancelled
}

/**
 * Merges one claimed entry. Every exit finishes the entry — a `merging` row left
 * behind would wedge that repository's queue permanently, since the unique partial
 * index means nothing else can claim while it stands.
 */
const runMergeEntry = async (deps: AgentDeps, entry: MergeQueueEntry): Promise<void> => {
  const fail = async (reason: MergeFailureReason, detail: string, run: AgentRun | null) => {
    const finished = await deps.mergeQueue.finish(entry.workspaceId, entry.id, {
      status: 'failed',
      failureReason: reason,
      detail,
    })
    // Null means this entry was already resolved — the stuck check abandoned it
    // while the Runner was still working. It has already had its say in the
    // thread; saying it again from here would just contradict the timestamps.
    if (!finished || !run) return
    // The branch goes back to its owning run (§7): its disposition stays unset, so
    // the human can fix and re-queue, push, or discard it.
    await postRunSystemMessage(deps, run, describeMergeFailure(reason, entry.branchName, detail))
    await notifyRun(deps, run, 'merge_failed', {
      detail: describeMergeFailure(reason, entry.branchName, null),
    })
  }

  const run = await deps.agentRuns.findById(entry.workspaceId, entry.agentRunId)
  if (!run) {
    await deps.mergeQueue.finish(entry.workspaceId, entry.id, {
      status: 'failed',
      failureReason: 'runner_error',
      detail: 'the run this entry belongs to no longer exists',
    })
    return
  }

  const repository = await deps.repositories.findById(entry.workspaceId, entry.repositoryId)
  if (!repository) {
    await fail('runner_error', 'the repository this entry belongs to no longer exists', run)
    return
  }

  let result: Awaited<ReturnType<RunDispatchPort['mergeRun']>>
  try {
    result = await deps.dispatch.mergeRun({
      runnerId: run.runnerId,
      runId: run.id,
      verifyCommand: repository.verifyCommand,
    })
  } catch (error) {
    // A disconnected or unresponsive Runner is a failed *attempt*, not a lost
    // entry — the human is told, and re-queueing is one click.
    await fail('runner_error', error instanceof Error ? error.message : String(error), run)
    return
  }

  if (!result.ok) {
    await fail(result.reason, result.detail, run)
    return
  }

  const merged = await deps.mergeQueue.finish(entry.workspaceId, entry.id, {
    status: 'merged',
    mergedCommitSha: result.commitSha,
    verified: result.verified,
  })
  // A late success must not overwrite an entry already reported as abandoned, and
  // must not set a disposition on a branch the human was told is theirs again.
  if (!merged) return
  await deps.agentRuns.setBranchDisposition(entry.workspaceId, run.id, 'merged')

  // Says outright when nothing verified the merge. A queue that reports "merged"
  // identically whether or not tests ran would make the distinction invisible at
  // exactly the moment it matters.
  const verification = result.verified
    ? 'verified'
    : `unverified — ${result.note ?? 'no verification ran'}`
  await postRunSystemMessage(
    deps,
    run,
    `${entry.branchName} merged into ${repository.defaultBranch} as ${result.commitSha.slice(0, 8)} (${verification}).`,
  )
  await notifyRun(deps, run, 'merge_succeeded', {
    detail: `Merged into ${repository.defaultBranch} (${verification}).`,
  })
}

/**
 * Advances every repository's merge queue by at most one entry (PLAN.md §7 Phase
 * 2). A periodic sweep like `reapStuckRuns`, called from the same interval in
 * apps/server and never through the contract.
 *
 * Serial *per repository*, concurrent *across* them: two repositories share no
 * target branch, so making one wait on the other's test suite would be a queue
 * that is slow for no safety reason. Within a repository, `selectNextMergeEntry`
 * returns nothing while one is in flight, and the database's unique partial index
 * is what makes that true rather than merely intended.
 *
 * Overlapping ticks are expected and safe: a merge can take as long as a test
 * suite, so later ticks will run while an earlier one is still merging. They find
 * the entry already `merging` and do nothing.
 */
export const advanceMergeQueue = async (
  deps: AgentDeps,
  options: { mergeStuckMs: number },
): Promise<void> => {
  const open = await deps.mergeQueue.listAllOpen()

  // An entry left `merging` by a server that died mid-merge would block its
  // repository forever — nothing else can claim while the unique index holds. Same
  // shape of problem, and the same answer, as the dead-run reaper.
  const now = Date.now()
  for (const entry of open) {
    if (entry.status !== 'merging') continue
    const startedAt = (entry.startedAt ?? entry.createdAt).getTime()
    if (now - startedAt <= options.mergeStuckMs) continue

    const run = await deps.agentRuns.findById(entry.workspaceId, entry.agentRunId)
    await deps.mergeQueue.finish(entry.workspaceId, entry.id, {
      status: 'failed',
      failureReason: 'runner_error',
      detail: `merge abandoned after ${Math.round(options.mergeStuckMs / 60_000)} min with no result`,
    })
    if (run) {
      await postRunSystemMessage(
        deps,
        run,
        `${entry.branchName} was not merged: the merge did not finish and was abandoned.`,
      )
    }
  }

  const byRepository = new Map<string, MergeQueueEntry[]>()
  for (const entry of await deps.mergeQueue.listAllOpen()) {
    const bucket = byRepository.get(entry.repositoryId)
    if (bucket) bucket.push(entry)
    else byRepository.set(entry.repositoryId, [entry])
  }

  await Promise.all(
    [...byRepository.values()].map(async (entries) => {
      const next = selectNextMergeEntry(entries)
      if (!next) return

      // Null means another sweep claimed it first — the serialization working, not
      // an error. Nothing to do this tick.
      const claimed = await deps.mergeQueue.claim(next.workspaceId, next.id)
      if (!claimed) return

      await runMergeEntry(deps, claimed)
    }),
  )
}

/**
 * Dead-run reaper (PLAN.md §6 runtime safety) — a periodic sweep, not a
 * request-scoped use-case; called from a `setInterval` in apps/server, never
 * through the contract. Two independent signals, per PLAN.md's own framing
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
  const runs = await deps.agentRuns.listAllActive()
  const now = Date.now()

  for (const run of runs) {
    const sinceHeartbeat = now - (run.lastHeartbeatAt ?? run.createdAt).getTime()
    const sinceEvent = now - (run.lastEventAt ?? run.createdAt).getTime()

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
      completedAt: new Date(),
    })
    await postRunSystemMessage(deps, failed, `Run failed: ${reason}.`)
    // A reaped run is the case least likely to be noticed: it produced no
    // terminal event of its own, so a watcher sees the thread simply stop.
    await notifyRun(deps, failed, 'run_failed', { detail: reason })
  }
}

/**
 * Approval SLA (PLAN.md §6 runtime safety: "approval SLA (timeout → auto-deny →
 * resumable)"). A periodic sweep like `reapStuckRuns`, called from the same
 * interval in apps/server and never through the contract.
 *
 * Auto-deny rather than auto-approve, always: an unattended gate is exactly the
 * case where nobody vouched for the call, and the whole point of §6 A3 is that
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
  const pending = await deps.approvals.listAllPending()
  const now = Date.now()

  for (const approval of pending) {
    if (now - approval.createdAt.getTime() <= options.approvalSlaMs) continue

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
    // Worth saying out loud rather than only in the thread: the human's window
    // to decide closed, and the run went on with the call denied.
    await notifyRun(deps, run, 'approval_expired', { toolName: approval.toolName })
  }
}

// Tried in order; the first string field present is shown as the call's
// headline target. Full args aren't hidden — they're what a risky call's
// approval card renders verbatim (PLAN.md §6 A3) — this is just what makes
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
      return primary ? `→ ${event.toolName}: ${primary}` : `→ ${event.toolName} ${JSON.stringify(event.input)}`
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
 * Structured-tier ingest (PLAN.md §4d-bis) — called by
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

  // Idempotency gate (PLAN.md §6 "idempotency keys on run steps"), before any
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

  // Dead-run reaper input (PLAN.md §6) — any event at all counts as progress,
  // distinct from the heartbeat's plain connection-liveness signal.
  await deps.agentRuns.recordEventActivity(input.workspaceId, input.agentRunId)

  const author = input.event.kind === 'run_completed' || input.event.kind === 'run_failed'
    ? systemActor()
    : agentRunActor(input.agentRunId)

  const message = await deps.messages.append({
    workspaceId: input.workspaceId,
    threadId: run.threadId,
    author,
    body: { kind: author.kind === 'system' ? 'system' : 'text', text: eventToMessageText(input.event) },
  })

  await deps.events.publish({
    type: 'message.created',
    workspaceId: input.workspaceId,
    threadId: run.threadId,
    message,
  })

  if (input.event.kind === 'run_completed') {
    // The SDK's self-reported cost is a fallback, not the truth (PLAN.md §6 A6).
    // If the egress proxy already metered this run, its figure stands; only an
    // unsandboxed run — where no proxy sat on the request path — has nothing
    // better to record.
    const metered = run.totalCostUsd !== null
    const completed = await deps.agentRuns.updateStatus(input.workspaceId, input.agentRunId, {
      status: 'completed',
      ...(metered ? {} : { totalCostUsd: input.event.totalCostUsd }),
      completedAt: new Date(),
    })
    // Notified from the *updated* run, not the one read at the top: the branch
    // name and the metered cost are what make this notification actionable, and
    // `run` predates the transition that finalizes them.
    await notifyRun(deps, completed, 'run_finished')
  } else if (input.event.kind === 'run_failed') {
    const failed = await deps.agentRuns.updateStatus(input.workspaceId, input.agentRunId, {
      status: 'failed',
      errorMessage: input.event.message,
      completedAt: new Date(),
    })
    await notifyRun(deps, failed, 'run_failed', { detail: input.event.message })
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
  // model-authored summary (PLAN.md §6 A3), renders in the approval card
  // itself (ApprovalCard.vue), which is where a human actually decides.
  // Dumping the raw payload and internal id here too would just be noise.
  const message = await deps.messages.append({
    workspaceId: input.workspaceId,
    threadId: run.threadId,
    author: systemActor(),
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

  // The one notification the ship criterion names outright: a gate blocks the
  // run until a human answers, and the approval SLA will auto-*deny* it if
  // nobody does — so being told is the difference between a decision and a
  // timeout.
  await notifyRun(deps, run, 'approval_needed', { toolName: input.toolName })

  return approval
}

/**
 * Hard rule (PLAN.md §6 A1): only a human actor may resolve an approval. An
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

  // isHuman() above already guarantees this, but TS can't narrow across the
  // function call — asserting explicitly rather than casting.
  if (input.actor.kind !== 'user') throw new ForbiddenError('Only a human may resolve an approval request')

  const resolved = await deps.approvals.resolve(input.workspaceId, input.approvalRequestId, {
    status: input.decision === 'approve' ? 'approved' : 'denied',
    resolvedByUserId: input.actor.userId,
  })

  await deps.dispatch.sendApprovalDecision({
    runnerId: run.runnerId,
    toolUseId: approval.toolUseId,
    decision: input.decision === 'approve' ? 'allow' : 'deny',
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
