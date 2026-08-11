import {
 BUILTIN_PERSONAS,
 DEFAULT_RESPONSE_STYLE,
 ForbiddenError,
 NotFoundError,
 ValidationError,
 agentRunActor,
 applyResponseStyle,
 attenuateChildPersona,
 buildNotification,
 describeMergeFailure,
 describePathOverlaps,
 detectPathOverlaps,
 isHuman,
 isPricedModel,
 isMergeQueueEntryTerminal,
 isRiskyTool,
 parseDecomposition,
 parsePersonaMarkdown,
 primaryToolArgument,
 selectNextMergeEntry,
 summarizeChildOutcomes,
 systemActor,
 transcriptChunkKey,
 transcriptPrefix,
 type Actor,
 type AgentEvent,
 type AgentPersona,
 type AgentPersonaId,
 type AgentRun,
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
 type NotificationKind,
 type PersonaCapability,
 type PersonaGroup,
 type PersonaGroupId,
 type PersonaSpec,
 type PlatformNoteKind,
 type Repository,
 type ResponseStyle,
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
 CapabilityRepositoryPort,
 MergeQueueRepositoryPort,
 PersonaGroupRepositoryPort,
 PersonaRepositoryPort,
 RepositoryRepositoryPort,
 ListDirectoryResult,
 RunDispatchPort,
 RunnerRepositoryPort,
 WorkspaceRunControlRepositoryPort,
} from './agent-ports.js'
import type { BlobStoragePort } from './ports.js'
import type { NotificationDeps } from './notification-use-cases.js'
import {
 buildContextLedger,
 recordPlatformNote,
 resolveTreeRunId,
 type NoteDeps,
} from './note-use-cases.js'
import type { Deps } from './use-cases.js'

export interface AgentDeps extends Deps, NotificationDeps, NoteDeps {
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
 * The product shape gives a Planner no filesystem and no shell, and the roadmap writes it as `tools: []`.
 * Enforced at authoring time rather than trusted: a Planner that also held `Bash`
 * would make every attenuation check downstream meaningless, since its children
 * could then legitimately inherit it.
 */
const assertPlannerHasNoTools = (parsed: {
 harnessPlanner: boolean
 tools: string[]
 harnessDelegates: string[]
}): void => {
 if (parsed.harnessPlanner && parsed.tools.length > 0) {
 throw new ValidationError(
 `A planner persona must declare "tools: []" — it delegates rather than acting. Got: ${parsed.tools.join(', ')}`,
)
 }
 // Only a planner may carry an envelope. On any other persona it would be a
 // general way to hand children more than the parent holds, which is the exact
 // escalation the attenuation exists to prevent.
 if (!parsed.harnessPlanner && parsed.harnessDelegates.length > 0) {
 throw new ValidationError(
 'Only a planner persona may declare "harness.delegates" — it is the envelope its children are attenuated against.',
)
 }
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
 assertPlannerHasNoTools(parsed)
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
 */
export const seedBuiltinPersonas = async (
 deps: AgentDeps,
 input: { workspaceId: WorkspaceId },
): Promise<void> => {
 const existing = new Set(
 (await deps.personas.listByWorkspace(input.workspaceId)).map((persona) => persona.name),
)
 for (const persona of BUILTIN_PERSONAS) {
 if (existing.has(persona.name)) continue
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
 harnessPlanner: persona.harnessPlanner,
 harnessDelegates: persona.harnessDelegates,
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
 assertPlannerHasNoTools(parsed)
 return deps.personas.update(input.workspaceId, input.personaId, {
 description: parsed.description,
 markdownSource: input.markdownSource,
 model: parsed.model,
 tools: parsed.tools,
 harnessEffort: parsed.harnessEffort,
 harnessMaxTurns: parsed.harnessMaxTurns,
 harnessAutoApprove: parsed.harnessAutoApprove,
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
 },
): Promise<Capability> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may register a capability')
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
 specs.push({ kind: 'skill', name: capability.name, content: capability.content ?? '' })
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

 // Concurrency limit. Phase 1 allowed exactly one
 // active run workspace-wide; a swarm is N workers on one goal, so the limit is
 // now a number rather than a special case. It is still a *limit*: unbounded
 // concurrency multiplies both spend and the human attention the riskiest assumption is about, and a
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

 // A child inherits the style its parent was launched with, so one swarm speaks in
 // one voice; only a human's start actually chooses one.
 const responseStyle: ResponseStyle =
 input.responseStyle ?? parent?.persona.responseStyle ?? DEFAULT_RESPONSE_STYLE

 if (input.model !== undefined && !isPricedModel(input.model)) {
 throw new ValidationError(
 `Unknown model "${input.model}" — spend on it could not be metered, so its budget cap could not be enforced`,
)
 }

 const personaSpec: PersonaSpec = {
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
 autoApprove: persona.harnessAutoApprove,
 planner: persona.harnessPlanner,
 delegates: persona.harnessDelegates,
 capabilities: await resolveCapabilities(deps, input.workspaceId, input.personaId),
 }

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

 try {
 await deps.dispatch.startRun({
 runnerId: repository.runnerId,
 runId: run.id,
 persona: personaSpec,
 cwd: repository.absolutePath,
 defaultBranch: repository.defaultBranch,
...(input.task === undefined ? {}: { task: input.task }),
...(contextLedger === '' ? {}: { contextLedger }),
...(input.reconcile && parent
 ? { reconcile: { parentRunId: parent.id, branchName: input.reconcile.branchName } }
: {}),
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
 const started: AgentRunId[] = []
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

 for (const subtask of verdict.decomposition.subtasks) {
 const persona = personas.find((candidate) => candidate.name === subtask.personaName)
 if (!persona) {
 refused.push(`${subtask.title}: no persona named "${subtask.personaName}"`)
 continue
 }

 try {
 const child = await startAgentRun(deps, {
 workspaceId: input.workspaceId,
 // The Planner acts as itself. `startAgentRun` enforces that a run may only
 // spawn children *of itself*, so this is also what ties attenuation to the
 // right parent.
 actor: agentRunActor(planner.id),
 threadId: planner.threadId,
 repositoryId: planner.repositoryId,
 personaId: persona.id,
 // The paths this subtask owns are appended to the *task*, not left only in
 // the ledger. The ledger carries every sibling's claim, so a worker reading
 // it alone cannot tell which claim is its own — and the task is the one
 // channel a worker is meant to treat as authoritative.
 task:
 subtask.paths.length === 0
 ? subtask.task
: `${subtask.task}\n\nYou own these paths for this task: ${subtask.paths.join(', ')}. Other workers own the rest; prefer leaving their paths alone and reporting what you need from them.`,
 parentRunId: planner.id,
 relation: 'delegation',
 ownedPaths: subtask.paths,
 })
 started.push(child.id)
 } catch (error) {
 refused.push(`${subtask.title}: ${error instanceof Error ? error.message: String(error)}`)
 }
 }

 const summary = [
 `Plan accepted: ${started.length} subtask(s) started.`,
...verdict.decomposition.subtasks
.filter((_, index) => index < started.length)
.map((subtask) => `• ${subtask.title} → ${subtask.personaName}`),
...refused.map((reason) => `✗ ${reason}`),
 ].join('\n')
 await postRunSystemMessage(deps, planner, summary)

 return { started, refused }
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
 const delegated = siblings.filter((sibling) => sibling.relation === 'delegation')
 if (delegated.length === 0) return
 // Only the last one reports. Anything else would post a partial summary per
 // child finishing, which is noise at exactly the wrong moment.
 if (!delegated.every((sibling) => TERMINAL_RUN_STATUSES.includes(sibling.status))) return

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
): Promise<void> =>
 deps.agentRuns.recordHeartbeat(input.workspaceId, input.agentRunId, input.context)

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

 return { ok: result.ok, detail: result.ok ? null: result.detail }
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
 enqueuedByUserId: input.actor.kind === 'user' ? input.actor.userId: null,
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
