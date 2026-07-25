import type { Actor } from './actor.js'
import type {
  AuditEventId,
  ChannelId,
  MessageId,
  ThreadId,
  UserId,
  WorkspaceId,
} from './ids.js'

export interface Workspace {
  readonly id: WorkspaceId
  readonly name: string
  readonly slug: string
  readonly createdAt: Date
}

export interface User {
  readonly id: UserId
  readonly email: string
  readonly displayName: string
  readonly createdAt: Date
}

export interface Channel {
  readonly id: ChannelId
  readonly workspaceId: WorkspaceId
  readonly name: string
  readonly topic: string | null
  readonly isPrivate: boolean
  readonly createdAt: Date
}

/**
 * A thread is the unit an agent run attaches to. Channel-level messages belong
 * to the channel's root thread, so there is exactly one message container type.
 */
export interface Thread {
  readonly id: ThreadId
  readonly workspaceId: WorkspaceId
  readonly channelId: ChannelId
  readonly parentMessageId: MessageId | null
  readonly isRoot: boolean
  readonly createdAt: Date
}

export type MessageBody =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'system'; readonly text: string }

export interface Message {
  readonly id: MessageId
  readonly workspaceId: WorkspaceId
  readonly threadId: ThreadId
  readonly author: Actor
  readonly body: MessageBody
  readonly createdAt: Date
  readonly editedAt: Date | null
}

/** Append-only, immutable. Required from Phase 0 — agents act, so provenance cannot be retrofitted. */
export interface AuditEvent {
  readonly id: AuditEventId
  readonly workspaceId: WorkspaceId
  readonly actor: Actor
  readonly action: string
  readonly subjectType: string
  readonly subjectId: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly createdAt: Date
}
