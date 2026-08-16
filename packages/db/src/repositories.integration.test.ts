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
 agentRunRepository,
 atlasRepository,
 personaGroupRepository,
 subjectMapRepository,
} from './agent-repositories.js'
import {
 auditAdapter,
 channelRepository,
 messageRepository,
 threadRepository,
} from './repositories.js'
import {
 agentPersona,
 agentRun,
 auditEvent,
 channel,
 message,
 repository,
 runner,
 subjectMapNode,
 thread,
 workspace,
} from './schema.js'
import { user } from './auth-schema.js'

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

/**
 * Unread state, against real SQL.
 *
 * These are here rather than over HTTP because all three rules are properties of one
 * statement, and two of them are the kind a hand-written join gets wrong quietly: an
 * agent's message has a null `actor_user_id`, so the obvious `<>` comparison drops every
 * one of them, and a channel nobody has opened has no marker row at all.
 */
describe('unread state', => {
 const seed = async (name: string) => {
 const { channel: created, rootThread } = await createChannel(deps, {
 workspaceId: WS,
 actor: human,
 name,
 })
 return { channelId: created.id, threadId: rootThread.id }
 }

 const unreadFor = async (userId: string) =>
 Object.fromEntries(
 (await deps.channels.unreadByChannel(WS, asUserId(userId))).map((row) => [
 row.channelId,
 row.unread,
 ]),
)

 it('counts what somebody else said and never what you said yourself', async => {
 const { channelId, threadId } = await seed('general')
 await postMessage(deps, { workspaceId: WS, actor: human, threadId, text: 'mine' })
 await postMessage(deps, {
 workspaceId: WS,
 actor: userActor(asUserId('someone-else')),
 threadId,
 text: 'theirs',
 })

 expect(await unreadFor('user_integration')).toEqual({ [channelId]: 1 })
 expect(await unreadFor('someone-else')).toEqual({ [channelId]: 1 })
 })

 /**
 * The one a `<>` comparison silently loses. An agent's `actor_user_id` is null, and
 * `null <> 'me'` is null rather than true — so the messages a human most needs to
 * notice would be the only ones never counted.
 */
 it('counts an agent"s messages, whose author column is null', async => {
 const { channelId, threadId } = await seed('agents')
 await postMessage(deps, { workspaceId: WS, actor: agent, threadId, text: 'from a run' })
 expect(await unreadFor('user_integration')).toEqual({ [channelId]: 1 })
 })

 it('clears on read, and stays clear until something new arrives', async => {
 const { channelId, threadId } = await seed('reading')
 await postMessage(deps, {
 workspaceId: WS,
 actor: userActor(asUserId('someone-else')),
 threadId,
 text: 'first',
 })

 const seq = await deps.channels.latestSeq(WS, channelId)
 await deps.channels.markChannelRead(WS, channelId, asUserId('user_integration'), seq)
 expect(await unreadFor('user_integration')).toEqual({})

 await postMessage(deps, {
 workspaceId: WS,
 actor: userActor(asUserId('someone-else')),
 threadId,
 text: 'second',
 })
 expect(await unreadFor('user_integration')).toEqual({ [channelId]: 1 })
 })

 /**
 * Two tabs, or a click racing a poll. The greatest-wins rule is inside the UPDATE
 * rather than around it, so this holds without the caller ordering anything.
 */
 it('never moves a marker backwards', async => {
 const { channelId, threadId } = await seed('races')
 await postMessage(deps, {
 workspaceId: WS,
 actor: userActor(asUserId('someone-else')),
 threadId,
 text: 'first',
 })
 const seq = await deps.channels.latestSeq(WS, channelId)

 await deps.channels.markChannelRead(WS, channelId, asUserId('user_integration'), seq)
 await deps.channels.markChannelRead(WS, channelId, asUserId('user_integration'), 1n)

 expect(await unreadFor('user_integration')).toEqual({})
 })

 it('keeps one workspace"s unread out of another"s', async => {
 const { threadId } = await seed('shared-name')
 await postMessage(deps, {
 workspaceId: WS,
 actor: userActor(asUserId('someone-else')),
 threadId,
 text: 'here',
 })
 expect(await deps.channels.unreadByChannel(OTHER_WS, asUserId('user_integration'))).toEqual([])
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
 persona: {...persona, systemPrompt: 'x', tools: [], approvalMode: 'ask' as const },
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

/**
 * The pruning `deletePersona` used to do for itself, now the port's job and therefore
 * tested where the storage actually is. The use-case test can only assert that pruning
 * was asked for; whether a jsonb array really loses the right element, and only in the
 * right workspace, is a question about Postgres.
 */
describe('persona group pruning', => {
 const groups = personaGroupRepository(db)

 const group = (workspaceId: WorkspaceId, name: string, personaIds: string[]) =>
 groups.create({ workspaceId, name, personaIds })

 it('drops the persona from every group holding it and leaves the rest alone', async => {
 const held = await group(WS, 'backend', ['p_1', 'p_2'])
 const alsoHeld = await group(WS, 'oncall', ['p_2', 'p_1', 'p_3'])
 const untouched = await group(WS, 'frontend', ['p_3'])

 expect(await groups.prunePersona(WS, 'p_1')).toBe(2)

 const after = new Map((await groups.listByWorkspace(WS)).map((g) => [g.id, g.personaIds]))
 expect(after.get(held.id)).toEqual(['p_2'])
 expect(after.get(alsoHeld.id)).toEqual(['p_2', 'p_3'])
 expect(after.get(untouched.id)).toEqual(['p_3'])
 })

 it('empties a group whose only member was the persona, rather than deleting it', async => {
 const solo = await group(WS, 'solo', ['p_1'])
 expect(await groups.prunePersona(WS, 'p_1')).toBe(1)

 const after = await groups.listByWorkspace(WS)
 expect(after.map((g) => g.id)).toContain(solo.id)
 expect(after.find((g) => g.id === solo.id)?.personaIds).toEqual([])
 })

 it('reports zero when nothing held the persona, and touches no row', async => {
 const other = await group(WS, 'backend', ['p_2'])
 const before = (await groups.listByWorkspace(WS)).find((g) => g.id === other.id)

 expect(await groups.prunePersona(WS, 'p_1')).toBe(0)

 const after = (await groups.listByWorkspace(WS)).find((g) => g.id === other.id)
 expect(after?.personaIds).toEqual(['p_2'])
 // The guard exists so an unaffected group does not claim to have been edited.
 expect(after?.updatedAt).toEqual(before?.updatedAt)
 })

 /**
 * The team repository, asserted where the claim actually lives: `set null` on
 * delete is a Postgres behaviour, and it is the whole reason this is a foreign key at
 * all rather than a bare id like `orchestratorId`. A team whose repository was unbound
 * has to still open.
 */
 it('keeps a team whose repository was deleted, with nothing chosen', async => {
 const [rn] = await db
.insert(runner)
.values({ workspaceId: WS, name: 'runner-lands', pairingTokenHash: 'hash-lands' })
.returning({ id: runner.id })
 const [repo] = await db
.insert(repository)
.values({
 workspaceId: WS,
 runnerId: rn!.id,
 displayName: 'lands',
 absolutePath: '/tmp/lands',
 defaultBranch: 'main',
 })
.returning({ id: repository.id })

 const team = await group(WS, 'lands', ['p_1'])
 const bound = await groups.update(WS, team.id, {
 name: 'lands',
 personaIds: ['p_1'],
 repositoryId: repo!.id,
 })
 expect(bound.repositoryId).toBe(repo!.id)

 // Absent leaves it alone; null un-chooses it. Two different acts, as with the root.
 const renamed = await groups.update(WS, team.id, { name: 'lands-2', personaIds: ['p_1'] })
 expect(renamed.repositoryId).toBe(repo!.id)

 await db.delete(repository).where(sql`${repository.id} = ${repo!.id}`)
 const after = (await groups.listByWorkspace(WS)).find((g) => g.id === team.id)
 expect(after).toBeDefined
 expect(after?.repositoryId).toBeNull
 })

 it('never reaches into another workspace\'s groups', async => {
 const mine = await group(WS, 'backend', ['p_1'])
 const theirs = await group(OTHER_WS, 'backend', ['p_1'])

 expect(await groups.prunePersona(WS, 'p_1')).toBe(1)

 expect((await groups.listByWorkspace(WS)).find((g) => g.id === mine.id)?.personaIds).toEqual([])
 expect(
 (await groups.listByWorkspace(OTHER_WS)).find((g) => g.id === theirs.id)?.personaIds,
).toEqual(['p_1'])
 })
})

/**
 * The atlas's write side, asserted where its claims actually live.
 *
 * Three of the four things this repository promises are Postgres behaviours and cannot be
 * demonstrated against a fake: the unique index that makes one relation one row, the
 * `on conflict do nothing` that stops a second proposer overwriting the first's argument,
 * and the joins that read both endpoints' current labels rather than a copy taken when
 * the relation was proposed.
 */
describe('atlas repository', => {
 const atlas = atlasRepository(db)
 const maps = subjectMapRepository(db)

 const seedConcept = async (input: {
 workspaceId: WorkspaceId
 personaName: string
 subjectRef: string
 label: string
 }) => {
 const [persona] = await db
.insert(agentPersona)
.values({
 workspaceId: input.workspaceId,
 name: input.personaName,
 description: '',
 markdownSource: '',
 model: 'claude-opus-5',
 tools: [],
 })
.returning({ id: agentPersona.id })
 const map = await maps.upsertMap({
 workspaceId: input.workspaceId,
 personaId: persona!.id as never,
 subjectKind: 'repository',
 repositoryId: null,
 subjectRef: input.subjectRef,
 revision: 'abc1234',
 status: 'ready',
 masteryRunId: null,
 })
 await maps.writeFragment({
 workspaceId: input.workspaceId,
 mapId: map.id,
 revision: 'abc1234',
 nodes: [
 {
 key: input.label,
 kind: 'concept',
 label: input.label,
 summary: `about ${input.label}`,
 provenance: 'inferred',
 paths: [],
 observationCount: 1,
 },
 ],
 edges: [],
 })
 const [node] = await maps.listNodes(input.workspaceId, map.id)
 return { personaId: persona!.id, mapId: map.id, nodeId: node!.id }
 }

 it('stores one relation once, and keeps the first proposer’s argument', async => {
 const flight = await seedConcept({
 workspaceId: WS,
 personaName: 'flight-expert',
 subjectRef: 'flight-api',
 label: 'Cancellation fee',
 })
 const hotel = await seedConcept({
 workspaceId: WS,
 personaName: 'hotel-expert',
 subjectRef: 'hotel-api',
 label: 'Refund policy',
 })
 const [first, second] = [flight.nodeId, hotel.nodeId].sort

 const created = await atlas.propose({
 workspaceId: WS,
 fromNodeId: first!,
 toNodeId: second!,
 relation: 'same_concept',
 rationale: 'Both compute a partial charge.',
 proposedByPersonaId: flight.personaId as never,
 proposedByRunId: null,
 })
 expect(created.created).toBe(true)

 const again = await atlas.propose({
 workspaceId: WS,
 fromNodeId: first!,
 toNodeId: second!,
 relation: 'same_concept',
 rationale: 'A different argument entirely.',
 proposedByPersonaId: hotel.personaId as never,
 proposedByRunId: null,
 })
 expect(again.created).toBe(false)
 // A second proposer must not overwrite the argument a human is going to read.
 expect(again.edge.rationale).toBe('Both compute a partial charge.')
 expect(await atlas.list(WS)).toHaveLength(1)
 })

 /**
 * Labels are joined, never copied. A curation pass that rewords a concept must not
 * leave the atlas quoting a sentence its own map no longer contains.
 */
 it('reads the endpoint’s current label rather than the one it was proposed under', async => {
 const flight = await seedConcept({
 workspaceId: WS,
 personaName: 'flight-expert',
 subjectRef: 'flight-api',
 label: 'Cancellation fee',
 })
 const hotel = await seedConcept({
 workspaceId: WS,
 personaName: 'hotel-expert',
 subjectRef: 'hotel-api',
 label: 'Refund policy',
 })
 const [first, second] = [flight.nodeId, hotel.nodeId].sort
 const { edge } = await atlas.propose({
 workspaceId: WS,
 fromNodeId: first!,
 toNodeId: second!,
 relation: 'same_concept',
 rationale: 'Same computation.',
 proposedByPersonaId: null,
 proposedByRunId: null,
 })

 await db
.update(subjectMapNode)
.set({ label: 'Cancellation charge' })
.where(sql`${subjectMapNode.id} = ${flight.nodeId}`)

 const reread = await atlas.get(WS, edge.id)
 const labels = [reread?.from.label, reread?.to.label]
 expect(labels).toContain('Cancellation charge')
 expect(labels).not.toContain('Cancellation fee')
 })

 /**
 * The bi-temporal model: the edge survives its endpoint being superseded, and the
 * read reports that so the caller can decline to render it.
 */
 it('keeps a relation whose endpoint the map has retired, and says so', async => {
 const flight = await seedConcept({
 workspaceId: WS,
 personaName: 'flight-expert',
 subjectRef: 'flight-api',
 label: 'Cancellation fee',
 })
 const hotel = await seedConcept({
 workspaceId: WS,
 personaName: 'hotel-expert',
 subjectRef: 'hotel-api',
 label: 'Refund policy',
 })
 const [first, second] = [flight.nodeId, hotel.nodeId].sort
 const { edge } = await atlas.propose({
 workspaceId: WS,
 fromNodeId: first!,
 toNodeId: second!,
 relation: 'same_concept',
 rationale: 'Same computation.',
 proposedByPersonaId: null,
 proposedByRunId: null,
 })

 await maps.invalidateNodes(WS, [flight.nodeId], 'the repository outgrew it')

 const reread = await atlas.get(WS, edge.id)
 expect(reread).not.toBeNull
 expect([reread?.from.live, reread?.to.live]).toContain(false)
 })

 it('decides once, and refuses to be decided again', async => {
 const flight = await seedConcept({
 workspaceId: WS,
 personaName: 'flight-expert',
 subjectRef: 'flight-api',
 label: 'Cancellation fee',
 })
 const hotel = await seedConcept({
 workspaceId: WS,
 personaName: 'hotel-expert',
 subjectRef: 'hotel-api',
 label: 'Refund policy',
 })
 const [first, second] = [flight.nodeId, hotel.nodeId].sort
 const { edge } = await atlas.propose({
 workspaceId: WS,
 fromNodeId: first!,
 toNodeId: second!,
 relation: 'same_concept',
 rationale: 'Same computation.',
 proposedByPersonaId: null,
 proposedByRunId: null,
 })

 // A fresh id per run: `user` is Better Auth's table and this suite's truncate does
 // not reach it, so a fixed id survives into the next run and collides.
 const userId = `u-atlas-${Date.now}`
 const [row] = await db
.insert(user)
.values({
 id: userId,
 name: 'Ramin',
 email: `${userId}@example.com`,
 emailVerified: true,
 })
.returning({ id: user.id })

 const promoted = await atlas.decide({
 workspaceId: WS,
 edgeId: edge.id,
 status: 'promoted',
 decidedByUserId: row!.id as never,
 decidedByName: 'Ramin',
 note: '',
 })
 expect(promoted?.status).toBe('promoted')
 expect(promoted?.decidedByName).toBe('Ramin')

 // First decision wins — a second would rewrite whose name is on it.
 expect(
 await atlas.decide({
 workspaceId: WS,
 edgeId: edge.id,
 status: 'rejected',
 decidedByUserId: row!.id as never,
 decidedByName: 'Ramin',
 note: 'changed my mind',
 }),
).toBeNull

 expect(await atlas.listPromotedTouching(WS, [flight.nodeId])).toHaveLength(1)
 })

 it('never reaches into another workspace’s relations', async => {
 const flight = await seedConcept({
 workspaceId: WS,
 personaName: 'flight-expert',
 subjectRef: 'flight-api',
 label: 'Cancellation fee',
 })
 const hotel = await seedConcept({
 workspaceId: WS,
 personaName: 'hotel-expert',
 subjectRef: 'hotel-api',
 label: 'Refund policy',
 })
 const [first, second] = [flight.nodeId, hotel.nodeId].sort
 await atlas.propose({
 workspaceId: WS,
 fromNodeId: first!,
 toNodeId: second!,
 relation: 'same_concept',
 rationale: 'Same computation.',
 proposedByPersonaId: null,
 proposedByRunId: null,
 })
 expect(await atlas.list(OTHER_WS)).toHaveLength(0)
 })
})
