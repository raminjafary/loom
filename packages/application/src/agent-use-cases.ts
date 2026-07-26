import {
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
 type ApprovalRequest,
 type ApprovalRequestId,
 type PersonaSpec,
 type Repository,
 type RepositoryId,
 type Runner,
 type RunnerId,
 type ThreadId,
 type WorkspaceId,
} from '@loom/domain'
import type {
 AgentRunRepositoryPort,
 ApprovalRepositoryPort,
 PersonaRepositoryPort,
 RepositoryRepositoryPort,
 RunDispatchPort,
 RunnerRepositoryPort,
} from './agent-ports.js'
import type { Deps } from './use-cases.js'

export interface AgentDeps extends Deps {
 readonly runners: RunnerRepositoryPort
 readonly repositories: RepositoryRepositoryPort
 readonly agentRuns: AgentRunRepositoryPort
 readonly approvals: ApprovalRepositoryPort
 readonly personas: PersonaRepositoryPort
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
 })
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
 })
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
 },
): Promise<AgentRun> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may start an agent run')
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
 })
 } catch (error) {
 const failed = await deps.agentRuns.updateStatus(input.workspaceId, run.id, {
 status: 'failed',
 errorMessage: error instanceof Error ? error.message: String(error),
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
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId; event: AgentEvent },
): Promise<void> => {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')

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
