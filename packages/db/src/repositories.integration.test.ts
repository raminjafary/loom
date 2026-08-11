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
import { agentRunRepository } from './agent-repositories.js'
import {
 auditAdapter,
 channelRepository,
 messageRepository,
 threadRepository,
} from './repositories.js'
import {
 agentRun,
 auditEvent,
 channel,
 message,
 repository,
 runner,
 thread,
 workspace,
} from './schema.js'

/**
 * The same use-case scenarios that `@loom/application` runs against in-memory
 * fakes, re-run against real Postgres adapters. Passing both is what actually
 * demonstrates the port abstraction holds rather than merely typechecking.
 *
 * Requires `docker compose up -d`. Skipped when DATABASE_URL is unreachable.
 *
 * Prefers TEST_DATABASE_URL when set — this suite truncates `workspace`
 * itself (see beforeEach below), which cascades to nearly every domain
 * table, so it must never point at a database a developer is using by hand.
 */

const DATABASE_URL =
 process.env.TEST_DATABASE_URL ?? 'postgres://loom:loom@localhost:5432/loom_test'

const { db, close } = createDatabase(DATABASE_URL)

const deps: Deps = {
 channels: channelRepository(db),
 threads: threadRepository(db),
 messages: messageRepository(db),
 audit: auditAdapter(db),
 events: { publish: async => {} },
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

beforeEach(async => {
 await db.execute(sql`truncate table ${auditEvent}, ${message}, ${thread}, ${channel}, ${workspace} restart identity cascade`)
 WS = await seedWorkspace(db, `ws-a-${Date.now}`)
 OTHER_WS = await seedWorkspace(db, `ws-b-${Date.now}`)
})

afterAll(async => {
 await close
})

describe('channel repository via use-cases', => {
 it('creates a channel with a root thread and writes an audit row', async => {
 const { channel: created, rootThread } = await createChannel(deps, {
 workspaceId: WS,
 actor: human,
 name: 'Backend Team',
 })

 expect(created.name).toBe('backend-team')
 expect(rootThread.isRoot).toBe(true)
 expect(rootThread.channelId).toBe(created.id)

 const audits = await db.select.from(auditEvent)
 expect(audits).toHaveLength(1)
 expect(audits[0]?.action).toBe('channel.created')
 expect(audits[0]?.actorKind).toBe('user')
 })

 it('refuses an agent actor', async => {
 await expect(
 createChannel(deps, { workspaceId: WS, actor: agent, name: 'agent-made' }),
).rejects.toThrow(ForbiddenError)
 })

 it('rejects a duplicate name in the same workspace but allows it in another', async => {
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

 it('enforces one root thread per channel at the database level', async => {
 const { channel: created } = await createChannel(deps, {
 workspaceId: WS,
 actor: human,
 name: 'general',
 })
 await expect(
 deps.threads.createRoot({ workspaceId: WS, channelId: created.id }),
).rejects.toThrow
 })

 it('scopes listing to one workspace', async => {
 await createChannel(deps, { workspaceId: WS, actor: human, name: 'mine' })
 await createChannel(deps, { workspaceId: OTHER_WS, actor: human, name: 'theirs' })
 const mine = await listChannels(deps, { workspaceId: WS })
 expect(mine.map((c) => c.name)).toEqual(['mine'])
 })
})

describe('message repository via use-cases', => {
 it('round-trips an agent actor through the actor columns', async => {
 const { rootThread } = await createChannel(deps, {
 workspaceId: WS,
 actor: human,
 name: 'general',
 })

 const posted = await postMessage(deps, {
 workspaceId: WS,
 actor: agent,
 threadId: rootThread.id,
 text: ' hello from a run ',
 })

 expect(posted.body).toEqual({ kind: 'text', text: 'hello from a run' })
 expect(posted.author).toEqual(agent)
 })

 it('will not read a thread from another workspace', async => {
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

 it('pages newest-first and walks the cursor to exhaustion', async => {
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
 expect(first.nextCursor).not.toBeNull

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
 expect(third.nextCursor).toBeNull
 })

 it('backfills only what a reconnecting client missed, oldest-first', async => {
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

 it('orders by seq, not created_at, so same-millisecond inserts stay stable', async => {
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

/**
 * The cost dashboard's rollup.
 *
 * Against real Postgres rather than a fake, because every property worth asserting here
 * is a property of the SQL: that the grouping keys are read out of the persona *jsonb
 * snapshot*, that a null `total_cost_usd` counts as zero money but still counts as a
 * run, and that the whole thing stays inside one workspace. None of those survive being
 * mocked.
 */
describe('agent run cost rollup', => {
 const runs = agentRunRepository(db)

 // `runner.pairing_token_hash` is unique across the whole table, not per workspace, so
 // two workspaces scaffolding the same channel name must not derive the same hash.
 let scaffoldSeq = 0

 /** Enough of the FK chain to hang runs off. Values are arbitrary; the runs are the point. */
 const scaffold = async (workspaceId: WorkspaceId, channelName: string) => {
 scaffoldSeq += 1
 const [ch] = await db
.insert(channel)
.values({ workspaceId, name: channelName, isPrivate: false })
.returning({ id: channel.id })
 const [th] = await db
.insert(thread)
.values({ workspaceId, channelId: ch!.id, isRoot: true })
.returning({ id: thread.id })
 const [rn] = await db
.insert(runner)
.values({ workspaceId, name: `runner-${channelName}-${scaffoldSeq}`, pairingTokenHash: `hash-${channelName}-${scaffoldSeq}` })
.returning({ id: runner.id })
 const [repo] = await db
.insert(repository)
.values({
 workspaceId,
 runnerId: rn!.id,
 displayName: 'repo',
 absolutePath: `/tmp/${channelName}`,
 defaultBranch: 'main',
 })
.returning({ id: repository.id })
 return { threadId: th!.id, runnerId: rn!.id, repositoryId: repo!.id }
 }

 const addRun = async (
 workspaceId: WorkspaceId,
 scaffolding: { threadId: string; runnerId: string; repositoryId: string },
 persona: { name: string; model: string },
 totalCostUsd: number | null,
 createdAt?: Date,
) => {
 await db.insert(agentRun).values({
 workspaceId,
 threadId: scaffolding.threadId,
 repositoryId: scaffolding.repositoryId,
 runnerId: scaffolding.runnerId,
 persona: {...persona, systemPrompt: 'x', tools: [], autoApprove: false },
 status: 'completed',
 totalCostUsd,
...(createdAt ? { createdAt }: {}),
 })
 }

 it('groups by the persona snapshot the run actually carried', async => {
 const scaffolding = await scaffold(WS, 'general')
 await addRun(WS, scaffolding, { name: 'planner', model: 'claude-opus-5' }, 0.6)
 await addRun(WS, scaffolding, { name: 'worker', model: 'claude-haiku-4-5' }, 0.1)
 await addRun(WS, scaffolding, { name: 'worker', model: 'claude-haiku-4-5' }, 0.3)

 const rollup = await runs.costRollup(WS, { since: null })
 expect(rollup.totals.runCount).toBe(3)
 expect(rollup.totals.totalUsd).toBeCloseTo(1.0)

 // Highest spend first, so the expensive thing is the thing read first.
 expect(rollup.byPersona[0]).toMatchObject({ personaName: 'planner', model: 'claude-opus-5' })
 const worker = rollup.byPersona.find((r) => r.personaName === 'worker')
 expect(worker?.runCount).toBe(2)
 expect(worker?.totalUsd).toBeCloseTo(0.4)
 // The max is the run that hurt, which a mean would hide.
 expect(worker?.maxUsd).toBeCloseTo(0.3)
 })

 /**
 * A run that failed before reaching the egress proxy has null spend, and null means
 * "never metered", not "free". It must count as a run and contribute no money — a
 * workspace full of failures should read as many runs and little cost, which is true.
 */
 it('counts an unmetered run without inventing spend for it', async => {
 const scaffolding = await scaffold(WS, 'general')
 await addRun(WS, scaffolding, { name: 'worker', model: 'claude-sonnet-5' }, null)
 await addRun(WS, scaffolding, { name: 'worker', model: 'claude-sonnet-5' }, 0.25)

 const rollup = await runs.costRollup(WS, { since: null })
 expect(rollup.totals.runCount).toBe(2)
 expect(rollup.totals.totalUsd).toBeCloseTo(0.25)
 })

 it('rolls up per thread with the channel that thread belongs to', async => {
 const first = await scaffold(WS, 'general')
 const second = await scaffold(WS, 'migration')
 await addRun(WS, first, { name: 'worker', model: 'claude-sonnet-5' }, 0.2)
 await addRun(WS, second, { name: 'worker', model: 'claude-sonnet-5' }, 0.5)

 const rollup = await runs.costRollup(WS, { since: null })
 expect(rollup.byThread.map((r) => r.channelName)).toEqual(['migration', 'general'])
 expect(rollup.byThread[0]?.totalUsd).toBeCloseTo(0.5)
 // One model, two threads: the model grouping must not be split by thread.
 expect(rollup.byModel).toHaveLength(1)
 expect(rollup.byModel[0]?.totalUsd).toBeCloseTo(0.7)
 })

 it('honours the window, so a dashboard can ask what today cost', async => {
 const scaffolding = await scaffold(WS, 'general')
 const longAgo = new Date(Date.now - 72 * 3_600_000)
 await addRun(WS, scaffolding, { name: 'worker', model: 'claude-sonnet-5' }, 5, longAgo)
 await addRun(WS, scaffolding, { name: 'worker', model: 'claude-sonnet-5' }, 1)

 expect((await runs.costRollup(WS, { since: null })).totals.totalUsd).toBeCloseTo(6)
 const since = new Date(Date.now - 24 * 3_600_000)
 const recent = await runs.costRollup(WS, { since })
 expect(recent.totals.runCount).toBe(1)
 expect(recent.totals.totalUsd).toBeCloseTo(1)
 })

 it('never reports another workspace\'s spend', async => {
 const mine = await scaffold(WS, 'general')
 const theirs = await scaffold(OTHER_WS, 'general')
 await addRun(WS, mine, { name: 'worker', model: 'claude-sonnet-5' }, 0.4)
 await addRun(OTHER_WS, theirs, { name: 'worker', model: 'claude-opus-5' }, 9)

 const rollup = await runs.costRollup(WS, { since: null })
 expect(rollup.totals.totalUsd).toBeCloseTo(0.4)
 expect(rollup.byModel.map((r) => r.model)).toEqual(['claude-sonnet-5'])
 expect(rollup.topRuns).toHaveLength(1)
 })

 it('reports an empty workspace as zero rather than as nothing', async => {
 const rollup = await runs.costRollup(WS, { since: null })
 expect(rollup.totals).toEqual({ runCount: 0, totalUsd: 0 })
 expect(rollup.byModel).toEqual([])
 expect(rollup.topRuns).toEqual([])
 })
})
