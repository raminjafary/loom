import {
  backfillMessages,
  createChannel,
  listChannels,
  listMessages,
  postMessage,
  type Deps,
} from '@loom/application'
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  agentRunActor,
  asUserId,
  asWorkspaceId,
  userActor,
  type WorkspaceId,
} from '@loom/domain'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from './client.js'
import {
  auditAdapter,
  channelRepository,
  messageRepository,
  threadRepository,
} from './repositories.js'
import { auditEvent, channel, message, thread, workspace } from './schema.js'

/**
 * The same use-case scenarios that `@loom/application` runs against in-memory
 * fakes, re-run against real Postgres adapters. Passing both is what actually
 * demonstrates the port abstraction holds rather than merely typechecking.
 *
 * Requires `docker compose up -d`. Skipped when DATABASE_URL is unreachable.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loom:loom@localhost:5432/loom'

const { db, close } = createDatabase(DATABASE_URL)

const deps: Deps = {
  channels: channelRepository(db),
  threads: threadRepository(db),
  messages: messageRepository(db),
  audit: auditAdapter(db),
  events: { publish: async () => {} },
}

let WS: WorkspaceId
let OTHER_WS: WorkspaceId
const human = userActor(asUserId('user_integration'))
const agent = agentRunActor('00000000-0000-4000-8000-000000000001' as never)

const seedWorkspace = async (database: Database, slug: string): Promise<WorkspaceId> => {
  const [row] = await database
    .insert(workspace)
    .values({ name: slug, slug })
    .returning({ id: workspace.id })
  if (!row) throw new Error('workspace seed failed')
  return asWorkspaceId(row.id)
}

beforeEach(async () => {
  await db.execute(sql`truncate table ${auditEvent}, ${message}, ${thread}, ${channel}, ${workspace} restart identity cascade`)
  WS = await seedWorkspace(db, `ws-a-${Date.now()}`)
  OTHER_WS = await seedWorkspace(db, `ws-b-${Date.now()}`)
})

afterAll(async () => {
  await close()
})

describe('channel repository via use-cases', () => {
  it('creates a channel with a root thread and writes an audit row', async () => {
    const { channel: created, rootThread } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'Backend Team',
    })

    expect(created.name).toBe('backend-team')
    expect(rootThread.isRoot).toBe(true)
    expect(rootThread.channelId).toBe(created.id)

    const audits = await db.select().from(auditEvent)
    expect(audits).toHaveLength(1)
    expect(audits[0]?.action).toBe('channel.created')
    expect(audits[0]?.actorKind).toBe('user')
  })

  it('refuses an agent actor', async () => {
    await expect(
      createChannel(deps, { workspaceId: WS, actor: agent, name: 'agent-made' }),
    ).rejects.toThrow(ForbiddenError)
  })

  it('rejects a duplicate name in the same workspace but allows it in another', async () => {
    await createChannel(deps, { workspaceId: WS, actor: human, name: 'general' })
    await expect(
      createChannel(deps, { workspaceId: WS, actor: human, name: 'General' }),
    ).rejects.toThrow(ValidationError)

    const elsewhere = await createChannel(deps, {
      workspaceId: OTHER_WS,
      actor: human,
      name: 'general',
    })
    expect(elsewhere.channel.workspaceId).toBe(OTHER_WS)
  })

  it('enforces one root thread per channel at the database level', async () => {
    const { channel: created } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'general',
    })
    await expect(
      deps.threads.createRoot({ workspaceId: WS, channelId: created.id }),
    ).rejects.toThrow()
  })

  it('scopes listing to one workspace', async () => {
    await createChannel(deps, { workspaceId: WS, actor: human, name: 'mine' })
    await createChannel(deps, { workspaceId: OTHER_WS, actor: human, name: 'theirs' })
    const mine = await listChannels(deps, { workspaceId: WS })
    expect(mine.map((c) => c.name)).toEqual(['mine'])
  })
})

describe('message repository via use-cases', () => {
  it('round-trips an agent actor through the actor columns', async () => {
    const { rootThread } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'general',
    })

    const posted = await postMessage(deps, {
      workspaceId: WS,
      actor: agent,
      threadId: rootThread.id,
      text: '  hello from a run  ',
    })

    expect(posted.body).toEqual({ kind: 'text', text: 'hello from a run' })
    expect(posted.author).toEqual(agent)
  })

  it('will not read a thread from another workspace', async () => {
    const { rootThread } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'general',
    })
    await expect(
      postMessage(deps, {
        workspaceId: OTHER_WS,
        actor: human,
        threadId: rootThread.id,
        text: 'leaking',
      }),
    ).rejects.toThrow(NotFoundError)
  })

  it('pages newest-first and walks the cursor to exhaustion', async () => {
    const { rootThread } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'general',
    })
    for (let i = 1; i <= 5; i += 1) {
      await postMessage(deps, {
        workspaceId: WS,
        actor: human,
        threadId: rootThread.id,
        text: `m${i}`,
      })
    }

    const first = await listMessages(deps, { workspaceId: WS, threadId: rootThread.id, limit: 2 })
    expect(first.messages.map((m) => m.body.text)).toEqual(['m5', 'm4'])
    expect(first.nextCursor).not.toBeNull()

    const second = await listMessages(deps, {
      workspaceId: WS,
      threadId: rootThread.id,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    })
    expect(second.messages.map((m) => m.body.text)).toEqual(['m3', 'm2'])

    const third = await listMessages(deps, {
      workspaceId: WS,
      threadId: rootThread.id,
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    })
    expect(third.messages.map((m) => m.body.text)).toEqual(['m1'])
    expect(third.nextCursor).toBeNull()
  })

  it('backfills only what a reconnecting client missed, oldest-first', async () => {
    const { rootThread } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'general',
    })
    const seen = await postMessage(deps, {
      workspaceId: WS,
      actor: human,
      threadId: rootThread.id,
      text: 'seen',
    })
    await postMessage(deps, {
      workspaceId: WS,
      actor: human,
      threadId: rootThread.id,
      text: 'missed-1',
    })
    await postMessage(deps, {
      workspaceId: WS,
      actor: human,
      threadId: rootThread.id,
      text: 'missed-2',
    })

    const missed = await backfillMessages(deps, {
      workspaceId: WS,
      threadId: rootThread.id,
      afterMessageId: seen.id,
    })
    expect(missed.map((m) => m.body.text)).toEqual(['missed-1', 'missed-2'])
  })

  it('orders by seq, not created_at, so same-millisecond inserts stay stable', async () => {
    const { rootThread } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'general',
    })
    // Concurrent inserts share a timestamp; only `seq` disambiguates them.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        deps.messages.append({
          workspaceId: WS,
          threadId: rootThread.id,
          author: human,
          body: { kind: 'text', text: `c${i}` },
        }),
      ),
    )

    const page = await listMessages(deps, {
      workspaceId: WS,
      threadId: rootThread.id,
      limit: 100,
    })
    expect(page.messages).toHaveLength(10)
    const texts = page.messages.map((m) => m.body.text)
    expect(new Set(texts).size).toBe(10)
  })
})
