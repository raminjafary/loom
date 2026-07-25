import {
 asAgentRunId,
 asAuditEventId,
 asChannelId,
 asMessageId,
 asThreadId,
 asUserId,
 asWorkspaceId,
 type Actor,
 type AuditEvent,
 type Channel,
 type Message,
 type MessageBody,
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

/** Cursors are opaque to callers; internally they are the `seq` watermark. */
export const encodeCursor = (seq: bigint): string =>
 Buffer.from(`seq:${seq.toString}`, 'utf8').toString('base64url')

export const decodeCursor = (cursor: string): bigint => {
 const raw = Buffer.from(cursor, 'base64url').toString('utf8')
 const match = /^seq:(\d+)$/.exec(raw)
 if (!match?.[1]) throw new Error('malformed cursor')
 return BigInt(match[1])
}
