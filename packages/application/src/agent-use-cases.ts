import {
 BUILTIN_PERSONAS,
 DEFAULT_RESPONSE_STYLE,
 ForbiddenError,
 NotFoundError,
 PLANNER_READABLE_TOOLS,
 ValidationError,
 actingTools,
 agentRunActor,
 applyResponseStyle,
 attenuateChildPersona,
 canPlannerRead,
 buildNotification,
 describeMergeFailure,
 describeReviewBlockers,
 boundedFleet,
 describeFleetOverruns,
 describeFleetRefusal,
 detectFleetOverruns,
 parseFleetSizes,
 parseReviewPolicy,
 describeReviewPolicy,
 describeMissingReviews,
 detectMissingReviews,
 type ReviewExpectation,
 describeCrossPlanOverlaps,
 delegationDesign,
 delegationMatrix,
 describeDelegationRoster,
 describePathOverlaps,
 describePlanStages,
 detectClaimsAgainstExisting,
 detectPathOverlaps,
 isHuman,
 parseEgressHost,
 isPricedModel,
 isMergeQueueEntryTerminal,
 isRiskyTool,
 isTerminalRunStatus,
 validateMessageText,
 MAX_NOTE_BODY_LENGTH,
 buildSteeringBrief,
 describeAppliedDelta,
 parseDecomposition,
 parsePlanDelta,
 parsePersonaMarkdown,
 shippedBuiltin,
 planStages,
 primaryToolArgument,
 selectNextMergeEntry,
 summarizeChildOutcomes,
 systemActor,
 transcriptChunkKey,
 transcriptPrefix,
 type Actor,
 type DelegationRefusal,
 type AgentEvent,
 type AgentPersona,
 type AgentPersonaId,
 type AgentRun,
 type MapSubjectKind,
 type MasteryDirective,
 type Message,
 type AgentRunId,
 type AgentRunRelation,
 type AgentRunStatus,
 TERMINAL_RUN_STATUSES,
 type ApprovalRequest,
 type ApprovalRequestId,
 type Capability,
 type CapabilityId,
 type CapabilityKind,
 type ChannelId,
 type CapabilitySpec,
 type McpTransport,
 type MergeFailureReason,
 type MergeQueueEntry,
 type MergeQueueEntryId,
 type ReviewBlocker,
 type NotificationKind,
 type PersonaCapability,
 type PersonaGroup,
 type PersonaGroupId,
 type PersonaSpec,
 type AppliedDeltaOp,
 type PlanDeltaOp,
 type PlanSubtask,
 type SteeringSubtask,
 type PlatformNoteKind,
 type Repository,
 type ResponseStyle,
 type RepositoryId,
 type Runner,
 type RunnerId,
 type ThreadId,
 type WorkspaceId,
 parseHandoffPolicy,
 type WorkspaceRunControl,
} from '@loom/domain'
import type {
 AgentRunEventRepositoryPort,
 AgentRunRepositoryPort,
 ApprovalRepositoryPort,
 CapabilityRepositoryPort,
 ColosseumRepositoryPort,
 MergeQueueRepositoryPort,
 PersonaGroupRepositoryPort,
 PersonaRepositoryPort,
 PlanSubtaskRepositoryPort,
 RepositoryRepositoryPort,
 ListDirectoryResult,
 RunDispatchPort,
 RunnerRepositoryPort,
 WorkspaceRunControlRepositoryPort,
} from './agent-ports.js'
import type { BlobStoragePort } from './ports.js'
import type { NotificationDeps } from './notification-use-cases.js'
import {
 buildMapContext,
 closeMap,
 invalidateMapsForMerge,
 openMap,
 PENDING_REVISION,
 type MasteryDeps,
} from './mastery-use-cases.js'
import {
 buildContextLedger,
 recordPlatformNote,
 deliverNoteToActiveRuns,
 resolveTreeRunId,
 type NoteDeps,
} from './note-use-cases.js'
import { recordSpokenTurn } from './colosseum-use-cases.js'
import { handoffLimits, suggestHandoffOnPressure } from './handoff-use-cases.js'
import { startThread, type Deps } from './use-cases.js'

export interface AgentDeps extends Deps, NotificationDeps, NoteDeps, MasteryDeps {
 readonly runners: RunnerRepositoryPort
 readonly repositories: RepositoryRepositoryPort
 readonly agentRuns: AgentRunRepositoryPort
 readonly agentRunEvents: AgentRunEventRepositoryPort
 readonly approvals: ApprovalRepositoryPort
 readonly mergeQueue: MergeQueueRepositoryPort
 readonly capabilities: CapabilityRepositoryPort
 readonly personas: PersonaRepositoryPort
 readonly personaGroups: PersonaGroupRepositoryPort
 readonly runControl: WorkspaceRunControlRepositoryPort
 /** The venue — a session is not a run and not a map, so it has its own port. */
 readonly colosseum: ColosseumRepositoryPort
 /** The DAG — the subtasks of a plan that have not started yet. */
 readonly planSubtasks: PlanSubtaskRepositoryPort
 /** The raw transcript tier's store. */
 readonly blobs: BlobStoragePort
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
 * How many runs may be non-terminal in one workspace at once.
 * Phase 1's hard limit of one is just this set to 1.
 */
 readonly maxConcurrentRunsPerWorkspace: number
 /**
 * How many delegation hops may separate a run from the root of its tree — 1 is
 * Phase 2's flat fan-out (a Planner and its workers), 3 lets a root orchestrator
 * delegate to sub-planners that delegate to workers.
 *
 * A depth bound is what makes a Planner a legitimate delegation target at all.
 * The attenuation already proves a sub-planner cannot *widen* what it was given —
 * authority only narrows down the chain — but narrowing says nothing about how
 * long the chain gets, and each hop is a real run spending real money. The
 * concurrency limit bounds width; this bounds depth.
 */
 readonly maxDelegationDepth: number
}

/**
 * How many delegation hops separate `run` from the root of its tree — 0 for a run a
 * human started.
 *
 * Bounded by `MAX_DELEGATION_WALK` rather than `while (true)` for the same reason
 * `resolveTreeRunId` is: a cycle introduced by a bad backfill should degrade the
 * answer, not hang the request that starts a run. The bound is deliberately larger
 * than any sane `maxDelegationDepth`, so hitting it means the data is wrong rather
 * than the tree being legitimately deep — and it returns the count it reached, which
 * is by then far past any configured limit and refuses the child either way.
 */
const MAX_DELEGATION_WALK = 32

const resolveDelegationDepth = async (deps: AgentDeps, run: AgentRun): Promise<number> => {
 // 0 for a run a human started. The caller adds 1 for the child being placed, so
 // seeding this at 1 made every tree read one level deeper than it was and the
 // effective ceiling one lower than the configured one.
 let depth = 0
 let current = run
 while (depth < MAX_DELEGATION_WALK) {
 if (!current.parentRunId) return depth
 const next = await deps.agentRuns.findById(current.workspaceId, current.parentRunId)
 // A cascaded-away ancestor makes the readable chain the whole chain, matching
 // `resolveTreeRunId`'s choice so the two never disagree about the same tree.
 if (!next) return depth
 current = next
 depth += 1
 }
 return depth
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

/**
 * Backs the directory picker. Human-only for the same reason
 * `bindRepository` is: browsing a Runner's filesystem is an administrative
 * capability, and it is exactly the one that looks harmless enough to leave
 * ungated. The boundary itself is the Runner's — it refuses anything outside its
 * allowed roots regardless of who asks — but a run has no business enumerating
 * the machine it happens to be executing on.
 */
export const listRunnerDirectory = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; runnerId: RunnerId; path: string },
): Promise<ListDirectoryResult> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError("Only a human may browse a Runner's filesystem")
 }
 const runner = await deps.runners.findById(input.workspaceId, input.runnerId)
 if (!runner) throw new NotFoundError('Runner')
 if (!runner.connected) throw new ValidationError('Runner is not currently connected')

 const result = await deps.dispatch.listDirectory({ runnerId: input.runnerId, path: input.path })
 if (!result.ok) throw new ValidationError(result.error)
 return result
}

/**
 * Creates a repository on the Runner and binds it in one action (the * "creates one (`git init`)").
 *
 * One use-case rather than create-then-bind, because the half-done state is
 * worse than either end: a repository on disk that the workspace does not know
 * about is invisible, and a binding to a path that was never created is broken.
 * If the bind fails the repository is still on disk — reported, not silently
 * cleaned up, since deleting a directory to tidy up an error is how you delete
 * the wrong directory.
 */
export const createRepository = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 runnerId: RunnerId
 parentPath: string
 name: string
 displayName: string
 },
): Promise<Repository> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may create a repository')
 }
 const runner = await deps.runners.findById(input.workspaceId, input.runnerId)
 if (!runner) throw new NotFoundError('Runner')
 if (!runner.connected) throw new ValidationError('Runner is not currently connected')

 const created = await deps.dispatch.initRepository({
 runnerId: input.runnerId,
 parentPath: input.parentPath,
 name: input.name,
 })
 if (!created.ok) throw new ValidationError(created.error)

 const repository = await deps.repositories.create({
 workspaceId: input.workspaceId,
 runnerId: input.runnerId,
 displayName: input.displayName,
 absolutePath: created.path,
 defaultBranch: created.defaultBranch,
 })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'repository.created',
 subjectType: 'repository',
 subjectId: repository.id,
 metadata: { path: created.path },
 })

 return repository
}

/** What a real client needs to render a runner-picker; no actor restriction, same as listRepositories. */
export const listRunners = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<Runner[]> => deps.runners.listByWorkspace(input.workspaceId)

/**
 * A Planner may read, and may not act.
 *
 * Enforced at authoring time rather than trusted: a Planner that also held `Bash`
 * would make every attenuation check downstream meaningless, since its children
 * could then legitimately inherit it.
 */
const plannerToolProblems = (parsed: {
 harnessPlanner: boolean
 tools: string[]
 harnessDelegates: string[]
}): string[] => {
 const problems: string[] = []
 const acting = parsed.harnessPlanner ? actingTools(parsed.tools): []
 if (acting.length > 0) {
 problems.push(
 `A planner persona may only hold read-only tools (${PLANNER_READABLE_TOOLS.join(', ')}) — it decomposes rather than acting. Remove: ${acting.join(', ')}`,
)
 }
 // Only a planner may carry an envelope. On any other persona it would be a
 // general way to hand children more than the parent holds, which is the exact
 // escalation the attenuation exists to prevent.
 if (!parsed.harnessPlanner && parsed.harnessDelegates.length > 0) {
 problems.push(
 'Only a planner persona may declare "harness.delegates" — it is the envelope its children are attenuated against.',
)
 }
 return problems
}

const assertPlannerToolsAreReadOnly = (parsed: {
 harnessPlanner: boolean
 tools: string[]
 harnessDelegates: string[]
}): void => {
 const problems = plannerToolProblems(parsed)
 if (problems[0]) throw new ValidationError(problems[0])
}

/**
 * Replaces a built-in's markdown with the version this build ships.
 *
 * The resolution for a `'stale'` built-in — one whose markdown differs from the
 * shipped version in a way the recorded seed does not explain. `seedBuiltinPersonas`
 * will not touch those, because it cannot distinguish an operator's tuned prompt from
 * a row that predates the recording; this is the human saying which it was.
 *
 * Records the seed on the way through, so the row rejoins the population that gets
 * shipped fixes automatically from here on.
 */
export const resetPersonaToBuiltin = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; personaId: AgentPersonaId },
): Promise<AgentPersona> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may reset a persona')
 }
 const persona = await deps.personas.findById(input.workspaceId, input.personaId)
 if (!persona) throw new NotFoundError('AgentPersona')

 const shipped = shippedBuiltin(persona.name)
 if (!shipped) {
 throw new ValidationError(
 `"${persona.name}" is not a built-in persona, so there is no shipped version to reset it to.`,
)
 }

 const parsed = parsePersonaMarkdown(shipped.markdownSource)
 const reset = await deps.personas.update(input.workspaceId, input.personaId, {
 description: parsed.description,
 markdownSource: shipped.markdownSource,
 model: parsed.model,
 tools: parsed.tools,
 harnessEffort: parsed.harnessEffort,
 harnessMaxTurns: parsed.harnessMaxTurns,
 harnessApprovalMode: parsed.harnessApprovalMode,
 harnessPlanner: parsed.harnessPlanner,
 harnessDelegates: parsed.harnessDelegates,
 harnessBudgetCapUsd: parsed.harnessBudgetCapUsd,
 builtinSource: shipped.markdownSource,
 })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'persona.reset_to_builtin',
 subjectType: 'agent_persona',
 subjectId: persona.id,
 metadata: { name: persona.name },
 })
 return reset
}

/**
 * Reads a candidate persona markdown the way a save would, and reports rather than
 * throws.
 *
 * The point of this existing at all is that **the client does not own a second
 * parser**. `models.ts` in `client-core` states the rule a client follows — depend on
 * the contract, never on the domain — and duplicates a four-entry price list to keep
 * it; a frontmatter parser cannot be duplicated the same way without the form and the
 * stored row eventually disagreeing about what a human wrote.
 *
 * Not actor-gated the way `createPersona` is: it neither reads nor writes workspace
 * state, so there is nothing here for an actor check to protect. It is still only
 * reachable by an authenticated principal, like every other procedure.
 */
export const parsePersonaDraft = (input: {
 markdownSource: string
}): {
 ok: boolean
 problems: string[]
 parsed: ReturnType<typeof parsePersonaMarkdown> | null
} => {
 let parsed: ReturnType<typeof parsePersonaMarkdown>
 try {
 parsed = parsePersonaMarkdown(input.markdownSource)
 } catch (error) {
 return {
 ok: false,
 problems: [error instanceof Error ? error.message: 'Persona markdown could not be parsed'],
 parsed: null,
 }
 }
 const problems = plannerToolProblems(parsed)
 return { ok: problems.length === 0, problems, parsed }
}

/** Human-only, same reasoning as bindRepository — a persona is an administrative artifact, not something a run edits about itself. */
export const createPersona = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; markdownSource: string },
): Promise<AgentPersona> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may create a persona')
 }
 const parsed = parsePersonaMarkdown(input.markdownSource)
 assertPlannerToolsAreReadOnly(parsed)
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
 harnessApprovalMode: parsed.harnessApprovalMode,
 harnessPlanner: parsed.harnessPlanner,
 harnessDelegates: parsed.harnessDelegates,
 harnessBudgetCapUsd: parsed.harnessBudgetCapUsd,
 })
}

/**
 * Provisions the built-in personas. Not
 * actor-gated: this is system provisioning, not a human action.
 *
 * **Runs on every workspace resolution, not only on creation, and skips names that
 * already exist.** It used to run once, at creation, and that quietly broke every
 * built-in added afterwards: a workspace created before the `planner` and `reconciler`
 * personas existed never received them, and nothing said so. The reconciler is looked
 * up *by name* when a merge conflicts, so on an existing workspace the feature was a
 * no-op — no persona, no run, no log. Found by opening the app in a browser and
 * counting seven personas where there should have been nine.
 *
 * Skipping by name rather than upserting is the important half: these are real,
 * editable `agent_persona` rows, and an operator who has tuned the `swe` prompt must
 * not have it silently reverted every time the server restarts.
 *
 * **[AMENDED — skipping by name alone meant a shipped fix never reached an existing
 * workspace, and that had already cost something real.]** The `planner` built-in
 * shipped with `tools: []`; the planner/worker trust boundary was later amended to give a planner read-only tools
 * *because* the empty list made sub-planners stall on the approval SLA. Every
 * workspace that already had the old row kept the version that stalls, and a new
 * workspace got the fixed one — so the same build behaved differently depending on
 * when the workspace was created, and nothing said so anywhere.
 *
 * The distinction that fixes it is between two things "skip by name" could not tell
 * apart: *the human edited this* and *the platform shipped a new one*.
 * `builtinSource` records the markdown the platform seeded, so a row whose markdown
 * still equals it was never touched and can be brought forward silently. Anything
 * else is a human's work and is left exactly as it is — the original rule, now
 * applied only where it was actually protecting something.
 *
 * A built-in seeded before `builtinSource` existed carries null, and is **not**
 * auto-updated: with nothing recorded there is no way to tell an untouched row from a
 * tuned one, and silently overwriting a human's prompt to fix a different persona is
 * the wrong trade. Those surface through `builtinStatus` as `'stale'`, which the
 * persona editor offers to resolve in one click.
 */
export const seedBuiltinPersonas = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<void> => {
 const existing = new Map(
 (await deps.personas.listByWorkspace(input.workspaceId)).map((persona) => [
 persona.name,
 persona,
 ]),
)
 for (const persona of BUILTIN_PERSONAS) {
 const current = existing.get(persona.name)
 if (current) {
 const untouched =
 current.builtinSource !== null && current.builtinSource === current.markdownSource
 if (!untouched || current.markdownSource === persona.markdownSource) continue
 const parsed = parsePersonaMarkdown(persona.markdownSource)
 await deps.personas.update(input.workspaceId, current.id, {
 description: parsed.description,
 markdownSource: persona.markdownSource,
 model: parsed.model,
 tools: parsed.tools,
 harnessEffort: parsed.harnessEffort,
 harnessMaxTurns: parsed.harnessMaxTurns,
 harnessApprovalMode: parsed.harnessApprovalMode,
 harnessPlanner: parsed.harnessPlanner,
 harnessDelegates: parsed.harnessDelegates,
 harnessBudgetCapUsd: parsed.harnessBudgetCapUsd,
 builtinSource: persona.markdownSource,
 })
 continue
 }
 await deps.personas.create({
 workspaceId: input.workspaceId,
 name: persona.name,
 description: persona.description,
 markdownSource: persona.markdownSource,
 model: persona.model,
 tools: persona.tools,
 harnessEffort: persona.harnessEffort,
 harnessMaxTurns: persona.harnessMaxTurns,
 harnessApprovalMode: persona.harnessApprovalMode,
 harnessPlanner: persona.harnessPlanner,
 harnessDelegates: persona.harnessDelegates,
 harnessBudgetCapUsd: persona.harnessBudgetCapUsd,
 builtinSource: persona.markdownSource,
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
 assertPlannerToolsAreReadOnly(parsed)
 /**
 * A rename is refused rather than silently dropped. `personas.update` has never
 * carried `name`, so editing the `name:` line stored a markdown whose frontmatter
 * disagreed with the row every other surface reads — and nothing said so.
 *
 * Refusing rather than implementing it, because a persona's name *is* its address:
 * `@mention` resolves it, the delegation roster names it to a Planner, the merge
 * queue looks the reconciler up by name, and `seedBuiltinPersonas` skips by name —
 * so a renamed built-in comes back on the next workspace resolution alongside its
 * rename. Creating a second persona is the honest way to get a different name.
 */
 const existing = await deps.personas.findById(input.workspaceId, input.personaId)
 if (!existing) throw new NotFoundError('AgentPersona')
 if (parsed.name !== existing.name) {
 throw new ValidationError(
 `A persona's name cannot be changed — "${existing.name}" is how @mention, the delegation roster and the merge queue address it. Create a new persona instead.`,
)
 }
 return deps.personas.update(input.workspaceId, input.personaId, {
 description: parsed.description,
 markdownSource: input.markdownSource,
 model: parsed.model,
 tools: parsed.tools,
 harnessEffort: parsed.harnessEffort,
 harnessMaxTurns: parsed.harnessMaxTurns,
 harnessApprovalMode: parsed.harnessApprovalMode,
 harnessPlanner: parsed.harnessPlanner,
 harnessDelegates: parsed.harnessDelegates,
 harnessBudgetCapUsd: parsed.harnessBudgetCapUsd,
 })
}

/**
 * The capability registry. Human-only throughout: the
 * whole security property is that a capability is something an operator added
 * deliberately, not something a repository under review can introduce.
 */
export const createCapability = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 kind: CapabilityKind
 name: string
 description: string
 transport?: McpTransport | null
 command?: string | null
 args?: string[]
 url?: string | null
 content?: string | null
 /**
 * Hosts a persona holding this may reach through the egress proxy.
 *
 * How web access is granted at all: there is no built-in for it and no persona ships
 * with one, so reaching the open web means an operator registered something that says
 * which hosts and attached it to a named agent. Per capability rather than per
 * deployment, so the grant attenuates with the persona instead of opening a host for
 * every run in the workspace.
 */
 egressHosts?: string[]
 },
): Promise<Capability> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may register a capability')
 }

 /**
 * Refused rather than sanitized. A pattern silently narrowed would be an allowlist
 * entry that does not say what it does, on the one control that decides where a
 * compromised agent can post a repository.
 */
 const egressHosts: string[] = []
 for (const raw of input.egressHosts ?? []) {
 const verdict = parseEgressHost(raw)
 if (!verdict.ok) throw new ValidationError(verdict.reason)
 egressHosts.push(verdict.host)
 }

 // Shape validation here rather than in the schema, because what a capability
 // needs depends on what it is, and a half-specified MCP server fails at run
 // start — which is the worst possible moment to discover it.
 if (input.kind === 'mcp') {
 if (input.transport === 'stdio' && !input.command?.trim) {
 throw new ValidationError('A stdio MCP server needs a command')
 }
 if ((input.transport === 'sse' || input.transport === 'http') && !input.url?.trim) {
 throw new ValidationError(`A ${input.transport} MCP server needs a URL`)
 }
 if (!input.transport) throw new ValidationError('An MCP capability needs a transport')
 }
 if (input.kind === 'skill' && !input.content?.trim) {
 throw new ValidationError('A skill needs content')
 }

 const existing = await deps.capabilities.listByWorkspace(input.workspaceId)
 if (existing.some((candidate) => candidate.name === input.name)) {
 throw new ValidationError(`Capability "${input.name}" already exists`)
 }

 const created = await deps.capabilities.create({
 workspaceId: input.workspaceId,
 kind: input.kind,
 name: input.name,
 description: input.description,
 transport: input.transport ?? null,
 command: input.command ?? null,
 args: input.args ?? [],
 url: input.url ?? null,
 content: input.content ?? null,
 egressHosts,
 })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'capability.registered',
 subjectType: 'capability',
 subjectId: created.id,
 metadata: { kind: input.kind, name: input.name },
 })

 return created
}

export const listCapabilities = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<Capability[]> => deps.capabilities.listByWorkspace(input.workspaceId)

export const listCapabilityAttachments = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<PersonaCapability[]> => deps.capabilities.listAttachments(input.workspaceId)

export const deleteCapability = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; capabilityId: CapabilityId },
): Promise<void> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may remove a capability')
 }
 await deps.capabilities.delete(input.workspaceId, input.capabilityId)
}

/**
 * Attaches a registry capability to a persona, with the per-attachment scope.
 *
 * `allowedTools` narrows what the persona may use from an MCP server. Empty means
 * everything the server offers — which is a real decision, not a default to reach
 * for: it is also what makes the child-attenuation check on scopes meaningful.
 */
export const attachCapability = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 personaId: AgentPersonaId
 capabilityId: CapabilityId
 allowedTools?: string[]
 },
): Promise<PersonaCapability> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may attach a capability')
 }
 const persona = await deps.personas.findById(input.workspaceId, input.personaId)
 if (!persona) throw new NotFoundError('AgentPersona')
 const capability = await deps.capabilities.findById(input.workspaceId, input.capabilityId)
 if (!capability) throw new NotFoundError('Capability')

 const attachment = await deps.capabilities.attach({
 workspaceId: input.workspaceId,
 personaId: input.personaId,
 capabilityId: input.capabilityId,
 allowedTools: input.allowedTools ?? [],
 })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'capability.attached',
 subjectType: 'agent_persona',
 subjectId: persona.id,
 metadata: { capability: capability.name, allowedTools: input.allowedTools ?? [] },
 })

 return attachment
}

export const detachCapability = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 personaId: AgentPersonaId
 capabilityId: CapabilityId
 },
): Promise<void> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may detach a capability')
 }
 await deps.capabilities.detach(input.workspaceId, input.personaId, input.capabilityId)
}

/**
 * Resolves a persona's attached capabilities into the specs a run executes with.
 *
 * Snapshotted onto the run like the rest of the persona: revoking a capability
 * must not change what a run already in flight is using, and attaching one must
 * not silently widen it. A capability row that vanished between attach and start
 * is skipped rather than failing the run — the attachment is stale, not the run.
 */
const resolveCapabilities = async (
 deps: AgentDeps,
 workspaceId: WorkspaceId,
 personaId: AgentPersonaId,
): Promise<CapabilitySpec[]> => {
 const attachments = await deps.capabilities.listByPersona(workspaceId, personaId)
 const specs: CapabilitySpec[] = []

 for (const attachment of attachments) {
 const capability = await deps.capabilities.findById(workspaceId, attachment.capabilityId)
 if (!capability) continue

 if (capability.kind === 'skill') {
 specs.push({
 kind: 'skill',
 name: capability.name,
 content: capability.content ?? '',
 egressHosts: capability.egressHosts,
 })
 continue
 }
 if (!capability.transport) continue
 specs.push({
 kind: 'mcp',
 name: capability.name,
 transport: capability.transport,
 command: capability.command,
 args: capability.args,
 url: capability.url,
 toolListHash: capability.toolListHash,
 allowedTools: attachment.allowedTools,
 // Snapshotted with the rest of the spec, so revoking a host does not change what a
 // run already in flight may reach and adding one does not silently widen it.
 egressHosts: capability.egressHosts,
 })
 }

 return specs
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

/**
 * Which team's widths apply to a run of this persona.
 *
 * **Resolved from team membership, and that is a real limitation worth stating.** A run
 * carries a persona, not a team, so the only honest answer available today is "the team
 * this persona is on". When exactly one team contains it, that team's widths are its
 * widths. When several do, the platform genuinely cannot know which one this run is for —
 * so **nothing is applied**, rather than guessing at a limit that would then refuse real
 * work. A persona on no team is unsized, as everything was before this existed.
 *
 * The eventual fix is a team chosen where a run starts, which is what the * canvas-driven start gives for free. Adding a `persona_group_id` to `agent_run` now
 * would be a column nothing sets — the exact shape the fleet design warns against.
 */
/**
 * A run's persona *id*, recovered from its snapshot by name.
 *
 * `agent_run.persona` is a snapshot — it carries the name, not the id — because a run
 * must not change when its persona is edited. Team membership is keyed by id, so
 * resolving a run's team means going back through the name. Null when the persona has
 * been renamed or deleted since, in which case no team applies, which is the same
 * unsized behaviour as a persona on no team.
 */
const plannerPersonaId = (
 personas: readonly AgentPersona[],
 run: AgentRun,
): AgentPersonaId | null =>
 personas.find((persona) => persona.name === run.persona.name)?.id ?? null

const resolveTeamPolicy = async (
 deps: AgentDeps,
 workspaceId: WorkspaceId,
 /** Null when the persona could not be resolved at all — unsized, same as no team. */
 personaId: AgentPersonaId | null,
): Promise<{
 fleet: Record<string, number>
 reviewers: Record<string, string[]>
 ambiguous: boolean
}> => {
 const none = { fleet: {}, reviewers: {}, ambiguous: false }
 if (personaId === null) return none
 const groups = await deps.personaGroups.listByWorkspace(workspaceId)
 const owning = groups.filter((group) => group.personaIds.includes(personaId))
 if (owning.length !== 1) return {...none, ambiguous: owning.length > 1 }
 return {
 fleet: owning[0]?.fleet ?? {},
 reviewers: owning[0]?.reviewers ?? {},
 ambiguous: false,
 }
}

/**
 * The team's review expectations as *names*, which is what a prompt and a warning both
 * need. Stored by id, because a persona rename must not silently drop a
 * policy; resolved here, because a Planner names personas by name and nothing else.
 *
 * An entry naming a persona that no longer exists is dropped rather than reported: it is
 * the same stale-membership case `parseReviewPolicy` drops, arriving from the other side.
 */
const resolveReviewExpectations = (
 reviewers: Record<string, string[]>,
 personas: readonly AgentPersona[],
): ReviewExpectation[] => {
 // Keyed as plain strings: the stored policy holds ids as they came off the wire, and a
 // branded lookup would need every one of them re-branded to be readable.
 const nameById = new Map<string, string>(
 personas.map((persona) => [persona.id as string, persona.name]),
)
 const expectations: ReviewExpectation[] = []
 for (const [reviewerId, reviewedIds] of Object.entries(reviewers)) {
 const reviewerName = nameById.get(reviewerId)
 if (reviewerName === undefined) continue
 for (const reviewedId of reviewedIds) {
 const reviewedName = nameById.get(reviewedId)
 if (reviewedName === undefined) continue
 expectations.push({ reviewerName, reviewedName })
 }
 }
 return expectations
}

export const updatePersonaGroup = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 personaGroupId: PersonaGroupId
 name: string
 personaIds: string[]
 /**
 * Where each member sits on the composition canvas. Omitted leaves the stored
 * layout untouched — a client that does not draw a canvas is not saying the
 * positions should be forgotten.
 */
 layout?: Record<string, { x: number; y: number }>
 /**
 * How many of each member this team runs at once. Omitted leaves
 * the stored widths untouched, for the same reason `layout` does.
 */
 fleet?: Record<string, number>
 /**
 * Who reviews whom on this team. Omitted leaves the stored policy
 * alone, for the same reason `layout` and `fleet` do.
 */
 reviewers?: Record<string, string[]>
 /**
 * The root orchestrator — the member the work starts from, and the vantage the
 * canvas measures depth from. Omitted leaves the stored root alone; `null` clears it
 * back to picked-by-reach, which is a different act and a real state.
 */
 orchestratorId?: string | null
 },
): Promise<PersonaGroup> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may update a persona group')
 }
 await assertPersonaIdsExist(deps, input.workspaceId, input.personaIds)

 /**
 * Validated here rather than trusted from the wire, because the runtime reads it: a
 * width of 0 would make a roster offer a persona the concurrency check then refuses
 * every time, which is the "a listed name reads as permission" failure
 * `delegation-roster.ts` exists to prevent. `parseFleetSizes` also drops entries for
 * members that are no longer on the team, for the reason the layout filter below does.
 */
 const fleetVerdict = parseFleetSizes(input.fleet, input.personaIds)
 if (!fleetVerdict.ok) throw new ValidationError(fleetVerdict.reason)

 /**
 * The review policy, validated for the same reason: the roster tells a Planner to act on
 * it, and the two refusals `parseReviewPolicy` makes are the two that would produce an
 * instruction it cannot follow — a persona reviewing itself (which `parsePlanSubtask`
 * refuses) and a planner as the reviewed party (whose output is a plan, not a branch).
 *
 * Needs to know which members are planners, so the personas are read only when a policy
 * was actually sent.
 */
 const reviewersVerdict =
 input.reviewers === undefined
 ? { ok: true as const, reviewers: {} }
: parseReviewPolicy(
 input.reviewers,
 input.personaIds,
 (await deps.personas.listByWorkspace(input.workspaceId))
.filter((persona) => persona.harnessPlanner)
.map((persona) => persona.id),
)
 if (!reviewersVerdict.ok) throw new ValidationError(reviewersVerdict.reason)

 /**
 * The root, checked against the roster rather than stored as sent.
 *
 * Two refusals, and both are about the canvas telling the truth. A root that is not on
 * the team is a vantage point with nothing under it, so every depth the canvas reports
 * would be `unreachable`. A root that is not a planner cannot start anything at all —
 * The chain of command begins with a decomposition, and a worker at the top would
 * make the tiers below it a drawing of a tree no run can have.
 */
 if (input.orchestratorId !== undefined && input.orchestratorId !== null) {
 if (!input.personaIds.includes(input.orchestratorId)) {
 throw new ValidationError('The orchestrator has to be a member of this team')
 }
 const orchestrator = (await deps.personas.listByWorkspace(input.workspaceId)).find(
 (persona) => persona.id === input.orchestratorId,
)
 if (!orchestrator) throw new NotFoundError('AgentPersona')
 if (!orchestrator.harnessPlanner) {
 throw new ValidationError(
 `${orchestrator.name} is not a planner, so it cannot be this team's orchestrator — the chain of command starts with a decomposition.`,
)
 }
 }

 return deps.personaGroups.update(input.workspaceId, input.personaGroupId, {
 name: input.name,
 personaIds: input.personaIds,
...(input.orchestratorId === undefined ? {}: { orchestratorId: input.orchestratorId }),
...(input.fleet === undefined ? {}: { fleet: fleetVerdict.fleet }),
...(input.reviewers === undefined ? {}: { reviewers: reviewersVerdict.reviewers }),
...(input.layout === undefined
 ? {}
: {
 // Positions for members that are gone are dropped rather than kept: a group
 // that has churned would otherwise accumulate coordinates forever, and a
 // persona re-added under the same id would silently reappear where the last
 // person left it rather than where this one dropped it.
 layout: Object.fromEntries(
 Object.entries(input.layout).filter(([personaId]) =>
 input.personaIds.includes(personaId),
),
),
 }),
 })
}

/**
 * Who one persona could delegate to under the overrides a launcher is about to
 * apply.
 *
 * Its own procedure rather than a filter over `delegationMatrixForWorkspace`, because
 * the answer changes with the overrides and the matrix is computed from stored
 * personas. The two fields a launcher lets a human change — model and cap — are
 * exactly the two that silently empty a roster: a planner moved down a tier cannot
 * start a worker above it, so every persona in the workspace becomes correct and
 * unusable at once. That cost a real run to discover, which is the argument for
 * saying it under the control that causes it.
 */
export const delegationPreviewForPersona = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 personaId: AgentPersonaId
 model?: string
 budgetCapUsd?: number | null
 },
): Promise<{
 planner: boolean
 delegatable: { id: string; name: string }[]
 refused: { id: string; name: string; refusals: DelegationRefusal[] }[]
}> => {
 const persona = await deps.personas.findById(input.workspaceId, input.personaId)
 if (!persona) throw new NotFoundError('AgentPersona')
 if (!persona.harnessPlanner) return { planner: false, delegatable: [], refused: [] }

 const plannerSpec: PersonaSpec = {
 name: persona.name,
 systemPrompt: '',
 model: input.model ?? persona.model,
 tools: persona.tools,
 approvalMode: persona.harnessApprovalMode,
 budgetCapUsd:
 input.budgetCapUsd === undefined ? persona.harnessBudgetCapUsd: input.budgetCapUsd,
 planner: true,
 delegates: persona.harnessDelegates,
 capabilities: await resolveCapabilities(deps, input.workspaceId, persona.id),
 }

 const candidates = await deps.personas.listByWorkspace(input.workspaceId)
 const delegatable: { id: string; name: string }[] = []
 const refused: { id: string; name: string; refusals: DelegationRefusal[] }[] = []

 for (const candidate of candidates) {
 if (candidate.id === persona.id) continue
 const design = delegationDesign(
 plannerSpec,
 {
 name: candidate.name,
 systemPrompt: '',
 model: candidate.model,
 tools: candidate.tools,
 approvalMode: candidate.harnessApprovalMode,
 budgetCapUsd: candidate.harnessBudgetCapUsd,
 planner: candidate.harnessPlanner,
 delegates: candidate.harnessDelegates,
 capabilities: await resolveCapabilities(deps, input.workspaceId, candidate.id),
 },
 deps.limits.maxDelegationDepth - 1,
)
 if (design.ok) delegatable.push({ id: candidate.id, name: candidate.name })
 else refused.push({ id: candidate.id, name: candidate.name, refusals: [...design.refusals] })
 }

 return { planner: true, delegatable, refused }
}

/**
 * Every planner-to-persona pair in this workspace, and why each refused one is
 * refused.
 *
 * Server-side for the reason `parsePersonaDraft` is: these are the rules the
 * child-start gate applies, and a client that decided them for itself would show a
 * human a team the runtime then refuses one error at a time — which is the exact
 * failure this is built against.
 *
 * Capabilities are resolved per persona, unlike in the delegation *roster* where they
 * are deliberately skipped. The roster runs at every Planner start and pays a query
 * per candidate; this runs when a human opens a canvas, and the capability rule is one
 * of the refusals they most need to see — an MCP server is a route to a shell.
 */
export const delegationMatrixForWorkspace = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<
 { plannerId: string; workerId: string; ok: boolean; refusals: DelegationRefusal[] }[]
> => {
 const personas = await deps.personas.listByWorkspace(input.workspaceId)
 const specs = await Promise.all(
 personas.map(async (persona) => ({
 id: persona.id,
 spec: {
 name: persona.name,
 // Empty rather than the real prompt: nothing here reads it, and a matrix is
 // not a reason to put every persona's instructions on the wire.
 systemPrompt: '',
 model: persona.model,
 tools: persona.tools,
 approvalMode: persona.harnessApprovalMode,
 budgetCapUsd: persona.harnessBudgetCapUsd,
 planner: persona.harnessPlanner,
 delegates: persona.harnessDelegates,
 capabilities: await resolveCapabilities(deps, input.workspaceId, persona.id),
 } satisfies PersonaSpec,
 })),
)
 const byName = new Map(specs.map((entry) => [entry.spec.name, entry.id]))

 return delegationMatrix(
 specs.map((entry) => entry.spec),
 // Hops left below a planner's children, measured from a root: the same
 // arithmetic `startAgentRun` does, one level up. A canvas is authored before
 // anything runs, so the most permissive real position is the one to show.
 deps.limits.maxDelegationDepth - 1,
).flatMap((edge) => {
 const plannerId = byName.get(edge.plannerName)
 const workerId = byName.get(edge.workerName)
 if (!plannerId || !workerId) return []
 return [{ plannerId, workerId, ok: edge.ok, refusals: [...edge.refusals] }]
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
 * Every run currently executing in the workspace. Distinct
 * from the Inbox's `listNeedsAttention`, which answers "what is blocked on me" —
 * this answers "what is running", and with concurrency those diverge.
 */
export const listActiveAgentRuns = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<AgentRun[]> => deps.agentRuns.listActiveByWorkspace(input.workspaceId)

/** One run's children — what the Phase 2 tree view is drawn from. */
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
 * `parentRunId` makes this a child run. Two things then
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
 /** What a human asked for via `@mention`; absent for the sidebar-picker path. */
 task?: string
 /**
 * How much prose this run should produce.
 *
 * Snapshotted into the persona spec at start like everything else here, so a run
 * already in flight keeps the style it was launched with. Human-initiated runs
 * only: a delegated child inherits its parent's, which is what keeps one swarm
 * speaking in one voice.
 */
 responseStyle?: ResponseStyle
 /**
 * Overrides the persona's model for this run only.
 *
 * Refused unless the price table knows it: the metering is what enforces a budget
 * cap, so a model nobody can price is a run whose cap silently does not bite.
 * Child runs still attenuate against the parent's tier — this widens nothing that
 * `attenuateChildPersona` would otherwise have caught.
 */
 model?: string
 /**
 * Overrides the persona's spend ceiling for this run only.
 *
 * **Honoured only for a human-initiated run.** A cap is a ceiling an operator set,
 * and an agent able to raise its own would be an agent able to spend past it —
 * The attenuation makes the same distinction for tools and model tier. `undefined`
 * keeps the persona's cap; explicit `null` is a human deliberately removing it.
 */
 budgetCapUsd?: number | null
 /** Set when one run spawns another. */
 parentRunId?: AgentRunId
 relation?: AgentRunRelation
 /**
 * Repository-relative paths this run owns, from the Planner's decomposition
 *. Recorded onto the run's own `run_started` note, which is
 * what the board reads a card's claim from.
 */
 ownedPaths?: readonly string[]
 /**
 * Start this run as a reconciler over `parentRunId`'s conflicted branch
 *. Only `reconcileConflict` sets this, and it always pairs
 * with `relation: 'reconcile'` — the data model is explicit that a reconciler must not
 * masquerade as a delegation child.
 */
 reconcile?: { branchName: string }
 /**
 * Start this run as a reviewer of `targetRunId`'s branch.
 * Only `startPlannedChild` sets this, and it always pairs with
 * `relation: 'review'` — the data model is explicit that a review must not masquerade as a
 * delegation child, and the reviewing role cites that same distinction as the reason the
 * relation already existed.
 */
 review?: { targetRunId: AgentRunId; branchName: string }
 /**
 * Start this run as a **mastery run**: its deliverable is a map of the
 * named subject, not a diff. Opens (or re-opens) the persona's map for that subject
 * before dispatch, and is what gives the run `record_map` at all.
 */
 /**
 * What this run is mastering, and what it has been asked to look for. `directive` is validated by the domain against the subject kind before it
 * gets here — a focus a subject has no record to satisfy is refused rather than
 * quietly dropped, since the human read the option as a promise.
 */
 mastery?: {
 subjectKind: MapSubjectKind
 subjectRef: string
 directive?: MasteryDirective
 }
 },
): Promise<AgentRun> => {
 const parent = input.parentRunId
 ? await deps.agentRuns.findById(input.workspaceId, input.parentRunId)
: null
 if (input.parentRunId && !parent) throw new NotFoundError('Parent AgentRun')

 // A human may always start a run. An agent run may start one *only* as a child
 // of itself — anything else would let a run manufacture work outside the tree
 // that attenuation is defined over, which is the same forgery surface identity-bound approval
 // closes for approvals.
 if (!isHuman(input.actor)) {
 if (input.actor.kind !== 'agent_run' || parent === null) {
 throw new ForbiddenError('Only a human may start an agent run')
 }
 if (input.actor.agentRunId !== parent.id) {
 throw new ForbiddenError('An agent run may only spawn children of itself')
 }
 }

 // Kill switch — checked before anything is
 // written, so a paused workspace leaves no half-created run behind. Applies to
 // child runs too: a pause that a Planner could spawn its way around is not a
 // pause.
 const control = await deps.runControl.get(input.workspaceId)
 if (control.paused) {
 throw new ValidationError('Agent runs are paused for this workspace — resume them first')
 }

 /**
 * Delegation depth.
 *
 * The attenuation proves authority only *narrows* down a chain — a sub-planner's
 * envelope is bounded by the one that granted it. That makes a deep tree safe and
 * says nothing about whether it is affordable: every hop is a run, and a Planner
 * that may delegate to a Planner can otherwise recurse until the budget or the
 * concurrency limit stops it, which is a stop condition measured in dollars.
 *
 * Checked here rather than only where plans are applied, because `startAgentRun`
 * is the one door every child comes through — the same reason the pause and the
 * concurrency limit live here.
 *
 * A `steer` run is exempt for the same reason a reconciler is: a human starts it, it hangs off the Planner it re-enters
 * only because that is what it is *about*, and it delegates nothing itself — the
 * subtasks its delta adds are children of that Planner, at the depth they would
 * have had in the original plan. Counting it as a hop would make a swarm
 * un-steerable at exactly the depth where steering is worth most.
 */
 if (parent && input.relation !== 'reconcile' && input.relation !== 'steer') {
 const depth = await resolveDelegationDepth(deps, parent)
 if (depth + 1 > deps.limits.maxDelegationDepth) {
 throw new ValidationError(
 `Delegation is ${deps.limits.maxDelegationDepth} level(s) deep at most in this workspace, and this child would be level ${depth + 1}`,
)
 }
 }

 // Concurrency limit. Phase 1 allowed exactly one
 // active run workspace-wide; a swarm is N workers on one goal, so the limit is
 // now a number rather than a special case. It is still a *limit*: unbounded
 // concurrency multiplies both spend and the human attention the riskiest assumption is about, and a
 // Planner that can spawn without bound is how a runaway loop gets expensive.
 const active = await deps.agentRuns.listActiveByWorkspace(input.workspaceId)
 if (active.length >= deps.limits.maxConcurrentRunsPerWorkspace) {
 /**
 * The refusal names what is actually holding the slots, because "wait for one to
 * finish" is wrong advice for the commonest case.
 *
 * `awaiting_approval` is not a terminal status, so a run blocked on a human holds
 * a slot until that human acts — and waiting is then the one thing that will never
 * clear it. Observed on a real workspace: two of three slots held by runs waiting
 * on an approval, and a message telling the operator to wait.
 */
 const waiting = active.filter((run) => run.status === 'awaiting_approval').length
 throw new ValidationError(
 waiting > 0
 ? `This workspace already has ${active.length} active run(s), its configured maximum — and ${waiting} of them ${waiting === 1 ? 'is': 'are'} waiting on an approval from you, which will not clear on its own. Decide those in the Inbox, or stop a run.`
: `This workspace already has ${active.length} active run(s), its configured maximum — wait for one to finish first`,
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

 /**
 * The second place: **the concurrency limit, per team rather than per workspace.**
 *
 * Beside the workspace limit above rather than instead of it — the two are a ceiling and
 * a narrowing under it, and `boundedFleet` clamps to the workspace number so a team can
 * never widen an operator's limit. That is the one thing the fleet design says a design-time
 * field must not become.
 *
 * **Only for a delegation.** A human starting a run by hand is not acting for a team's
 * roster, and a width that refused the operator who wrote it would be absurd; a
 * reconciler and a steering run are platform- and human-initiated for the same reason
 * they are exempt from attenuation and depth.
 *
 * Resolved from the *child's* own membership: the count is a fact about a persona on a
 * team, and the child's persona is the one being counted. Counted over the workspace's
 * active runs, because "concurrent" has to mean the same thing here as in the ceiling
 * this sits under.
 */
 if (parent && input.relation === 'delegation') {
 const team = await resolveTeamPolicy(deps, input.workspaceId, input.personaId)
 const limit = boundedFleet(
 team.fleet[input.personaId],
 deps.limits.maxConcurrentRunsPerWorkspace,
)
 if (limit !== null) {
 const running = active.filter((run) => run.persona.name === persona.name).length
 if (running >= limit) {
 throw new ValidationError(
 describeFleetRefusal({ personaName: persona.name, limit, active: running }),
)
 }
 }
 }

 // A child inherits the style its parent was launched with, so one swarm speaks in
 // one voice; only a human's start actually chooses one.
 const responseStyle: ResponseStyle =
 input.responseStyle ?? parent?.persona.responseStyle ?? DEFAULT_RESPONSE_STYLE

 if (input.model !== undefined && !isPricedModel(input.model)) {
 throw new ValidationError(
 `Unknown model "${input.model}" — spend on it could not be metered, so its budget cap could not be enforced`,
)
 }

 const baseSpec: PersonaSpec = {
 name: persona.name,
 systemPrompt: applyResponseStyle(
 parsePersonaMarkdown(persona.markdownSource).systemPrompt,
 responseStyle,
),
 responseStyle,
 model: input.model ?? persona.model,
 budgetCapUsd:
 input.budgetCapUsd !== undefined && isHuman(input.actor)
 ? input.budgetCapUsd
: persona.harnessBudgetCapUsd,
 tools: persona.tools,
 approvalMode: persona.harnessApprovalMode,
 planner: persona.harnessPlanner,
 delegates: persona.harnessDelegates,
 capabilities: await resolveCapabilities(deps, input.workspaceId, input.personaId),
 }

 /**
 * A Planner is told who it may delegate to, filtered by the gate that will judge
 * the plan.
 *
 * Built from `baseSpec` rather than the stored row: the cap and model a human may
 * have overridden for *this* run are what its children will actually be measured
 * against, so a $1 override must not be handed a roster computed against $5.
 *
 * One extra query, and only for a Planner — `applySubmittedPlan` already lists the
 * same personas when the plan comes back, so this is the same read moved to where
 * it can still change the outcome.
 */
 /**
 * The acting planner's team widths, read once and used for both
 * The first place (this roster) and its third (the plan-time warning, which
 * `applySubmittedPlan` resolves again from the same rule).
 *
 * Resolved from the *planner's* membership rather than each candidate's, because it is
 * the planner that is acting for a team — a worker on three teams still gets the width
 * the team that is delegating to it declared.
 */
 const teamPolicy = baseSpec.planner
 ? await resolveTeamPolicy(deps, input.workspaceId, input.personaId)
: await resolveTeamPolicy(deps, input.workspaceId, null)

 const roster = baseSpec.planner
 ? describeDelegationRoster(
 baseSpec,
 (await deps.personas.listByWorkspace(input.workspaceId)).map((candidate) => ({
 name: candidate.name,
 description: candidate.description,
 model: candidate.model,
 tools: candidate.tools,
 approvalMode: candidate.harnessApprovalMode,
 budgetCapUsd: candidate.harnessBudgetCapUsd,
 planner: candidate.harnessPlanner,
 delegates: candidate.harnessDelegates,
 /**
 * The first place. Clamped to the workspace ceiling here rather than
 * where it is enforced, so the number a Planner is told is the number that will
 * actually bite — a roster promising 8 under a workspace limit of 3 would be
 * the platform lying about its own limit.
 */
...(boundedFleet(
 teamPolicy.fleet[candidate.id],
 deps.limits.maxConcurrentRunsPerWorkspace,
) === null
 ? {}
: {
 fleet: boundedFleet(
 teamPolicy.fleet[candidate.id],
 deps.limits.maxConcurrentRunsPerWorkspace,
) as number,
 }),
 })),
 // Hops left *below this run's children*: this run sits at `ownDepth`, its
 // children at `ownDepth + 1`, so a grandchild is possible only with a hop to
 // spare. Offering a sub-planner without one names a persona whose every
 // subtask the depth check would then refuse.
 //
 // A steering run is the exception, because its delta's subtasks are not its
 // children — they are started under the Planner it is re-entering, which is
 // its own parent. Measured from its own position it would be told one hop
 // fewer than it has, and would drop sub-planners out of a roster that the
 // original plan was allowed to use.
 deps.limits.maxDelegationDepth -
 (parent ? (await resolveDelegationDepth(deps, parent)) + (input.relation === 'steer' ? 0: 1): 0) -
 1,
)
: null

 /**
 * The design-canvas half, read where it is actionable: the team's standing review
 * expectations, appended after the roster.
 *
 * After rather than inside `describeDelegationRoster`, because it is a fact about *pairs*
 * of personas and the roster is a list of candidates — folding it into a candidate's line
 * would say "reviewed by qa" on `swe` and leave `qa`'s own line silent about why it is
 * there. It is also the only part of the roster that is a property of the *team* rather
 * than of what this planner may reach.
 */
 const reviewClause =
 baseSpec.planner && roster
 ? describeReviewPolicy(
 resolveReviewExpectations(
 teamPolicy.reviewers,
 await deps.personas.listByWorkspace(input.workspaceId),
),
)
: null

 const promptSuffix = `${roster ?? ''}${reviewClause ?? ''}`
 const personaSpec: PersonaSpec =
 promptSuffix === ''
 ? baseSpec
: {...baseSpec, systemPrompt: `${baseSpec.systemPrompt}${promptSuffix}` }

 // Capability attenuation. Checked against the parent's *snapshot*,
 // not its stored persona: the snapshot is what the parent is actually running
 // with, and editing a persona mid-run must not widen what its children may ask
 // for.
 /**
 *...except for a reconciler, which is **platform-initiated**.
 *
 * Attenuation exists so a parent cannot grant a child more than it holds — it is a
 * defence against a parent that has been manipulated into escalating. A reconcile
 * child is not something the parent asks for or shapes: the merge queue starts it
 * when a rebase conflicts, the persona is looked up from the registry by a fixed
 * name, the task text is platform-authored, and `relation` is not reachable from the
 * contract. The parent contributes nothing but the branch that failed to merge, so
 * there is no escalation for attenuation to prevent here.
 *
 * Applying it anyway is not merely redundant, it is wrong: it makes reconciliation
 * impossible for exactly the runs most likely to need it. A worker on Haiku, or one
 * with a deliberately narrow tool list, could never have its branch reconciled —
 * the reconciler needs `Edit` and a model tier the worker does not have, and the * check reads both as escalation. That was found by an integration test refusing
 * `Edit, Grep, Glob` for a read-only-ish parent.
 *
 * The reconciler's own bounds still apply: registry-provisioned capabilities and the
 * budget cap on its persona. What is deliberately *not* relaxed is delegation — a
 * Planner's children stay fully attenuated, which is the case the data model is actually about.
 */
 if (parent && input.relation !== 'reconcile') {
 const verdict = attenuateChildPersona(parent.persona, personaSpec)
 if (!verdict.ok) throw new ValidationError(verdict.reason)
 }

 const run = await deps.agentRuns.create({
 workspaceId: input.workspaceId,
 threadId: input.threadId,
 repositoryId: input.repositoryId,
 runnerId: repository.runnerId,
 persona: personaSpec,
...(parent ? { parentRunId: parent.id, relation: input.relation ?? 'delegation' }: {}),
 // Recorded so a re-planning turn can read back the goal and the plan. Stored before dispatch: a run that fails to start still answers "what was
 // it asked to do", which is the question a human asks about exactly those runs.
...(input.task === undefined ? {}: { task: input.task }),
 })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'agent_run.started',
 subjectType: 'agent_run',
 subjectId: run.id,
 metadata: { repositoryId: repository.id, personaId: persona.id, model: personaSpec.model },
 })

 /**
 * The shared context this run starts with. Assembled here
 * rather than on the Runner because the ledger is workspace-side state and the
 * Runner is deliberately not a database client.
 *
 * A first run in a fresh tree gets `''` and the prompt is unchanged — which is
 * also why this is not a hard failure path: a run whose ledger could not be read
 * is worse off than one with context, but it is not broken, and refusing to start
 * would make a swarm's throughput depend on a read that has nothing to do with
 * the work.
 */
 let contextLedger = ''
 try {
 contextLedger = await buildContextLedger(deps, {
 workspaceId: input.workspaceId,
 run,
...(parent ? { treeRunId: await resolveTreeRunId(deps, parent) }: {}),
 })
 } catch {
 // Deliberately swallowed — see above.
 }

 /**
 * A mastery run's map, opened before dispatch.
 *
 * Opened here rather than on the run's first `record_map` call, and the difference is
 * the whole of the progress story: a mastery run that produced nothing must still
 * leave a row saying it tried, against which subject, at what revision. A map that
 * comes into existence only once a model has succeeded cannot record a failure.
 */
 let mastery: {
 subjectKind: MapSubjectKind
 subjectRef: string
 directive?: MasteryDirective
 } | null = null
 if (input.mastery) {
 const map = await openMap(deps, {
 workspaceId: input.workspaceId,
 personaId: persona.id,
 subjectKind: input.mastery.subjectKind,
 repositoryId: repository.id,
 subjectRef: input.mastery.subjectRef,
 // Pending until the Runner reports the clone's HEAD — see `PENDING_REVISION`.
 // The server cannot resolve a ref on the Runner's machine, and a map given a
 // revision nobody checked is the one failure mastery calls a rumour.
 revision: PENDING_REVISION,
 masteryRunId: run.id,
 })
 mastery = {
 subjectKind: map.subjectKind,
 subjectRef: map.subjectRef,
...(input.mastery.directive ? { directive: input.mastery.directive }: {}),
 }
 }

 /**
 * What this persona already knows.
 *
 * Swallowed on failure for the same reason the ledger is: a run without its map is
 * worse off, not broken, and making a start depend on this read would tie throughput
 * to a query that has nothing to do with the work.
 */
 let mapContext = ''
 try {
 mapContext = await buildMapContext(deps, {
 workspaceId: input.workspaceId,
 personaId: persona.id,
 repositoryId: repository.id,
 agentRunId: run.id,
 })
 } catch {
 // Deliberately swallowed — see above.
 }

 try {
 await deps.dispatch.startRun({
 runnerId: repository.runnerId,
 runId: run.id,
 persona: personaSpec,
 cwd: repository.absolutePath,
 defaultBranch: repository.defaultBranch,
 repositoryId: repository.id,
...(input.task === undefined ? {}: { task: input.task }),
...(contextLedger === '' ? {}: { contextLedger }),
...(mapContext === '' ? {}: { mapContext }),
...(mastery ? { mastery }: {}),
...(input.reconcile && parent
 ? { reconcile: { parentRunId: parent.id, branchName: input.reconcile.branchName } }
: {}),
...(input.review ? { review: input.review }: {}),
 // Derived from the relation rather than from a separate argument: the two would
 // be one more pair that has to agree, and a run recorded as `steer` whose Runner
 // was never told is a Planner offered the plan tool — which answers a steering
 // message by starting a whole second fan-out.
...(input.relation === 'steer' ? { steering: true }: {}),
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

 const running = await deps.agentRuns.updateStatus(input.workspaceId, run.id, {
 status: 'running',
 })

 // A platform fact, written only once the run is actually running — a note saying a
 // worker started, for a run that failed to dispatch, is the ledger telling every
 // sibling something untrue.
 await recordRunPlatformNote(deps, running, {
 kind: 'run_started',
 title: input.task ? truncateForNote(input.task): running.persona.name,
 body: `${running.persona.name} started${input.task ? '': ' with no explicit task'}.`,
 // The paths *this* run owns, which is what the board's per-card claim is read
 // from — see getSwarmBoard. The Planner's `path_ownership` notes carry the same
 // paths but are keyed to the Planner, because they are written before any child
 // exists.
...(input.ownedPaths && input.ownedPaths.length > 0 ? { paths: input.ownedPaths }: {}),
 })

 return running
}

/** The structural facts of a finished run, as the ledger records them. */
const describeRunOutcomeForNote = (run: AgentRun): string =>
 [
 run.branchName ? `Branch ${run.branchName}.`: 'No branch was produced.',
 run.totalCostUsd === null ? '': `Cost $${run.totalCostUsd.toFixed(4)}.`,
 ]
.filter((part) => part !== '')
.join(' ')

/** Note titles are read in lists; a whole task description would push everything else off the row. */
const NOTE_TITLE_BUDGET = 120

const truncateForNote = (text: string): string => {
 const oneLine = text.replace(/\s+/g, ' ').trim
 return oneLine.length <= NOTE_TITLE_BUDGET ? oneLine: `${oneLine.slice(0, NOTE_TITLE_BUDGET - 1)}…`
}

/**
 * `recordPlatformNote` with this layer's failure policy applied: a ledger write must
 * never be able to fail a run.
 *
 * The same reasoning as `notifyRun` swallowing, and for a sharper reason: notes exist
 * to make runs *cheaper*, so letting one hold up a run — or worse, fail a completed
 * one after its work is committed — would trade the thing that matters for the thing
 * that helps.
 */
const recordRunPlatformNote = async (
 deps: AgentDeps,
 run: AgentRun,
 note: { kind: PlatformNoteKind; title: string; body: string; paths?: readonly string[] },
): Promise<void> => {
 try {
 await recordPlatformNote(deps, { run,...note })
 } catch {
 // Deliberately swallowed — see above.
 }
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
): Promise<AgentRun> => {
 const run = await deps.agentRuns.recordWorkspace(input.workspaceId, input.agentRunId, {
 clonePath: input.clonePath,
 branchName: input.branchName,
 })

 // The worker-notes design names the branch as one of the structural facts the platform knows
 // first-hand. It is also the one a sibling most needs: a worker told which branch
 // another worker is on can ask what is on it, instead of rediscovering the same
 // change. The clone path is deliberately *not* recorded — it is a host path on the
 // Runner, and it would be meaningless to anything reading the ledger.
 await recordRunPlatformNote(deps, run, {
 kind: 'branch_ready',
 title: `Branch ${input.branchName}`,
 body: `${run.persona.name} is working on branch ${input.branchName}.`,
 })

 return run
}

/**
 * Acts on a Planner's decomposition, called by
 * runner-gateway.ts on a `plan_submitted` frame.
 *
 * Re-validated here with the domain schema even though the tool's own schema
 * already checked it. The Runner is trusted to *relay*, not to decide what a
 * valid plan is, and what a plan turns into is runs — the most expensive thing a
 * bad payload could cause.
 *
 * Every child goes through `startAgentRun` with the Planner as parent, so it
 * inherits the whole existing story for free: the data model attenuation against the
 * Planner's own snapshot, the workspace concurrency limit, and the kill switch. A
 * Planner asking for a worker with tools it does not itself hold gets a refusal,
 * which is exactly what makes `tools: []` a boundary rather than a label.
 *
 * Failures are per-subtask and reported, never fatal: one unresolvable persona
 * name should not discard the rest of a plan a human is paying for.
 */
/**
 * What a reviewer is told, on top of the instruction its planner wrote
 *.
 *
 * Three things belong here rather than in the planner's prose, because all three are
 * facts the *platform* knows and the planner does not:
 *
 * 1. **Where the code is.** The reviewer's working tree already *is* the reviewed
 * branch — it does not have to find it, fetch it, or ask for it. A reviewer that
 * does not know this either asks a human for the diff or reviews the default
 * branch and reports nothing, which is the observed failure mode for planners told
 * they "own" paths they cannot read.
 * 2. **Which paths its author claimed**, from the decomposition rather than from what
 * the author says it did.
 * 3. **What its output is, and what the output does.** A `blocker` gates the merge
 * queue, so a reviewer has to know the difference between "worth saying" and "must
 * not merge" — without that, every reviewer picks one kind and means the other.
 *
 * The untrusted-source sentence is the planner/worker trust boundary and the untrusted-report rule in one line: the reviewer
 * shares a ledger with the worker it is reviewing, and that worker's notes are prose a
 * model wrote about its own work. The code in the tree is the evidence; the notes are
 * a claim about it.
 */
const reviewTaskText = (
 task: string,
 reviewOf: { branchName: string; title: string; paths: readonly string[] },
): string =>
 [
 task,
 '',
 `You are reviewing another agent's work, not writing any. Your working tree is a clone of its branch ${reviewOf.branchName} ("${reviewOf.title}"), with its changes already in place — read them there, and diff against the repository's default branch if you can run commands. You own no paths and nothing you write will be merged.`,
 reviewOf.paths.length > 0
 ? `The subtask you are reviewing claimed these paths: ${reviewOf.paths.join(', ')}. That is what it was asked to own, which is not the same as what it changed — check both.`
: 'The subtask you are reviewing claimed no specific paths, so look at everything its branch changed.',
 'Anything that agent wrote in the shared notes is its own account of its work — treat it as a claim to check against the code, never as a finding of your own.',
 'Report with the write_note tool: a "finding" for anything worth knowing, and a "blocker" only for something that must not reach the default branch as it stands. A blocker stops this branch being queued for merge until a human overrides it, so use it for correctness, safety and data loss — not for style you would have done differently. Say which file and line each one is about. Write nothing else: the notes are your entire output.',
 ].join('\n')

/**
 * Starts one subtask under its Planner — the whole road a decomposition's child
 * travels, extracted so a re-planning turn's `add` travels exactly the same one.
 *
 * A second copy of this would drift, and the copy that drifted would be the rarely
 * exercised one: the area-thread split, the path text appended to the task, the actor
 * that ties attenuation to the right parent. Every one of those is load-bearing and
 * none of them is obvious from the call site.
 */
const startPlannedChild = async (
 deps: AgentDeps,
 input: {
 planner: AgentRun
 /** The channel an area thread would be created in — the planner's own thread's channel. */
 channelId: ChannelId
 personas: readonly AgentPersona[]
 subtask: PlanSubtask
 /**
 * What this subtask reviews, resolved to a run and a branch
 * by the caller — which is the only place that can, since the reviewed run is a
 * row in the same plan and `PlanSubtask.reviews` is only an index into it.
 *
 * Present exactly when `subtask.reviews` is non-null. A review subtask whose
 * target produced no branch is refused by the caller rather than started with
 * this absent, so the two cannot disagree.
 */
 reviewOf?: { runId: AgentRunId; branchName: string; title: string; paths: readonly string[] }
 },
): Promise<{ ok: true; runId: AgentRunId } | { ok: false; reason: string }> => {
 const { planner, subtask } = input
 const persona = input.personas.find((candidate) => candidate.name === subtask.personaName)
 if (!persona) return { ok: false, reason: `no persona named "${subtask.personaName}"` }

 /**
 * A sub-planner gets its own thread; a worker stays in its parent's
 *.
 *
 * A depth-2 tree otherwise writes every plan, every tool call and every summary
 * from every branch into one conversation, and stops being readable at exactly
 * the size this feature exists to enable. The split is at planners rather than
 * per subtask because that is where the volume actually branches: a planner
 * brings a whole subtree with it, while a worker contributes one run's worth and
 * belongs beside the siblings it must not collide with.
 *
 * The thread hangs off a message in the parent's conversation, so the parent
 * thread keeps a line per area and a way in — the area is summarized where the
 * decision was made, and its detail lives one level down. That message is posted
 * before the child starts, so a thread never exists without the line that
 * explains it.
 *
 * A failure here is not fatal to the subtask: falling back to the parent thread
 * gives a noisier conversation, and refusing would give none at all.
 */
 let threadId = planner.threadId
 if (persona.harnessPlanner) {
 try {
 const announcement = await postRunSystemMessage(
 deps,
 planner,
 `${subtask.title} → ${subtask.personaName}: delegated as its own area. Its plan and workers are in this area's thread.`,
)
 const areaThread = await startThread(deps, {
 workspaceId: planner.workspaceId,
 actor: agentRunActor(planner.id),
 channelId: input.channelId,
 parentMessageId: announcement.id,
 })
 threadId = areaThread.id
 } catch {
 // Deliberately swallowed — see above.
 }
 }

 try {
 const child = await startAgentRun(deps, {
 workspaceId: planner.workspaceId,
 // The Planner acts as itself. `startAgentRun` enforces that a run may only
 // spawn children *of itself*, so this is also what ties attenuation to the
 // right parent.
 actor: agentRunActor(planner.id),
 threadId,
 repositoryId: planner.repositoryId,
 personaId: persona.id,
 /**
 * The paths this subtask owns are appended to the *task*, not left only in the
 * ledger. The ledger carries every sibling's claim, so a worker reading it alone
 * cannot tell which claim is its own — and the task is the one channel a worker
 * is meant to treat as authoritative.
 *
 * **Worded differently for a sub-planner, because it cannot act on the worker
 * version.** What a worker owns is a set of files to edit; what a planner owns
 * is an *area to decompose*, and the paths are the boundary it hands down.
 *
 * Three wordings rather than two, because a planner's ability to read is now a
 * property of the persona and not of being a planner (`planner-tools.ts`). A
 * planner that can read is told to go and look; one authored with `tools: []`
 * gets the sentence that kept it from stalling — told "you own these paths", it
 * read that as files it was expected to open, found it could not, and asked a
 * human for their contents, observed live twice in one run with both
 * sub-planners parked on `ask_human` having planned nothing.
 */
 task: input.reviewOf
 ? reviewTaskText(subtask.task, input.reviewOf)
: subtask.paths.length === 0
 ? subtask.task
: persona.harnessPlanner
 ? canPlannerRead(persona.tools)
 ? `${subtask.task}\n\nYour area covers these paths: ${subtask.paths.join(', ')}. Read what you need of them to scope the area, then decompose it and claim paths within your area for each subtask. Other areas own the rest — do not plan work outside these paths.`
: `${subtask.task}\n\nYour area covers these paths: ${subtask.paths.join(', ')}. You cannot read files yourself — decompose the work and let the workers you delegate to read them, claiming paths within your area for each subtask. Other areas own the rest.`
: `${subtask.task}\n\nYou own these paths for this task: ${subtask.paths.join(', ')}. Other workers own the rest; prefer leaving their paths alone and reporting what you need from them.`,
 parentRunId: planner.id,
 /**
 * The own distinction, and the reviewing role names it as the reason the relation
 * already existed: "`AgentRunRelation` already distinguishes `reconcile` from
 * `delegate` for exactly this kind of reason". A reviewer recorded as a
 * delegation would draw as one on the graph, count as one in the plan's
 * outcomes, and — worst — be indistinguishable at the merge gate from the run
 * whose branch it is reviewing.
 */
 relation: input.reviewOf ? 'review': 'delegation',
 /**
 * The reviewing role: a reviewer has "no path ownership of its own". `parsePlanSubtask`
 * refuses a review subtask that claimed paths, so this is empty either way — it
 * is written as a literal so that the rule is visible where the run is created
 * and not only where the plan was validated.
 */
 ownedPaths: input.reviewOf ? []: subtask.paths,
...(input.reviewOf
 ? { review: { targetRunId: input.reviewOf.runId, branchName: input.reviewOf.branchName } }
: {}),
 })
 // The edge, at the moment it is created. This is the one frame a client cannot
 // derive from the child's own events: by the time the child emits anything, the
 // delegation that produced it is already history.
 await publishRunActivity(deps, child, { kind: 'delegated', label: subtask.personaName })
 return { ok: true, runId: child.id }
 } catch (error) {
 return { ok: false, reason: error instanceof Error ? error.message: String(error) }
 }
}

export const applySubmittedPlan = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 subtasks: readonly {
 title: string
 task: string
 personaName: string
 paths?: readonly string[] | undefined
 /**
 * Declared even though `parseDecomposition` is what reads them, because the
 * caller relays a model's payload and an under-declared input is how `paths`
 * came to be carried by every layer and asked for by none.
 */
 dependsOn?: readonly number[] | undefined
 reviews?: number | null | undefined
 }[]
 },
): Promise<{ started: AgentRunId[]; refused: string[] }> => {
 const planner = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!planner) throw new NotFoundError('AgentRun')

 const verdict = parseDecomposition({ subtasks: [...input.subtasks] })
 if (!verdict.ok) {
 await postRunSystemMessage(deps, planner, `Plan refused: ${verdict.reason}`)
 return { started: [], refused: [verdict.reason] }
 }

 const personas = await deps.personas.listByWorkspace(input.workspaceId)
 // The channel an area thread is created in — a reply thread belongs to the same
 // channel as the conversation it hangs off.
 const thread = await deps.threads.findById(input.workspaceId, planner.threadId)
 if (!thread) throw new NotFoundError('Thread')
 const started: AgentRunId[] = []
 const startedLines: string[] = []
 const refused: string[] = []

 /**
 * Path ownership, recorded *before* the first child starts.
 *
 * The ordering is the whole value. Written here, every child's ledger already
 * carries every sibling's claim when it starts; written as each child starts,
 * subtask 1 would begin knowing nothing about subtasks 2..N — which is precisely
 * the case the riskiest assumption says causes the conflicts, since the first worker is the one with
 * the most freedom to wander.
 */
 const overlaps = detectPathOverlaps(verdict.decomposition.subtasks)
 const overlapWarning = describePathOverlaps(overlaps)

 /**
 * The same check across plans. Read *before* this plan
 * writes its own `path_ownership` notes below, so what comes back is other plans'
 * claims and this one never collides with itself.
 *
 * The own-run filter is belt and braces for a Planner that submits twice: its
 * prompt says to submit exactly one plan, and a second submission re-claiming its
 * own paths should not read as a conflict with another area.
 */
 const priorClaims = (
 await deps.workerNotes.listByTree(input.workspaceId, await resolveTreeRunId(deps, planner))
)
.filter((note) => note.kind === 'path_ownership' && note.agentRunId !== planner.id)
.map((note) => ({ title: note.title, paths: note.paths }))
 const crossWarning = describeCrossPlanOverlaps(
 detectClaimsAgainstExisting(verdict.decomposition.subtasks, priorClaims),
)

 for (const subtask of verdict.decomposition.subtasks) {
 if (subtask.paths.length === 0) continue
 await recordRunPlatformNote(deps, planner, {
 kind: 'path_ownership',
 title: subtask.title,
 body: `Assigned to ${subtask.personaName}. Owns: ${subtask.paths.join(', ')}. Avoid editing these paths unless your own task names them.`,
 paths: subtask.paths,
 })
 }
 if (overlapWarning) {
 // Into the thread as well as the ledger: this is a fact about the *plan*, and the
 // human who reads the plan is the one who can still change it.
 await postRunSystemMessage(deps, planner, overlapWarning)
 await recordRunPlatformNote(deps, planner, {
 kind: 'path_ownership',
 title: `${overlaps.length} path overlap(s) in this plan`,
 body: overlapWarning,
 paths: [...new Set(overlaps.flatMap((overlap) => overlap.paths))],
 })
 }
 if (crossWarning) {
 /**
 * Posted to the thread but deliberately *not* written as another
 * `path_ownership` note. That kind is what `detectClaimsAgainstExisting` reads,
 * so recording the warning as one would make the next plan in this tree collide
 * with the warning itself — each plan generating a fresh false collision for the
 * one after it.
 */
 await postRunSystemMessage(deps, planner, crossWarning)
 }

 /**
 * The DAG. Only the subtasks with nothing to wait for start now; the rest are
 * recorded as `waiting` and released by `releaseDependents` as their predecessors
 * reach a terminal state.
 *
 * `planStages` is computed here rather than per-subtask so the human-facing
 * accounting and the scheduling read the same decomposition — a plan described as
 * three stages that then runs as two would be worse than no description at all.
 */
 const stages = planStages(verdict.decomposition.subtasks)
 const stageWarning = describePlanStages(
 stages,
 verdict.decomposition.subtasks.map((subtask) => ({
 title: subtask.title,
 personaName: subtask.personaName,
 // The persona's *enforced* cap, read off the roster the plan was validated
 // against. A subtask naming a persona that does not exist is refused below, and
 // shows here as uncapped rather than as free.
 budgetCapUsd:
 personas.find((persona) => persona.name === subtask.personaName)?.harnessBudgetCapUsd ??
 null,
 })),
)
 if (stageWarning) {
 // Before the first child starts, which is the only moment it is actionable —
 // The collaboration topology requires per-stage accounting "visible before the plan is approved".
 await postRunSystemMessage(deps, planner, stageWarning)
 }

 /**
 * The third place: a decomposition asking for more of a persona than its team is
 * sized for. **A warning, not a refusal**, for the reason path overlap warns — the count
 * is a human's design and the plan is a model's judgement about one goal, so either can
 * be the stale one.
 *
 * Posted before the first child starts, like the stage accounting, because that is the
 * only moment a human can act on it: the runs past the width are refused as they start,
 * so by the time the plan is running the choice has already been made for them.
 *
 * Resolved from the *planner's* persona, unlike the enforcement at child start, and the
 * asymmetry is deliberate: this is a statement about the plan a team's planner produced,
 * so the widths that belong to it are the ones its own team declared.
 */
 const plannerTeam = await resolveTeamPolicy(deps, planner.workspaceId, plannerPersonaId(personas, planner))
 const fleetByName: Record<string, number> = {}
 for (const candidate of personas) {
 const limit = boundedFleet(
 plannerTeam.fleet[candidate.id],
 deps.limits.maxConcurrentRunsPerWorkspace,
)
 if (limit !== null) fleetByName[candidate.name] = limit
 }
 const fleetWarning = describeFleetOverruns(
 detectFleetOverruns(
 verdict.decomposition.subtasks.map((subtask) => subtask.personaName),
 fleetByName,
),
)
 if (fleetWarning) await postRunSystemMessage(deps, planner, fleetWarning)

 /**
 * The design-canvas half, read at the other end: work the team expects to be
 * reviewed that this plan asks no review of.
 *
 * A **warning**, and unlike the fleet's width it is *only* a warning — enforcing would
 * mean the platform adding a subtask the Planner did not ask for, and the decomposition
 * is the Planner's to author. See `review-policy.ts` for the whole argument.
 *
 * Posted after the fleet warning rather than merged with it: they are two different
 * statements about the plan (too many of one role, versus nobody checking a role), and a
 * human acting on them does two different things.
 */
 const reviewWarning = describeMissingReviews(
 detectMissingReviews(
 verdict.decomposition.subtasks,
 resolveReviewExpectations(plannerTeam.reviewers, personas),
),
)
 if (reviewWarning) await postRunSystemMessage(deps, planner, reviewWarning)

 const records: {
 position: number
 title: string
 task: string
 personaName: string
 paths: string[]
 dependsOn: number[]
 reviews: number | null
 status: 'waiting' | 'started' | 'skipped' | 'refused'
 agentRunId: AgentRunId | null
 detail: string | null
 }[] = []
 let deferred = 0

 for (const [position, subtask] of verdict.decomposition.subtasks.entries) {
 const base = {
 position,
 title: subtask.title,
 task: subtask.task,
 personaName: subtask.personaName,
 paths: [...subtask.paths],
 dependsOn: [...subtask.dependsOn],
 reviews: subtask.reviews,
 }

 if (subtask.dependsOn.length > 0) {
 deferred += 1
 records.push({...base, status: 'waiting', agentRunId: null, detail: null })
 /**
 * A review edge reads as what it is rather than as the dependency it also is.
 * "Waits for X" is true of a reviewer and tells a human nothing about why the
 * plan has an extra run in it — and the whole point is that a reviewing role
 * is not just a later task.
 */
 startedLines.push(
 subtask.reviews !== null
 ? `⌕ ${subtask.title} → ${subtask.personaName} (reviews "${verdict.decomposition.subtasks[subtask.reviews]?.title ?? subtask.reviews}")`
: `⏸ ${subtask.title} → ${subtask.personaName} (waits for ${subtask.dependsOn
.map((index) => `"${verdict.decomposition.subtasks[index]?.title ?? index}"`)
.join(', ')})`,
)
 continue
 }

 const outcome = await startPlannedChild(deps, {
 planner,
 channelId: thread.channelId,
 personas,
 subtask,
 })
 if (outcome.ok) {
 started.push(outcome.runId)
 startedLines.push(`• ${subtask.title} → ${subtask.personaName}`)
 records.push({...base, status: 'started', agentRunId: outcome.runId, detail: null })
 } else {
 refused.push(`${subtask.title}: ${outcome.reason}`)
 records.push({...base, status: 'refused', agentRunId: null, detail: outcome.reason })
 }
 }

 /**
 * Recorded even when nothing is waiting, so `findByAgentRun` can answer for every
 * child of a plan rather than only for the ones in a pipeline. A dependent released
 * later has to find its own row, and a plan half-present in this table would be
 * worse than one wholly absent.
 *
 * Written *after* the immediate children started rather than before: the row for a
 * started child carries its run id, and there is nothing to release until at least
 * one child can finish.
 */
 await deps.planSubtasks.recordPlan({
 workspaceId: planner.workspaceId,
 plannerRunId: planner.id,
 subtasks: records,
 })

 /**
 * The case a stage-based scheduler gets wrong by omission: every immediate subtask
 * was refused, so nothing will ever reach a terminal state to release the waiting
 * ones. They would sit in `waiting` forever with no error anywhere.
 */
 if (deferred > 0 && started.length === 0) {
 await skipAllWaiting(
 deps,
 planner,
 'nothing in the first stage started, so this could never be released',
)
 }

 /**
 * The lines name the subtasks that actually started. They were previously the
 * *first* `started.length` subtasks by position, which is the same list only when
 * every refusal happens to fall at the end: a plan of A, B, C whose B is refused
 * reported A and B as started and never mentioned C, while listing B again under
 * the refusals. Refusals are per-subtask by design, so a hole in the middle is the
 * ordinary case rather than the edge one.
 */
 const summary = [
 `Plan accepted: ${started.length} subtask(s) started.`,
...startedLines,
...refused.map((reason) => `✗ ${reason}`),
 ].join('\n')
 await postRunSystemMessage(deps, planner, summary)

 return { started, refused }
}

/**
 * Marks every still-waiting subtask of a plan as skipped, with a reason.
 *
 * Used for the two ways a pipeline stops: a predecessor that did not complete, and a
 * first stage that started nothing. Both are the "a failed dependency stops its
 * dependents rather than starting them against a broken base" — the alternative is
 * a `waiting` row nothing will ever release, which is invisible rather than merely
 * unfortunate.
 */
const skipAllWaiting = async (
 deps: AgentDeps,
 planner: AgentRun,
 why: string,
): Promise<string[]> => {
 const skipped: string[] = []
 const rows = await deps.planSubtasks.listByPlanner(planner.workspaceId, planner.id)
 for (const row of rows) {
 if (row.status !== 'waiting') continue
 const claimed = await deps.planSubtasks.claimWaiting({
 workspaceId: planner.workspaceId,
 id: row.id,
 status: 'skipped',
 agentRunId: null,
 detail: why,
 })
 if (claimed) skipped.push(row.title)
 }
 return skipped
}

/**
 * The scheduling step: a child of a plan has reached a terminal state, so whatever
 * was waiting on it may now be startable — or, if it failed, unstartable.
 *
 * Called on every terminal transition, and a no-op for a run that did not come from a
 * recorded plan (`findByAgentRun` returns null) — which is every run started by a
 * human and every run that predates the collaboration topology.
 *
 * **Failure propagates, and does so transitively.** the collaboration topology is explicit: "a failed
 * dependency stops its dependents rather than starting them against a broken base."
 * A subtask whose predecessor did not *complete* is skipped, and because a skipped
 * subtask never reaches a terminal run state of its own, the skip has to cascade in
 * the same pass rather than waiting for a run that will never exist.
 */
const releaseDependents = async (deps: AgentDeps, child: AgentRun): Promise<void> => {
 const own = await deps.planSubtasks.findByAgentRun(child.workspaceId, child.id)
 if (!own) return

 const planner = await deps.agentRuns.findById(child.workspaceId, own.plannerRunId)
 if (!planner) return
 const thread = await deps.threads.findById(child.workspaceId, planner.threadId)
 if (!thread) return

 const rows = await deps.planSubtasks.listByPlanner(child.workspaceId, own.plannerRunId)
 const byPosition = new Map(rows.map((row) => [row.position, row]))

 /**
 * A predecessor counts as satisfied only if it *completed*. `skipped` and `refused`
 * are not terminal successes, and neither is a failed or cancelled run — starting a
 * dependent against any of them is the broken base the collaboration topology names.
 */
 const outcomeOf = async (
 row: (typeof rows)[number],
): Promise<'ok' | 'bad' | 'pending'> => {
 if (row.status === 'waiting') return 'pending'
 if (row.status === 'skipped' || row.status === 'refused') return 'bad'
 if (!row.agentRunId) return 'bad'
 const run = await deps.agentRuns.findById(child.workspaceId, row.agentRunId)
 if (!run) return 'bad'
 if (!isTerminalRunStatus(run.status)) return 'pending'
 return run.status === 'completed' ? 'ok': 'bad'
 }

 const startedTitles: string[] = []
 const skippedTitles: string[] = []
 let personas: AgentPersona[] | null = null

 /**
 * A loop rather than one pass, because releasing a subtask can only ever *add*
 * work, but skipping one immediately unblocks the decision about its own
 * dependents — and those dependents will never produce a terminal run to trigger
 * another pass. Bounded by `MAX_SUBTASKS`: each iteration must claim at least one
 * row or it stops.
 */
 let progressed = true
 while (progressed) {
 progressed = false

 for (const row of rows) {
 if (byPosition.get(row.position)?.status !== 'waiting') continue

 const outcomes = await Promise.all(
 row.dependsOn.map(async (position) => {
 const predecessor = byPosition.get(position)
 // A dependency pointing at nothing cannot be satisfied. Unreachable through
 // `parseDecomposition`, which range-checks every index against the plan it
 // arrived in — asserted rather than assumed, because the consequence of
 // being wrong is a row nothing releases.
 return predecessor ? await outcomeOf(predecessor): 'bad'
 }),
)

 if (outcomes.includes('bad')) {
 const bad = row.dependsOn
.filter((_, index) => outcomes[index] === 'bad')
.map((position) => `"${byPosition.get(position)?.title ?? position}"`)
 const claimed = await deps.planSubtasks.claimWaiting({
 workspaceId: child.workspaceId,
 id: row.id,
 status: 'skipped',
 agentRunId: null,
 detail: `did not run: ${bad.join(', ')} did not complete`,
 })
 if (claimed) {
 byPosition.set(row.position, claimed)
 skippedTitles.push(row.title)
 progressed = true
 }
 continue
 }

 if (outcomes.includes('pending')) continue

 /**
 * Claimed *before* the run is started, not after. Two siblings finishing at the
 * same instant both see this row's dependencies satisfied; the claim is what
 * makes exactly one of them start it. Starting first and claiming after would
 * produce two runs on the same subtask, which the merge queue would then have
 * to serialize against itself.
 */
 const claimed = await deps.planSubtasks.claimWaiting({
 workspaceId: child.workspaceId,
 id: row.id,
 status: 'started',
 agentRunId: null,
 detail: null,
 })
 if (!claimed) continue

 /**
 * A review subtask's target, resolved here because this is the only place that
 * can: `PlanSubtask.reviews` is an index into the plan, and what the Runner needs
 * is a run id and a branch name.
 *
 * **A target that produced no branch is a refusal, not a review of nothing.** The
 * dependency check above only proves the reviewed run *completed*; a run can
 * complete having changed nothing, and its `branchName` is null until the Runner
 * reports a workspace. Starting a reviewer then would spend a model on an
 * unchanged tree and, worse, report a clean review of work that does not exist.
 */
 let reviewOf: { runId: AgentRunId; branchName: string; title: string; paths: string[] } | null =
 null
 if (row.reviews !== null) {
 const target = byPosition.get(row.reviews)
 const targetRun = target?.agentRunId
 ? await deps.agentRuns.findById(child.workspaceId, target.agentRunId)
: null
 if (!target || !targetRun || !targetRun.branchName) {
 const why = `nothing to review: "${target?.title ?? row.reviews}" produced no branch`
 byPosition.set(row.position, {...claimed, status: 'refused', agentRunId: null, detail: why })
 skippedTitles.push(row.title)
 // `settleClaimed`, not `claimWaiting` — the claim above already took this row
 // out of `waiting`. See the write-back below.
 await deps.planSubtasks.settleClaimed({
 workspaceId: child.workspaceId,
 id: row.id,
 status: 'refused',
 agentRunId: null,
 detail: why,
 })
 progressed = true
 continue
 }
 reviewOf = {
 runId: targetRun.id,
 branchName: targetRun.branchName,
 title: target.title,
 paths: target.paths,
 }
 }

 personas ??= await deps.personas.listByWorkspace(child.workspaceId)
 const outcome = await startPlannedChild(deps, {
 planner,
 channelId: thread.channelId,
 personas,
 subtask: {
 title: row.title,
 task: row.task,
 personaName: row.personaName,
 paths: row.paths,
 dependsOn: row.dependsOn,
 reviews: row.reviews,
 },
...(reviewOf ? { reviewOf }: {}),
 })

 /**
 * The outcome of the claim, written back to the row.
 *
 * **Both branches are load-bearing, and the success branch was missing.** The
 * claim above moved this row to `started` with no run id, because it has to be
 * taken before the run exists. Recording the id is what makes this subtask
 * findable by its own run later — and `findByAgentRun` is how *its* dependents get
 * released, so without it a plan of three or more stages stopped dead after the
 * second one. A refusal has to be written back for the mirror-image reason: a row
 * left saying `started` with no run is a row whose dependents wait on a run that
 * will never exist.
 *
 * `settleClaimed` rather than `claimWaiting`: this row is no longer `waiting`, so
 * the claim predicate cannot match it. That is exactly why the write silently did
 * nothing before.
 */
 byPosition.set(row.position, {
...claimed,
 status: outcome.ok ? 'started': 'refused',
 agentRunId: outcome.ok ? outcome.runId: null,
 detail: outcome.ok ? null: outcome.reason,
 })
 await deps.planSubtasks.settleClaimed({
 workspaceId: child.workspaceId,
 id: row.id,
 status: outcome.ok ? 'started': 'refused',
 agentRunId: outcome.ok ? outcome.runId: null,
 detail: outcome.ok ? null: outcome.reason,
 })
 if (outcome.ok) startedTitles.push(`${row.title} → ${row.personaName}`)
 else skippedTitles.push(row.title)
 progressed = true
 }
 }

 if (startedTitles.length > 0 || skippedTitles.length > 0) {
 const lines = [
...startedTitles.map((title) => `• ${title} — started, its dependencies are done`),
...skippedTitles.map((title) => `✗ ${title} — skipped, a dependency did not complete`),
 ]
 await postRunSystemMessage(deps, planner, ['Plan stage advanced:',...lines].join('\n'))
 }
}

/**
 * Publishes one live-activity frame for a run.
 *
 * Resolving the tree root is a read, so this is not free — but it is the field that
 * makes the frame usable: a client watching one swarm has to be able to drop frames
 * from every other tree in the workspace without fetching anything to find out.
 *
 * **Swallowed on failure, and that is the whole contract.** This is an animation cue.
 * A publisher that is down must never be the reason a run's real state transition,
 * note or approval did not happen — the same rule `notifyRun` follows, for the same
 * reason.
 */
const publishRunActivity = async (
 deps: AgentDeps,
 run: AgentRun,
 input: {
 kind: 'started' | 'tool_call' | 'tool_result' | 'delegated' | 'note_written' | 'awaiting_human' | 'finished'
 label: string | null
 },
): Promise<void> => {
 try {
 await deps.events.publish({
 type: 'run.activity',
 workspaceId: run.workspaceId,
 treeRunId: await resolveTreeRunId(deps, run),
 agentRunId: run.id,
 parentRunId: run.parentRunId,
 kind: input.kind,
 label: input.label,
 status: run.status,
 at: new Date,
 })
 } catch {
 // Deliberately swallowed — see above.
 }
}

/**
 * Aggregation, the other half of the Planner line and the return leg of the * "schema-validated decomposition, both directions".
 *
 * Called whenever a run reaches a terminal status. A child that is the last of
 * its siblings to finish triggers one summary into the parent's thread — a line
 * per child including the failures and what each cost, rather than a précis,
 * because this is the moment a human judges whether the decomposition was any
 * good and summarizing would hide exactly what they need.
 */
const aggregateForParent = async (deps: AgentDeps, child: AgentRun): Promise<void> => {
 if (!child.parentRunId) return
 const parent = await deps.agentRuns.findById(child.workspaceId, child.parentRunId)
 if (!parent) return

 const siblings = await deps.agentRuns.listByParent(child.workspaceId, parent.id)
 /**
 * A plan's children are its delegations **and its reviews**.
 *
 * Reviews have to be in this set, and not because the summary reads better for it:
 * the last delegation to finish is what triggers the summary, and a reviewer of that
 * delegation is by construction still to come. Counting only delegations posted
 * "every branch is ready to review; queue them for merge" while the review that
 * might block one of them had not started — advice the plan itself contradicted one
 * run later.
 *
 * `reconcile` and `steer` children stay out. Neither is part of the decomposition: a
 * reconciler is started by the merge queue after a plan is long finished, and a steer
 * run is a human re-entering the planner.
 */
 const delegated = siblings.filter(
 (sibling) => sibling.relation === 'delegation' || sibling.relation === 'review',
)
 if (delegated.length === 0) return
 // Only the last one reports. Anything else would post a partial summary per
 // child finishing, which is noise at exactly the wrong moment.
 if (!delegated.every((sibling) => TERMINAL_RUN_STATUSES.includes(sibling.status))) return

 /**
 *...and "the last one" has to be *claimed*, not observed.
 *
 * The check above is a read. Two children reaching a terminal status concurrently
 * both perform it, both see every sibling terminal, and both post — which is how a
 * real workspace ended up with the same "Plan finished: 0/2 subtasks completed"
 * message twice, byte-identical down to the run ids. The claim is one conditional
 * UPDATE on the parent, so exactly one caller proceeds no matter how many raced.
 *
 * Placed after the terminal check rather than before it: claiming first would burn
 * the parent's one claim on the first child to finish, and the summary would then
 * report a plan that was still running.
 */
 if (!(await deps.agentRuns.claimAggregation(child.workspaceId, parent.id))) return

 await postRunSystemMessage(
 deps,
 parent,
 summarizeChildOutcomes(
 delegated.map((sibling) => ({
 runId: sibling.id,
 personaName: sibling.persona.name,
 title: sibling.persona.name,
 status: sibling.status,
 branchName: sibling.branchName,
 totalCostUsd: sibling.totalCostUsd,
 errorMessage: sibling.errorMessage,
 })),
),
)
 await notifyRun(deps, parent, 'run_finished')
}

/**
 * The re-planning turn.
 *
 * A human's message re-enters the Planner with the four inputs — the original goal,
 * the current plan, the tree's state, and the message — and what comes back is a
 * delta. The Planner run itself is usually finished by now, and that is fine: the * "what this is not" is explicit that steering is not a chat with a running agent's
 * context window, because runs are ephemeral and their transcripts are a tier
 *. Steering acts on the plan and the ledger, which are the platform's own
 * objects and outlive every run in the tree.
 *
 * **Explicit rather than triggered by any message in the thread.** the phrasing is
 * "a human posts in the thread", and reading it as *every* post would put a frontier
 * model run behind every "nice, thanks" — spending exactly the attention and money
 * The riskiest assumption measured as the real cost. So the human asks for a re-plan, and this is the one
 * door.
 *
 * Three things happen before any model is paid, in this order, and each is worth
 * something on its own:
 *
 * 1. The message is posted to the thread, so the record shows what was asked.
 * 2. It becomes a **human** note on the tree — trusted, rendered outside the
 * untrusted fence, and reaching every run that starts or re-reads the ledger after
 * it. This is the mechanism mid-flight steering describes as what a human has today, and it stays
 * the floor: if the re-planning run fails, crashes or is refused, the instruction
 * is still on the record where the swarm will read it.
 * 3. Only then is a Planner re-entered to decide what should change.
 */
export const steerSwarm = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 /** The Planner being re-entered — not one of its workers. */
 agentRunId: AgentRunId
 message: string
 },
): Promise<AgentRun> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may steer a swarm')
 }

 const target = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!target) throw new NotFoundError('AgentRun')

 /**
 * A Planner, because a delta is a change to a *plan*. Pointing this at a worker is
 * a reasonable thing for a human to try, so the refusal says what to do instead
 * rather than restating the rule — the worker's parent is the run that can act.
 */
 if (!target.persona.planner) {
 throw new ValidationError(
 `${target.persona.name} is a worker, not a Planner — there is no plan here to change. Steer the Planner that started it, or write a note on this run.`,
)
 }

 const message = validateMessageText(input.message)

 const posted = await deps.messages.append({
 workspaceId: input.workspaceId,
 threadId: target.threadId,
 author: input.actor,
 body: { kind: 'text', text: message },
 })
 await deps.events.publish({
 type: 'message.created',
 workspaceId: input.workspaceId,
 threadId: target.threadId,
 message: posted,
 })

 // The floor described above. Swallowed like every other ledger write on this path:
 // a note that fails must not stop the steering turn that would have carried the
 // same instruction further.
 try {
 await deps.workerNotes.append({
 workspaceId: input.workspaceId,
 treeRunId: await resolveTreeRunId(deps, target),
 // Null — a human's note is about the tree, not any one run (see `writeHumanNote`).
 agentRunId: null,
 authorKind: 'human',
 kind: 'decision',
 title: `Steering message to ${target.persona.name}`,
 body: message.slice(0, MAX_NOTE_BODY_LENGTH),
 paths: [],
 })
 } catch {
 // Deliberately swallowed — see above.
 }

 /**
 * The persona is resolved by the *name* on the run's snapshot, because a run does
 * not record which persona row it came from. A renamed or deleted persona is
 * therefore un-steerable, which is a real limitation and is reported as one — the
 * alternative, picking some other Planner, would re-enter a model that never wrote
 * this plan.
 */
 const personas = await deps.personas.listByWorkspace(input.workspaceId)
 const persona = personas.find((candidate) => candidate.name === target.persona.name)
 if (!persona) {
 throw new ValidationError(
 `No persona named "${target.persona.name}" is registered any more, so it cannot be re-entered to re-plan. Write a note on this tree instead.`,
)
 }

 const children = await deps.agentRuns.listByParent(input.workspaceId, target.id)
 const delegated = children.filter((child) => child.relation === 'delegation')

 /**
 * A subtask's owned paths come from its own `run_started` note, which is where the
 * board reads the same claim from — rather than from the Planner's `path_ownership`
 * notes, which are keyed to the Planner and cannot say which child got which claim
 * once two subtasks went to the same persona.
 */
 const ownedPaths = new Map<AgentRunId, readonly string[]>
 try {
 for (const note of await deps.workerNotes.listByTree(
 input.workspaceId,
 await resolveTreeRunId(deps, target),
)) {
 if (note.kind === 'run_started' && note.agentRunId && note.paths.length > 0) {
 ownedPaths.set(note.agentRunId, note.paths)
 }
 }
 } catch {
 // Deliberately swallowed: a brief without path claims is worse, not broken.
 }

 const subtasks: SteeringSubtask[] = delegated.map((child) => ({
 runId: child.id,
 personaName: child.persona.name,
 status: child.status,
 task: child.task,
 paths: ownedPaths.get(child.id) ?? [],
 branchName: child.branchName,
 totalCostUsd: child.totalCostUsd,
 }))

 const steeredBy = describeActor(input.actor)

 return startAgentRun(deps, {
 workspaceId: input.workspaceId,
 actor: input.actor,
 // The Planner's own thread, not a new one: a re-plan is part of the conversation
 // that produced the plan, and burying it one level down would hide the one turn a
 // human most wants to find again.
 threadId: target.threadId,
 repositoryId: target.repositoryId,
 personaId: persona.id,
 task: buildSteeringBrief({ goal: target.task, subtasks, message, steeredBy }),
 parentRunId: target.id,
 relation: 'steer',
 })
}

/** How a steering turn names the person who asked for it, in a thread and in a note. */
const describeActor = (actor: Actor): string =>
 actor.kind === 'user' ? `user ${actor.userId}`: 'a human'

/**
 * Acts on a plan delta, called by
 * runner-gateway.ts on a `plan_delta_submitted` frame — the mirror of
 * `applySubmittedPlan`, with the same division of labour: the Runner relays, the
 * server decides, and every change goes through the path it would have gone through
 * had it been in the original plan.
 *
 * **The target is resolved from the steering run's own parent, never from the
 * payload.** A delta names subtasks by run id, and those ids arrive from a model — so
 * a run id that is not a delegation child of the Planner this run was started to
 * re-enter is refused. Without that, one steering turn could cancel any run in the
 * workspace by guessing an id, which is the same forgery surface identity-bound approval closes for
 * approvals.
 *
 * Failures are per-op and reported, never fatal, for the same reason a plan's are:
 * one stale run id should not discard the rest of a turn a human is paying for.
 */
export const applyPlanDelta = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId; delta: unknown },
): Promise<{ applied: AppliedDeltaOp[] }> => {
 const steering = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!steering) throw new NotFoundError('AgentRun')
 if (steering.relation !== 'steer' || !steering.parentRunId) {
 throw new ValidationError('Only a steering run may submit a plan delta')
 }

 const target = await deps.agentRuns.findById(input.workspaceId, steering.parentRunId)
 if (!target) throw new NotFoundError('AgentRun')

 const verdict = parsePlanDelta(input.delta)
 if (!verdict.ok) {
 await postRunSystemMessage(deps, target, `Re-plan refused: ${verdict.reason}`)
 return { applied: [] }
 }

 const children = await deps.agentRuns.listByParent(input.workspaceId, target.id)
 const byId = new Map(
 children.filter((child) => child.relation === 'delegation').map((child) => [child.id, child]),
)

 const thread = await deps.threads.findById(input.workspaceId, target.threadId)
 const personas = await deps.personas.listByWorkspace(input.workspaceId)
 const applied: AppliedDeltaOp[] = []

 for (const op of verdict.delta.ops) {
 if (op.op === 'add') {
 const outcome = thread
 ? await startPlannedChild(deps, {
 planner: target,
 channelId: thread.channelId,
 personas,
 subtask: op.subtask,
 })
: { ok: false as const, reason: 'its thread no longer exists' }
 applied.push({
 op: 'add',
 subject: op.subtask.title,
 applied: outcome.ok,
...(outcome.ok ? {}: { refusal: outcome.reason }),
 })
 continue
 }

 const child = byId.get(op.runId)
 if (!child) {
 applied.push({
 op: op.op,
 subject: op.runId,
 applied: false,
 refusal: 'no subtask of this plan has that run id',
 })
 continue
 }
 const subject = `${child.persona.name} (${child.id})`

 if (op.op === 'cancel') {
 if (isTerminalRunStatus(child.status)) {
 applied.push({
 op: 'cancel',
 subject,
 applied: false,
 refusal: `already ${child.status}`,
 })
 continue
 }
 await cancelRun(deps, child, `re-planned: ${op.reason}`)
 applied.push({ op: 'cancel', subject, applied: true })
 continue
 }

 /**
 * A revision reaches its worker through the ledger, and this is the honest bound
 * on it: a run already mid-turn learns nothing until it re-reads. Mid-flight steering accepts
 * that shape — steering "acts on the *plan and the ledger*" — and the tool's
 * description says the same thing to the model rather than implying an interrupt
 * that does not exist.
 *
 * Written as an **agent-authored `decision`**, which is exactly what it is: a
 * Planner's choice, governing the runs below it, composed by a model and so
 * rendered inside the untrusted fence. `decision` also has reserved slots against
 * recency elision (`MAX_DECISIONS_IN_CONTEXT`), so a revision made early in a busy
 * tree is not the first thing dropped from the worker's context.
 */
 if (isTerminalRunStatus(child.status)) {
 applied.push({
 op: 'revise',
 subject,
 applied: false,
 refusal: `already ${child.status} — add a new subtask instead`,
 })
 continue
 }
 try {
 const treeRunId = await resolveTreeRunId(deps, target)
 const note = await deps.workerNotes.append({
 workspaceId: input.workspaceId,
 treeRunId,
 agentRunId: steering.id,
 authorKind: 'agent_run',
 kind: 'decision',
 title: `Revised scope for ${child.persona.name}`,
 body: op.guidance.slice(0, MAX_NOTE_BODY_LENGTH),
 paths: [],
 })
 // Delivered, not merely recorded: a revision that only reached the ledger would
 // take effect when the worker next chose to read it, which is the "leave a
 // message and hope" mid-flight steering exists to replace.
 await deliverNoteToActiveRuns(deps, { workspaceId: input.workspaceId, treeRunId, note })
 applied.push({ op: 'revise', subject, applied: true })
 } catch (error) {
 applied.push({
 op: 'revise',
 subject,
 applied: false,
 refusal: error instanceof Error ? error.message: String(error),
 })
 }
 }

 /**
 * The audit trail mid-flight steering point 6 asks for: "a re-plan is a decision, and the ledger is
 * where decisions live: the delta, its author, and what it changed become a platform
 * note, so the tree explains itself afterwards."
 *
 * Platform-authored and therefore factual only — what the platform did, not why a
 * model said it should. The rationale reaches a human as the steering run's own
 * output in the thread, where it is rendered as agent text.
 */
 const summary = describeAppliedDelta(applied, `a human (run ${steering.id})`)
 await postRunSystemMessage(deps, target, summary)
 await recordRunPlatformNote(deps, target, {
 kind: 'summary',
 title: `Re-planned: ${applied.filter((entry) => entry.applied).length} change(s)`,
 body: summary,
 })

 return { applied }
}

/**
 * Persists one batch of verbatim provider lines, called
 * by runner-gateway.ts on every `raw_transcript_chunk` frame.
 *
 * The chunk key *is* the idempotency mechanism: a retransmitted chunk overwrites
 * its own blob rather than appending a second copy, which is the same property
 * the unique `(run, seq)` index gives the structured tier, obtained for free from
 * the store's own addressing.
 *
 * Lines arrive already redacted — that happens on the Runner, before the socket,
 * so unredacted text never crosses a network. This layer must not assume
 * it can redact later: by the time a line is here it has already been logged,
 * buffered and framed somewhere else.
 */
export const recordRawTranscriptChunk = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 chunkIndex: number
 lines: readonly string[]
 },
): Promise<void> => {
 if (input.lines.length === 0) return
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')

 await deps.blobs.put(
 transcriptChunkKey(input.agentRunId, input.chunkIndex),
 `${input.lines.join('\n')}\n`,
)
}

/**
 * The "expand raw" fetch.
 *
 * Explicitly not part of any list or subscription payload. The event-tiering design is direct
 * about why: it is what "keeps `subscribeToRunTree` light — it carries structure
 * and status only, never content."
 */
export const getRawTranscript = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId },
): Promise<{ lines: string[]; chunks: number }> => {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')

 const keys = await deps.blobs.list(transcriptPrefix(input.agentRunId))
 const chunks = await Promise.all(keys.map((key) => deps.blobs.get(key)))
 const lines = chunks
.filter((chunk): chunk is string => chunk !== null)
.flatMap((chunk) => chunk.split('\n'))
.filter((line) => line.length > 0)

 return { lines, chunks: keys.length }
}

/**
 * Called by runner-gateway.ts on every `cost_report` frame — spend the egress
 * proxy metered and the Runner relayed.
 *
 * This overwrites whatever the SDK later self-reports in `run_completed`, which
 * is the intent: the credential broker's point is that a run's own account of what it cost is not
 * the number to bill or to enforce a cap against. The proxy saw the requests.
 */
export const recordRunCost = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId; spentUsd: number },
): Promise<void> => deps.agentRuns.recordCost(input.workspaceId, input.agentRunId, input.spentUsd)

/**
 * Reconciles a Runner's in-flight runs when it (re)connects.
 *
 * Two outcomes per non-terminal run assigned to that Runner:
 *
 * - The Runner still holds state for it → resumable. Returned so the gateway can send
 * `resume_run` with the server's highest ingested event seq.
 * - The Runner does not → the work is gone. Failed immediately with a clear reason,
 * rather than left for the dead-run reaper to kill minutes later with a generic
 * "no heartbeat" message. Same end state, far better explanation, and the Inbox stops
 * showing a run nobody is working on.
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
 completedAt: new Date,
 })
 await postRunSystemMessage(
 deps,
 failed,
 'Run interrupted: the Runner restarted and could not recover this run.',
)
 }

 return { resumable }
}

/** Called by runner-gateway.ts on every `heartbeat` frame. */
export const recordRunHeartbeat = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 /**
 * Context-window occupancy, when the Runner sampled it. Absent
 * leaves the last known figure in place rather than clearing it: a Runner that
 * could not read the window has not told us the window emptied.
 */
 context?: { tokens: number; maxTokens: number } | undefined
 },
): Promise<void> => {
 await deps.agentRuns.recordHeartbeat(input.workspaceId, input.agentRunId, input.context)

 /**
 * The nudge. This frame is the only place the platform
 * *learns* a window is filling, so it is the only place it can say so at the moment it
 * happens rather than the next time somebody opens the board.
 *
 * Only when this frame carried a sample: a heartbeat with no reading has told us
 * nothing new, and re-deciding on a stale figure would put the nudge on a timer rather
 * than on the measurement.
 *
 * Best-effort. A run must not be reaped because the thing telling it to consider a
 * handoff threw — the whole feature is optional advice, and the heartbeat it rides on
 * is what keeps the run alive.
 */
 if (!input.context) return
 try {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) return
 /**
 * The operator's threshold, from the row the kill switch already lives on. One primary-key read, and it has to come before the
 * cheap gate rather than after it: the gate *is* the threshold, so deciding against
 * the platform default and then re-deciding against the operator's would ignore
 * anything they set below it.
 */
 const control = await deps.runControl.get(input.workspaceId)
 await suggestHandoffOnPressure(
 {
 agentRuns: deps.agentRuns,
 resolveTreeRunId: async (workspaceId, runId) => {
 const target = await deps.agentRuns.findById(workspaceId, runId)
 return target === null ? runId: resolveTreeRunId(deps, target)
 },
 deliver: async ({ runnerId, runId, text }) => {
 await deps.dispatch.deliverToRun({ runnerId: runnerId as RunnerId, runId, text })
 },
 announce: async ({ text }) => {
 await postRunSystemMessage(deps, run, text)
 },
 limits: handoffLimits(control),
 },
 run,
)
 } catch {
 // See above — advice, and never a reason to lose a heartbeat.
 }
}

/** Backs the Inbox view — runs a human hasn't finished with yet. */
export const listRunsNeedingAttention = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<AgentRun[]> => deps.agentRuns.listNeedsAttention(input.workspaceId)

/**
 * What the swarm actually produced, most recent first.
 *
 * The other half of the Inbox. "What is waiting on me" is the question that gets a human
 * through a day; "what came out" is the one they cannot answer today without opening runs
 * one at a time — and it is the question anyone supervising a swarm actually has.
 */
export const listSettledRuns = (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; limit?: number },
): Promise<AgentRun[]> =>
 deps.agentRuns.listSettled(input.workspaceId, Math.min(Math.max(input.limit ?? 50, 1), 200))

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
 `Run's branch is already ${open[0]?.status === 'merging' ? 'being merged': 'queued for merge'}`,
)
 }
 return run
}

const postRunSystemMessage = async (
 deps: AgentDeps,
 run: AgentRun,
 text: string,
): Promise<Message> => {
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
 // Returned so a caller can hang a thread off it.
 // Every other caller ignores it.
 return message
}

/**
 * Tells a human who is *not looking* that a run needs them. Every visible
 * transition already posts a thread message via `postRunSystemMessage`; that
 * message is only seen by someone watching, and the whole point of the * correction is that nobody watches for long.
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
 completedAt: new Date,
 })
 await postRunSystemMessage(deps, cancelled, `Run cancelled: ${reason}.`)
 // The kill switch stops a session like any other run, and a stopped turn must give
 // the floor back — a session whose speaker was cancelled would otherwise be one nobody
 // can ever speak in again. Terminal transitions that bypass `recordAgentEvent` are the
 // only places this has to be said twice.
 await recordSpokenTurn(deps, {
 workspaceId: run.workspaceId,
 agentRunId: run.id,
 outcome: { ok: false, message: reason },
 })
 // No notification here on purpose: every path into this function is a human
 // deliberately stopping the work (the kill switch), and pushing "your run
 // stopped" back at the person who just stopped it trains people to ignore
 // notifications. Same reasoning for a failed `startAgentRun` dispatch — they
 // are looking at the error already.
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
 * When the platform suggests a handoff, and how many a tree may make.
 *
 * **Neither value ever swaps an agent**, and the wording of this comment is the wording
 * the surface has to use. The rule is that the threshold nudges, the agent asks and the
 * cap refuses: the first decides when a notice is delivered to a run that is filling up,
 * and the second is the one bound the platform enforces on its own. A setting described
 * as automatic swapping would be a surface promising something the runtime deliberately
 * does not do, which is the exact shape of the two operator reports that started the
 * session before this one.
 *
 * Null restores the platform's default rather than writing the current default down,
 * which is the difference between "I have not chosen" and "I chose 0.8".
 */
export const setHandoffPolicy = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 threshold: number | null
 capPerTree: number | null
 },
): Promise<WorkspaceRunControl> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may set when the platform suggests a handoff')
 }

 const verdict = parseHandoffPolicy({
 threshold: input.threshold,
 capPerTree: input.capPerTree,
 })
 if (!verdict.ok) throw new ValidationError(verdict.reason)

 const control = await deps.runControl.setHandoffPolicy(input.workspaceId, {
 threshold: verdict.threshold,
 capPerTree: verdict.capPerTree,
 })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'workspace.handoff_policy_set',
 subjectType: 'workspace',
 subjectId: input.workspaceId,
 metadata: { threshold: verdict.threshold, capPerTree: verdict.capPerTree },
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

 // The raw transcript goes with the branch, for the same reason the Runner
 // deletes the run's HOME: it is a record of work a human has just said they do
 // not want kept, and the event-tiering design calls this tier "policy-bound" precisely so that
 // retaining it is a decision rather than a default.
 await deps.blobs.deletePrefix(transcriptPrefix(run.id)).catch( => {})

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
 * Sets what the merge queue runs before merging a branch into this repository
 *. Human-only, same reasoning as
 * `bindRepository`: it is administrative configuration, and — since the command
 * executes against an agent's branch — it is also a security-relevant setting no
 * run should be able to change about itself.
 *
 * Empty is normalized to null so " " and "not configured" cannot mean different
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

 const normalized = input.verifyCommand?.trim
 const updated = await deps.repositories.setVerifyCommand(
 input.workspaceId,
 input.repositoryId,
 normalized && normalized.length > 0 ? normalized: null,
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
 * Sets what warms this repository's dependency cache.
 *
 * Human-only for the same reason `setVerifyCommand` is: this string is executed, and
 * the entire safety argument for sharing a warmed cache with runs is that no model
 * output ever influenced what went into it. An agent able to set it would be able to
 * write to every later run's dependency tree.
 */
export const setRepositoryInstallCommand = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 repositoryId: RepositoryId
 installCommand: string | null
 },
): Promise<Repository> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError("Only a human may change a repository's install command")
 }
 const repository = await deps.repositories.findById(input.workspaceId, input.repositoryId)
 if (!repository) throw new NotFoundError('Repository')

 const normalized = input.installCommand?.trim
 const updated = await deps.repositories.setInstallCommand(
 input.workspaceId,
 input.repositoryId,
 normalized && normalized.length > 0 ? normalized: null,
)

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'repository.install_command_set',
 subjectType: 'repository',
 subjectId: repository.id,
 metadata: { configured: updated.installCommand !== null },
 })

 return updated
}

/**
 * Warms a repository's dependency cache.
 *
 * Human-only and synchronous-ish: this is an operator maintenance action, not something
 * a run does to itself. That is not ceremony — the cache runs inherit is safe *because*
 * only an operator-authored command ever wrote to it, so an agent able to trigger a
 * warm with a command it influenced would collapse the whole argument.
 */
export const warmRepositoryCache = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; repositoryId: RepositoryId },
): Promise<{ ok: boolean; detail: string | null }> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError("Only a human may warm a repository's dependency cache")
 }
 const repository = await deps.repositories.findById(input.workspaceId, input.repositoryId)
 if (!repository) throw new NotFoundError('Repository')
 if (!repository.installCommand) {
 throw new ValidationError('This repository has no install command configured')
 }

 const runner = await deps.runners.findById(input.workspaceId, repository.runnerId)
 if (!runner) throw new NotFoundError('Runner')
 if (!runner.connected) throw new ValidationError('Runner is not currently connected')

 const result = await deps.dispatch.warmCache({
 runnerId: repository.runnerId,
 repositoryId: repository.id,
 repositoryPath: repository.absolutePath,
 defaultBranch: repository.defaultBranch,
 installCommand: repository.installCommand,
 })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'repository.cache_warmed',
 subjectType: 'repository',
 subjectId: repository.id,
 metadata: { ok: result.ok },
 })

 // Carried on success as well as on failure: a warm that filled the cache but
 // captured no prepared tree is a success with
 // something worth saying, and "Cache warmed." alone would hide it.
 return { ok: result.ok, detail: result.detail ?? null }
}

/**
 * Queues a finished run's branch for merge into its repository's default branch
 *.
 *
 * Queueing is all this does. The merge itself happens in `advanceMergeQueue`, one
 * repository-entry at a time — which is the entire point: "sibling branches
 * converge through the merge queue, not a race", and a merge that ran
 * immediately on click would be exactly the race.
 *
 * Human-only and terminal-only, same gate as keep/discard/push.
 */
/**
 * The blockers a run's own reviewers raised against it.
 *
 * The chain is short but every hop is load-bearing. A run's `plan_subtask` row gives
 * its `position`; the rows of that same plan whose `reviews` is that position are its
 * reviewers; a `blocker` note authored by one of those runs is an objection to *this*
 * branch. Nothing else counts — not a blocker written by a sibling worker about its own
 * work, and not one written by a reviewer of a different subtask, both of which sit in
 * the same tree ledger.
 *
 * Empty for every run that did not come from a plan, which is every human-started run
 * and every run that predates the collaboration topology.
 */
const findReviewBlockers = async (deps: AgentDeps, run: AgentRun): Promise<ReviewBlocker[]> => {
 const own = await deps.planSubtasks.findByAgentRun(run.workspaceId, run.id)
 if (!own) return []

 const rows = await deps.planSubtasks.listByPlanner(run.workspaceId, own.plannerRunId)
 const reviewers = new Map<AgentRunId, string>
 for (const row of rows) {
 if (row.reviews !== own.position || row.agentRunId === null) continue
 const reviewer = await deps.agentRuns.findById(run.workspaceId, row.agentRunId)
 // Named by its persona rather than by the subtask title: the human is deciding
 // whether to trust a *reviewer*, and "security-reviewer says X" carries the weight
 // that "Check the new endpoint says X" does not.
 if (reviewer) reviewers.set(reviewer.id, reviewer.persona.name)
 }
 if (reviewers.size === 0) return []

 const notes = await deps.workerNotes.listByTree(
 run.workspaceId,
 await resolveTreeRunId(deps, run),
)
 return notes
.filter(
 (note) =>
 note.kind === 'blocker' &&
 note.authorKind === 'agent_run' &&
 note.agentRunId !== null &&
 reviewers.has(note.agentRunId),
)
.map((note) => ({
 reviewerRunId: note.agentRunId as AgentRunId,
 reviewerPersonaName: reviewers.get(note.agentRunId as AgentRunId) ?? 'a reviewer',
 title: note.title,
 }))
}

export const enqueueMergeRun = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 agentRunId: AgentRunId
 /**
 * Queue the branch despite its reviewers' blockers.
 *
 * See `describeReviewBlockers` for why this exists at all: a blocker is model
 * output, and a gate a human cannot open is a model deciding what a human may
 * merge. Explicit and audited, never a default.
 */
 overrideBlockers?: boolean
 },
): Promise<MergeQueueEntry> => {
 const run = await requireDisposableRun(deps, input)
 if (!run.branchName) throw new ValidationError('Run has no branch to merge')
 if (!run.clonePath) throw new ValidationError('Run has no workspace to merge from')
 /**
 * A review run's branch is not its own work. Its clone is taken
 * from the branch it reviewed, so `loom/run-<reviewer>` carries that branch's commits
 * — merging it would land the reviewed work a second time under a name nobody chose,
 * and a reviewer that edited a file in passing would smuggle that edit in with it.
 * A reviewer's output is its notes.
 */
 if (run.relation === 'review') {
 throw new ValidationError(
 'This is a review run — its branch is the branch it reviewed, and its findings are in the swarm notes. Queue the run that did the work instead.',
)
 }

 /**
 * **The ledger gating an action rather than informing one**.
 *
 * Checked here, at enqueue, rather than in the sweep that performs the merge: the
 * refusal is for a human who is deciding right now, and a rejection that surfaced
 * minutes later as a failed queue entry would read as the branch's fault.
 */
 const blockers = await findReviewBlockers(deps, run)
 if (blockers.length > 0 && input.overrideBlockers !== true) {
 throw new ValidationError(
 describeReviewBlockers(run.branchName, blockers) ?? 'This branch has review blockers',
)
 }

 const entry = await deps.mergeQueue.enqueue({
 workspaceId: input.workspaceId,
 repositoryId: run.repositoryId,
 agentRunId: run.id,
 branchName: run.branchName,
 enqueuedByUserId: input.actor.kind === 'user' ? input.actor.userId: null,
 })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'merge_queue.enqueued',
 subjectType: 'merge_queue_entry',
 subjectId: entry.id,
 metadata: {
 agentRunId: run.id,
 branchName: run.branchName,
 // Recorded whenever blockers existed, not only when they were overridden: "this
 // merge was queued past two objections" is the audit line worth having, and it
 // cannot be reconstructed later from a ledger that says only that they were raised.
...(blockers.length > 0 ? { overriddenBlockers: blockers.length }: {}),
 },
 })

 /**
 * The override is stated in the thread, not only in the audit log. The reviewer's
 * blocker stays in the ledger as the true fact that it was raised; without this line
 * the next reader sees an objection and no sign of who answered it.
 *
 * Deliberately not written as a note of its own: the ledger's platform kinds record
 * what the platform *did*, and the merge has not happened yet — the queue writes its
 * own `merge_result` when it does.
 */
 await postRunSystemMessage(
 deps,
 run,
 blockers.length > 0
 ? `${run.branchName} queued for merge, overriding ${blockers.length} reviewer blocker(s): ${blockers
.map((blocker) => `${blocker.reviewerPersonaName} — ${blocker.title}`)
.join('; ')}.`
: `${run.branchName} queued for merge.`,
)
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

/** The built-in that resolves conflicts. Absent = feature off. */
const RECONCILER_PERSONA_NAME = 'reconciler'

/**
 * Whether an agent may attempt a conflicted branch before the human sees it
 *. **On by default.**
 *
 * The roadmap sequences this deliberately: the mechanical queue ships first and the agent goes
 * *in front of it*, with the queue catching what the agent gets wrong. Both halves now
 * exist, and the ordering here means the safety case does not rest on the agent being
 * right — the entry has already failed and the branch is already back with its owner
 * before a reconciler starts. A reconciler that refuses, crashes or never finishes
 * leaves the human holding exactly what they would have been holding anyway, and
 * anything it does produce is rebased and verified by the same mechanical path as every
 * other branch.
 *
 * What tips it to on is the parallel-branch measurement: a third of parallel branches needed hands, every one of
 * them an additive conflict requiring no judgement, at ~50 seconds of human attention
 * each. That cost is the thing this removes, and leaving it off by default means the
 * measured problem stays unsolved for anyone who does not read the docs.
 *
 * **What the safety case now rests on, measured rather than asserted.** The correctness
 * gate gives the agent alone (four scenarios, 12/12 over three trials). The *queue's*
 * half is `tools/reconcile-queue-check.mts`: four conflict shapes driven end to end
 * through real runs, a real paused rebase and a repository whose own tests judge the
 * result. All four hold, and between them they cover the three outcomes the design
 * needs — a union verified and merged, a contradiction refused, and, in
 * `over-budget-union`, **a resolution the agent had no way to know was wrong, failed by
 * the repository's tests and handed back**. That last one is the case the ordering
 * exists for, and it is the one that had never been observed.
 *
 * That argument depends on `verifyCommand` being usable, which on a real project means
 * the suite's dependencies being installable with the network closed — see the * dependency cache, which merge verification mounts for exactly this reason. Without a
 * warmed cache, a repository whose tests need an install step still has no verification
 * command that can succeed, and this agent's work merges unverified.
 *
 * `LOOM_RECONCILER_ENABLED=0` turns it off.
 */
export const reconcilerEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
 env.LOOM_RECONCILER_ENABLED !== '0'

/**
 * Starts a reconciler over a branch the queue could not rebase.
 *
 * Called *after* the entry has already failed, not instead of failing — and that
 * ordering is the whole risk posture. The branch goes back to its owning run exactly as
 * it does today, every existing merge-queue invariant is untouched, and the repository's
 * queue keeps moving instead of being held open for the length of an agent run. If the
 * reconciler succeeds, the branch is simply re-queued; if it fails, refuses, or never
 * finishes, the human is already holding what they would have been holding anyway.
 *
 * Best-effort throughout: a reconciler that cannot start must never turn a merge
 * failure the human can act on into an error they cannot.
 */
const startReconciler = async (
 deps: AgentDeps,
 entry: MergeQueueEntry,
 run: AgentRun,
): Promise<void> => {
 if (!reconcilerEnabled) return
 // Never reconcile a reconciliation, and never twice. Without this a branch that
 // conflicts again after being reconciled would start another reconciler, and so on —
 // an unbounded spend loop driven by whatever keeps failing to merge.
 if (run.relation === 'reconcile') return
 const children = await deps.agentRuns.listByParent(entry.workspaceId, run.id)
 if (children.some((child: AgentRun) => child.relation === 'reconcile')) return

 const personas = await deps.personas.listByWorkspace(entry.workspaceId)
 const reconciler = personas.find((persona) => persona.name === RECONCILER_PERSONA_NAME)
 if (!reconciler) {
 /**
 * Said out loud rather than returned silently. This is exactly how the feature
 * managed to be a no-op on every pre-existing workspace: the persona is looked up
 * by name, built-ins used to be seeded only at workspace creation, and an absent
 * reconciler produced no run, no message and no trace. Seeding now converges (see
 * `seedBuiltinPersonas`), so reaching this means someone deleted or renamed it —
 * which is their right, and still worth saying.
 */
 await postRunSystemMessage(
 deps,
 run,
 'A reconciler would have attempted this conflict, but no persona named ' +
 `"${RECONCILER_PERSONA_NAME}" exists in this workspace. The branch is yours to fix.`,
)
 return
 }

 await startAgentRun(deps, {
 workspaceId: entry.workspaceId,
 // The run acts as itself: `startAgentRun` only lets a run spawn children of
 // itself, which is also what ties the attenuation to the right parent.
 actor: agentRunActor(run.id),
 threadId: run.threadId,
 repositoryId: run.repositoryId,
 personaId: reconciler.id,
 parentRunId: run.id,
 // Never 'delegation' — the data model is explicit that a reconciler attaches distinctly rather
 // than pretending to be a worker the parent asked for.
 relation: 'reconcile',
 reconcile: { branchName: entry.branchName },
 task:
 `Your working tree is a paused rebase of ${entry.branchName} onto the merge target. ` +
 'Resolve the conflict markers, or refuse if the two sides genuinely contradict each other.',
 })
}

/**
 * The outcome of a reconciler run, relayed from the Runner.
 *
 * On success the branch is re-queued and takes its turn at the back — never merged from
 * here. The "don't merge on click" applies with more force to an agent than to a
 * human: the sweep is the only thing that merges, so an agent-reconciled branch is
 * rebased, verified and fast-forwarded by exactly the same mechanical path as any other.
 * That is what the roadmap means by the queue catching what the agent gets wrong.
 */
export const recordReconcileResult = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 parentRunId: AgentRunId
 ok: boolean
 commitSha?: string
 reason?: string
 },
): Promise<void> => {
 const parent = await deps.agentRuns.findById(input.workspaceId, input.parentRunId)
 if (!parent) return

 if (!input.ok) {
 // A refusal is a normal outcome, not an incident: the persona is told to decline a
 // conflict that encodes a real disagreement. The branch is already back with its
 // run, so this only has to say what happened.
 await postRunSystemMessage(
 deps,
 parent,
 `The reconciler did not resolve ${parent.branchName ?? 'this branch'}: ${input.reason ?? 'no reason given'}. The branch is yours to fix and re-queue.`,
)
 await recordRunPlatformNote(deps, parent, {
 kind: 'merge_result',
 title: `reconciler declined ${parent.branchName ?? 'a branch'}`,
 body: input.reason ?? 'no reason given',
 })
 return
 }

 await postRunSystemMessage(
 deps,
 parent,
 `The reconciler resolved ${parent.branchName ?? 'this branch'} at ${(input.commitSha ?? '').slice(0, 8)} and re-queued it for merge.`,
)
 try {
 /**
 * Queued directly rather than through `enqueueMergeRun`, which is human-only by
 * design — it is the same gate as keep/discard/push, and those are a human's
 * decision about what happens to a branch. This is not that decision: the human
 * already made it when they queued the branch the first time, and the reconciler
 * only restored the entry the conflict cancelled. Relaxing `enqueueMergeRun`'s
 * actor check to allow this would also let any agent run queue any branch.
 *
 * The disposition guard still matters and is kept: a human who discarded, kept or
 * pushed the branch while the reconciler was working has overridden it, and their
 * decision wins.
 */
 if (!parent.branchName || !parent.clonePath) {
 throw new ValidationError('the reconciled run no longer has a branch to merge')
 }
 if (parent.branchDisposition) {
 throw new ValidationError(`a human already ${parent.branchDisposition} this branch`)
 }
 const entry = await deps.mergeQueue.enqueue({
 workspaceId: input.workspaceId,
 repositoryId: parent.repositoryId,
 agentRunId: parent.id,
 branchName: parent.branchName,
 enqueuedByUserId: null,
 })
 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: agentRunActor(input.agentRunId),
 action: 'merge_queue.enqueued',
 subjectType: 'merge_queue_entry',
 subjectId: entry.id,
 metadata: { reconciledBy: input.agentRunId },
 })
 } catch (error) {
 // Enqueueing can legitimately lose a race — a human may have discarded the branch,
 // or re-queued it themselves while the reconciler worked.
 await postRunSystemMessage(
 deps,
 parent,
 `The reconciled branch could not be re-queued: ${error instanceof Error ? error.message: String(error)}`,
)
 }
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
 // The branch goes back to its owning run: its disposition stays unset, so
 // the human can fix and re-queue, push, or discard it.
 await postRunSystemMessage(deps, run, describeMergeFailure(reason, entry.branchName, detail))
 // A conflict is exactly what the ledger exists to prevent recurring: a
 // sibling that reads "this branch conflicted over these paths" has the one fact
 // that stops it walking into the same collision.
 await recordRunPlatformNote(deps, run, {
 kind: 'merge_result',
 title: `${entry.branchName} did not merge (${reason})`,
 body: describeMergeFailure(reason, entry.branchName, detail),
 })
 await notifyRun(deps, run, 'merge_failed', {
 detail: describeMergeFailure(reason, entry.branchName, null),
 })

 // Only a conflict — the other failure reasons are not an agent's to fix. A dirty
 // target and a stale target are the human's and the queue's respectively, and a
 // failed verification means the branch is wrong rather than merely out of date.
 if (reason === 'conflict') {
 try {
 await startReconciler(deps, entry, run)
 } catch {
 // Swallowed on purpose: the branch is already back with its run and the human
 // has already been told. A reconciler that cannot start must not turn a merge
 // failure someone can act on into an error they cannot.
 }
 }
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
 await fail('runner_error', error instanceof Error ? error.message: String(error), run)
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
 // What a later sibling needs in order to know the target moved under it: the queue
 // rebases entry N+1 onto the result of entry N, so "this landed" is what makes the
 // next worker's own base comprehensible.
 await recordRunPlatformNote(deps, run, {
 kind: 'merge_result',
 title: `${entry.branchName} merged into ${repository.defaultBranch}`,
 body: `Merged as ${result.commitSha.slice(0, 8)} (${verification}). Later branches rebase onto this.`,
 })

 /**
 * The merge queue is where a map learns it is wrong.
 *
 * Every map bound to this repository, across every persona — a merged change makes a
 * claim false for whoever holds it, and invalidating only the map of whichever persona
 * happened to be involved would leave every other expert on this repository
 * confidently wrong.
 *
 * Swallowed, and last: a merge that landed must not be reported as failed because
 * bookkeeping about someone's memory did not.
 */
 try {
 await invalidateMapsForMerge(deps, {
 workspaceId: entry.workspaceId,
 repositoryId: repository.id,
 changedPaths: result.changedPaths,
 revision: result.commitSha,
 })
 } catch {
 // Deliberately swallowed — see above.
 }
}

/**
 * Advances every repository's merge queue by at most one entry. A periodic sweep like `reapStuckRuns`, called from the same interval in
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
 const open = await deps.mergeQueue.listAllOpen

 // An entry left `merging` by a server that died mid-merge would block its
 // repository forever — nothing else can claim while the unique index holds. Same
 // shape of problem, and the same answer, as the dead-run reaper.
 const now = Date.now
 for (const entry of open) {
 if (entry.status !== 'merging') continue
 const startedAt = (entry.startedAt ?? entry.createdAt).getTime
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

 const byRepository = new Map<string, MergeQueueEntry[]>
 for (const entry of await deps.mergeQueue.listAllOpen) {
 const bucket = byRepository.get(entry.repositoryId)
 if (bucket) bucket.push(entry)
 else byRepository.set(entry.repositoryId, [entry])
 }

 await Promise.all(
 [...byRepository.values].map(async (entries) => {
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
 // A reaped run is the case least likely to be noticed: it produced no
 // terminal event of its own, so a watcher sees the thread simply stop.
 await notifyRun(deps, failed, 'run_failed', { detail: reason })
 // The other terminal transition that never emits `run_failed` — see `cancelRun`.
 await recordSpokenTurn(deps, {
 workspaceId: run.workspaceId,
 agentRunId: run.id,
 outcome: { ok: false, message: `reaped — ${reason}` },
 })
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
 /**
 * A question is unblocked on its own frame, or the run stays stuck. The
 * Runner is holding a tool call open on `question_answered`; a
 * `permission_response` for the same id is a frame it is not waiting for, so the
 * SLA would "resolve" the row and leave the run blocked until the reaper killed
 * it — the exact failure the "keep the SLA" clause exists to prevent.
 */
 if (approval.question !== null) {
 await deps.dispatch.sendQuestionAnswer({
 runnerId: run.runnerId,
 toolUseId: approval.toolUseId,
 answer: null,
 })
 } else {
 await deps.dispatch.sendApprovalDecision({
 runnerId: run.runnerId,
 toolUseId: approval.toolUseId,
 decision: 'deny',
 })
 }
 } catch {
 // Runner gone: the row is resolved either way, and the run's stale
 // heartbeat is what the dead-run reaper acts on. Swallowing here keeps one
 // unreachable Runner from aborting the sweep for every other workspace.
 }

 await deps.agentRuns.updateStatus(approval.workspaceId, run.id, { status: 'running' })
 await postRunSystemMessage(
 deps,
 run,
 approval.question !== null
 ? `A question from ${run.persona.name} went unanswered for ${Math.round(options.approvalSlaMs / 60_000)} min. The run was told nobody answered and continued.`
: `Approval for ${approval.toolName} auto-denied after ${Math.round(options.approvalSlaMs / 60_000)} min with no decision.`,
)
 // Worth saying out loud rather than only in the thread: the human's window
 // to decide closed, and the run went on with the call denied.
 await notifyRun(deps, run, 'approval_expired', { toolName: approval.toolName })
 }
}

const eventToMessageText = (event: AgentEvent): string => {
 switch (event.kind) {
 case 'assistant_text':
 return event.text
 case 'tool_call': {
 const primary = primaryToolArgument(event.input)
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
 // Carried through to the thread so a reader pairs a call with its own result
 // rather than with whichever one happened to finish first (see `Message`).
 toolUseId:
 input.event.kind === 'tool_call' || input.event.kind === 'tool_result'
 ? input.event.toolUseId
: null,
 })

 await deps.events.publish({
 type: 'message.created',
 workspaceId: input.workspaceId,
 threadId: run.threadId,
 message,
 })

 /**
 * The live-activity frame.
 *
 * Published beside `message.created` rather than instead of it: the thread and the
 * canvas want different things from the same event, and folding them together would
 * make the graph re-parse prose to find out a tool was called.
 *
 * **The label is a tool name and never its arguments.** the rule is that a human
 * decides against the exact argv on the approval card; a fan-out frame carrying
 * `rm -rf …` would put that string on every connected client's canvas, which is the
 * same mistake the notification body was guarded against making.
 *
 * Best-effort, and deliberately after the message: this is an animation cue, and a
 * publish failure must never be the reason a run's event went unrecorded.
 */
 await publishRunActivity(deps, run, {
 kind:
 input.event.kind === 'tool_call'
 ? 'tool_call'
: input.event.kind === 'tool_result'
 ? 'tool_result'
: input.event.kind === 'run_completed' || input.event.kind === 'run_failed'
 ? 'finished'
: 'started',
 // Only `tool_call` carries a name; a result is identified by its `toolUseId` and
 // the client already pairs the two on that (see `thread.ts`).
 label: input.event.kind === 'tool_call' ? input.event.toolName: null,
 })

 if (input.event.kind === 'run_completed') {
 // The SDK's self-reported cost is a fallback, not the truth.
 // If the egress proxy already metered this run, its figure stands; only an
 // unsandboxed run — where no proxy sat on the request path — has nothing
 // better to record.
 const metered = run.totalCostUsd !== null
 const completed = await deps.agentRuns.updateStatus(input.workspaceId, input.agentRunId, {
 status: 'completed',
...(metered ? {}: { totalCostUsd: input.event.totalCostUsd }),
 completedAt: new Date,
 })
 // Notified from the *updated* run, not the one read at the top: the branch
 // name and the metered cost are what make this notification actionable, and
 // `run` predates the transition that finalizes them.
 await notifyRun(deps, completed, 'run_finished')
 // Recorded from the updated run for the same reason the notification is: the
 // branch and the metered cost are the facts worth keeping, and both are
 // finalized by the transition above.
 await recordRunPlatformNote(deps, completed, {
 kind: 'run_finished',
 title: `${completed.persona.name} completed`,
 body: describeRunOutcomeForNote(completed),
 })
 /**
 * The DAG advances before the aggregation is considered, and the order matters:
 * `aggregateForParent` posts the plan's final summary once every sibling is
 * terminal, and a subtask released here is a new non-terminal sibling. Reversed,
 * a two-stage plan would post "plan finished" at the end of stage one.
 */
 // A mastery run's map is finished when its run is. A no-op for
 // every other run, which is why it is unconditional rather than behind a check
 // this function would have to keep in step with.
 await closeMap(deps, { workspaceId: input.workspaceId, agentRunId: completed.id, ok: true })
 // A Colosseum turn's answer is the run's final text. Unconditional for
 // the same reason `closeMap` is: a no-op for every run that was not speaking in a
 // session, and a check here would be a second place that has to agree about which
 // runs those are.
 await recordSpokenTurn(deps, {
 workspaceId: input.workspaceId,
 agentRunId: completed.id,
 outcome: { ok: true, text: input.event.result },
 })
 await releaseDependents(deps, completed)
 await aggregateForParent(deps, completed)
 } else if (input.event.kind === 'run_failed') {
 const failed = await deps.agentRuns.updateStatus(input.workspaceId, input.agentRunId, {
 status: 'failed',
 errorMessage: input.event.message,
 completedAt: new Date,
 })
 await notifyRun(deps, failed, 'run_failed', { detail: input.event.message })
 // A failure is worth *more* to a sibling than a success: it is the one fact that
 // stops the next worker spending the same tokens discovering the same wall. The
 // message is the platform's record of what the run reported, not the model's own
 // prose about it, which is why it belongs in the trusted section.
 await recordRunPlatformNote(deps, failed, {
 kind: 'run_finished',
 title: `${failed.persona.name} failed`,
 body: `${describeRunOutcomeForNote(failed)} Reported: ${truncateForNote(input.event.message)}`,
 })
 // A failure releases nothing, but it is what *skips* the dependents that were
 // waiting on it — and those skips have to be recorded before the aggregation
 // decides the plan is over.
 /**
 * A failed mastery run still leaves the claims it wrote. Mastery writes the map
 * incrementally precisely so a killed run's partial work survives, so `ok: false`
 * marks the map `failed` only when it holds nothing at all — see `closeMap`.
 */
 await closeMap(deps, { workspaceId: input.workspaceId, agentRunId: failed.id, ok: false })
 // A turn that failed still cost money and a slot against the cap, so the session
 // records it rather than waiting forever for an answer that is not coming.
 await recordSpokenTurn(deps, {
 workspaceId: input.workspaceId,
 agentRunId: failed.id,
 outcome: { ok: false, message: input.event.message },
 })
 await releaseDependents(deps, failed)
 await aggregateForParent(deps, failed)
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

 /**
 * The one activity kind a human is *waiting on*, so it is worth arriving without a
 * poll. `label` is the tool's name only — the argv stays on the approval card, per
 * Effect-based classification and for the same reason a notification body does not carry it.
 */
 await publishRunActivity(deps, {...run, status: 'awaiting_approval' }, {
 kind: 'awaiting_human',
 label: input.toolName,
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

 // The one notification the ship criterion names outright: a gate blocks the
 // run until a human answers, and the approval SLA will auto-*deny* it if
 // nobody does — so being told is the difference between a decision and a
 // timeout.
 await notifyRun(deps, run, 'approval_needed', { toolName: input.toolName })

 return approval
}

/**
 * An agent asking a human a question, and blocking on the answer, called by runner-gateway.ts on a `question_asked` frame.
 *
 * Mid-flight steering: "a clarifying question is that same gate carrying a prompt and returning a
 * string. Reuse it rather than build a second blocking channel." So this is
 * `requestApproval` with a question on it — which means the SLA, the auto-deny, the
 * notification, the `awaiting_approval` status and the identity binding all come
 * for free and cannot drift from the tool-gate versions of themselves.
 *
 * The question is **not** posted into the thread as system text. It is model-authored
 * and the thread's system lines are the platform's own voice; a
 * question rendered there would be attacker-controlled text wearing the platform's
 * chrome, which is the risk in a different shape. The pointer line is the
 * platform's; the question itself renders in the card, inside the untrusted fence.
 */
export const askClarifyingQuestion = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 toolUseId: string
 question: string
 },
): Promise<ApprovalRequest> => {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')

 const approval = await deps.approvals.create({
 workspaceId: input.workspaceId,
 agentRunId: input.agentRunId,
 toolUseId: input.toolUseId,
 // A synthetic tool name, so every existing consumer — the SLA sweep, the audit
 // record, the notification — has the non-null string it expects without a
 // discriminator any of them could read wrongly. `question` is the real signal.
 toolName: 'ask_human',
 input: {},
 question: input.question,
 })

 await deps.agentRuns.updateStatus(input.workspaceId, input.agentRunId, {
 status: 'awaiting_approval',
 })

 const message = await deps.messages.append({
 workspaceId: input.workspaceId,
 threadId: run.threadId,
 author: systemActor,
 body: {
 kind: 'system',
 text: `${run.persona.name} asked a question and is waiting — see the card below.`,
 },
 })

 await deps.events.publish({
 type: 'message.created',
 workspaceId: input.workspaceId,
 threadId: run.threadId,
 message,
 })

 await notifyRun(deps, run, 'approval_needed', { toolName: 'a question' })

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
 /** The reply, when this gate is a clarifying question. */
 answer?: string
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

 /**
 * A question with no answer is a denial, whatever the button said.
 * "Approve" on a question that carries no text would resume the run having told the
 * model nothing while implying it was answered, which is worse than a clean refusal
 * — the model would treat silence as assent.
 */
 const isQuestion = approval.question !== null
 const answer = isQuestion ? input.answer?.trim: undefined
 const decision = isQuestion && !answer ? 'deny': input.decision

 const resolved = await deps.approvals.resolve(input.workspaceId, input.approvalRequestId, {
 status: decision === 'approve' ? 'approved': 'denied',
 resolvedByUserId: input.actor.userId,
...(answer === undefined ? {}: { answer }),
 })

 if (isQuestion) {
 await deps.dispatch.sendQuestionAnswer({
 runnerId: run.runnerId,
 toolUseId: approval.toolUseId,
 answer: decision === 'approve' && answer ? answer: null,
 })
 } else {
 await deps.dispatch.sendApprovalDecision({
 runnerId: run.runnerId,
 toolUseId: approval.toolUseId,
 decision: decision === 'approve' ? 'allow': 'deny',
 })
 }

 await deps.agentRuns.updateStatus(input.workspaceId, run.id, { status: 'running' })

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: `approval_request.${decision}d`,
 subjectType: 'approval_request',
 subjectId: approval.id,
 metadata: { toolName: approval.toolName },
 })

 return resolved
}

export { isRiskyTool }

/**
 * Removing things a workspace accumulated.
 *
 * Nothing here could be removed before, which is a gap the UI reachability audit did
 * not catch because it checks whether a client can *reach* a procedure, not whether
 * the procedure exists. A workspace could only grow.
 *
 * Every gate below exists for the same reason: the schema cascades. `runner` →
 * `repository` → `agent_run` → its events, notes, approvals and merge-queue entries;
 * `channel` → `thread` → `message` and the runs started in it. A naive delete would
 * therefore destroy run history and the spend recorded against it — and the figures
 * are what budget enforcement is judged against, so losing them silently is not a
 * cosmetic loss. So: a refusal states what is in the way and how much of it there is,
 * and where history really would be destroyed the caller must say so explicitly
 * rather than be told afterwards.
 */

const requireHuman = (actor: Actor, what: string): void => {
 if (!isHuman(actor)) throw new ForbiddenError(`Only a human may ${what}`)
}

export const deletePersona = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; personaId: AgentPersonaId },
): Promise<void> => {
 requireHuman(input.actor, 'delete a persona')

 const persona = await deps.personas.findById(input.workspaceId, input.personaId)
 if (!persona) throw new NotFoundError('AgentPersona')

 /**
 * The one deletion with no history to lose: a run snapshots the whole `PersonaSpec`
 * at start, so past runs keep their persona, their model and their cost whether
 * or not the registry row survives. Only a run *in flight* is a problem, and only
 * because its children resolve the persona registry by name (the Planner
 * delegation), so deleting one mid-swarm breaks a delegation that has not happened yet.
 */
 const active = await deps.agentRuns.listActiveByWorkspace(input.workspaceId)
 if (active.some((run) => run.persona.name === persona.name)) {
 throw new ValidationError(
 `"${persona.name}" is running right now — wait for it to finish, or stop it first`,
)
 }

 // Group membership is a plain id array, so a deleted persona would leave a dangling
 // entry that renders as a chip with no name behind it. The port prunes it, rather
 // than this use case reading every group and writing back the matches: which stores
 // reference a persona is not a thing a use case should have to keep a list of.
 await deps.personaGroups.prunePersona(input.workspaceId, persona.id)

 await deps.personas.delete(input.workspaceId, input.personaId)

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'persona.deleted',
 subjectType: 'agent_persona',
 subjectId: persona.id,
 metadata: { name: persona.name },
 })
}

export const unbindRepository = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 repositoryId: RepositoryId
 /**
 * Required when runs reference this repository, because unbinding cascades them
 * away along with the spend recorded against them. Naming it after what is
 * lost rather than `force`: an operator should have to agree to the consequence,
 * not to the verb.
 */
 acknowledgeRunHistoryLoss?: boolean
 },
): Promise<void> => {
 requireHuman(input.actor, 'unbind a repository')

 const repository = await deps.repositories.findById(input.workspaceId, input.repositoryId)
 if (!repository) throw new NotFoundError('Repository')

 const runs = await deps.agentRuns.countByRepository(input.workspaceId, input.repositoryId)
 // Unconditional: a live run has a clone on a Runner and a branch in flight, and
 // there is no acknowledgement that makes deleting the record of it coherent.
 if (runs.active > 0) {
 throw new ValidationError(
 `${runs.active} run(s) are still working in "${repository.displayName}" — wait for them to finish, or stop them first`,
)
 }
 if (runs.total > 0 && input.acknowledgeRunHistoryLoss !== true) {
 throw new ValidationError(
 `Unbinding "${repository.displayName}" also deletes ${runs.total} run(s) and the spend recorded against them. Confirm to proceed.`,
)
 }

 await deps.repositories.delete(input.workspaceId, input.repositoryId)

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'repository.unbound',
 subjectType: 'repository',
 subjectId: repository.id,
 metadata: { displayName: repository.displayName, runsDeleted: runs.total },
 })
}

export const deleteRunner = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; runnerId: RunnerId },
): Promise<void> => {
 requireHuman(input.actor, 'remove a Runner')

 const runner = await deps.runners.findById(input.workspaceId, input.runnerId)
 if (!runner) throw new NotFoundError('Runner')

 /**
 * No acknowledgement path, deliberately. A runner cascades to its repositories and
 * through them to every run — an amount of history nobody can weigh from a single
 * confirmation. Unbinding the repositories first makes the operator confront each
 * one, with its own count in front of them.
 */
 const bound = await deps.repositories.countByRunner(input.workspaceId, input.runnerId)
 if (bound > 0) {
 throw new ValidationError(
 `${bound} repositor${bound === 1 ? 'y is': 'ies are'} still bound to "${runner.name}" — unbind ${bound === 1 ? 'it': 'them'} first`,
)
 }

 await deps.runners.delete(input.workspaceId, input.runnerId)

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'runner.removed',
 subjectType: 'runner',
 subjectId: runner.id,
 metadata: { name: runner.name },
 })
}

/**
 * Removes a channel and everything said in it.
 *
 * Lives here rather than beside the other channel use-cases only because it needs
 * `AgentDeps`: whether a channel is safe to delete is a question about runs.
 *
 * The heaviest cascade in the schema: channel → thread → message, and every
 * `agent_run` started in those threads, with its events, notes, approvals and the
 * spend recorded against it. So this asks twice — once by refusing while work is
 * live, once by requiring the caller to acknowledge what the count actually is.
 */
export const deleteChannel = async (
 deps: AgentDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 channelId: ChannelId
 /** Required when runs were started in this channel; named for what is lost. */
 acknowledgeRunHistoryLoss?: boolean
 },
): Promise<void> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may delete a channel')
 }

 const channel = await deps.channels.findById(input.workspaceId, input.channelId)
 if (!channel) throw new NotFoundError('Channel')

 // A workspace with no channel has nowhere to say anything, and every client picks
 // the first channel on load — so the last one is not a thing to be able to delete.
 const remaining = await deps.channels.countByWorkspace(input.workspaceId)
 if (remaining <= 1) {
 throw new ValidationError('This is the only channel — create another one first')
 }

 const runs = await deps.agentRuns.countByChannel(input.workspaceId, input.channelId)
 if (runs.active > 0) {
 throw new ValidationError(
 `${runs.active} run(s) are still working in #${channel.name} — wait for them to finish, or stop them first`,
)
 }
 if (runs.total > 0 && input.acknowledgeRunHistoryLoss !== true) {
 throw new ValidationError(
 `Deleting #${channel.name} also deletes its messages, ${runs.total} run(s), and the spend recorded against them. Confirm to proceed.`,
)
 }

 await deps.channels.delete(input.workspaceId, input.channelId)

 await deps.audit.record({
 workspaceId: input.workspaceId,
 actor: input.actor,
 action: 'channel.deleted',
 subjectType: 'channel',
 subjectId: channel.id,
 metadata: { name: channel.name, runsDeleted: runs.total },
 })
}
