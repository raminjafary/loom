import type {
 Actor,
 AuditEvent,
 Channel,
 ChannelId,
 Message,
 MessageBody,
 MessageId,
 Notification,
 NotificationTarget,
 NotificationTransport,
 Thread,
 ThreadId,
 UserId,
 WorkspaceId,
} from '@loom/domain'

/**
 * Ports own the interfaces; infrastructure owns the implementations.
 * No vendor type (ORM row, queue job, client handle) may appear in these
 * signatures — that rule is what keeps every layer swappable
 * and it is enforced by the boundary lint rule, not by convention.
 */

/**
 * The raw transcript tier's storage.
 *
 * Deliberately a byte/string store keyed by an opaque path, with no notion of
 * runs, chunks or JSONL: those belong to the domain (`transcriptChunkKey`) and
 * the use-case. An object store that knew what a transcript was could not be
 * swapped for one that does not.
 */
export interface BlobStoragePort {
 put(key: string, body: string): Promise<void>
 get(key: string): Promise<string | null>
 /** Keys under a prefix, lexicographically — which `transcriptChunkKey` makes chronological. */
 list(prefix: string): Promise<string[]>
 /** Removes everything under a prefix. Used when a human discards a run's branch. */
 deletePrefix(prefix: string): Promise<void>
}

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
 /**
 * Removes a channel. Cascades through its threads to their messages and to every
 * run started in them — see `deleteChannel` for the gate that makes that a choice
 * rather than a surprise.
 */
 delete(workspaceId: WorkspaceId, id: ChannelId): Promise<void>
 countByWorkspace(workspaceId: WorkspaceId): Promise<number>
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
 /** Set only for a tool call or its result, to correlate the two (see `Message`). */
 toolUseId?: string | null
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

/**
 * The `NotificationPort` — web push is the built adapter; email,
 * Slack mirror, desktop and webhook are the swaps it exists for.
 *
 * Distinct from `EventPublisherPort`, which fans realtime frames out to clients
 * that are *already watching*. This one reaches a human who is not looking, and
 * that is precisely the retention hook: the Inbox answers "what needs me" once
 * they arrive; this is what makes them arrive.
 */
export interface NotificationPort {
 /**
 * Fans one notification out to every registered target in its workspace.
 *
 * Callers treat this as best-effort and never let a delivery failure fail the
 * thing being announced — a run must not stay `running` because a push
 * service was down. The adapter owns retry/pruning policy, since what a dead
 * subscription looks like is transport-specific.
 */
 deliver(notification: Notification): Promise<void>
 /**
 * What a client needs before it can register a target — a VAPID public key
 * for web push, nothing at all for a transport whose targets an operator
 * configures server-side. `transport: null` means notifications are not
 * configured on this deployment, which a client must be able to tell apart
 * from "configured but you haven't subscribed".
 */
 clientConfig: { transport: NotificationTransport | null; publicKey: string | null }
}

export interface NotificationTargetRepositoryPort {
 /** Upsert by (workspace, endpoint) — see NotificationTarget on why endpoint is the identity. */
 register(input: {
 workspaceId: WorkspaceId
 userId: UserId
 transport: NotificationTransport
 endpoint: string
 credentials: Record<string, string>
 }): Promise<NotificationTarget>
 /** Idempotent: unregistering an endpoint that was never registered is not an error. */
 unregister(workspaceId: WorkspaceId, endpoint: string): Promise<void>
 listByWorkspace(workspaceId: WorkspaceId): Promise<NotificationTarget[]>
}
