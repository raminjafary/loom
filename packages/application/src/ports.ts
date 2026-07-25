import type {
 Actor,
 AuditEvent,
 Channel,
 ChannelId,
 Message,
 MessageBody,
 MessageId,
 Thread,
 ThreadId,
 WorkspaceId,
} from '@loom/domain'

/**
 * Ports own the interfaces; infrastructure owns the implementations.
 * No vendor type (ORM row, queue job, client handle) may appear in these
 * signatures — that rule is what keeps every layer swappable
 * and it is enforced by the boundary lint rule, not by convention.
 */

export interface ClockPort {
 now: Date
}

export interface IdPort {
 newId: string
}

export interface ChannelRepositoryPort {
 create(input: {
 workspaceId: WorkspaceId
 name: string
 topic: string | null
 isPrivate: boolean
 }): Promise<Channel>
 listByWorkspace(workspaceId: WorkspaceId): Promise<Channel[]>
 findById(workspaceId: WorkspaceId, id: ChannelId): Promise<Channel | null>
 findByName(workspaceId: WorkspaceId, name: string): Promise<Channel | null>
}

export interface ThreadRepositoryPort {
 createRoot(input: { workspaceId: WorkspaceId; channelId: ChannelId }): Promise<Thread>
 createReply(input: {
 workspaceId: WorkspaceId
 channelId: ChannelId
 parentMessageId: MessageId
 }): Promise<Thread>
 findById(workspaceId: WorkspaceId, id: ThreadId): Promise<Thread | null>
 findRootByChannel(workspaceId: WorkspaceId, channelId: ChannelId): Promise<Thread | null>
}

export interface MessagePage {
 readonly messages: Message[]
 /** Opaque cursor for the next older page; null when the beginning is reached. */
 readonly nextCursor: string | null
}

export interface MessageRepositoryPort {
 append(input: {
 workspaceId: WorkspaceId
 threadId: ThreadId
 author: Actor
 body: MessageBody
 }): Promise<Message>
 /** Newest-first page. `cursor` is the opaque value from a prior page. */
 listByThread(input: {
 workspaceId: WorkspaceId
 threadId: ThreadId
 limit: number
 cursor?: string | undefined
 }): Promise<MessagePage>
 /** Backfill for a reconnecting client: everything after a known message. */
 listSince(input: {
 workspaceId: WorkspaceId
 threadId: ThreadId
 afterMessageId: MessageId
 limit: number
 }): Promise<Message[]>
}

export interface AuditPort {
 record(input: {
 workspaceId: WorkspaceId
 actor: Actor
 action: string
 subjectType: string
 subjectId: string
 metadata?: Record<string, unknown>
 }): Promise<AuditEvent>
}

export type DomainEvent =
 | { readonly type: 'message.created'; readonly workspaceId: WorkspaceId; readonly threadId: ThreadId; readonly message: Message }
 | { readonly type: 'channel.created'; readonly workspaceId: WorkspaceId; readonly channel: Channel }
 | { readonly type: 'thread.created'; readonly workspaceId: WorkspaceId; readonly thread: Thread }

export interface EventPublisherPort {
 publish(event: DomainEvent): Promise<void>
}

export interface EventSubscriberPort {
 subscribe(
 workspaceId: WorkspaceId,
 handler: (event: DomainEvent) => void,
): Promise< => Promise<void>>
}
