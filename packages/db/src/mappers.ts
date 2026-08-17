import {
 MAP_EDGE_KINDS,
 MAP_NODE_KINDS,
 MAP_PROVENANCES,
 MAP_SUBJECT_KINDS,
 asSubjectMapId,
 asAgentPersonaId,
 asAgentRunId,
 asApprovalRequestId,
 asAuditEventId,
 asCapabilityId,
 asChannelId,
 asMergeQueueEntryId,
 asMessageId,
 asPersonaGroupId,
 asPersonaRevisionId,
 asPersonaVariantId,
 asPersonaVariantSetId,
 asRepositoryId,
 asRunnerId,
 asThreadId,
 asUserId,
 isApprovalMode,
 approvalModeFromSnapshot,
 DEFAULT_APPROVAL_MODE,
 type ApprovalMode,
 asWorkerNoteId,
 asWorkspaceId,
 AUTHORED_NOTE_KINDS,
 PLATFORM_NOTE_KINDS,
 type Actor,
 type AgentPersona,
 type PersonaRevision,
 type PersonaVariant,
 type PersonaVariantSet,
 type Envelope,
 type AgentRun,
 type AgentRunBranchDisposition,
 type AgentRunRelation,
 type AgentRunStatus,
 type ApprovalRequest,
 type ApprovalStatus,
 type AuditEvent,
 type Capability,
 type CapabilitySpec,
 type Channel,
 type MergeFailureReason,
 type MergeQueueEntry,
 type MergeQueueEntryStatus,
 type Message,
 type MessageBody,
 type NoteAuthorKind,
 type NotificationTarget,
 type NotificationTransport,
 type PersonaCapability,
 type PersonaGroup,
 type PersonaSpec,
 type Repository,
 type Runner,
 type Thread,
 type WorkerNote,
 type WorkerNoteKind,
 type MapEdge,
 type MapNode,
 type SubjectMap,
 type SubjectMapStatus,
 type RunVerification,
 type VerificationCheck,
 type VerificationCheckResult,
 type VerificationStatus,
 asRunVerificationId,
} from '@loom/domain'
import type { PlanSubtaskRecord } from '@loom/application'

/**
 * The translation seam. Drizzle row shapes stop here and domain entities start
 * here — that is what keeps `PersistencePort` swappable.
 */

/**
 * A stored approval mode, defaulted rather than trusted.
 *
 * The column is `text`, so an unrecognised value is possible — a hand-edited row, or a
 * mode a future build adds and this one does not know. It reads as `ask`, the
 * narrowest, because the failure has to fall closed: guessing wide would hand a run
 * permissions nobody granted it.
 */
const toApprovalMode = (value: string): ApprovalMode =>
 isApprovalMode(value) ? value: DEFAULT_APPROVAL_MODE

interface ActorColumns {
 actorKind: string
 actorUserId: string | null
 actorAgentRunId: string | null
}

export const toActor = (row: ActorColumns): Actor => {
 switch (row.actorKind) {
 case 'user':
 if (!row.actorUserId) throw new Error('user actor row missing actor_user_id')
 return { kind: 'user', userId: asUserId(row.actorUserId) }
 case 'agent_run':
 if (!row.actorAgentRunId) throw new Error('agent_run actor row missing actor_agent_run_id')
 return { kind: 'agent_run', agentRunId: asAgentRunId(row.actorAgentRunId) }
 case 'system':
 return { kind: 'system' }
 default:
 throw new Error(`unknown actor_kind: ${row.actorKind}`)
 }
}

export const fromActor = (actor: Actor): ActorColumns => {
 switch (actor.kind) {
 case 'user':
 return { actorKind: 'user', actorUserId: actor.userId, actorAgentRunId: null }
 case 'agent_run':
 return { actorKind: 'agent_run', actorUserId: null, actorAgentRunId: actor.agentRunId }
 case 'system':
 return { actorKind: 'system', actorUserId: null, actorAgentRunId: null }
 }
}

const toMessageBody = (bodyKind: string, bodyText: string): MessageBody => {
 if (bodyKind === 'text') return { kind: 'text', text: bodyText }
 if (bodyKind === 'system') return { kind: 'system', text: bodyText }
 throw new Error(`unknown body_kind: ${bodyKind}`)
}

export interface ChannelRow {
 id: string
 workspaceId: string
 name: string
 topic: string | null
 isPrivate: boolean
 createdAt: Date
}

export const toChannel = (row: ChannelRow): Channel => ({
 id: asChannelId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 name: row.name,
 topic: row.topic,
 isPrivate: row.isPrivate,
 createdAt: row.createdAt,
})

export interface ThreadRow {
 id: string
 workspaceId: string
 channelId: string
 parentMessageId: string | null
 isRoot: boolean
 createdAt: Date
}

export const toThread = (row: ThreadRow): Thread => ({
 id: asThreadId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 channelId: asChannelId(row.channelId),
 parentMessageId: row.parentMessageId ? asMessageId(row.parentMessageId): null,
 isRoot: row.isRoot,
 createdAt: row.createdAt,
})

export interface MessageRow extends ActorColumns {
 id: string
 workspaceId: string
 threadId: string
 bodyKind: string
 bodyText: string
 toolUseId: string | null
 createdAt: Date
 editedAt: Date | null
}

export const toMessage = (row: MessageRow): Message => ({
 id: asMessageId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 threadId: asThreadId(row.threadId),
 author: toActor(row),
 body: toMessageBody(row.bodyKind, row.bodyText),
 toolUseId: row.toolUseId,
 createdAt: row.createdAt,
 editedAt: row.editedAt,
})

export interface AuditRow extends ActorColumns {
 id: string
 workspaceId: string
 action: string
 subjectType: string
 subjectId: string
 metadata: unknown
 createdAt: Date
}

export const toAuditEvent = (row: AuditRow): AuditEvent => ({
 id: asAuditEventId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 actor: toActor(row),
 action: row.action,
 subjectType: row.subjectType,
 subjectId: row.subjectId,
 metadata: (row.metadata ?? {}) as Record<string, unknown>,
 createdAt: row.createdAt,
})

export interface RunnerRow {
 id: string
 workspaceId: string
 name: string
 allowedRoots: unknown
 connected: boolean
 lastSeenAt: Date | null
 createdAt: Date
}

export const toRunner = (row: RunnerRow): Runner => ({
 id: asRunnerId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 name: row.name,
 allowedRoots: Array.isArray(row.allowedRoots) ? (row.allowedRoots as string[]): [],
 connected: row.connected,
 lastSeenAt: row.lastSeenAt,
 createdAt: row.createdAt,
})

export interface RepositoryRow {
 id: string
 workspaceId: string
 runnerId: string
 displayName: string
 absolutePath: string
 defaultBranch: string
 verifyCommand: string | null
 verificationChecks?: VerificationCheck[] | null
 installCommand: string | null
 reconcilerEnabled?: boolean
 createdAt: Date
}

export const toRepository = (row: RepositoryRow): Repository => ({
 id: asRepositoryId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 runnerId: asRunnerId(row.runnerId),
 displayName: row.displayName,
 absolutePath: row.absolutePath,
 defaultBranch: row.defaultBranch,
 verifyCommand: row.verifyCommand,
 // Empty for a row read before the column existed, which is exactly what it means:
 // that repository's definition of done is whatever `verifyCommand` holds.
 verificationChecks: row.verificationChecks ?? [],
 installCommand: row.installCommand,
 // Defaulted to on for a row read before the column existed, which is the behaviour
 // every repository had then and the one measurement argues for.
 reconcilerEnabled: row.reconcilerEnabled ?? true,
 createdAt: row.createdAt,
})

export interface CapabilityRow {
 id: string
 workspaceId: string
 kind: string
 name: string
 description: string
 transport: string | null
 command: string | null
 args: string[]
 url: string | null
 toolListHash: string | null
 content: string | null
 egressHosts: string[]
 createdAt: Date
 updatedAt: Date
}

export const toCapability = (row: CapabilityRow): Capability => {
 if (row.kind !== 'mcp' && row.kind !== 'skill') {
 throw new Error(`unknown capability kind: ${row.kind}`)
 }
 const transport =
 row.transport === 'stdio' || row.transport === 'sse' || row.transport === 'http'
 ? row.transport
: null
 return {
 id: asCapabilityId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 kind: row.kind,
 name: row.name,
 description: row.description,
 transport,
 command: row.command,
 args: row.args,
 url: row.url,
 toolListHash: row.toolListHash,
 content: row.content,
 egressHosts: row.egressHosts,
 createdAt: row.createdAt,
 updatedAt: row.updatedAt,
 }
}

export interface PersonaCapabilityRow {
 id: string
 workspaceId: string
 personaId: string
 capabilityId: string
 allowedTools: string[]
}

export const toPersonaCapability = (row: PersonaCapabilityRow): PersonaCapability => ({
 id: row.id,
 workspaceId: asWorkspaceId(row.workspaceId),
 personaId: asAgentPersonaId(row.personaId),
 capabilityId: asCapabilityId(row.capabilityId),
 allowedTools: row.allowedTools,
})

export interface MergeQueueEntryRow {
 id: string
 position: bigint
 workspaceId: string
 repositoryId: string
 agentRunId: string
 branchName: string
 status: string
 failureReason: string | null
 detail: string | null
 mergedCommitSha: string | null
 verified: boolean
 enqueuedByUserId: string | null
 createdAt: Date
 startedAt: Date | null
 finishedAt: Date | null
}

const MERGE_QUEUE_STATUSES: readonly MergeQueueEntryStatus[] = [
 'queued',
 'merging',
 'merged',
 'failed',
 'cancelled',
]

const MERGE_FAILURE_REASONS: readonly MergeFailureReason[] = [
 'conflict',
 'verification_failed',
 'verification_refused',
 'dirty_target',
 'stale_target',
 'runner_error',
]

export const toMergeQueueEntry = (row: MergeQueueEntryRow): MergeQueueEntry => {
 const status = MERGE_QUEUE_STATUSES.find((candidate) => candidate === row.status)
 if (!status) throw new Error(`unknown merge_queue_entry.status: ${row.status}`)

 const failureReason =
 row.failureReason === null
 ? null
: (MERGE_FAILURE_REASONS.find((candidate) => candidate === row.failureReason) ?? null)

 return {
 id: asMergeQueueEntryId(row.id),
 // postgres.js hands bigserial back as a string unless told otherwise; both
 // shapes are accepted here rather than depending on driver configuration for
 // an ordering key.
 position: BigInt(row.position),
 workspaceId: asWorkspaceId(row.workspaceId),
 repositoryId: asRepositoryId(row.repositoryId),
 agentRunId: asAgentRunId(row.agentRunId),
 branchName: row.branchName,
 status,
 failureReason,
 detail: row.detail,
 mergedCommitSha: row.mergedCommitSha,
 verified: row.verified,
 enqueuedByUserId: row.enqueuedByUserId,
 createdAt: row.createdAt,
 startedAt: row.startedAt,
 finishedAt: row.finishedAt,
 }
}

export interface RunVerificationRow {
 id: string
 workspaceId: string
 agentRunId: string
 repositoryId: string
 branchName: string
 status: string
 commitSha: string | null
 checks: VerificationCheckResult[] | null
 reason: string | null
 createdAt: Date
 startedAt: Date | null
 finishedAt: Date | null
}

const VERIFICATION_STATUSES: readonly VerificationStatus[] = [
 'pending',
 'passed',
 'failed',
 'skipped',
 'refused',
 'error',
]

export const toRunVerification = (row: RunVerificationRow): RunVerification => {
 const status = VERIFICATION_STATUSES.find((candidate) => candidate === row.status)
 // Thrown rather than defaulted, unlike an approval mode: there is no narrowest
 // verification status to fall back to. `passed` would certify unmeasured work and
 // `failed` would condemn it, so an unreadable row is a bug to surface, not a verdict.
 if (!status) throw new Error(`unknown run_verification.status: ${row.status}`)

 return {
 id: asRunVerificationId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 agentRunId: asAgentRunId(row.agentRunId),
 repositoryId: asRepositoryId(row.repositoryId),
 branchName: row.branchName,
 status,
 commitSha: row.commitSha,
 checks: row.checks ?? [],
 reason: row.reason,
 createdAt: row.createdAt,
 startedAt: row.startedAt,
 finishedAt: row.finishedAt,
 }
}

const isPersonaSpec = (value: unknown): value is PersonaSpec =>
 typeof value === 'object' &&
 value !== null &&
 typeof (value as Record<string, unknown>).name === 'string' &&
 typeof (value as Record<string, unknown>).systemPrompt === 'string' &&
 typeof (value as Record<string, unknown>).model === 'string' &&
 Array.isArray((value as Record<string, unknown>).tools)

const toPersonaSpec = (value: unknown): PersonaSpec => {
 if (!isPersonaSpec(value)) throw new Error('malformed persona spec in agent_run row')
 // `budgetCapUsd` postdates some already-completed runs' stored persona JSON (added
 // after they ran) — defaulted rather than letting a legacy row fail output
 // validation the first time something re-fetches it in bulk. It defaults to null
 // (uncapped) because that is what those runs actually executed under; inventing a
 // cap retroactively would misreport history. `capabilities` postdates the registry
 // landing, same story: a run that completed before it existed held none.
 const raw = value as {
 approvalMode?: unknown
 autoApprove?: unknown
 budgetCapUsd?: unknown
 capabilities?: unknown
 }
 return {
...value,
 /**
 * The mode, read through the boolean it replaced (`approvalModeFromSnapshot`).
 *
 * A run that finished before approval modes existed has `autoApprove` in its
 * persona JSON and nothing else, and it must still be readable — its cost, its
 * diff and its transcript are all still wanted. This is a *historical* record
 * being rendered, never a permission being granted: nothing re-runs from a
 * snapshot, so reading `true` as `auto` reports what that run actually ran under
 * rather than deciding anything.
 */
 approvalMode: approvalModeFromSnapshot(raw),
 budgetCapUsd: typeof raw.budgetCapUsd === 'number' ? raw.budgetCapUsd: null,
 capabilities: Array.isArray(raw.capabilities) ? (raw.capabilities as CapabilitySpec[]): [],
 }
}

export interface AgentRunRow {
 id: string
 workspaceId: string
 threadId: string
 repositoryId: string
 runnerId: string
 persona: unknown
 parentRunId: string | null
 relation: string | null
 task: string | null
 status: string
 totalCostUsd: number | null
 errorMessage: string | null
 clonePath: string | null
 branchName: string | null
 branchDisposition: string | null
 lastHeartbeatAt: Date | null
 lastEventAt: Date | null
 contextTokens: number | null
 contextMaxTokens: number | null
 handoffSuggestedAt: Date | null
 createdAt: Date
 completedAt: Date | null
}

const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
 'pending',
 'running',
 'awaiting_approval',
 'completed',
 'failed',
 'cancelled',
]

const toAgentRunStatus = (value: string): AgentRunStatus => {
 if ((AGENT_RUN_STATUSES as readonly string[]).includes(value)) return value as AgentRunStatus
 throw new Error(`unknown agent_run status: ${value}`)
}

const AGENT_RUN_BRANCH_DISPOSITIONS: readonly AgentRunBranchDisposition[] = [
 'kept',
 'discarded',
 'pushed',
 'merged',
]

const toAgentRunBranchDisposition = (value: string | null): AgentRunBranchDisposition | null => {
 if (value === null) return null
 if ((AGENT_RUN_BRANCH_DISPOSITIONS as readonly string[]).includes(value)) {
 return value as AgentRunBranchDisposition
 }
 throw new Error(`unknown agent_run branch_disposition: ${value}`)
}

const AGENT_RUN_RELATIONS: readonly AgentRunRelation[] = [
 'delegation',
 'review',
 'reconcile',
 'steer',
 'handoff',
]

const toAgentRunRelation = (value: string | null): AgentRunRelation | null => {
 if (value === null) return null
 if ((AGENT_RUN_RELATIONS as readonly string[]).includes(value)) return value as AgentRunRelation
 throw new Error(`unknown agent_run relation: ${value}`)
}

export const toAgentRun = (row: AgentRunRow): AgentRun => ({
 id: asAgentRunId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 threadId: asThreadId(row.threadId),
 repositoryId: asRepositoryId(row.repositoryId),
 runnerId: asRunnerId(row.runnerId),
 persona: toPersonaSpec(row.persona),
 parentRunId: row.parentRunId === null ? null: asAgentRunId(row.parentRunId),
 relation: toAgentRunRelation(row.relation),
 task: row.task,
 status: toAgentRunStatus(row.status),
 totalCostUsd: row.totalCostUsd,
 errorMessage: row.errorMessage,
 clonePath: row.clonePath,
 branchName: row.branchName,
 branchDisposition: toAgentRunBranchDisposition(row.branchDisposition),
 lastHeartbeatAt: row.lastHeartbeatAt,
 lastEventAt: row.lastEventAt,
 contextTokens: row.contextTokens,
 contextMaxTokens: row.contextMaxTokens,
 handoffSuggestedAt: row.handoffSuggestedAt,
 createdAt: row.createdAt,
 completedAt: row.completedAt,
})

export interface ApprovalRequestRow {
 question?: string | null
 answer?: string | null
 id: string
 workspaceId: string
 agentRunId: string
 toolUseId: string
 toolName: string
 input: unknown
 status: string
 createdAt: Date
 resolvedAt: Date | null
}

const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'denied']

const toApprovalStatus = (value: string): ApprovalStatus => {
 if ((APPROVAL_STATUSES as readonly string[]).includes(value)) return value as ApprovalStatus
 throw new Error(`unknown approval_request status: ${value}`)
}

export const toApprovalRequest = (row: ApprovalRequestRow): ApprovalRequest => ({
 id: asApprovalRequestId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 agentRunId: asAgentRunId(row.agentRunId),
 toolUseId: row.toolUseId,
 toolName: row.toolName,
 input: (row.input ?? {}) as Record<string, unknown>,
 status: toApprovalStatus(row.status),
 // Null on every gate created before mid-flight steering, and on every ordinary tool gate since.
 question: row.question ?? null,
 answer: row.answer ?? null,
 createdAt: row.createdAt,
 resolvedAt: row.resolvedAt,
})

export interface AgentPersonaRow {
 id: string
 workspaceId: string
 name: string
 description: string
 markdownSource: string
 model: string
 tools: unknown
 harnessEffort: string | null
 harnessMaxTurns: number | null
 harnessApprovalMode: string
 harnessPlanner: boolean
 harnessDelegates: string[]
 harnessBudgetCapUsd: number | null
 envelope?: Envelope | null
 builtinSource?: string | null
 createdAt: Date
 updatedAt: Date
}

export const toAgentPersona = (row: AgentPersonaRow): AgentPersona => ({
 id: asAgentPersonaId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 name: row.name,
 description: row.description,
 markdownSource: row.markdownSource,
 model: row.model,
 tools: Array.isArray(row.tools) ? (row.tools as string[]): [],
 harnessEffort: row.harnessEffort,
 harnessMaxTurns: row.harnessMaxTurns,
 harnessApprovalMode: toApprovalMode(row.harnessApprovalMode),
 harnessPlanner: row.harnessPlanner,
 harnessDelegates: row.harnessDelegates,
 harnessBudgetCapUsd: row.harnessBudgetCapUsd,
 // `?? null` rather than a default object: a row written before this column existed has
 // no envelope, which is exactly the same statement as a persona whose operator chose
 // not to give it one — it may not rewrite itself.
 envelope: row.envelope ?? null,
 builtinSource: row.builtinSource ?? null,
 createdAt: row.createdAt,
 updatedAt: row.updatedAt,
})

export interface PersonaRevisionRow {
 id: string
 workspaceId: string
 personaId: string
 markdownSource: string
 replacedByKind: string
 replacedByRunId: string | null
 replacedByUserId: string | null
 rationale: string
 createdAt: Date
}

/**
 * A superseded prompt.
 *
 * `replacedByKind` is narrowed rather than validated: the column is written only by this
 * package's own repository, and an unrecognized value reads as `platform`, which is the
 * kind that claims the least about who did it.
 */
export const toPersonaRevision = (row: PersonaRevisionRow): PersonaRevision => ({
 id: asPersonaRevisionId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 personaId: asAgentPersonaId(row.personaId),
 markdownSource: row.markdownSource,
 replacedByKind:
 row.replacedByKind === 'human' || row.replacedByKind === 'agent_run'
 ? row.replacedByKind
: 'platform',
 replacedByRunId: row.replacedByRunId === null ? null: asAgentRunId(row.replacedByRunId),
 replacedByUserId: row.replacedByUserId === null ? null: asUserId(row.replacedByUserId),
 rationale: row.rationale,
 createdAt: row.createdAt,
})

export interface PersonaVariantSetRow {
 id: string
 workspaceId: string
 personaId: string
 proposedByRunId: string | null
 status: string
 promotedVariantId: string | null
 settledAt: Date | null
 settledByUserId: string | null
 createdAt: Date
}

/**
 * One search over candidate prompts.
 *
 * `status` is narrowed rather than validated, the same way a revision's author kind is: the
 * column is written only by this package, and anything unrecognized reads as `settled` —
 * the state that claims no measurement is running, which is the safe direction to be wrong
 * in. Reading a corrupt row as `open` would hold a persona's search slot forever.
 */
export const toPersonaVariantSet = (row: PersonaVariantSetRow): PersonaVariantSet => ({
 id: asPersonaVariantSetId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 personaId: asAgentPersonaId(row.personaId),
 proposedByRunId: row.proposedByRunId === null ? null: asAgentRunId(row.proposedByRunId),
 status: row.status === 'open' ? 'open': 'settled',
 promotedVariantId:
 row.promotedVariantId === null ? null: asPersonaVariantId(row.promotedVariantId),
 settledAt: row.settledAt,
 settledByUserId: row.settledByUserId === null ? null: asUserId(row.settledByUserId),
 createdAt: row.createdAt,
})

export interface PersonaVariantRow {
 id: string
 workspaceId: string
 setId: string
 personaId: string
 markdownSource: string
 rationale: string
 position: number
 createdAt: Date
}

export const toPersonaVariant = (row: PersonaVariantRow): PersonaVariant => ({
 id: asPersonaVariantId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 setId: asPersonaVariantSetId(row.setId),
 personaId: asAgentPersonaId(row.personaId),
 markdownSource: row.markdownSource,
 rationale: row.rationale,
 position: row.position,
 createdAt: row.createdAt,
})

export interface PersonaGroupRow {
 id: string
 workspaceId: string
 name: string
 description?: string | null
 personaIds: unknown
 layout?: unknown
 fleet?: unknown
 reviewers?: unknown
 reportsTo?: unknown
 orchestratorId?: string | null
 repositoryId?: string | null
 extraRepositoryIds?: unknown
 createdAt: Date
 updatedAt: Date
}

export const toPersonaGroup = (row: PersonaGroupRow): PersonaGroup => ({
 id: asPersonaGroupId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 name: row.name,
 // Empty for a row that predates the column and for one nobody described — the same
 // state, and both mean "undescribed" rather than "missing".
 description: row.description ?? '',
 personaIds: Array.isArray(row.personaIds) ? (row.personaIds as string[]): [],
 // Defaulted rather than trusted: rows written before the column existed carry no
 // layout, and a group with no positions must open as an unarranged canvas rather
 // than fail to load.
 layout:
 row.layout && typeof row.layout === 'object' && !Array.isArray(row.layout)
 ? (row.layout as Record<string, { x: number; y: number }>)
: {},
 // Defaulted for the same reason `layout` is, and it matters more here: an unsized team
 // is the pre-fleet behaviour (the Planner decides), so a row that predates the column
 // has to read as unsized rather than as sized-to-nothing.
 fleet:
 row.fleet && typeof row.fleet === 'object' && !Array.isArray(row.fleet)
 ? (row.fleet as Record<string, number>)
: {},
 // Defaulted like the two above: a row written before the column existed expects nothing
 // to be reviewed, which is the behaviour every team had before this shipped.
 reviewers:
 row.reviewers && typeof row.reviewers === 'object' && !Array.isArray(row.reviewers)
 ? (row.reviewers as Record<string, string[]>)
: {},
 // Defaulted like the three above. Empty is every team that predates the column, and it
 // means no narrowing rather than nobody: an unassigned worker is offered to every planner,
 // which is exactly what a team with no chain of command has always done.
 reportsTo:
 row.reportsTo && typeof row.reportsTo === 'object' && !Array.isArray(row.reportsTo)
 ? (row.reportsTo as Record<string, string>)
: {},
 // Null for every team that predates the column, which is the same state as "nobody has
 // chosen" — the canvas picks by reach and says so, rather than rendering an empty tier.
 orchestratorId: row.orchestratorId ?? null,
 // Null for a team that predates the column and for one whose repository was deleted —
 // deliberately the same state, because both mean the same thing to every reader: no
 // repository chosen, so nothing is defaulted from this team.
 repositoryId: row.repositoryId ?? null,
 // Empty for a row that predates the column: the team works in one repository, which is
 // what every team did before a cross-repository team was expressible.
 extraRepositoryIds: Array.isArray(row.extraRepositoryIds)
 ? (row.extraRepositoryIds as string[])
: [],
 createdAt: row.createdAt,
 updatedAt: row.updatedAt,
})

export interface NotificationTargetRow {
 id: string
 workspaceId: string
 userId: string
 transport: string
 endpoint: string
 credentials: unknown
 createdAt: Date
}

export const toNotificationTarget = (row: NotificationTargetRow): NotificationTarget => ({
 id: row.id,
 workspaceId: asWorkspaceId(row.workspaceId),
 userId: asUserId(row.userId),
 // Only one transport exists so far; a row with anything else is a migration
 // artifact, and silently treating it as web push would send garbage.
 transport: row.transport as NotificationTransport,
 endpoint: row.endpoint,
 credentials:
 row.credentials !== null && typeof row.credentials === 'object'
 ? (row.credentials as Record<string, string>)
: {},
 createdAt: row.createdAt,
})

export interface PlanSubtaskRow {
 id: string
 workspaceId: string
 plannerRunId: string
 position: number
 title: string
 task: string
 personaName: string
 paths: unknown
 dependsOn: unknown
 reviews: number | null
 repository?: string | null
 status: string
 agentRunId: string | null
 detail: string | null
}

const PLAN_SUBTASK_STATUSES = ['waiting', 'started', 'skipped', 'refused'] as const

/**
 * Hand-validated rather than cast, like every other status in this file. A status
 * this mapper does not recognise is a row written by code that no longer matches the
 * reader, and silently widening the type is how a `waiting` subtask ends up treated
 * as terminal — which would strand the rest of its pipeline with no error anywhere.
 */
export const toPlanSubtask = (row: PlanSubtaskRow): PlanSubtaskRecord => {
 const status = PLAN_SUBTASK_STATUSES.find((candidate) => candidate === row.status)
 if (!status) throw new Error(`unknown plan_subtask.status: ${row.status}`)

 return {
 id: row.id,
 workspaceId: asWorkspaceId(row.workspaceId),
 plannerRunId: asAgentRunId(row.plannerRunId),
 position: row.position,
 title: row.title,
 task: row.task,
 personaName: row.personaName,
 paths: Array.isArray(row.paths) ? (row.paths as string[]): [],
 dependsOn: Array.isArray(row.dependsOn) ? (row.dependsOn as number[]): [],
 reviews: row.reviews,
 // Null for every row that predates the column, which means the same thing it means for
 // a subtask that named nothing: the planner's own repository.
 repository: row.repository ?? null,
 status,
 agentRunId: row.agentRunId === null ? null: asAgentRunId(row.agentRunId),
 detail: row.detail,
 }
}

export interface WorkerNoteRow {
 id: string
 workspaceId: string
 treeRunId: string
 agentRunId: string | null
 authorKind: string
 kind: string
 title: string
 body: string
 paths: unknown
 createdAt: Date
}

const NOTE_AUTHOR_KINDS: readonly NoteAuthorKind[] = ['platform', 'human', 'agent_run']

const NOTE_KINDS: readonly WorkerNoteKind[] = [...PLATFORM_NOTE_KINDS,...AUTHORED_NOTE_KINDS]

export const toWorkerNote = (row: WorkerNoteRow): WorkerNote => {
 const authorKind = NOTE_AUTHOR_KINDS.find((candidate) => candidate === row.authorKind)
 if (!authorKind) throw new Error(`unknown worker_note.author_kind: ${row.authorKind}`)

 const kind = NOTE_KINDS.find((candidate) => candidate === row.kind)
 if (!kind) throw new Error(`unknown worker_note.kind: ${row.kind}`)

 return {
 id: asWorkerNoteId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 treeRunId: asAgentRunId(row.treeRunId),
 agentRunId: row.agentRunId === null ? null: asAgentRunId(row.agentRunId),
 authorKind,
 kind,
 title: row.title,
 body: row.body,
 paths: Array.isArray(row.paths) ? (row.paths as string[]): [],
 createdAt: row.createdAt,
 }
}

/** Cursors are opaque to callers; internally they are the `seq` watermark. */
export const encodeCursor = (seq: bigint): string =>
 Buffer.from(`seq:${seq.toString}`, 'utf8').toString('base64url')

export const decodeCursor = (cursor: string): bigint => {
 const raw = Buffer.from(cursor, 'base64url').toString('utf8')
 const match = /^seq:(\d+)$/.exec(raw)
 if (!match?.[1]) throw new Error('malformed cursor')
 return BigInt(match[1])
}

export interface SubjectMapRow {
 id: string
 workspaceId: string
 personaId: string
 subjectKind: string
 repositoryId: string | null
 subjectRef: string
 revision: string
 status: string
 retrievalOverride?: string | null
 masteryRunId: string | null
 createdAt: Date
 updatedAt: Date
}

export interface SubjectMapNodeRow {
 retirementProposedAt?: Date | null
 retirementReason?: string | null
 id: string
 workspaceId: string
 mapId: string
 key: string
 kind: string
 label: string
 summary: string
 provenance: string
 paths: unknown
 observationCount: number
 derivedAtRevision: string
 createdAt: Date
 invalidatedAt: Date | null
 invalidatedReason: string | null
}

export interface SubjectMapEdgeRow {
 id: string
 workspaceId: string
 mapId: string
 fromKey: string
 toKey: string
 kind: string
 provenance: string
 derivedAtRevision: string
 createdAt: Date
 invalidatedAt: Date | null
 invalidatedReason: string | null
}

const SUBJECT_MAP_STATUSES: readonly SubjectMapStatus[] = ['mastering', 'ready', 'failed']

export const toSubjectMap = (row: SubjectMapRow): SubjectMap => {
 const subjectKind = MAP_SUBJECT_KINDS.find((candidate) => candidate === row.subjectKind)
 if (!subjectKind) throw new Error(`unknown subject_map.subject_kind: ${row.subjectKind}`)

 const status = SUBJECT_MAP_STATUSES.find((candidate) => candidate === row.status)
 if (!status) throw new Error(`unknown subject_map.status: ${row.status}`)

 return {
 id: asSubjectMapId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 personaId: asAgentPersonaId(row.personaId),
 subjectKind,
 repositoryId: row.repositoryId === null ? null: asRepositoryId(row.repositoryId),
 subjectRef: row.subjectRef,
 revision: row.revision,
 status,
 // Anything that is not one of the two answers reads as "nobody has decided", which
 // is the state every map written before this column existed is really in.
 retrievalOverride:
 row.retrievalOverride === 'on' || row.retrievalOverride === 'off'
 ? row.retrievalOverride
: null,
 masteryRunId: row.masteryRunId === null ? null: asAgentRunId(row.masteryRunId),
 createdAt: row.createdAt,
 updatedAt: row.updatedAt,
 }
}

export const toMapNode = (row: SubjectMapNodeRow): MapNode => {
 const kind = MAP_NODE_KINDS.find((candidate) => candidate === row.kind)
 if (!kind) throw new Error(`unknown subject_map_node.kind: ${row.kind}`)

 const provenance = MAP_PROVENANCES.find((candidate) => candidate === row.provenance)
 if (!provenance) throw new Error(`unknown subject_map_node.provenance: ${row.provenance}`)

 return {
 id: row.id,
 mapId: asSubjectMapId(row.mapId),
 workspaceId: asWorkspaceId(row.workspaceId),
 key: row.key,
 kind,
 label: row.label,
 summary: row.summary,
 provenance,
 paths: Array.isArray(row.paths) ? (row.paths as string[]): [],
 observationCount: row.observationCount,
 derivedAtRevision: row.derivedAtRevision,
 createdAt: row.createdAt,
 invalidatedAt: row.invalidatedAt,
 invalidatedReason: row.invalidatedReason,
 // Null for every row written before curation existed, which is the same state as
 // "nothing has been proposed" — the honest default, and the ordinary one.
 retirementProposedAt: row.retirementProposedAt ?? null,
 retirementReason: row.retirementReason ?? null,
 }
}

export const toMapEdge = (row: SubjectMapEdgeRow): MapEdge => {
 const kind = MAP_EDGE_KINDS.find((candidate) => candidate === row.kind)
 if (!kind) throw new Error(`unknown subject_map_edge.kind: ${row.kind}`)

 const provenance = MAP_PROVENANCES.find((candidate) => candidate === row.provenance)
 if (!provenance) throw new Error(`unknown subject_map_edge.provenance: ${row.provenance}`)

 return {
 id: row.id,
 mapId: asSubjectMapId(row.mapId),
 workspaceId: asWorkspaceId(row.workspaceId),
 fromKey: row.fromKey,
 toKey: row.toKey,
 kind,
 provenance,
 derivedAtRevision: row.derivedAtRevision,
 createdAt: row.createdAt,
 invalidatedAt: row.invalidatedAt,
 invalidatedReason: row.invalidatedReason,
 }
}
