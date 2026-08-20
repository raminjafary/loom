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
  asAgentPersonaId,
  asAgentRunId,
  asRepositoryId,
  asUserId,
  asWorkspaceId,
  userActor,
  type VerificationStatus,
  type WorkspaceId,
} from '@loom/domain'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from './client.js'
import { schemaStatus } from './schema-status.js'
import {
  agentRunRepository,
  atlasRepository,
  mergeQueueRepository,
  personaGroupRepository,
  personaRepository,
  personaVariantRepository,
  subjectMapRepository,
} from './agent-repositories.js'
import { campaignRepository, screenRepository } from './screen-repositories.js'
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
  personaRevision,
  promptTrialUse,
  repository,
  runVerification,
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

/**
 * Unread state, against real SQL.
 *
 * These are here rather than over HTTP because all three rules are properties of one
 * statement, and two of them are the kind a hand-written join gets wrong quietly: an
 * agent's message has a null `actor_user_id`, so the obvious `<>` comparison drops every
 * one of them, and a channel nobody has opened has no marker row at all.
 */
describe('unread state', () => {
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

  it('counts what somebody else said and never what you said yourself', async () => {
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
  it('counts an agent"s messages, whose author column is null', async () => {
    const { channelId, threadId } = await seed('agents')
    await postMessage(deps, { workspaceId: WS, actor: agent, threadId, text: 'from a run' })
    expect(await unreadFor('user_integration')).toEqual({ [channelId]: 1 })
  })

  it('clears on read, and stays clear until something new arrives', async () => {
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
  it('never moves a marker backwards', async () => {
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

  it('keeps one workspace"s unread out of another"s', async () => {
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

/**
 * The cost dashboard's rollup.
 *
 * Against real Postgres rather than a fake, because every property worth asserting here
 * is a property of the SQL: that the grouping keys are read out of the persona *jsonb
 * snapshot*, that a null `total_cost_usd` counts as zero money but still counts as a
 * run, and that the whole thing stays inside one workspace. None of those survive being
 * mocked.
 */
describe('agent run cost rollup', () => {
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
      persona: { ...persona, systemPrompt: 'x', tools: [], approvalMode: 'ask' as const },
      status: 'completed',
      totalCostUsd,
      ...(createdAt ? { createdAt } : {}),
    })
  }

  it('groups by the persona snapshot the run actually carried', async () => {
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
  it('counts an unmetered run without inventing spend for it', async () => {
    const scaffolding = await scaffold(WS, 'general')
    await addRun(WS, scaffolding, { name: 'worker', model: 'claude-sonnet-5' }, null)
    await addRun(WS, scaffolding, { name: 'worker', model: 'claude-sonnet-5' }, 0.25)

    const rollup = await runs.costRollup(WS, { since: null })
    expect(rollup.totals.runCount).toBe(2)
    expect(rollup.totals.totalUsd).toBeCloseTo(0.25)
  })

  it('rolls up per thread with the channel that thread belongs to', async () => {
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

  it('honours the window, so a dashboard can ask what today cost', async () => {
    const scaffolding = await scaffold(WS, 'general')
    const longAgo = new Date(Date.now() - 72 * 3_600_000)
    await addRun(WS, scaffolding, { name: 'worker', model: 'claude-sonnet-5' }, 5, longAgo)
    await addRun(WS, scaffolding, { name: 'worker', model: 'claude-sonnet-5' }, 1)

    expect((await runs.costRollup(WS, { since: null })).totals.totalUsd).toBeCloseTo(6)
    const since = new Date(Date.now() - 24 * 3_600_000)
    const recent = await runs.costRollup(WS, { since })
    expect(recent.totals.runCount).toBe(1)
    expect(recent.totals.totalUsd).toBeCloseTo(1)
  })

  it('never reports another workspace\'s spend', async () => {
    const mine = await scaffold(WS, 'general')
    const theirs = await scaffold(OTHER_WS, 'general')
    await addRun(WS, mine, { name: 'worker', model: 'claude-sonnet-5' }, 0.4)
    await addRun(OTHER_WS, theirs, { name: 'worker', model: 'claude-opus-5' }, 9)

    const rollup = await runs.costRollup(WS, { since: null })
    expect(rollup.totals.totalUsd).toBeCloseTo(0.4)
    expect(rollup.byModel.map((r) => r.model)).toEqual(['claude-sonnet-5'])
    expect(rollup.topRuns).toHaveLength(1)
  })

  it('reports an empty workspace as zero rather than as nothing', async () => {
    const rollup = await runs.costRollup(WS, { since: null })
    expect(rollup.totals).toEqual({ runCount: 0, totalUsd: 0 })
    expect(rollup.byModel).toEqual([])
    expect(rollup.topRuns).toEqual([])
  })
})

/**
 * The prompt trial's fitness, against real Postgres.
 *
 * Here rather than in the application layer because the whole change is one aggregate:
 * whether a left-joined verification really widens "decided", whether a `skipped` row
 * really does not, and whether `mode() within group` over `jsonb_path_query_first` really
 * names the check that failed most. None of that is answerable against a fake — a fake
 * would return whatever this file's author believed the SQL did.
 */
describe('prompt trial outcomes', () => {
  const personas = personaRepository(db)

  let seq = 0

  const scaffold = async (workspaceId: WorkspaceId) => {
    seq += 1
    const [ch] = await db
      .insert(channel)
      .values({ workspaceId, name: `trial-${seq}`, isPrivate: false })
      .returning({ id: channel.id })
    const [th] = await db
      .insert(thread)
      .values({ workspaceId, channelId: ch!.id, isRoot: true })
      .returning({ id: thread.id })
    const [rn] = await db
      .insert(runner)
      .values({ workspaceId, name: `runner-trial-${seq}`, pairingTokenHash: `hash-trial-${seq}` })
      .returning({ id: runner.id })
    const [repo] = await db
      .insert(repository)
      .values({
        workspaceId,
        runnerId: rn!.id,
        displayName: 'repo',
        absolutePath: `/tmp/trial-${seq}`,
        defaultBranch: 'main',
      })
      .returning({ id: repository.id })
    const [persona] = await db
      .insert(agentPersona)
      .values({
        workspaceId,
        name: `worker-${seq}`,
        description: 'd',
        markdownSource: 'live',
        model: 'claude-haiku-4-5',
      })
      .returning({ id: agentPersona.id })
    const [revision] = await db
      .insert(personaRevision)
      .values({
        workspaceId,
        personaId: persona!.id,
        markdownSource: 'superseded',
        replacedByKind: 'agent_run',
      })
      .returning({ id: personaRevision.id })
    return {
      threadId: th!.id,
      runnerId: rn!.id,
      repositoryId: repo!.id,
      personaId: persona!.id,
      revisionId: revision!.id,
    }
  }

  type Scaffolding = Awaited<ReturnType<typeof scaffold>>

  /** One run on one arm, with whatever the harness and the human said about its branch. */
  const addTrialRun = async (
    workspaceId: WorkspaceId,
    s: Scaffolding,
    input: {
      arm: 'revised' | 'previous'
      status?: 'completed' | 'failed'
      disposition?: 'merged' | 'discarded' | null
      costUsd?: number
      verification?: { status: VerificationStatus; failing?: string }
      /** For the variant search, whose arms are `variant_use` rows rather than trial ones. */
      skipTrialRow?: boolean
    },
  ) => {
    const [run] = await db
      .insert(agentRun)
      .values({
        workspaceId,
        threadId: s.threadId,
        repositoryId: s.repositoryId,
        runnerId: s.runnerId,
        persona: { name: 'worker', model: 'claude-haiku-4-5', systemPrompt: 'x', tools: [], approvalMode: 'ask' as const },
        status: input.status ?? 'completed',
        branchName: 'loom/x',
        branchDisposition: input.disposition ?? null,
        totalCostUsd: input.costUsd ?? 0.1,
      })
      .returning({ id: agentRun.id })
    if (!input.skipTrialRow) {
      await db.insert(promptTrialUse).values({
        workspaceId,
        personaId: s.personaId,
        revisionId: s.revisionId,
        agentRunId: run!.id,
        arm: input.arm,
      })
    }
    if (input.verification) {
      await db.insert(runVerification).values({
        workspaceId,
        agentRunId: run!.id,
        repositoryId: s.repositoryId,
        branchName: 'loom/x',
        status: input.verification.status,
        // Shaped like the harness's own output: the failing check, then the ones it never
        // reached. `not_run` is a recorded status rather than an omission, which is what
        // makes "the build failed and the tests were never run" readable at all.
        checks: input.verification.failing
          ? [
              { name: input.verification.failing, status: 'failed', detail: 'boom', durationMs: 12 },
              { name: 'smoke', status: 'not_run', detail: null, durationMs: null },
            ]
          : [{ name: 'tests', status: 'passed', detail: null, durationMs: 30 }],
      })
    }
    return run!.id
  }

  const armed = (tallies: Awaited<ReturnType<typeof personas.tallyTrialOutcomes>>, arm: string) =>
    tallies.find((tally) => tally.arm === arm)

  /**
   * The point of the whole change: a branch nobody has looked at, which failed the
   * repository's definition of done, is evidence. Before the harness the only decided run
   * was one a human had ruled on, so the fitness measured what reviewers had time for.
   */
  it('counts a failed definition of done as a decided run, with no human involved', async () => {
    const s = await scaffold(WS)
    await addTrialRun(WS, s, { arm: 'revised', verification: { status: 'failed', failing: 'build' } })
    await addTrialRun(WS, s, { arm: 'revised', verification: { status: 'failed', failing: 'build' } })
    await addTrialRun(WS, s, { arm: 'revised', verification: { status: 'failed', failing: 'tests' } })
    await addTrialRun(WS, s, { arm: 'previous', disposition: 'merged', verification: { status: 'passed' } })

    const tallies = await personas.tallyTrialOutcomes(WS, s.revisionId as never)
    expect(armed(tallies, 'revised')).toMatchObject({
      decided: 3,
      merged: 0,
      verificationFailed: 3,
      // Two builds against one test failure — the name a human needs, not just a count.
      failingCheck: 'build',
    })
    expect(armed(tallies, 'previous')).toMatchObject({
      decided: 1,
      merged: 1,
      verificationFailed: 0,
      failingCheck: null,
    })
  })

  /**
   * `skipped` and `refused` are facts about the operator's setup, and `pending` is a
   * verdict that has not arrived. Folding any of them into `failed` would make every
   * unconfigured repository look like it was producing broken work.
   */
  it('leaves a skipped, refused or pending verification out of the evidence', async () => {
    const s = await scaffold(WS)
    await addTrialRun(WS, s, { arm: 'revised', verification: { status: 'skipped' } })
    await addTrialRun(WS, s, { arm: 'revised', verification: { status: 'refused' } })
    await addTrialRun(WS, s, { arm: 'revised', verification: { status: 'pending' } })
    await addTrialRun(WS, s, { arm: 'revised', verification: { status: 'error' } })

    const tallies = await personas.tallyTrialOutcomes(WS, s.revisionId as never)
    expect(armed(tallies, 'revised')).toMatchObject({
      decided: 0,
      verificationFailed: 0,
      failingCheck: null,
    })
  })

  /**
   * A run is decided once, however many ways it qualifies — the filter is an OR, so a
   * failed run whose branch also failed its checks must not be counted twice, and its cost
   * must not be summed twice either.
   */
  it('counts a run once when the human, the run and the harness all agree', async () => {
    const s = await scaffold(WS)
    await addTrialRun(WS, s, {
      arm: 'revised',
      status: 'failed',
      disposition: 'discarded',
      costUsd: 0.5,
      verification: { status: 'failed', failing: 'build' },
    })

    const tallies = await personas.tallyTrialOutcomes(WS, s.revisionId as never)
    expect(armed(tallies, 'revised')).toMatchObject({
      decided: 1,
      discarded: 1,
      failed: 1,
      verificationFailed: 1,
      costUsdTotal: 0.5,
    })
  })

  /** A run with no verification row at all — the ordinary case in a repository with no checks. */
  it('reads a run with no verification as the disposition alone', async () => {
    const s = await scaffold(WS)
    await addTrialRun(WS, s, { arm: 'revised', disposition: 'merged' })
    await addTrialRun(WS, s, { arm: 'revised' })

    const tallies = await personas.tallyTrialOutcomes(WS, s.revisionId as never)
    expect(armed(tallies, 'revised')).toMatchObject({
      decided: 1,
      merged: 1,
      verificationFailed: 0,
      failingCheck: null,
    })
  })

  it('never reads another workspace"s runs into an arm', async () => {
    const mine = await scaffold(WS)
    const theirs = await scaffold(OTHER_WS)
    await addTrialRun(OTHER_WS, theirs, {
      arm: 'revised',
      verification: { status: 'failed', failing: 'build' },
    })

    expect(await personas.tallyTrialOutcomes(WS, mine.revisionId as never)).toEqual([])
  })

  /**
   * The searching half, against real Postgres.
   *
   * Two things here are only answerable against a database. The incumbent arm is a **null**
   * `variant_id`, and `group by` on a nullable column is exactly where an arm quietly
   * disappears — a `where variant_id is not null` anywhere in the aggregate would drop the
   * control group and every candidate would look unbeatable. And the one-open-search rule is
   * a partial unique index, so what enforces it is the index, not the use case that checks
   * first.
   */
  describe('the variant search', () => {
    const variants = personaVariantRepository(db)

    const openSearch = async (workspaceId: WorkspaceId, s: Scaffolding) =>
      variants.openSet({
        workspaceId,
        personaId: s.personaId as never,
        candidates: [
          { markdownSource: 'alpha doc', rationale: 'alpha' },
          { markdownSource: 'beta doc', rationale: 'beta' },
        ],
      })

    it('refuses a second open search for one persona, at the database', async () => {
      const s = await scaffold(WS)
      await openSearch(WS, s)
      await expect(openSearch(WS, s)).rejects.toThrow()

      // Settled frees the slot — which is what makes "discard and try again" work at all.
      const open = await variants.findOpenSet(WS, s.personaId as never)
      await variants.settleSet(WS, open!.set.id, { promotedVariantId: null })
      await expect(openSearch(WS, s)).resolves.toBeDefined()
    })

    it('tallies the incumbent arm, which is a null variant id', async () => {
      const s = await scaffold(WS)
      const { set, variants: candidates } = await openSearch(WS, s)
      const alpha = candidates[0]!

      const runOn = async (variantId: string | null, input: Parameters<typeof addTrialRun>[2]) => {
        const runId = await addTrialRun(WS, s, { ...input, arm: 'revised', skipTrialRow: true })
        await variants.recordVariantUse({
          workspaceId: WS,
          setId: set.id,
          variantId: variantId as never,
          agentRunId: runId as never,
        })
      }

      await runOn(null, { arm: 'revised', disposition: 'merged' })
      await runOn(null, { arm: 'revised', disposition: 'discarded' })
      await runOn(alpha.id, {
        arm: 'revised',
        verification: { status: 'failed', failing: 'build' },
      })

      const tallies = await variants.tallyVariantOutcomes(WS, set.id)
      const incumbent = tallies.find((tally) => tally.variantId === null)
      expect(incumbent).toMatchObject({ decided: 2, merged: 1, discarded: 1 })
      expect(tallies.find((tally) => tally.variantId === alpha.id)).toMatchObject({
        decided: 1,
        merged: 0,
        verificationFailed: 1,
        failingCheck: 'build',
      })

      // Assignment counts every run handed out, decided or not — that is what balances.
      const arms = await variants.countVariantArms(WS, set.id)
      expect(arms.find((arm) => arm.variantId === null)?.count).toBe(2)
      expect(arms.find((arm) => arm.variantId === alpha.id)?.count).toBe(1)
    })

    /** A double settle is a no-op, so two humans clicking at once cannot both decide. */
    it('settles once', async () => {
      const s = await scaffold(WS)
      const { set, variants: candidates } = await openSearch(WS, s)
      expect(await variants.settleSet(WS, set.id, { promotedVariantId: candidates[0]!.id })).not.toBeNull()
      expect(await variants.settleSet(WS, set.id, { promotedVariantId: candidates[1]!.id })).toBeNull()

      const settled = await variants.findSet(WS, set.id)
      expect(settled?.set.promotedVariantId).toBe(candidates[0]!.id)
      // Both candidates survive: a loser is archived, never deleted.
      expect(settled?.variants).toHaveLength(2)
    })
  })
})

/**
 * The pruning `deletePersona` used to do for itself, now the port's job and therefore
 * tested where the storage actually is. The use-case test can only assert that pruning
 * was asked for; whether a jsonb array really loses the right element, and only in the
 * right workspace, is a question about Postgres.
 */
describe('persona group pruning', () => {
  const groups = personaGroupRepository(db)

  const group = (workspaceId: WorkspaceId, name: string, personaIds: string[]) =>
    groups.create({ workspaceId, name, personaIds })

  it('drops the persona from every group holding it and leaves the rest alone', async () => {
    const held = await group(WS, 'backend', ['p_1', 'p_2'])
    const alsoHeld = await group(WS, 'oncall', ['p_2', 'p_1', 'p_3'])
    const untouched = await group(WS, 'frontend', ['p_3'])

    expect(await groups.prunePersona(WS, 'p_1')).toBe(2)

    const after = new Map((await groups.listByWorkspace(WS)).map((g) => [g.id, g.personaIds]))
    expect(after.get(held.id)).toEqual(['p_2'])
    expect(after.get(alsoHeld.id)).toEqual(['p_2', 'p_3'])
    expect(after.get(untouched.id)).toEqual(['p_3'])
  })

  it('empties a group whose only member was the persona, rather than deleting it', async () => {
    const solo = await group(WS, 'solo', ['p_1'])
    expect(await groups.prunePersona(WS, 'p_1')).toBe(1)

    const after = await groups.listByWorkspace(WS)
    expect(after.map((g) => g.id)).toContain(solo.id)
    expect(after.find((g) => g.id === solo.id)?.personaIds).toEqual([])
  })

  it('reports zero when nothing held the persona, and touches no row', async () => {
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
  it('keeps a team whose repository was deleted, with nothing chosen', async () => {
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
    expect(after).toBeDefined()
    expect(after?.repositoryId).toBeNull()
  })

  it('never reaches into another workspace\'s groups', async () => {
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
describe('atlas repository', () => {
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

  it('stores one relation once, and keeps the first proposer’s argument', async () => {
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
    const [first, second] = [flight.nodeId, hotel.nodeId].sort()

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
  it('reads the endpoint’s current label rather than the one it was proposed under', async () => {
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
    const [first, second] = [flight.nodeId, hotel.nodeId].sort()
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
  it('keeps a relation whose endpoint the map has retired, and says so', async () => {
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
    const [first, second] = [flight.nodeId, hotel.nodeId].sort()
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
    expect(reread).not.toBeNull()
    expect([reread?.from.live, reread?.to.live]).toContain(false)
  })

  it('decides once, and refuses to be decided again', async () => {
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
    const [first, second] = [flight.nodeId, hotel.nodeId].sort()
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
    const userId = `u-atlas-${Date.now()}`
    const [row] = await db
      .insert(user)
      .values({
        id: userId,
        name: 'Ada',
        email: `${userId}@example.com`,
        emailVerified: true,
      })
      .returning({ id: user.id })

    const promoted = await atlas.decide({
      workspaceId: WS,
      edgeId: edge.id,
      status: 'promoted',
      decidedByUserId: row!.id as never,
      decidedByName: 'Ada',
      note: '',
    })
    expect(promoted?.status).toBe('promoted')
    expect(promoted?.decidedByName).toBe('Ada')

    // First decision wins — a second would rewrite whose name is on it.
    expect(
      await atlas.decide({
        workspaceId: WS,
        edgeId: edge.id,
        status: 'rejected',
        decidedByUserId: row!.id as never,
        decidedByName: 'Ada',
        note: 'changed my mind',
      }),
    ).toBeNull()

    expect(await atlas.listPromotedTouching(WS, [flight.nodeId])).toHaveLength(1)
  })

  it('never reaches into another workspace’s relations', async () => {
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
    const [first, second] = [flight.nodeId, hotel.nodeId].sort()
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

/**
 * The held-out screen, against real Postgres.
 *
 * The queries are the risk here, not the arithmetic — `replay-set.test.ts` covers that. What
 * these assert is the two things a join gets wrong silently: which runs are eligible material
 * for a set, and the difference between "no screen" and "nothing admitted", which decide
 * whether a search deals candidates at all.
 */
describe('the held-out screen', () => {
  const screens = screenRepository(db)
  const variants = personaVariantRepository(db)
  const runs = agentRunRepository(db)
  let seq = 0

  const scaffold = async (workspaceId: WorkspaceId, personaName: string) => {
    seq += 1
    const [ch] = await db
      .insert(channel)
      .values({ workspaceId, name: `screen-${seq}`, isPrivate: false })
      .returning({ id: channel.id })
    const [th] = await db
      .insert(thread)
      .values({ workspaceId, channelId: ch!.id, isRoot: true })
      .returning({ id: thread.id })
    const [rn] = await db
      .insert(runner)
      .values({ workspaceId, name: `runner-screen-${seq}`, pairingTokenHash: `hash-screen-${seq}` })
      .returning({ id: runner.id })
    const [repo] = await db
      .insert(repository)
      .values({
        workspaceId,
        runnerId: rn!.id,
        displayName: 'repo',
        absolutePath: `/tmp/screen-${seq}`,
        defaultBranch: 'main',
      })
      .returning({ id: repository.id })
    const [persona] = await db
      .insert(agentPersona)
      .values({
        workspaceId,
        name: personaName,
        description: 'd',
        markdownSource: 'live',
        model: 'claude-haiku-4-5',
      })
      .returning({ id: agentPersona.id })
    return {
      threadId: th!.id,
      runnerId: rn!.id,
      repositoryId: asRepositoryId(repo!.id),
      personaId: asAgentPersonaId(persona!.id),
    }
  }

  type Scaffolding = Awaited<ReturnType<typeof scaffold>>

  const addRun = async (
    workspaceId: WorkspaceId,
    s: Scaffolding,
    input: {
      personaName: string
      baseCommitSha?: string | null
      task?: string | null
      disposition?: 'merged' | 'discarded' | null
      status?: 'completed' | 'failed' | 'running'
      relation?: string
      completedAt?: Date
    },
  ) => {
    const [run] = await db
      .insert(agentRun)
      .values({
        workspaceId,
        threadId: s.threadId,
        repositoryId: s.repositoryId,
        runnerId: s.runnerId,
        persona: {
          name: input.personaName,
          model: 'claude-haiku-4-5',
          systemPrompt: 'x',
          tools: [],
          approvalMode: 'ask' as const,
        },
        status: input.status ?? 'completed',
        branchName: 'loom/x',
        baseCommitSha: input.baseCommitSha === undefined ? 'abc123' : input.baseCommitSha,
        task: input.task === undefined ? 'Do the thing.' : input.task,
        branchDisposition: input.disposition === undefined ? 'merged' : input.disposition,
        ...(input.relation === undefined ? {} : { relation: input.relation }),
        completedAt: input.completedAt ?? new Date(),
      })
      .returning({ id: agentRun.id })
    return asAgentRunId(run!.id)
  }

  it('offers a decided run of this persona, with its commit, task and outcome', async () => {
    const s = await scaffold(WS, 'screened-1')
    await addRun(WS, s, { personaName: 'screened-1', disposition: 'discarded' })
    const records = await screens.listDecidedRunsForPersona(WS, 'screened-1', 50)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      baseCommitSha: 'abc123',
      task: 'Do the thing.',
      outcome: 'discarded',
      wasMeasured: false,
    })
  })

  it('does not offer another persona\'s runs, resolved by the snapshot\'s name', async () => {
    const s = await scaffold(WS, 'screened-2')
    await addRun(WS, s, { personaName: 'somebody-else' })
    expect(await screens.listDecidedRunsForPersona(WS, 'screened-2', 50)).toEqual([])
  })

  it('does not offer an undecided run', async () => {
    const s = await scaffold(WS, 'screened-3')
    await addRun(WS, s, { personaName: 'screened-3', status: 'running', disposition: null })
    expect(await screens.listDecidedRunsForPersona(WS, 'screened-3', 50)).toEqual([])
  })

  it('marks a run that was an arm of a search, so a set is not built from other prompts', async () => {
    const s = await scaffold(WS, 'screened-4')
    const runId = await addRun(WS, s, { personaName: 'screened-4' })
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [
        { markdownSource: 'a', rationale: 'r' },
        { markdownSource: 'b', rationale: 'r' },
      ],
    })
    await variants.recordVariantUse({
      workspaceId: WS,
      setId: opened.set.id,
      variantId: opened.variants[0]!.id,
      agentRunId: runId as never,
    })
    const [record] = await screens.listDecidedRunsForPersona(WS, 'screened-4', 50)
    expect(record?.wasMeasured).toBe(true)
  })

  it('never offers a screening run as material, which would fold its output into its input', async () => {
    const s = await scaffold(WS, 'screened-5')
    await addRun(WS, s, { personaName: 'screened-5', relation: 'screen' })
    expect(await screens.listDecidedRunsForPersona(WS, 'screened-5', 50)).toEqual([])
  })

  it('carries the gaps through rather than filtering them, so the caller can count them', async () => {
    // The "no silent truncation" lives in `assembleReplaySet`, which can only report a
    // gap it was shown. A query that pre-filtered would make `considered` a lie.
    const s = await scaffold(WS, 'screened-6')
    await addRun(WS, s, { personaName: 'screened-6', baseCommitSha: null })
    await addRun(WS, s, { personaName: 'screened-6', task: null })
    const records = await screens.listDecidedRunsForPersona(WS, 'screened-6', 50)
    expect(records).toHaveLength(2)
    expect(records.map((r) => r.baseCommitSha === null || r.task === null)).toEqual([true, true])
  })

  it('finds the runs where the checks and the human disagreed, both directions', async () => {
    const s = await scaffold(WS, 'divergent-1')
    const ruled = async (input: {
      verdict: 'passed' | 'failed'
      disposition: 'merged' | 'discarded' | null
      personaName?: string
      relation?: string
      failing?: string
    }) => {
      const runId = await addRun(WS, s, {
        personaName: input.personaName ?? 'divergent-1',
        disposition: input.disposition,
        ...(input.relation ? { relation: input.relation } : {}),
      })
      await db.insert(runVerification).values({
        workspaceId: WS,
        agentRunId: runId,
        repositoryId: s.repositoryId,
        branchName: 'loom/x',
        status: input.verdict,
        checks:
          input.verdict === 'failed'
            ? [{ name: input.failing ?? 'boundary', status: 'failed', detail: 'boom', durationMs: 4 }]
            : [{ name: 'tests', status: 'passed', detail: null, durationMs: 4 }],
      })
      return runId
    }

    const thrownAway = await ruled({ verdict: 'passed', disposition: 'discarded' })
    const takenAnyway = await ruled({ verdict: 'failed', disposition: 'merged' })
    // Agreement, in both directions: the population, not the set.
    await ruled({ verdict: 'passed', disposition: 'merged' })
    await ruled({ verdict: 'failed', disposition: 'discarded' })
    // Nobody ruled on this one, so it could not have disagreed with anything.
    await ruled({ verdict: 'passed', disposition: null })
    // Not this persona's, and not live traffic.
    await ruled({ verdict: 'passed', disposition: 'discarded', personaName: 'somebody-else' })
    await ruled({ verdict: 'passed', disposition: 'discarded', relation: 'screen' })

    const set = await runs.divergenceSet(WS, 'divergent-1', 20)
    expect(set).toMatchObject({ passedAndDiscarded: 1, failedAndMerged: 1, comparable: 4 })
    expect(set.runs.map((run) => run.runId).sort()).toEqual([thrownAway, takenAnyway].sort())
    const failedAndMerged = set.runs.find((run) => run.kind === 'failed-and-merged')
    expect(failedAndMerged?.failingCheck).toBe('boundary')
    // Nothing failed on the other direction, so no check is named there.
    expect(set.runs.find((run) => run.kind === 'passed-and-discarded')?.failingCheck).toBeNull()
  })

  it('mines the failing-check histogram over this persona\'s own decided runs', async () => {
    const s = await scaffold(WS, 'weakness-1')
    const failing = async (name: string | null, personaName = 'weakness-1', relation?: string) => {
      const runId = await addRun(WS, s, { personaName, ...(relation ? { relation } : {}) })
      await db.insert(runVerification).values({
        workspaceId: WS,
        agentRunId: runId,
        repositoryId: s.repositoryId,
        branchName: 'loom/x',
        status: name === null ? 'passed' : 'failed',
        checks:
          name === null
            ? [{ name: 'tests', status: 'passed', detail: null, durationMs: 3 }]
            : [
                { name, status: 'failed', detail: 'boom', durationMs: 12 },
                { name: 'smoke', status: 'not_run', detail: null, durationMs: null },
              ],
      })
    }
    await failing('boundary')
    await failing('boundary')
    await failing('types')
    await failing(null)
    // A screening run's prompt is substituted, so its failure is a fact about a candidate.
    await failing('boundary', 'weakness-1', 'screen')
    // And another persona's failures are not this one's.
    await failing('boundary', 'somebody-else')

    const mined = await runs.tallyFailingChecks(WS, 'weakness-1', 5)
    expect(mined.decidedRuns).toBe(4)
    expect(mined.verificationFailures).toBe(3)
    // Most failures first, and `not_run` is never counted as a failure.
    expect(mined.checks).toEqual([
      { name: 'boundary', failures: 2 },
      { name: 'types', failures: 1 },
    ])
  })

  it('reports what a refused candidate did item by item, with the check that failed', async () => {
    const s = await scaffold(WS, 'weakness-2')
    const sourceRun = await addRun(WS, s, { personaName: 'weakness-2' })
    const set = await screens.openReplaySet({
      workspaceId: WS,
      personaId: s.personaId,
      draft: {
        items: [0, 1].map((index) => ({
          sourceRunId: sourceRun,
          repositoryId: s.repositoryId,
          commitSha: `commit${index}`,
          task: `Task ${index}.`,
          observedOutcome: 'merged' as const,
        })),
        excluded: [],
        eligible: 2,
        considered: 2,
      },
      detail: 'two items',
    })
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [
        { markdownSource: 'a', rationale: 'r' },
        { markdownSource: 'b', rationale: 'r' },
      ],
    })
    await screens.openScreens({
      workspaceId: WS,
      setId: opened.set.id,
      replaySetId: set.set.id,
      variantIds: opened.variants.map((v) => v.id),
      itemIds: set.items.map((i) => i.id),
    })

    const rows = await screens.screensForSet(WS, opened.set.id)
    const candidate = rows.find((row) => row.screen.variantId === opened.variants[0]!.id)!
    const screeningRun = await addRun(WS, s, { personaName: 'weakness-2', relation: 'screen' })
    await db.insert(runVerification).values({
      workspaceId: WS,
      agentRunId: screeningRun,
      repositoryId: s.repositoryId,
      branchName: 'loom/x',
      status: 'failed',
      checks: [{ name: 'boundary', status: 'failed', detail: 'boom', durationMs: 9 }],
    })
    /**
     * By item rather than by the order the runs came back in: `screensForSet` orders its runs
     * by insertion, which is not the set's order, and a test that assumed it agreed with
     * `position` failed on the row ids alone.
     */
    const runFor = (itemIndex: number) =>
      candidate.runs.find((entry) => entry.replayItemId === set.items[itemIndex]!.id)!
    await screens.attachScreenRun(WS, runFor(0).id, screeningRun)
    await screens.recordScreenRunOutcome(WS, runFor(0).id, {
      outcome: 'failed',
      reason: null,
      model: 'claude-sonnet-5',
    })
    await screens.recordScreenRunOutcome(WS, runFor(1).id, {
      outcome: 'passed',
      reason: null,
      model: 'claude-sonnet-5',
    })
    await screens.decideScreen(WS, candidate.screen.id, {
      decision: 'rejected',
      reason: 'passed 1 of 2',
    })

    const { candidates } = await screens.listRefusedCandidates(WS, s.personaId, 6)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.items).toEqual([
      { position: 1, outcome: 'failed', task: 'Task 0.', failingCheck: 'boundary' },
      { position: 2, outcome: 'passed', task: 'Task 1.', failingCheck: null },
    ])
  })

  it('counts the candidates a run has already gated, and only the decided ones', async () => {
    const s = await scaffold(WS, 'screened-6b')
    const runId = await addRun(WS, s, { personaName: 'screened-6b' })
    const set = await screens.openReplaySet({
      workspaceId: WS,
      personaId: s.personaId,
      draft: {
        items: [
          {
            sourceRunId: runId,
            repositoryId: s.repositoryId,
            commitSha: 'abc123',
            task: 'Do the thing.',
            observedOutcome: 'merged' as const,
          },
        ],
        excluded: [],
        eligible: 1,
        considered: 1,
      },
      detail: 'one item',
    })
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [
        { markdownSource: 'a', rationale: 'r' },
        { markdownSource: 'b', rationale: 'r' },
      ],
    })
    await screens.openScreens({
      workspaceId: WS,
      setId: opened.set.id,
      replaySetId: set.set.id,
      variantIds: opened.variants.map((v) => v.id),
      itemIds: set.items.map((i) => i.id),
    })

    // Screens exist and none has decided: nothing has been gated yet.
    const before = await screens.listDecidedRunsForPersona(WS, 'screened-6b', 50)
    expect(before[0]?.gatedCandidates).toBe(0)

    const rows = await screens.screensForSet(WS, opened.set.id)
    const incumbent = rows.find((row) => row.screen.variantId === null)!
    await screens.decideScreen(WS, incumbent.screen.id, { decision: 'admitted', reason: 'x' })
    // The control is not a gate — counting it would retire every set one candidate early.
    expect((await screens.listDecidedRunsForPersona(WS, 'screened-6b', 50))[0]?.gatedCandidates).toBe(0)

    for (const row of rows.filter((entry) => entry.screen.variantId !== null)) {
      await screens.decideScreen(WS, row.screen.id, { decision: 'rejected', reason: 'worse' })
    }
    const after = await screens.listDecidedRunsForPersona(WS, 'screened-6b', 50)
    expect(after[0]?.gatedCandidates).toBe(2)
  })

  it('versions a set per persona, from one', async () => {
    const s = await scaffold(WS, 'screened-7')
    const draft = {
      items: [],
      excluded: [],
      eligible: 0,
      considered: 3,
    }
    const first = await screens.openReplaySet({
      workspaceId: WS,
      personaId: s.personaId,
      draft,
      detail: 'first',
    })
    const second = await screens.openReplaySet({
      workspaceId: WS,
      personaId: s.personaId,
      draft,
      detail: 'second',
    })
    expect(first.set.version).toBe(1)
    expect(second.set.version).toBe(2)
  })

  it('opens one screen per arm including the incumbent, each with one run per item', async () => {
    const s = await scaffold(WS, 'screened-8')
    const runId = await addRun(WS, s, { personaName: 'screened-8' })
    const set = await screens.openReplaySet({
      workspaceId: WS,
      personaId: s.personaId,
      draft: {
        items: [
          {
            sourceRunId: runId,
            repositoryId: s.repositoryId,
            commitSha: 'abc123',
            task: 'Do the thing.',
            observedOutcome: 'merged' as const,
          },
        ],
        excluded: [],
        eligible: 1,
        considered: 1,
      },
      detail: 'one item',
    })
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [
        { markdownSource: 'a', rationale: 'r' },
        { markdownSource: 'b', rationale: 'r' },
      ],
    })
    await screens.openScreens({
      workspaceId: WS,
      setId: opened.set.id,
      replaySetId: set.set.id,
      variantIds: opened.variants.map((v) => v.id),
      itemIds: set.items.map((i) => i.id),
    })

    const rows = await screens.screensForSet(WS, opened.set.id)
    expect(rows).toHaveLength(3)
    expect(rows.filter((row) => row.screen.variantId === null)).toHaveLength(1)
    expect(rows.every((row) => row.runs.length === 1)).toBe(true)
    expect(rows.every((row) => row.runs[0]?.outcome === 'pending')).toBe(true)
  })

  it('distinguishes no screen from nothing admitted, which decides whether a search deals arms', async () => {
    const s = await scaffold(WS, 'screened-9')
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [
        { markdownSource: 'a', rationale: 'r' },
        { markdownSource: 'b', rationale: 'r' },
      ],
    })
    // No screen: null, which the caller reads as "deal every candidate as before".
    expect(await screens.admittedVariantIds(WS, opened.set.id)).toBeNull()

    const set = await screens.openReplaySet({
      workspaceId: WS,
      personaId: s.personaId,
      draft: { items: [], excluded: [], eligible: 0, considered: 0 },
      detail: 'none',
    })
    await screens.openScreens({
      workspaceId: WS,
      setId: opened.set.id,
      replaySetId: set.set.id,
      variantIds: opened.variants.map((v) => v.id),
      itemIds: [],
    })
    // A screen exists and has decided nothing: an empty list, so no candidate is dealt yet.
    expect(await screens.admittedVariantIds(WS, opened.set.id)).toEqual([])

    const rows = await screens.screensForSet(WS, opened.set.id)
    const candidate = rows.find((row) => row.screen.variantId !== null)!
    await screens.decideScreen(WS, candidate.screen.id, {
      decision: 'admitted',
      reason: 'good enough',
    })
    expect(await screens.admittedVariantIds(WS, opened.set.id)).toEqual([
      candidate.screen.variantId,
    ])
  })

  it('claims a screening run once, and gives the claim back on release', async () => {
    const s = await scaffold(WS, 'screened-10')
    const set = await screens.openReplaySet({
      workspaceId: WS,
      personaId: s.personaId,
      draft: {
        items: [
          {
            sourceRunId: await addRun(WS, s, { personaName: 'source' }),
            repositoryId: s.repositoryId,
            commitSha: 'abc123',
            task: 'Do the thing.',
            observedOutcome: 'merged' as const,
          },
        ],
        excluded: [],
        eligible: 1,
        considered: 1,
      },
      detail: 'one item',
    })
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [
        { markdownSource: 'a', rationale: 'r' },
        { markdownSource: 'b', rationale: 'r' },
      ],
    })
    await screens.openScreens({
      workspaceId: WS,
      setId: opened.set.id,
      replaySetId: set.set.id,
      variantIds: opened.variants.map((v) => v.id),
      itemIds: set.items.map((i) => i.id),
    })
    const [first] = await screens.screensForSet(WS, opened.set.id)
    const screenRunId = first!.runs[0]!.id

    expect(await screens.claimScreenRun(WS, screenRunId)).toBe(true)
    // The second sweep loses, which is what stops two runs against one item.
    expect(await screens.claimScreenRun(WS, screenRunId)).toBe(false)
    await screens.releaseScreenRun(WS, screenRunId)
    expect(await screens.claimScreenRun(WS, screenRunId)).toBe(true)
  })

  it('records an outcome once, so a second sweep does not overwrite what the gate read', async () => {
    const s = await scaffold(WS, 'screened-11')
    const set = await screens.openReplaySet({
      workspaceId: WS,
      personaId: s.personaId,
      draft: {
        items: [
          {
            sourceRunId: await addRun(WS, s, { personaName: 'source' }),
            repositoryId: s.repositoryId,
            commitSha: 'abc123',
            task: 'Do the thing.',
            observedOutcome: 'merged' as const,
          },
        ],
        excluded: [],
        eligible: 1,
        considered: 1,
      },
      detail: 'one item',
    })
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [
        { markdownSource: 'a', rationale: 'r' },
        { markdownSource: 'b', rationale: 'r' },
      ],
    })
    await screens.openScreens({
      workspaceId: WS,
      setId: opened.set.id,
      replaySetId: set.set.id,
      variantIds: opened.variants.map((v) => v.id),
      itemIds: set.items.map((i) => i.id),
    })
    const [first] = await screens.screensForSet(WS, opened.set.id)
    const screenRunId = first!.runs[0]!.id

    await screens.recordScreenRunOutcome(WS, screenRunId, {
      outcome: 'passed',
      reason: null,
      model: 'claude-sonnet-5',
    })
    await screens.recordScreenRunOutcome(WS, screenRunId, {
      outcome: 'failed',
      reason: 'later',
      model: 'claude-opus-5',
    })
    const [again] = await screens.screensForSet(WS, opened.set.id)
    expect(again!.runs[0]?.outcome).toBe('passed')
    // The model is written with the outcome, so the second sweep cannot restamp it either.
    expect(again!.runs[0]?.model).toBe('claude-sonnet-5')
  })

  it('decides a screen once, so two sweeps cannot record two verdicts', async () => {
    const s = await scaffold(WS, 'screened-12')
    const set = await screens.openReplaySet({
      workspaceId: WS,
      personaId: s.personaId,
      draft: { items: [], excluded: [], eligible: 0, considered: 0 },
      detail: 'none',
    })
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [
        { markdownSource: 'a', rationale: 'r' },
        { markdownSource: 'b', rationale: 'r' },
      ],
    })
    await screens.openScreens({
      workspaceId: WS,
      setId: opened.set.id,
      replaySetId: set.set.id,
      variantIds: opened.variants.map((v) => v.id),
      itemIds: [],
    })
    const candidate = (await screens.screensForSet(WS, opened.set.id)).find(
      (row) => row.screen.variantId !== null,
    )!
    await screens.decideScreen(WS, candidate.screen.id, { decision: 'admitted', reason: 'first' })
    await screens.decideScreen(WS, candidate.screen.id, { decision: 'rejected', reason: 'second' })
    const after = (await screens.screensForSet(WS, opened.set.id)).find(
      (row) => row.screen.id === candidate.screen.id,
    )!
    expect(after.screen.decision).toBe('admitted')
    expect(after.screen.reason).toBe('first')
  })

  it('lists only sets whose search is still open, so a settled one is not swept forever', async () => {
    const s = await scaffold(WS, 'screened-13')
    const set = await screens.openReplaySet({
      workspaceId: WS,
      personaId: s.personaId,
      draft: { items: [], excluded: [], eligible: 0, considered: 0 },
      detail: 'none',
    })
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [
        { markdownSource: 'a', rationale: 'r' },
        { markdownSource: 'b', rationale: 'r' },
      ],
    })
    await screens.openScreens({
      workspaceId: WS,
      setId: opened.set.id,
      replaySetId: set.set.id,
      variantIds: opened.variants.map((v) => v.id),
      itemIds: [],
    })
    expect((await screens.listSetsWithOpenScreens()).some((row) => row.setId === opened.set.id)).toBe(
      true,
    )
    await variants.settleSet(WS, opened.set.id, { promotedVariantId: null })
    expect((await screens.listSetsWithOpenScreens()).some((row) => row.setId === opened.set.id)).toBe(
      false,
    )
  })

  /**
   * The buffer a proposer reads. Both halves are queries over rows that already existed and
   * that nothing read, so what is worth asserting is which rows they refuse to count: an arm
   * that is still being measured has not lost, and an admitted candidate was not refused.
   */
  it('offers refused candidates with the sentence that refused them, and counts what it withheld', async () => {
    const s = await scaffold(WS, 'buffer-1')
    const set = await screens.openReplaySet({
      workspaceId: WS,
      personaId: s.personaId,
      draft: { items: [], excluded: [], eligible: 0, considered: 0 },
      detail: 'none',
    })
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [
        { markdownSource: 'refused one', rationale: 'terser' },
        { markdownSource: 'admitted one', rationale: 'louder' },
      ],
    })
    await screens.openScreens({
      workspaceId: WS,
      setId: opened.set.id,
      replaySetId: set.set.id,
      variantIds: opened.variants.map((v) => v.id),
      itemIds: [],
    })
    /**
     * By identity rather than by position: `screensForSet` does not promise the arms come
     * back in the order they were proposed, and a test that assumes it does asserts a
     * coupling between two orderings neither side guarantees.
     */
    const refusedVariantId = opened.variants.find((v) => v.markdownSource === 'refused one')!.id
    const rows = await screens.screensForSet(WS, opened.set.id)
    const candidates = rows.filter((row) => row.screen.variantId !== null)
    const toRefuse = candidates.find((row) => row.screen.variantId === refusedVariantId)!
    const toAdmit = candidates.find((row) => row.screen.variantId !== refusedVariantId)!
    await screens.decideScreen(WS, toRefuse.screen.id, {
      decision: 'rejected',
      reason: 'Rejected by the held-out screen: it passed 2 of 6 items (33%).',
    })
    await screens.decideScreen(WS, toAdmit.screen.id, { decision: 'admitted', reason: 'no worse' })

    const buffer = await screens.listRefusedCandidates(WS, s.personaId, 10)
    expect(buffer.total).toBe(1)
    expect(buffer.candidates).toHaveLength(1)
    expect(buffer.candidates[0]?.variantId).toBe(refusedVariantId)
    expect(buffer.candidates[0]?.reason).toContain('passed 2 of 6 items')
    expect(buffer.candidates[0]?.rationale).toBe('terser')

    // The incumbent is never in it: it has no candidate row to be refused.
    expect(buffer.candidates.every((row) => row.markdownSource !== 'live')).toBe(true)

    // Bounded rows, unbounded count — which is what lets a brief say "1 of 1 shown".
    const bounded = await screens.listRefusedCandidates(WS, s.personaId, 0)
    expect(bounded.candidates).toHaveLength(0)
    expect(bounded.total).toBe(1)
  })

  it('counts a candidate as losing only once its search has settled, and includes one never dealt a run', async () => {
    const s = await scaffold(WS, 'buffer-2')
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [
        { markdownSource: 'promoted', rationale: 'kept' },
        { markdownSource: 'lost with runs', rationale: 'measured' },
        { markdownSource: 'lost with none', rationale: 'never dealt' },
      ],
    })
    const [promoted, measured] = opened.variants

    // An open search has no losers yet: nothing has been decided about any of these.
    expect((await variants.listLosingArms(WS, s.personaId, 10)).total).toBe(0)

    const kept = await addRun(WS, s, { personaName: 'buffer-2', disposition: 'merged' })
    const dropped = await addRun(WS, s, { personaName: 'buffer-2', disposition: 'discarded' })
    for (const runId of [kept, dropped]) {
      await variants.recordVariantUse({
        workspaceId: WS,
        setId: opened.set.id,
        variantId: measured!.id,
        agentRunId: runId,
      })
    }
    await variants.settleSet(WS, opened.set.id, { promotedVariantId: promoted!.id })

    const losing = await variants.listLosingArms(WS, s.personaId, 10)
    expect(losing.total).toBe(2)
    const bodies = losing.arms.map((arm) => arm.markdownSource)
    expect(bodies).toContain('lost with runs')
    // An arm nobody spent anything on is still a loss, and arguably the most useful kind.
    expect(bodies).toContain('lost with none')
    expect(bodies).not.toContain('promoted')

    const withRuns = losing.arms.find((arm) => arm.markdownSource === 'lost with runs')
    expect(withRuns?.decided).toBe(2)
    expect(withRuns?.kept).toBe(1)
    const withNone = losing.arms.find((arm) => arm.markdownSource === 'lost with none')
    expect(withNone?.decided).toBe(0)
    expect(withNone?.kept).toBe(0)
  })

  it('counts every arm of a discarded search as losing, because nothing was promoted', async () => {
    const s = await scaffold(WS, 'buffer-3')
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [
        { markdownSource: 'a', rationale: 'r' },
        { markdownSource: 'b', rationale: 'r' },
      ],
    })
    await variants.settleSet(WS, opened.set.id, { promotedVariantId: null })
    const losing = await variants.listLosingArms(WS, s.personaId, 10)
    expect(losing.total).toBe(2)
  })

  /**
   * The proposer session row, which is the thing that *authorizes* a submission rather than
   * describing one: the persona a session may write candidates for is resolved from here and
   * never from its tool call.
   */
  it('resolves which persona a proposer session may propose for, and only for its own run', async () => {
    const s = await scaffold(WS, 'proposer-1')
    const proposerRun = await addRun(WS, s, { personaName: 'variant-proposer' })
    const otherRun = await addRun(WS, s, { personaName: 'proposer-1' })

    expect(await variants.findProposerSession(WS, proposerRun)).toBeNull()

    await variants.openProposerSession({
      workspaceId: WS,
      personaId: s.personaId,
      agentRunId: proposerRun,
      shown: {
        losingArms: 2,
        refusedCandidates: 1,
        losingArmsWithheld: 17,
        refusedCandidatesWithheld: 0,
      },
    })

    const session = await variants.findProposerSession(WS, proposerRun)
    expect(session?.personaId).toBe(s.personaId)
    // The bound as it was at start, which is the provenance a promotion is read against
    // months later — recomputing it would report today's buffer against yesterday's brief.
    expect(session?.shown).toEqual({
      losingArms: 2,
      refusedCandidates: 1,
      losingArmsWithheld: 17,
      refusedCandidatesWithheld: 0,
    })

    // Every other run in the workspace is not a proposer, which is what refuses a submission.
    expect(await variants.findProposerSession(WS, otherRun)).toBeNull()
  })

  /**
   * A repeat is a no-op rather than a second grant: two rows for one run would be two answers
   * to "which persona may this session propose for".
   */
  it('grants one persona per proposer run, whatever a retry says', async () => {
    const s = await scaffold(WS, 'proposer-2')
    const other = await scaffold(WS, 'proposer-3')
    const run = await addRun(WS, s, { personaName: 'variant-proposer' })
    const shown = {
      losingArms: 1,
      refusedCandidates: 0,
      losingArmsWithheld: 0,
      refusedCandidatesWithheld: 0,
    }
    await variants.openProposerSession({
      workspaceId: WS,
      personaId: s.personaId,
      agentRunId: run,
      shown,
    })
    await variants.openProposerSession({
      workspaceId: WS,
      personaId: other.personaId,
      agentRunId: run,
      shown,
    })
    expect((await variants.findProposerSession(WS, run))?.personaId).toBe(s.personaId)
  })
})

/**
 * Whether the schema this build expects is the schema the database has.
 *
 * The failure it exists for is the one no build can catch: a promoted revision of Loom's own
 * source that typechecks, passes its tests, starts, binds, answers — and fails its first query
 * because nobody ran the migration. So the negative case is the test worth having, and it is
 * produced by actually removing the applied row rather than by stubbing a count.
 */
describe('schema status', () => {
  it('names the newest migration this build ships, and confirms it is applied here', async () => {
    const status = await schemaStatus(db)
    expect(status.expected).toMatch(/^\d{4}_/)
    expect(status.applied).toBe(true)
    expect(status.detail).toContain(String(status.expected))
  })

  /**
   * The row is deleted and put back in a `finally`, because every other test in this file runs
   * against the same database — and a test that left it looking unmigrated would make the next
   * reader debug the wrong thing.
   */
  it('says the database is behind when the newest migration is not applied', async () => {
    const before = await schemaStatus(db)
    const [row] = await db.execute<{ id: number; hash: string; created_at: string }>(
      sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id desc limit 1`,
    )
    if (!row) throw new Error('no applied migrations to remove')
    try {
      await db.execute(sql`delete from drizzle.__drizzle_migrations where id = ${row.id}`)
      const behind = await schemaStatus(db)
      expect(behind.expected).toBe(before.expected)
      expect(behind.applied).toBe(false)
      // The sentence names what to do, because "degraded" is not an action.
      expect(behind.detail).toContain('Run the migrations')
    } finally {
      await db.execute(
        sql`insert into drizzle.__drizzle_migrations (id, hash, created_at) values (${row.id}, ${row.hash}, ${row.created_at})`,
      )
    }
    expect((await schemaStatus(db)).applied).toBe(true)
  })
})

/**
 * The routing table's evidence — what has happened per model for one persona.
 *
 * Grouped by the model on each run's own snapshot rather than by the persona row, which is the
 * only reading that means anything: the row holds one model, and the whole question is how the
 * several models this persona has run on compare.
 */
describe('model outcomes per persona', () => {
  const personas = personaRepository(db)
  let seq = 0

  const scaffold = async (workspaceId: WorkspaceId, personaName: string) => {
    seq += 1
    const [ch] = await db
      .insert(channel)
      .values({ workspaceId, name: `routing-${seq}`, isPrivate: false })
      .returning({ id: channel.id })
    const [th] = await db
      .insert(thread)
      .values({ workspaceId, channelId: ch!.id, isRoot: true })
      .returning({ id: thread.id })
    const [rn] = await db
      .insert(runner)
      .values({ workspaceId, name: `runner-routing-${seq}`, pairingTokenHash: `hash-routing-${seq}` })
      .returning({ id: runner.id })
    const [repo] = await db
      .insert(repository)
      .values({
        workspaceId,
        runnerId: rn!.id,
        displayName: 'repo',
        absolutePath: `/tmp/routing-${seq}`,
        defaultBranch: 'main',
      })
      .returning({ id: repository.id })
    return { threadId: th!.id, runnerId: rn!.id, repositoryId: repo!.id, personaName }
  }

  const addRun = async (
    workspaceId: WorkspaceId,
    s: Awaited<ReturnType<typeof scaffold>>,
    input: {
      model: string
      disposition?: 'merged' | 'discarded' | null
      relation?: string
      totalCostUsd?: number
    },
  ) => {
    const [row] = await db
      .insert(agentRun)
      .values({
        workspaceId,
        threadId: s.threadId,
        repositoryId: s.repositoryId,
        runnerId: s.runnerId,
        persona: {
          name: s.personaName,
          model: input.model,
          systemPrompt: 'x',
          tools: [],
          approvalMode: 'ask' as const,
        },
        status: 'completed',
        branchName: 'loom/x',
        branchDisposition: input.disposition === undefined ? 'merged' : input.disposition,
        totalCostUsd: input.totalCostUsd ?? 0.1,
        ...(input.relation === undefined ? {} : { relation: input.relation, parentRunId: null }),
        completedAt: new Date(),
      })
      .returning({ id: agentRun.id })
    return asAgentRunId(row!.id)
  }

  it('groups by the model each run actually ran with, and averages only decided runs', async () => {
    const s = await scaffold(WS, 'routing-worker-1')
    await addRun(WS, s, { model: 'claude-haiku-4-5-20251001', disposition: 'merged', totalCostUsd: 0.1 })
    await addRun(WS, s, { model: 'claude-haiku-4-5-20251001', disposition: 'discarded', totalCostUsd: 0.3 })
    await addRun(WS, s, { model: 'claude-sonnet-5', disposition: 'merged', totalCostUsd: 0.6 })

    const rows = await personas.tallyModelOutcomes(WS, 'routing-worker-1')
    const haiku = rows.find((row) => row.model === 'claude-haiku-4-5-20251001')
    expect(haiku).toMatchObject({ decided: 2, merged: 1 })
    expect(haiku?.meanCostUsd).toBeCloseTo(0.2, 6)
    expect(rows.find((row) => row.model === 'claude-sonnet-5')).toMatchObject({ decided: 1, merged: 1 })
  })

  /**
   * Escalations are excluded, and this is the test that matters most. They are the same task
   * retried after a failure, so counting them feeds the table a population selected for having
   * already failed — the higher tier would show a worse merge rate *because* it only ever sees
   * the hard cases, and the table would then route away from the tier that rescues them.
   */
  it('excludes an escalation, so the higher tier is not judged only on rescues', async () => {
    const s = await scaffold(WS, 'routing-worker-2')
    await addRun(WS, s, { model: 'claude-haiku-4-5-20251001', disposition: 'merged' })
    await addRun(WS, s, { model: 'claude-sonnet-5', disposition: 'discarded', relation: 'escalate' })

    const rows = await personas.tallyModelOutcomes(WS, 'routing-worker-2')
    expect(rows.map((row) => row.model)).toEqual(['claude-haiku-4-5-20251001'])
  })

  /** And a screening run, for the reason it is excluded from an arm: it is not live traffic. */
  it('excludes a screening run', async () => {
    const s = await scaffold(WS, 'routing-worker-3')
    await addRun(WS, s, { model: 'claude-haiku-4-5-20251001', disposition: 'merged' })
    await addRun(WS, s, { model: 'claude-opus-5', disposition: 'merged', relation: 'screen' })
    expect((await personas.tallyModelOutcomes(WS, 'routing-worker-3')).map((r) => r.model)).toEqual([
      'claude-haiku-4-5-20251001',
    ])
  })

  it('says nothing about a persona nothing has run as', async () => {
    expect(await personas.tallyModelOutcomes(WS, 'never-existed')).toEqual([])
  })
})

/**
 * The campaign's storage.
 *
 * Three claims only this layer can make: one running campaign per persona is an index rather
 * than a hope, spend is summed from the campaign's own rows so a deleted run cannot make it
 * look cheaper, and a campaign closes once — so two sweeps cannot write two endings, and a
 * halt cannot later be reported as a finish.
 */
describe('campaigns', () => {
  const campaigns = campaignRepository(db)
  const screens = screenRepository(db)
  let seq = 0

  const scaffold = async (workspaceId: WorkspaceId) => {
    seq += 1
    const [ch] = await db
      .insert(channel)
      .values({ workspaceId, name: `campaign-${seq}`, isPrivate: false })
      .returning({ id: channel.id })
    const [th] = await db
      .insert(thread)
      .values({ workspaceId, channelId: ch!.id, isRoot: true })
      .returning({ id: thread.id })
    const [rn] = await db
      .insert(runner)
      .values({
        workspaceId,
        name: `runner-campaign-${seq}`,
        pairingTokenHash: `hash-campaign-${seq}`,
      })
      .returning({ id: runner.id })
    const [repo] = await db
      .insert(repository)
      .values({
        workspaceId,
        runnerId: rn!.id,
        displayName: 'repo',
        absolutePath: `/tmp/campaign-${seq}`,
        defaultBranch: 'main',
      })
      .returning({ id: repository.id })
    const [persona] = await db
      .insert(agentPersona)
      .values({
        workspaceId,
        name: `campaigned-${seq}`,
        description: 'd',
        markdownSource: 'live',
        model: 'claude-haiku-4-5',
      })
      .returning({ id: agentPersona.id })
    const [sourceRun] = await db
      .insert(agentRun)
      .values({
        workspaceId,
        threadId: th!.id,
        repositoryId: repo!.id,
        runnerId: rn!.id,
        persona: {
          name: `campaigned-${seq}`,
          model: 'claude-haiku-4-5',
          systemPrompt: 'x',
          tools: [],
          approvalMode: 'ask' as const,
        },
        status: 'completed',
        branchDisposition: 'merged',
        completedAt: new Date(),
      })
      .returning({ id: agentRun.id })

    const set = await screens.openReplaySet({
      workspaceId,
      personaId: asAgentPersonaId(persona!.id),
      draft: {
        items: [0, 1].map((index) => ({
          sourceRunId: asAgentRunId(sourceRun!.id),
          repositoryId: asRepositoryId(repo!.id),
          commitSha: `commit${index}`,
          task: `Task ${index}.`,
          observedOutcome: 'merged' as const,
        })),
        excluded: [],
        eligible: 2,
        considered: 2,
      },
      detail: 'two items',
    })
    return {
      threadId: th!.id,
      personaId: asAgentPersonaId(persona!.id),
      replaySetId: set.set.id,
      itemIds: set.items.map((item) => item.id),
    }
  }

  const open = async (s: Awaited<ReturnType<typeof scaffold>>, label: string) =>
    campaigns.open({
      workspaceId: WS,
      personaId: s.personaId,
      replaySetId: s.replaySetId,
      label,
      capUsd: 5,
      openedByUserId: 'user_1',
      arms: [
        {
          revisionId: null,
          markdownSource: 'the document in use',
          label: 'the document in use',
          model: null,
        },
        {
          revisionId: null,
          markdownSource: 'an older document',
          label: 'vintage of 2026-01-04',
          model: 'claude-opus-5',
        },
      ],
      itemIds: s.itemIds,
    })

  it('opens a campaign with one pending run per arm and item', async () => {
    const s = await scaffold(WS)
    const opened = await open(s, 'growth, august')
    expect(opened.arms).toHaveLength(2)
    const arms = await campaigns.armsForCampaign(WS, opened.campaign.id)
    expect(arms.map((entry) => entry.runs.length)).toEqual([2, 2])
    expect(arms.every((entry) => entry.runs.every((run) => run.outcome === 'pending'))).toBe(true)
    // The arm's own document is snapshotted, so a deleted revision cannot orphan a score.
    expect(arms[1]?.arm.markdownSource).toBe('an older document')
    expect(arms[1]?.arm.model).toBe('claude-opus-5')
    expect(opened.campaign.openedByUserId).toBe('user_1')
  })

  it('refuses a second running campaign for one persona', async () => {
    const s = await scaffold(WS)
    await open(s, 'first')
    await expect(open(s, 'second')).rejects.toThrow()
  })

  it('sums spend from its own rows, and closes exactly once', async () => {
    const s = await scaffold(WS)
    const opened = await open(s, 'spending')
    const [arm] = await campaigns.armsForCampaign(WS, opened.campaign.id)
    const [first, second] = arm!.runs

    expect(await campaigns.claimCampaignRun(WS, first!.id)).toBe(true)
    // A second claim on the same row loses, which is what stops two sweeps starting two runs.
    expect(await campaigns.claimCampaignRun(WS, first!.id)).toBe(false)

    await campaigns.recordCampaignRunOutcome(WS, first!.id, {
      outcome: 'passed',
      reason: null,
      model: 'claude-haiku-4-5-20251001',
      costUsd: 0.4,
    })
    await campaigns.recordCampaignRunOutcome(WS, second!.id, {
      outcome: 'failed',
      reason: null,
      model: 'claude-haiku-4-5-20251001',
      costUsd: 0.6,
    })
    // A recorded row is not rewritten: the gate has already been shown that outcome.
    await campaigns.recordCampaignRunOutcome(WS, second!.id, {
      outcome: 'passed',
      reason: 'later',
      model: 'claude-opus-5',
      costUsd: 9,
    })
    expect(await campaigns.spentOnCampaign(WS, opened.campaign.id)).toBeCloseTo(1.0)

    const halted = await campaigns.close(WS, opened.campaign.id, {
      status: 'halted',
      reason: 'the cap is reached',
    })
    expect(halted?.status).toBe('halted')
    // And a later sweep cannot turn a halt into a finish.
    expect(
      await campaigns.close(WS, opened.campaign.id, { status: 'finished', reason: null }),
    ).toBeNull()
    expect((await campaigns.findById(WS, opened.campaign.id))?.status).toBe('halted')
    // A closed campaign leaves the running slot free for the next one.
    expect((await campaigns.listRunning()).map((row) => row.campaignId)).not.toContain(
      opened.campaign.id,
    )
  })
})

/**
 * The supervision ledger's two reads.
 *
 * Both are counts over windows, and both are the kind of query that returns a plausible
 * number when it is wrong: the audit stream includes acts by the platform itself, and the
 * denominator must not include work nobody was ever going to rule on.
 */
describe('the supervision ledger', () => {
  const audits = auditAdapter(db)
  const runsRepo = agentRunRepository(db)
  let seq = 0

  const scaffold = async (workspaceId: WorkspaceId) => {
    seq += 1
    const [ch] = await db
      .insert(channel)
      .values({ workspaceId, name: `supervision-${seq}`, isPrivate: false })
      .returning({ id: channel.id })
    const [th] = await db
      .insert(thread)
      .values({ workspaceId, channelId: ch!.id, isRoot: true })
      .returning({ id: thread.id })
    const [rn] = await db
      .insert(runner)
      .values({
        workspaceId,
        name: `runner-supervision-${seq}`,
        pairingTokenHash: `hash-supervision-${seq}`,
      })
      .returning({ id: runner.id })
    const [repo] = await db
      .insert(repository)
      .values({
        workspaceId,
        runnerId: rn!.id,
        displayName: 'repo',
        absolutePath: `/tmp/supervision-${seq}`,
        defaultBranch: 'main',
      })
      .returning({ id: repository.id })
    return { threadId: th!.id, runnerId: rn!.id, repositoryId: repo!.id }
  }

  it('reads back every audited act in the window, whoever acted', async () => {
    const since = new Date(Date.now() - 60_000)
    await audits.record({
      workspaceId: WS,
      actor: userActor(asUserId('user_1')),
      action: 'agent_run.discarded',
      subjectType: 'agent_run',
      subjectId: 'run_1',
      metadata: { personaName: 'swe' },
    })
    await audits.record({
      workspaceId: WS,
      actor: agentRunActor(asAgentRunId('00000000-0000-0000-0000-000000000001')),
      action: 'persona.self_revised',
      subjectType: 'agent_persona',
      subjectId: 'p_1',
    })

    const events = await audits.listSince({ workspaceId: WS, since, limit: 100 })
    expect(events.map((event) => event.action)).toEqual([
      'persona.self_revised',
      'agent_run.discarded',
    ])
    // Unclassified on purpose: which acts are supervision lives in the domain, and a query
    // that filtered would drift from the table that interprets it.
    expect(events.map((event) => event.actor.kind)).toEqual(['agent_run', 'user'])
    // The window is a real bound, not decoration.
    expect(
      await audits.listSince({ workspaceId: WS, since: new Date(Date.now() + 60_000), limit: 100 }),
    ).toEqual([])
  })

  it('counts decided runs in the window, and never a screening run', async () => {
    const s = await scaffold(WS)
    const add = async (input: {
      disposition: 'merged' | null
      relation?: string
      completedAt?: Date
    }) => {
      await db.insert(agentRun).values({
        workspaceId: WS,
        threadId: s.threadId,
        repositoryId: s.repositoryId,
        runnerId: s.runnerId,
        persona: {
          name: 'swe',
          model: 'claude-haiku-4-5',
          systemPrompt: 'x',
          tools: [],
          approvalMode: 'ask' as const,
        },
        status: 'completed',
        branchDisposition: input.disposition,
        ...(input.relation === undefined ? {} : { relation: input.relation }),
        completedAt: input.completedAt ?? new Date(),
      })
    }
    await add({ disposition: 'merged' })
    await add({ disposition: 'merged', relation: 'screen' })
    await add({ disposition: null })
    await add({ disposition: 'merged', completedAt: new Date(Date.now() - 10 * 60_000) })

    const since = new Date(Date.now() - 60_000)
    expect(await runsRepo.countDecidedRunsSince(WS, since)).toBe(1)
  })
})

/**
 * A merged branch that came back out.
 *
 * The arithmetic is `reverted-merges.test.ts`. What is only testable here is the pair of
 * things this join gets wrong silently: matching an abbreviated sha against the wrong
 * repository's commits, and inflating every other count in an arm's tally by joining a table
 * a run can have two rows in.
 */
describe('reverted merges', () => {
  const queue = mergeQueueRepository(db)
  const variants = personaVariantRepository(db)
  let seq = 0

  const scaffold = async (workspaceId: WorkspaceId) => {
    seq += 1
    const [ch] = await db
      .insert(channel)
      .values({ workspaceId, name: `revert-${seq}`, isPrivate: false })
      .returning({ id: channel.id })
    const [th] = await db
      .insert(thread)
      .values({ workspaceId, channelId: ch!.id, isRoot: true })
      .returning({ id: thread.id })
    const [rn] = await db
      .insert(runner)
      .values({ workspaceId, name: `runner-revert-${seq}`, pairingTokenHash: `hash-revert-${seq}` })
      .returning({ id: runner.id })
    const repos = await db
      .insert(repository)
      .values(
        [1, 2].map((n) => ({
          workspaceId,
          runnerId: rn!.id,
          displayName: `repo-${n}`,
          absolutePath: `/tmp/revert-${seq}-${n}`,
          defaultBranch: 'main',
        })),
      )
      .returning({ id: repository.id })
    const [persona] = await db
      .insert(agentPersona)
      .values({
        workspaceId,
        name: `reverted-${seq}`,
        description: 'd',
        markdownSource: 'live',
        model: 'claude-haiku-4-5',
      })
      .returning({ id: agentPersona.id })
    return {
      threadId: th!.id,
      runnerId: rn!.id,
      repositoryId: asRepositoryId(repos[0]!.id),
      otherRepositoryId: asRepositoryId(repos[1]!.id),
      personaId: asAgentPersonaId(persona!.id),
    }
  }

  const addMergedRun = async (
    workspaceId: WorkspaceId,
    s: Awaited<ReturnType<typeof scaffold>>,
    input: { repositoryId?: string; commitSha: string; entries?: number },
  ) => {
    const [run] = await db
      .insert(agentRun)
      .values({
        workspaceId,
        threadId: s.threadId,
        repositoryId: input.repositoryId ?? s.repositoryId,
        runnerId: s.runnerId,
        persona: {
          name: 'reverted',
          model: 'claude-haiku-4-5',
          systemPrompt: 'x',
          tools: [],
          approvalMode: 'ask' as const,
        },
        status: 'completed',
        branchDisposition: 'merged',
        completedAt: new Date(),
      })
      .returning({ id: agentRun.id })
    const runId = asAgentRunId(run!.id)

    /**
     * More than one entry per run is the ordinary case this has to survive: a branch that
     * failed verification and was re-queued has two, and only the last one merged.
     */
    for (let attempt = 0; attempt < (input.entries ?? 1); attempt += 1) {
      const entry = await queue.enqueue({
        workspaceId,
        repositoryId: asRepositoryId(input.repositoryId ?? s.repositoryId),
        agentRunId: runId,
        branchName: `loom/${input.commitSha}`,
        enqueuedByUserId: null,
      })
      await queue.claim(workspaceId, entry.id)
      const last = attempt === (input.entries ?? 1) - 1
      await queue.finish(
        workspaceId,
        entry.id,
        last
          ? { status: 'merged', mergedCommitSha: input.commitSha, verified: true }
          : { status: 'failed', failureReason: 'conflict', detail: 'earlier attempt' },
      )
    }
    return runId
  }

  it('stamps the merge an abbreviated sha named, and nothing in another repository', async () => {
    const s = await scaffold(WS)
    const mine = 'abc1234def5678901234567890123456789012ab'
    const theirs = 'abc1234def5678901234567890123456789012ab'
    await addMergedRun(WS, s, { commitSha: mine })
    await addMergedRun(WS, s, { commitSha: theirs, repositoryId: s.otherRepositoryId })

    const stamped = await queue.markReverted(WS, s.repositoryId, {
      revertedShas: ['abc1234'],
      revertedBySha: 'ffff000',
    })
    expect(stamped).toHaveLength(1)
    expect(stamped[0]?.repositoryId).toBe(s.repositoryId)
    expect(stamped[0]?.revertedBySha).toBe('ffff000')

    // And the second revert of the same branch does not re-date the disagreement.
    const again = await queue.markReverted(WS, s.repositoryId, {
      revertedShas: ['abc1234'],
      revertedBySha: 'eeee111',
    })
    expect(again).toEqual([])
  })

  it('counts a reverted merge once per run, without inflating the arm it is on', async () => {
    const s = await scaffold(WS)
    const opened = await variants.openSet({
      workspaceId: WS,
      personaId: s.personaId,
      candidates: [{ markdownSource: 'a', rationale: 'r' }],
    })
    const candidate = opened.variants[0]!
    // Two queue entries on one run: the join this count avoids would double `decided`.
    const runId = await addMergedRun(WS, s, { commitSha: '1111111aaaa', entries: 2 })
    await variants.recordVariantUse({
      workspaceId: WS,
      setId: opened.set.id,
      variantId: candidate.id,
      agentRunId: runId,
    })
    await queue.markReverted(WS, s.repositoryId, {
      revertedShas: ['1111111'],
      revertedBySha: '9999999',
    })

    const tallies = await variants.tallyVariantOutcomes(WS, opened.set.id)
    const arm = tallies.find((tally) => tally.variantId === candidate.id)
    expect(arm).toMatchObject({ decided: 1, merged: 1, reverted: 1 })
  })
})
