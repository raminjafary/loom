import type {
  AuditPort,
  ChannelRepositoryPort,
  MessagePage,
  MessageRepositoryPort,
  ThreadRepositoryPort,
} from '@loom/application'
import { NotFoundError, asChannelId } from '@loom/domain'
import { and, asc, count, desc, eq, gt, gte, inArray, lt, max, or, sql } from 'drizzle-orm'
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
import { auditEvent, channel, channelRead, message, thread } from './schema.js'

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

  /**
   * Unread per channel, in one statement.
   *
   * A left join to the marker so a channel nobody has opened counts from zero rather than
   * disappearing, and `actor_user_id is distinct from` rather than `<>` because an agent's
   * messages carry a null there — `null <> 'me'` is null, which would drop every agent
   * message from the count and make the one thing a human most needs to notice invisible.
   */
  async unreadByChannel(workspaceId, userId) {
    const rows = await db.execute<{ channel_id: string; unread: string }>(sql`
      select t.channel_id as channel_id, count(*)::text as unread
      from ${message} m
      join ${thread} t on t.id = m.thread_id
      left join ${channelRead} r
        on r.channel_id = t.channel_id
       and r.workspace_id = m.workspace_id
       and r.user_id = ${userId}
      where m.workspace_id = ${workspaceId}
        and m.seq > coalesce(r.last_read_seq, 0)
        and m.actor_user_id is distinct from ${userId}
      group by t.channel_id
    `)
    return [...rows].map((row) => ({
      channelId: asChannelId(row.channel_id),
      unread: Number(row.unread),
    }))
  },

  async markChannelRead(workspaceId, channelId, userId, seq) {
    /**
     * Greatest-wins inside the statement, so two tabs cannot un-read anything. A
     * read-then-write would be correct in a test and wrong the first time a click raced
     * the poll that follows it.
     */
    await db
      .insert(channelRead)
      .values({ workspaceId, channelId, userId, lastReadSeq: seq })
      .onConflictDoUpdate({
        target: [channelRead.workspaceId, channelRead.channelId, channelRead.userId],
        set: {
          lastReadSeq: sql`greatest(${channelRead.lastReadSeq}, excluded.last_read_seq)`,
          updatedAt: new Date(),
        },
      })
  },

  async latestSeq(workspaceId, channelId) {
    const [row] = await db
      .select({ value: max(message.seq) })
      .from(message)
      .innerJoin(thread, eq(thread.id, message.threadId))
      .where(and(eq(message.workspaceId, workspaceId), eq(thread.channelId, channelId)))
    return row?.value === null || row?.value === undefined ? 0n : BigInt(row.value)
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

  async listByThread({ workspaceId, threadId, limit, cursor, view }): Promise<MessagePage> {
    /**
     * The view, as SQL. An agent-authored row is
     * kept only when it is the focused run's; a system or human row is kept whatever the
     * focus, because those are the lines that say what happened rather than who said it.
     */
    const viewClause =
      view === undefined || view.authorKinds === null
        ? undefined
        : view.agentRunId === null
          ? inArray(message.actorKind, [...view.authorKinds])
          : or(
              inArray(message.actorKind, ['system', 'user']),
              and(
                eq(message.actorKind, 'agent_run'),
                eq(message.actorAgentRunId, view.agentRunId),
              ),
            )

    const where = and(
      eq(message.workspaceId, workspaceId),
      eq(message.threadId, threadId),
      ...(cursor ? [lt(message.seq, decodeCursor(cursor))] : []),
      ...(viewClause ? [viewClause] : []),
    )

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

  async listSince(input) {
    const rows = await db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.workspaceId, input.workspaceId),
          gte(auditEvent.createdAt, input.since),
        ),
      )
      // By `seq`, not by timestamp: acts arrive in the same millisecond and the ledger's
      // bound has to cut a window at a defined place — `message.seq`'s reason exactly.
      .orderBy(desc(auditEvent.seq))
      .limit(input.limit)
    return rows.map(toAuditEvent)
  },
})
