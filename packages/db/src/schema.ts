import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Better Auth owns `user`, `session`, `account`, `verification`. Everything
 * below is domain-owned and references `user.id` by string.
 */

export const workspace = pgTable(
  'workspace',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workspace_slug_idx').on(t.slug)],
)

export const workspaceMember = pgTable(
  'workspace_member',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workspace_member_unique_idx').on(t.workspaceId, t.userId)],
)

export const channel = pgTable(
  'channel',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    topic: text('topic'),
    isPrivate: boolean('is_private').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('channel_workspace_name_idx').on(t.workspaceId, t.name)],
)

export const thread = pgTable(
  'thread',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    parentMessageId: uuid('parent_message_id'),
    isRoot: boolean('is_root').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('thread_channel_idx').on(t.workspaceId, t.channelId),
    // At most one root thread per channel, enforced in the database.
    uniqueIndex('thread_root_per_channel_idx')
      .on(t.channelId)
      .where(sql`${t.isRoot}`),
  ],
)

/**
 * `seq` is the ordering and pagination key. Timestamps collide under concurrent
 * inserts, so cursors must never be built from `created_at`.
 */
export const message = pgTable(
  'message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigserial('seq', { mode: 'bigint' }).notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => thread.id, { onDelete: 'cascade' }),
    actorKind: text('actor_kind').notNull(),
    actorUserId: text('actor_user_id'),
    actorAgentRunId: uuid('actor_agent_run_id'),
    bodyKind: text('body_kind').notNull(),
    bodyText: text('body_text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (t) => [
    index('message_thread_seq_idx').on(t.workspaceId, t.threadId, t.seq),
    uniqueIndex('message_seq_idx').on(t.seq),
  ],
)

/** Append-only. No update or delete path exists by design (PLAN.md §5). */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigserial('seq', { mode: 'bigint' }).notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    actorKind: text('actor_kind').notNull(),
    actorUserId: text('actor_user_id'),
    actorAgentRunId: uuid('actor_agent_run_id'),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_workspace_seq_idx').on(t.workspaceId, t.seq)],
)
