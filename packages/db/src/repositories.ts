import type {
  AuditPort,
  ChannelRepositoryPort,
  MessagePage,
  MessageRepositoryPort,
  ThreadRepositoryPort,
} from '@loom/application'
import { NotFoundError } from '@loom/domain'
import { and, asc, count, desc, eq, gt, lt } from 'drizzle-orm'
import type { Database } from './client.js'
import {
  decodeCursor,
  encodeCursor,
  fromActor,
  toAuditEvent,
  toChannel,
  toMessage,
  toThread,
} from './mappers.js'
import { auditEvent, channel, message, thread } from './schema.js'

export const channelRepository = (db: Database): ChannelRepositoryPort => ({
  async delete(workspaceId, id) {
    // The cascade does the rest: threads, their messages, and every run started in
    // them. See `deleteChannel` for the gate that makes that deliberate.
    await db.delete(channel).where(and(eq(channel.workspaceId, workspaceId), eq(channel.id, id)))
  },

  async countByWorkspace(workspaceId) {
    const [row] = await db
      .select({ value: count() })
      .from(channel)
      .where(eq(channel.workspaceId, workspaceId))
    return row?.value ?? 0
  },

  async create(input) {
    const [row] = await db
      .insert(channel)
      .values({
        workspaceId: input.workspaceId,
        name: input.name,
        topic: input.topic,
        isPrivate: input.isPrivate,
      })
      .returning()
    if (!row) throw new Error('channel insert returned no row')
    return toChannel(row)
  },

  async listByWorkspace(workspaceId) {
    const rows = await db
      .select()
      .from(channel)
      .where(eq(channel.workspaceId, workspaceId))
      .orderBy(asc(channel.name))
    return rows.map(toChannel)
  },

  async findById(workspaceId, id) {
    const [row] = await db
      .select()
      .from(channel)
      .where(and(eq(channel.workspaceId, workspaceId), eq(channel.id, id)))
      .limit(1)
    return row ? toChannel(row) : null
  },

  async findByName(workspaceId, name) {
    const [row] = await db
      .select()
      .from(channel)
      .where(and(eq(channel.workspaceId, workspaceId), eq(channel.name, name)))
      .limit(1)
    return row ? toChannel(row) : null
  },
})

export const threadRepository = (db: Database): ThreadRepositoryPort => ({
  async createRoot(input) {
    const [row] = await db
      .insert(thread)
      .values({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        isRoot: true,
      })
      .returning()
    if (!row) throw new Error('thread insert returned no row')
    return toThread(row)
  },

  async createReply(input) {
    const [row] = await db
      .insert(thread)
      .values({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        parentMessageId: input.parentMessageId,
        isRoot: false,
      })
      .returning()
    if (!row) throw new Error('thread insert returned no row')
    return toThread(row)
  },

  async findById(workspaceId, id) {
    const [row] = await db
      .select()
      .from(thread)
      .where(and(eq(thread.workspaceId, workspaceId), eq(thread.id, id)))
      .limit(1)
    return row ? toThread(row) : null
  },

  async listByChannel(workspaceId, channelId) {
    return (
      await db
        .select()
        .from(thread)
        .where(and(eq(thread.workspaceId, workspaceId), eq(thread.channelId, channelId)))
        .orderBy(thread.createdAt)
    ).map(toThread)
  },

  async findRootByChannel(workspaceId, channelId) {
    const [row] = await db
      .select()
      .from(thread)
      .where(
        and(
          eq(thread.workspaceId, workspaceId),
          eq(thread.channelId, channelId),
          eq(thread.isRoot, true),
        ),
      )
      .limit(1)
    return row ? toThread(row) : null
  },
})

export const messageRepository = (db: Database): MessageRepositoryPort => ({
  async append(input) {
    const [row] = await db
      .insert(message)
      .values({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        ...fromActor(input.author),
        bodyKind: input.body.kind,
        bodyText: input.body.text,
        toolUseId: input.toolUseId ?? null,
      })
      .returning()
    if (!row) throw new Error('message insert returned no row')
    return toMessage(row)
  },

  async listByThread({ workspaceId, threadId, limit, cursor }): Promise<MessagePage> {
    const where = cursor
      ? and(
          eq(message.workspaceId, workspaceId),
          eq(message.threadId, threadId),
          lt(message.seq, decodeCursor(cursor)),
        )
      : and(eq(message.workspaceId, workspaceId), eq(message.threadId, threadId))

    // Over-fetch by one to learn whether another page exists without a count query.
    const rows = await db
      .select()
      .from(message)
      .where(where)
      .orderBy(desc(message.seq))
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)

    return {
      messages: page.map(toMessage),
      nextCursor: hasMore && last ? encodeCursor(last.seq) : null,
    }
  },

  async listSince({ workspaceId, threadId, afterMessageId, limit }) {
    const [anchor] = await db
      .select({ seq: message.seq })
      .from(message)
      .where(and(eq(message.workspaceId, workspaceId), eq(message.id, afterMessageId)))
      .limit(1)
    if (!anchor) throw new NotFoundError('Message')

    const rows = await db
      .select()
      .from(message)
      .where(
        and(
          eq(message.workspaceId, workspaceId),
          eq(message.threadId, threadId),
          gt(message.seq, anchor.seq),
        ),
      )
      .orderBy(asc(message.seq))
      .limit(limit)

    return rows.map(toMessage)
  },
})

export const auditAdapter = (db: Database): AuditPort => ({
  async record(input) {
    const [row] = await db
      .insert(auditEvent)
      .values({
        workspaceId: input.workspaceId,
        ...fromActor(input.actor),
        action: input.action,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        metadata: input.metadata ?? {},
      })
      .returning()
    if (!row) throw new Error('audit insert returned no row')
    return toAuditEvent(row)
  },
})
