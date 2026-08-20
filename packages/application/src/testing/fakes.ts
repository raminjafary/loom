import {
  asAuditEventId,
  asChannelId,
  asMessageId,
  asThreadId,
  type Actor,
  type AuditEvent,
  type Channel,
  type ChannelId,
  type Message,
  type MessageBody,
  type MessageId,
  type Thread,
  type ThreadId,
  type WorkspaceId,
} from '@loom/domain'
import type {
  AuditPort,
  ChannelRepositoryPort,
  DomainEvent,
  EventPublisherPort,
  MessagePage,
  MessageRepositoryPort,
  ThreadRepositoryPort,
} from '../ports.js'
import type { Deps } from '../use-cases.js'

/**
 * In-memory adapters. Their existence is the point: domain + application are
 * testable with no Postgres, no Valkey, no container.
 */
export class FakeStore {
  channels: Channel[] = []
  threads: Thread[] = []
  messages: Message[] = []
  audits: AuditEvent[] = []
  /** `${channelId}:${userId}` → the seq that user has read up to. */
  reads = new Map<string, bigint>()
  published: DomainEvent[] = []
  private seq = 0

  nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}_${String(this.seq).padStart(6, '0')}`
  }

  /** Monotonic, so ordering assertions don't depend on wall-clock resolution. */
  nextDate(): Date {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq))
  }
}

export const fakeChannels = (s: FakeStore): ChannelRepositoryPort => ({
  /**
   * Unread, in memory, with the same three rules the SQL has: a user's own messages do
   * not count, an unmarked channel counts from zero, and an agent's messages do count —
   * the last of which is the one the adapter needed `is distinct from` for.
   */
  async unreadByChannel(workspaceId, userId) {
    const counts = new Map<string, number>()
    // Insertion order stands in for `message.seq`: the domain entity has no seq — it is
    // a database ordering key, not a fact about a message — and this array is append-only
    // in exactly the order the sequence would have assigned.
    for (const [index, message] of s.messages.entries()) {
      const seq = BigInt(index + 1)
      if (message.workspaceId !== workspaceId) continue
      if (message.author.kind === 'user' && message.author.userId === userId) continue
      const thread = s.threads.find((entry) => entry.id === message.threadId)
      if (!thread) continue
      const marker = s.reads.get(`${thread.channelId}:${userId}`) ?? 0n
      if (seq <= marker) continue
      counts.set(thread.channelId, (counts.get(thread.channelId) ?? 0) + 1)
    }
    return [...counts].map(([channelId, unread]) => ({ channelId: asChannelId(channelId), unread }))
  },

  async markChannelRead(_workspaceId, channelId, userId, seq) {
    const key = `${channelId}:${userId}`
    const current = s.reads.get(key) ?? 0n
    // Greatest-wins, as the adapter's UPDATE does — a fake that let a marker move
    // backwards would make the concurrency rule untested in both places.
    s.reads.set(key, seq > current ? seq : current)
  },

  async latestSeq(workspaceId, channelId) {
    let highest = 0n
    for (const [index, message] of s.messages.entries()) {
      if (message.workspaceId !== workspaceId) continue
      const thread = s.threads.find((entry) => entry.id === message.threadId)
      if (thread?.channelId !== channelId) continue
      const seq = BigInt(index + 1)
      if (seq > highest) highest = seq
    }
    return highest
  },

  async create(input) {
    const channel: Channel = {
      id: asChannelId(s.nextId('ch')),
      workspaceId: input.workspaceId,
      name: input.name,
      topic: input.topic,
      isPrivate: input.isPrivate,
      createdAt: s.nextDate(),
    }
    s.channels.push(channel)
    return channel
  },
  async listByWorkspace(workspaceId) {
    return s.channels.filter((c) => c.workspaceId === workspaceId)
  },
  async findById(workspaceId, id) {
    return s.channels.find((c) => c.workspaceId === workspaceId && c.id === id) ?? null
  },
  async findByName(workspaceId, name) {
    return s.channels.find((c) => c.workspaceId === workspaceId && c.name === name) ?? null
  },
  async delete(workspaceId, id) {
    const index = s.channels.findIndex((c) => c.workspaceId === workspaceId && c.id === id)
    if (index >= 0) s.channels.splice(index, 1)
    // The real schema cascades through threads to messages; the fake does the same by
    // hand, or a test would see a deleted channel's messages survive it.
    const threadIds = new Set(
      s.threads.filter((t) => t.channelId === id).map((t) => t.id),
    )
    s.threads = s.threads.filter((t) => t.channelId !== id)
    s.messages = s.messages.filter((m) => !threadIds.has(m.threadId))
  },
  async countByWorkspace(workspaceId) {
    return s.channels.filter((c) => c.workspaceId === workspaceId).length
  },
})

export const fakeThreads = (s: FakeStore): ThreadRepositoryPort => ({
  async createRoot(input) {
    const thread: Thread = {
      id: asThreadId(s.nextId('th')),
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      parentMessageId: null,
      isRoot: true,
      createdAt: s.nextDate(),
    }
    s.threads.push(thread)
    return thread
  },
  async createReply(input) {
    const thread: Thread = {
      id: asThreadId(s.nextId('th')),
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      parentMessageId: input.parentMessageId,
      isRoot: false,
      createdAt: s.nextDate(),
    }
    s.threads.push(thread)
    return thread
  },
  async findById(workspaceId, id) {
    return s.threads.find((t) => t.workspaceId === workspaceId && t.id === id) ?? null
  },
  async listByChannel(workspaceId, channelId) {
    return s.threads.filter((t) => t.workspaceId === workspaceId && t.channelId === channelId)
  },
  async findRootByChannel(workspaceId, channelId) {
    return (
      s.threads.find(
        (t) => t.workspaceId === workspaceId && t.channelId === channelId && t.isRoot,
      ) ?? null
    )
  },
})

export const fakeMessages = (s: FakeStore): MessageRepositoryPort => ({
  async append(input: {
    workspaceId: WorkspaceId
    threadId: ThreadId
    author: Actor
    body: MessageBody
    toolUseId?: string | null
  }) {
    const message: Message = {
      id: asMessageId(s.nextId('msg')),
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      author: input.author,
      body: input.body,
      toolUseId: input.toolUseId ?? null,
      createdAt: s.nextDate(),
      editedAt: null,
    }
    s.messages.push(message)
    return message
  },
  async listByThread({ workspaceId, threadId, limit, cursor }): Promise<MessagePage> {
    const all = s.messages
      .filter((m) => m.workspaceId === workspaceId && m.threadId === threadId)
      .sort((a, b) => (a.id < b.id ? 1 : -1))
    const start = cursor ? all.findIndex((m) => m.id === cursor) + 1 : 0
    const page = all.slice(start, start + limit)
    const last = page.at(-1)
    const hasMore = last !== undefined && all.indexOf(last) < all.length - 1
    return { messages: page, nextCursor: hasMore && last ? last.id : null }
  },
  async listSince({ workspaceId, threadId, afterMessageId, limit }) {
    return s.messages
      .filter(
        (m) =>
          m.workspaceId === workspaceId && m.threadId === threadId && m.id > afterMessageId,
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit)
  },
})

export const fakeAudit = (s: FakeStore): AuditPort => ({
  async record(input) {
    const event: AuditEvent = {
      id: asAuditEventId(s.nextId('aud')),
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      metadata: input.metadata ?? {},
      createdAt: s.nextDate(),
    }
    s.audits.push(event)
    return event
  },

  async listSince({ workspaceId, since, limit }) {
    return s.audits
      .filter((event) => event.workspaceId === workspaceId && event.createdAt >= since)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
  },
})

export const fakeEvents = (s: FakeStore): EventPublisherPort => ({
  async publish(event) {
    s.published.push(event)
  },
})

export const fakeDeps = (s: FakeStore = new FakeStore()): { deps: Deps; store: FakeStore } => ({
  store: s,
  deps: {
    channels: fakeChannels(s),
    threads: fakeThreads(s),
    messages: fakeMessages(s),
    audit: fakeAudit(s),
    events: fakeEvents(s),
  },
})

export const messageIdFrom = (raw: string): MessageId => asMessageId(raw)
export const channelIdFrom = (raw: string): ChannelId => asChannelId(raw)
