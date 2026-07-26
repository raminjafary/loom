import {
 asAgentPersonaId,
 asAgentRunId,
 asApprovalRequestId,
 asAuditEventId,
 asChannelId,
 asMessageId,
 asRepositoryId,
 asRunnerId,
 asThreadId,
 asUserId,
 asWorkspaceId,
 type Actor,
 type AgentPersona,
 type AgentRun,
 type AgentRunStatus,
 type ApprovalRequest,
 type ApprovalStatus,
 type AuditEvent,
 type Channel,
 type Message,
 type MessageBody,
 type PersonaSpec,
 type Repository,
 type Runner,
 type Thread,
} from '@loom/domain'

/**
 * The translation seam. Drizzle row shapes stop here and domain entities start
 * here — that is what keeps `PersistencePort` swappable.
 */

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
 createdAt: Date
 editedAt: Date | null
}

export const toMessage = (row: MessageRow): Message => ({
 id: asMessageId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 threadId: asThreadId(row.threadId),
 author: toActor(row),
 body: toMessageBody(row.bodyKind, row.bodyText),
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
 createdAt: Date
}

export const toRepository = (row: RepositoryRow): Repository => ({
 id: asRepositoryId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 runnerId: asRunnerId(row.runnerId),
 displayName: row.displayName,
 absolutePath: row.absolutePath,
 defaultBranch: row.defaultBranch,
 createdAt: row.createdAt,
})

const isPersonaSpec = (value: unknown): value is PersonaSpec =>
 typeof value === 'object' &&
 value !== null &&
 typeof (value as Record<string, unknown>).name === 'string' &&
 typeof (value as Record<string, unknown>).systemPrompt === 'string' &&
 typeof (value as Record<string, unknown>).model === 'string' &&
 Array.isArray((value as Record<string, unknown>).tools)

const toPersonaSpec = (value: unknown): PersonaSpec => {
 if (!isPersonaSpec(value)) throw new Error('malformed persona spec in agent_run row')
 return value
}

export interface AgentRunRow {
 id: string
 workspaceId: string
 threadId: string
 repositoryId: string
 runnerId: string
 persona: unknown
 status: string
 totalCostUsd: number | null
 errorMessage: string | null
 clonePath: string | null
 branchName: string | null
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

export const toAgentRun = (row: AgentRunRow): AgentRun => ({
 id: asAgentRunId(row.id),
 workspaceId: asWorkspaceId(row.workspaceId),
 threadId: asThreadId(row.threadId),
 repositoryId: asRepositoryId(row.repositoryId),
 runnerId: asRunnerId(row.runnerId),
 persona: toPersonaSpec(row.persona),
 status: toAgentRunStatus(row.status),
 totalCostUsd: row.totalCostUsd,
 errorMessage: row.errorMessage,
 clonePath: row.clonePath,
 branchName: row.branchName,
 createdAt: row.createdAt,
 completedAt: row.completedAt,
})

export interface ApprovalRequestRow {
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
 createdAt: row.createdAt,
 updatedAt: row.updatedAt,
})

/** Cursors are opaque to callers; internally they are the `seq` watermark. */
export const encodeCursor = (seq: bigint): string =>
 Buffer.from(`seq:${seq.toString}`, 'utf8').toString('base64url')

export const decodeCursor = (cursor: string): bigint => {
 const raw = Buffer.from(cursor, 'base64url').toString('utf8')
 const match = /^seq:(\d+)$/.exec(raw)
 if (!match?.[1]) throw new Error('malformed cursor')
 return BigInt(match[1])
}
