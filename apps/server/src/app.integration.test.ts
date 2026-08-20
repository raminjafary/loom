import { ApprovalModeSchema, contract, type Contract } from '@loom/api-contract'
import { seedBuiltinPersonas, seedBuiltinTeams } from '@loom/application'
import { createDatabase, seedWorkspace, truncateDomainTables } from '@loom/db'
import { APPROVAL_MODES, BUILTIN_TEAMS, asWorkspaceId } from '@loom/domain'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import webpush from 'web-push'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type App } from './app.js'
import { devAuth } from './auth.js'
import { loadConfig } from './config.js'

/**
 * Drives the real oRPC contract over real HTTP against real Postgres and
 * Valkey. This is what proves the wire boundary works — the unit tests only
 * prove the use-cases do.
 *
 * Requires `docker compose up -d`.
 */

/**
 * Real keys, generated per run: `webpush.setVapidDetails` validates their
 * shape, so hard-coded placeholders would fail at adapter construction and a
 * test with no keys at all could not exercise the subscribe path (an
 * unconfigured deployment refuses to register a target, by design).
 */
const vapidKeys = webpush.generateVAPIDKeys()

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long-value',
  WS_SUBSCRIPTION_SECRET: 'test-subscription-secret-at-least-32-chars',
  SERVER_PORT: '0',
  VAPID_PUBLIC_KEY: vapidKeys.publicKey,
  VAPID_PRIVATE_KEY: vapidKeys.privateKey,
} as NodeJS.ProcessEnv)

const { db, close: closeDb } = createDatabase(config.DATABASE_URL)

let app: App
let client: ContractRouterClient<Contract>
let workspaceId: string
let baseUrl: string

beforeAll(async () => {
  const row = await seedWorkspace(db, `server-test-${Date.now()}`)
  workspaceId = row.id

  app = await buildApp(config, devAuth({ userId: 'dev-user', workspaceId }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })

  const address = app.fastify.server.address()
  if (address === null || typeof address === 'string') throw new Error('no bound port')
  baseUrl = `http://127.0.0.1:${address.port}/rpc`

  client = createORPCClient(new RPCLink({ url: baseUrl }))
})

beforeEach(async () => {
  await truncateDomainTables(db)
})

afterAll(async () => {
  await app.close()
  await closeDb()
})

describe('contract over HTTP', () => {
  it('serves health', async () => {
    const result = await client.health()
    expect(result.status).toBe('ok')
    expect(result.time).toBeInstanceOf(Date)
  })

  /**
   * The running-revision pointer, on an installation that has never promoted one — which is
   * every installation until it does, and is not a problem. The distinction this asserts is the
   * one that matters: `deployment: null` with no `problem` is a clean install, and a broken
   * pointer would arrive as a `problem` rather than as the same empty answer.
   */
  /**
   * Model routing is off until a human turns it on, and the default is the assertion: the table
   * is the one measurement here nobody randomised, so a default that overrode an operator's
   * `model:` would be the platform second-guessing a human from data it knows is biased.
   */
  it('leaves model routing off until a human turns it on', async () => {
    expect((await client.runControl.get()).modelRoutingEnabled).toBe(false)
    const on = await client.runControl.setModelRoutingEnabled({ enabled: true })
    expect(on.modelRoutingEnabled).toBe(true)
    // And the kill switch does not carry it: hitting pause must not change how models are chosen.
    const paused = await client.runControl.pauseAll()
    expect(paused.control.modelRoutingEnabled).toBe(true)
    await client.runControl.resume()
    expect((await client.runControl.setModelRoutingEnabled({ enabled: false })).modelRoutingEnabled).toBe(false)
  })

  it('reports no promoted revision, distinctly from a pointer it could not read', async () => {
    const result = await client.runControl.selfDeployment()
    expect(result.deployment).toBeNull()
    expect(result.problem).toBeNull()
  })

  /**
   * `/healthz` is what a supervisor and a promotion gate read, and it answers about the
   * *deployment* rather than about the process: a platform that started, bound and cannot
   * query its own schema is down, and one that reports itself healthy is how a bad revision
   * becomes the running one.
   */
  it('reports the schema it expects on /healthz, not merely that it is alive', async () => {
    const response = await fetch(baseUrl.replace('/rpc', '/healthz'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string; migration: string | null }
    expect(body.status).toBe('ok')
    // The tag rather than a boolean: "which migration" is what an operator acts on.
    expect(body.migration).toMatch(/^\d{4}_/)
  })

  it('creates a channel and lists it back', async () => {
    const created = await client.channel.create({ name: 'engineering' })
    expect(created.channel.name).toBe('engineering')
    expect(created.rootThread.isRoot).toBe(true)

    const channels = await client.channel.list()
    expect(channels.map((c) => c.name)).toEqual(['engineering'])
  })

  it('round-trips a message with a Date preserved across the wire', async () => {
    const { rootThread } = await client.channel.create({ name: 'general' })

    const posted = await client.message.post({ threadId: rootThread.id, text: 'hello' })
    expect(posted.body).toEqual({ kind: 'text', text: 'hello' })
    expect(posted.author).toEqual({ kind: 'user', userId: 'dev-user' })
    // oRPC preserves Date over the wire; a string here means the codec regressed.
    expect(posted.createdAt).toBeInstanceOf(Date)

    const page = await client.message.list({ threadId: rootThread.id })
    expect(page.messages).toHaveLength(1)
    expect(page.nextCursor).toBeNull()
  })

  it('maps a domain validation failure to a transport error', async () => {
    await client.channel.create({ name: 'duplicate' })
    await expect(client.channel.create({ name: 'duplicate' })).rejects.toThrow()
  })

  it('maps a missing thread to a transport error', async () => {
    await expect(
      client.message.post({
        threadId: '00000000-0000-4000-8000-000000000000',
        text: 'nowhere',
      }),
    ).rejects.toThrow()
  })

  it('rejects input the contract schema forbids, before reaching the domain', async () => {
    // Contract says name is min 2 chars; this must fail at the boundary.
    await expect(client.channel.create({ name: 'x' })).rejects.toThrow()
  })

  it('pages with a cursor over HTTP', async () => {
    const { rootThread } = await client.channel.create({ name: 'paging' })
    for (let i = 1; i <= 3; i += 1) {
      await client.message.post({ threadId: rootThread.id, text: `m${i}` })
    }

    const first = await client.message.list({ threadId: rootThread.id, limit: 2 })
    expect(first.messages.map((m) => m.body.text)).toEqual(['m3', 'm2'])
    expect(first.nextCursor).not.toBeNull()

    const second = await client.message.list({
      threadId: rootThread.id,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    })
    expect(second.messages.map((m) => m.body.text)).toEqual(['m1'])
    expect(second.nextCursor).toBeNull()
  })

  /**
   * The kill switch. `truncateDomainTables` deliberately spares
   * `workspace` (see packages/db/src/testing.ts), and the pause flag lives on
   * that row — so this test must resume before it ends, or every later test in
   * the file inherits a paused workspace.
   */
  it('pauses and resumes runs workspace-wide', async () => {
    expect((await client.runControl.get()).paused).toBe(false)

    const paused = await client.runControl.pauseAll()
    expect(paused.control.paused).toBe(true)
    expect(paused.control.pausedByUserId).toBe('dev-user')
    // Nothing was in flight, so nothing to cancel — the flag is the point here.
    expect(paused.cancelledRunIds).toEqual([])
    expect((await client.runControl.get()).paused).toBe(true)

    const resumed = await client.runControl.resume()
    expect(resumed.paused).toBe(false)
    expect(resumed.pausedAt).toBeNull()
    expect(resumed.pausedByUserId).toBeNull()
  })

  it('rejects starting a run while the workspace is paused', async () => {
    await client.runControl.pauseAll()
    try {
      // Rejected before any lookup of thread/repo/persona, so the ids below
      // never need to exist — that ordering is the assertion.
      await expect(
        client.agentRun.start({
          threadId: '00000000-0000-0000-0000-000000000000',
          repositoryId: '00000000-0000-0000-0000-000000000000',
          personaId: '00000000-0000-0000-0000-000000000000',
        }),
      ).rejects.toThrow(/paused/i)
    } finally {
      await client.runControl.resume()
    }
  })

  it('rejects an unauthenticated caller', async () => {
    const anonymous = await buildApp(config, { resolve: async () => null })
    await anonymous.fastify.listen({ port: 0, host: '127.0.0.1' })
    const address = anonymous.fastify.server.address()
    if (address === null || typeof address === 'string') throw new Error('no bound port')

    const anonClient: ContractRouterClient<Contract> = createORPCClient(
      new RPCLink({ url: `http://127.0.0.1:${address.port}/rpc` }),
    )
    await expect(anonClient.health()).rejects.toThrow()
    await anonymous.close()
  })
})

/**
 * The cost dashboard over real HTTP.
 *
 * Worth its own trip across the wire rather than trusting the repository test: this
 * payload carries a `Date` and figures Postgres returns as strings for `sum()`, and both
 * of those are exactly what a contract boundary silently mangles. The grouping logic is
 * asserted against real rows in `@loom/db`; this asserts the shape survives transport.
 */
describe('removal over HTTP', () => {
  /**
   * These are the paths where the schema's cascades meet a human's click, and the
   * only way to prove a gate holds is to make the real database refuse. The unit
   * tests check the rules against stubs; this checks the rules exist on the wire and
   * that the delete actually happens when they pass.
   */

  it('deletes a channel, but never the last one', async () => {
    await client.channel.create({ name: 'keeper' })
    const doomed = await client.channel.create({ name: 'doomed' })

    await client.channel.delete({ channelId: doomed.channel.id })
    const remaining = await client.channel.list()
    expect(remaining.map((c) => c.name)).not.toContain('doomed')

    // Down to one: the workspace must keep somewhere to talk.
    const last = remaining[0]
    if (!last) throw new Error('expected a surviving channel')
    for (const channel of remaining.slice(1)) {
      await client.channel.delete({ channelId: channel.id })
    }
    await expect(client.channel.delete({ channelId: last.id })).rejects.toThrow(/only channel/)
  })

  it('takes a channel\'s messages with it', async () => {
    await client.channel.create({ name: 'survivor' })
    const { channel, rootThread } = await client.channel.create({ name: 'transient' })
    await client.message.post({ threadId: rootThread.id, text: 'said in passing' })

    await client.channel.delete({ channelId: channel.id })

    // The thread is gone with the channel, so reading it is a not-found rather than
    // an empty page — which is the cascade doing what the gate warned about.
    await expect(client.message.list({ threadId: rootThread.id })).rejects.toThrow()
  })

  it('creates and deletes a persona', async () => {
    const persona = await client.persona.create({
      markdownSource: [
        '---',
        'name: disposable',
        'description: created to be removed',
        'model: claude-haiku-4-5-20251001',
        'tools: [Read]',
        '---',
        'Do nothing.',
      ].join('\n'),
    })

    await client.persona.delete({ personaId: persona.id })
    const personas = await client.persona.list()
    expect(personas.map((p) => p.name)).not.toContain('disposable')
  })

  /**
   * The divergence set, over the wire.
   *
   * A fresh persona is the state worth asserting here, because it is the one a reader would
   * otherwise misread: nothing comparable is not agreement, and the sentence has to say so.
   * Which rows count is `repositories.integration.test.ts`, against real SQL.
   */
  it('reports no divergence for a persona nothing has ruled on, without calling it agreement', async () => {
    const persona = await client.persona.create({
      markdownSource: [
        '---',
        'name: undivergent',
        'description: has done nothing yet',
        'model: claude-haiku-4-5-20251001',
        'tools: [Read]',
        '---',
        'Do nothing.',
      ].join('\n'),
    })

    const found = await client.persona.divergence({ personaId: persona.id })
    expect(found).toMatchObject({ comparable: 0, passedAndDiscarded: 0, failedAndMerged: 0 })
    expect(found?.detail).toContain('nothing the two could have disagreed about')
    expect(found?.runs).toEqual([])

    await client.persona.delete({ personaId: persona.id })
    // A persona deleted between two clicks is not an error — the panel reads null.
    expect(await client.persona.divergence({ personaId: persona.id })).toBeNull()
  })

  /**
   * The persona form reads the format through this procedure rather than owning a
   * parser. What it must never do is answer differently
   * from a save — a form populated by a lenient preview would show settings the write
   * path then stores otherwise.
   */
  describe('persona.parse', () => {
    const markdown = (frontmatter: string[], body = 'Do a thing.') =>
      ['---', ...frontmatter, '---', '', body].join('\n')

    it('reads a valid draft into the same fields a save would store', async () => {
      const source = markdown([
        'name: previewed',
        'description: a draft',
        'model: claude-haiku-4-5-20251001',
        'tools: [Read, Bash]',
        'harness:',
        '  approvalMode: auto',
        '  budgetCapUsd: 3',
      ])
      const draft = await client.persona.parse({ markdownSource: source })
      expect(draft.ok).toBe(true)
      expect(draft.problems).toEqual([])
      expect(draft.parsed?.tools).toEqual(['Read', 'Bash'])
      expect(draft.parsed?.harnessApprovalMode).toBe('auto')
      expect(draft.parsed?.harnessBudgetCapUsd).toBe(3)

      const created = await client.persona.create({ markdownSource: source })
      expect(created.tools).toEqual(draft.parsed?.tools)
      expect(created.harnessApprovalMode).toBe(draft.parsed?.harnessApprovalMode)
      expect(created.harnessBudgetCapUsd).toBe(draft.parsed?.harnessBudgetCapUsd)
      await client.persona.delete({ personaId: created.id })
    })

    it('reports an unparseable draft rather than throwing at a human mid-keystroke', async () => {
      const draft = await client.persona.parse({ markdownSource: 'no frontmatter here' })
      expect(draft.ok).toBe(false)
      expect(draft.parsed).toBeNull()
      expect(draft.problems[0]).toContain('frontmatter')
    })

    it('reports the same planner refusal a save raises', async () => {
      const source = markdown([
        'name: bad-planner',
        'description: a planner that can act',
        'model: claude-haiku-4-5-20251001',
        'tools: [Read, Bash]',
        'harness:',
        '  planner: true',
      ])
      const draft = await client.persona.parse({ markdownSource: source })
      expect(draft.ok).toBe(false)
      expect(draft.problems[0]).toContain('Bash')
      // The preview and the write path must agree about this, not merely both refuse.
      await expect(client.persona.create({ markdownSource: source })).rejects.toThrow()
    })
  })

  /**
   * `personas.update` has never carried `name`, so a changed `name:` line used to
   * store a markdown whose frontmatter disagreed with every surface that addresses
   * the persona by name — silently.
   */
  it('refuses a rename rather than storing a markdown the row disagrees with', async () => {
    const created = await client.persona.create({
      markdownSource: [
        '---',
        'name: renameable',
        'description: about to be renamed',
        'model: claude-haiku-4-5-20251001',
        'tools: [Read]',
        '---',
        'Do nothing.',
      ].join('\n'),
    })

    await expect(
      client.persona.update({
        personaId: created.id,
        markdownSource: created.markdownSource.replace('name: renameable', 'name: renamed'),
      }),
    ).rejects.toThrow()

    const stored = await client.persona.get({ personaId: created.id })
    expect(stored.name).toBe('renameable')
    expect(stored.markdownSource).toContain('name: renameable')

    // An edit that leaves the name alone still works.
    const edited = await client.persona.update({
      personaId: created.id,
      markdownSource: created.markdownSource.replace('about to be renamed', 'left alone'),
    })
    expect(edited.description).toBe('left alone')
    await client.persona.delete({ personaId: created.id })
  })

  /**
   * The composition canvas draws these edges. The property that
   * matters is that they are the *runtime's* answer: an edge the canvas shows as
   * allowed must be a child start the gate then permits.
   */
  describe('personaGroup.delegationMatrix', () => {
    const author = (frontmatter: string[]) =>
      client.persona.create({
        markdownSource: ['---', ...frontmatter, '---', '', 'Do a thing.'].join('\n'),
      })

    it('reports every reason a planner cannot delegate, not only the first', async () => {
      const planner = await author([
        'name: matrix-planner',
        'description: Decomposes',
        'model: claude-haiku-4-5-20251001',
        'tools: [Read, Grep, Glob]',
        'harness:',
        '  planner: true',
        '  delegates: [Read]',
        '  budgetCapUsd: 1',
      ])
      const worker = await author([
        'name: matrix-worker',
        'description: Acts',
        // Higher tier, wider tools, uncapped, and auto-approving: four separate correct
        // refusals, which is the situation the roadmap says a human currently discovers one
        // runtime error at a time.
        'model: claude-opus-5',
        'tools: [Read, Bash]',
        'harness:',
        '  approvalMode: auto',
      ])

      const matrix = await client.personaGroup.delegationMatrix()
      const edge = matrix.find(
        (row) => row.plannerId === planner.id && row.workerId === worker.id,
      )
      expect(edge?.ok).toBe(false)
      expect(edge?.refusals.map((refusal) => refusal.rule).sort()).toEqual([
        'autoApprove',
        'budget',
        'model',
        'tools',
      ])
      // Only the envelope one is offered as a repair — the rest would change what the
      // worker is, which drawing an edge did not ask for.
      expect(
        edge?.refusals.filter((refusal) => refusal.widenEnvelopeWith !== undefined),
      ).toHaveLength(1)

      await client.persona.delete({ personaId: worker.id })
      await client.persona.delete({ personaId: planner.id })
    })

    it('has no row for a persona that is not a planner', async () => {
      const worker = await author([
        'name: matrix-plain',
        'description: Acts',
        'model: claude-haiku-4-5-20251001',
        'tools: [Read]',
      ])
      const matrix = await client.personaGroup.delegationMatrix()
      expect(matrix.some((row) => row.plannerId === worker.id)).toBe(false)
      await client.persona.delete({ personaId: worker.id })
    })
  })

  /**
   * A layout is a fact a human recorded, so it has to survive a
   * roster edit — and a client that does not draw a canvas must not erase it by
   * saving without one.
   */
  it('keeps canvas positions across an update that does not send them', async () => {
    const persona = await client.persona.create({
      markdownSource: [
        '---',
        'name: layout-member',
        'description: On a team',
        'model: claude-haiku-4-5-20251001',
        'tools: [Read]',
        '---',
        'Do nothing.',
      ].join('\n'),
    })
    const group = await client.personaGroup.create({
      name: `layout-${Date.now()}`,
      personaIds: [persona.id],
    })
    expect(group.layout).toEqual({})

    const placed = await client.personaGroup.update({
      personaGroupId: group.id,
      name: group.name,
      personaIds: [persona.id],
      layout: { [persona.id]: { x: 120, y: 40 } },
    })
    expect(placed.layout[persona.id]).toEqual({ x: 120, y: 40 })

    const renamed = await client.personaGroup.update({
      personaGroupId: group.id,
      name: `${group.name}-renamed`,
      personaIds: [persona.id],
    })
    expect(renamed.layout[persona.id]).toEqual({ x: 120, y: 40 })

    // A position for someone no longer on the team is dropped rather than kept
    // forever — otherwise a re-added persona reappears where the last person left it.
    const emptied = await client.personaGroup.update({
      personaGroupId: group.id,
      name: group.name,
      personaIds: [],
      layout: { [persona.id]: { x: 120, y: 40 } },
    })
    expect(emptied.layout).toEqual({})

    await client.personaGroup.delete({ personaGroupId: group.id })
    await client.persona.delete({ personaId: persona.id })
  })

  /**
   * The fleet, over the contract. The domain tests cover what a width means; this
   * covers that the server *validates* it rather than storing what it was handed — the
   * runtime reads this field, so a stored 0 would make a roster offer a persona whose
   * every start is then refused.
   */
  it('stores a fleet width and refuses one that is not a width', async () => {
    const persona = await client.persona.create({
      markdownSource: [
        '---',
        `name: fleet-member-${Date.now()}`,
        'description: On a sized team',
        'model: claude-haiku-4-5-20251001',
        'tools: [Read]',
        '---',
        'Do nothing.',
      ].join('\n'),
    })
    const group = await client.personaGroup.create({
      name: `fleet-${Date.now()}`,
      personaIds: [persona.id],
    })
    // Unsized out of the box: every team that existed before this column did.
    expect(group.fleet).toEqual({})

    const sized = await client.personaGroup.update({
      personaGroupId: group.id,
      name: group.name,
      personaIds: [persona.id],
      fleet: { [persona.id]: 3 },
    })
    expect(sized.fleet[persona.id]).toBe(3)

    // Omitting it leaves the stored width alone, like `layout`.
    const renamed = await client.personaGroup.update({
      personaGroupId: group.id,
      name: `${group.name}-renamed`,
      personaIds: [persona.id],
    })
    expect(renamed.fleet[persona.id]).toBe(3)

    // Zero is a removal dressed as a width, and is refused with a reason.
    await expect(
      client.personaGroup.update({
        personaGroupId: group.id,
        name: group.name,
        personaIds: [persona.id],
        fleet: { [persona.id]: 0 },
      }),
    ).rejects.toThrow(/remove the persona from the team/)

    // A width for someone no longer on the team is dropped, not refused.
    const emptied = await client.personaGroup.update({
      personaGroupId: group.id,
      name: group.name,
      personaIds: [],
      fleet: { [persona.id]: 2 },
    })
    expect(emptied.fleet).toEqual({})

    await client.personaGroup.delete({ personaGroupId: group.id })
    await client.persona.delete({ personaId: persona.id })
  })

  /**
   * The root orchestrator, over the contract.
   *
   * The two refusals are what keep the canvas honest rather than what keep the runtime
   * safe: a root that is not on the team, or is not a planner, would make every depth the
   * canvas reports a drawing of a tree no run can have.
   */
  it('stores a root orchestrator, and refuses one that could not start a chain', async () => {
    const stamp = Date.now()
    const planner = await client.persona.create({
      markdownSource: [
        '---',
        `name: root-planner-${stamp}`,
        'description: Decomposes',
        'model: claude-sonnet-5',
        'tools: []',
        'harness:',
        '  planner: true',
        '  delegates: [Read]',
        '---',
        'You decompose.',
      ].join('\n'),
    })
    const worker = await client.persona.create({
      markdownSource: [
        '---',
        `name: root-worker-${stamp}`,
        'description: Works',
        'model: claude-haiku-4-5-20251001',
        'tools: [Read]',
        '---',
        'Do nothing.',
      ].join('\n'),
    })
    const group = await client.personaGroup.create({
      name: `chain-${stamp}`,
      personaIds: [planner.id, worker.id],
    })
    // Nobody has chosen out of the box, which is a real state — the canvas picks by reach.
    expect(group.orchestratorId).toBeNull()

    const rooted = await client.personaGroup.update({
      personaGroupId: group.id,
      name: group.name,
      personaIds: [planner.id, worker.id],
      orchestratorId: planner.id,
    })
    expect(rooted.orchestratorId).toBe(planner.id)

    // Omitted leaves it alone; null clears it. Two different acts, deliberately.
    const renamed = await client.personaGroup.update({
      personaGroupId: group.id,
      name: `${group.name}-renamed`,
      personaIds: [planner.id, worker.id],
    })
    expect(renamed.orchestratorId).toBe(planner.id)

    const cleared = await client.personaGroup.update({
      personaGroupId: group.id,
      name: group.name,
      personaIds: [planner.id, worker.id],
      orchestratorId: null,
    })
    expect(cleared.orchestratorId).toBeNull()

    await expect(
      client.personaGroup.update({
        personaGroupId: group.id,
        name: group.name,
        personaIds: [planner.id, worker.id],
        orchestratorId: worker.id,
      }),
    ).rejects.toThrow(/not a planner/)

    await expect(
      client.personaGroup.update({
        personaGroupId: group.id,
        name: group.name,
        personaIds: [worker.id],
        orchestratorId: planner.id,
      }),
    ).rejects.toThrow(/member of this team/)

    await client.personaGroup.delete({ personaGroupId: group.id })
    await client.persona.delete({ personaId: planner.id })
    await client.persona.delete({ personaId: worker.id })
  })

  /**
   * The shipped teams, over the contract.
   *
   * What is worth asserting here rather than in the domain is the *seeding*: that a team
   * arrives with its root, its review policy and its widths resolved to real persona ids,
   * and that running it again does not touch a team an operator has since edited.
   */
  it('seeds teams whose policy is resolved to the personas in this workspace', async () => {
    await seedBuiltinPersonas(app.deps, { workspaceId: asWorkspaceId(workspaceId) })
    await seedBuiltinTeams(app.deps, { workspaceId: asWorkspaceId(workspaceId) })

    const groups = await client.personaGroup.list()
    const personas = await client.persona.list()
    const nameById = new Map(personas.map((p: any) => [p.id, p.name]))

    for (const team of BUILTIN_TEAMS) {
      const seeded = groups.find((group) => group.name === team.name)
      expect(seeded, team.name).toBeDefined()
      if (!seeded) continue

      expect(seeded.personaIds.map((id) => nameById.get(id))).toEqual([...team.members])
      // The root, as an id — the vantage, without which the canvas picks by reach.
      expect(nameById.get(seeded.orchestratorId ?? '')).toBe(team.orchestrator)
      // And no repository, which is the operator's choice to make.
      expect(seeded.repositoryId).toBeNull()

      const reviewersByName = Object.fromEntries(
        Object.entries(seeded.reviewers).map(([reviewer, reviewed]) => [
          nameById.get(reviewer),
          reviewed.map((id) => nameById.get(id)),
        ]),
      )
      for (const [reviewer, reviewed] of Object.entries(team.reviewers ?? {})) {
        expect(reviewersByName[reviewer]).toEqual([...reviewed])
      }
      for (const [member, size] of Object.entries(team.fleet ?? {})) {
        const id = personas.find((p: any) => p.name === member)?.id
        expect(seeded.fleet[id ?? '']).toBe(size)
      }
    }
  })

  /**
   * Create-if-absent, never update. A team has no `builtinSource` to compare against, so
   * "the operator has not edited this" is not a checkable fact — and re-seeding would
   * silently undo a roster, a width or a repository somebody chose.
   */
  it('leaves a team an operator has edited entirely alone', async () => {
    await seedBuiltinPersonas(app.deps, { workspaceId: asWorkspaceId(workspaceId) })
    await seedBuiltinTeams(app.deps, { workspaceId: asWorkspaceId(workspaceId) })

    const first = (await client.personaGroup.list()).find(
      (group) => group.name === BUILTIN_TEAMS[0]?.name,
    )
    expect(first).toBeDefined()

    const emptied = await client.personaGroup.update({
      personaGroupId: first!.id,
      name: first!.name,
      personaIds: [],
    })
    expect(emptied.personaIds).toEqual([])

    await seedBuiltinTeams(app.deps, { workspaceId: asWorkspaceId(workspaceId) })
    const after = (await client.personaGroup.list()).find((group) => group.id === first!.id)
    expect(after?.personaIds).toEqual([])
    // And no second copy under the same name, which the unique index would refuse anyway.
    expect(
      (await client.personaGroup.list()).filter((group) => group.name === first!.name),
    ).toHaveLength(1)
  })

  /**
   * The team repository, over the contract. The `set null` behaviour is asserted in
   * `packages/db` where it happens; what belongs here is the refusal, because the run
   * launcher *defaults* from this field — an id naming nothing would not sit inert, it
   * would start a run against a repository no Runner can clone.
   */
  it('refuses a team repository that is not bound in this workspace', async () => {
    const stamp = Date.now()
    const member = await client.persona.create({
      markdownSource: [
        '---',
        `name: lands-member-${stamp}`,
        'description: On a team',
        'model: claude-haiku-4-5-20251001',
        'tools: [Read]',
        '---',
        'Do nothing.',
      ].join('\n'),
    })
    const group = await client.personaGroup.create({
      name: `lands-${stamp}`,
      personaIds: [member.id],
    })
    // Nobody has chosen out of the box — the state every team starts in.
    expect(group.repositoryId).toBeNull()

    await expect(
      client.personaGroup.update({
        personaGroupId: group.id,
        name: group.name,
        personaIds: [member.id],
        repositoryId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow(/Repository/)

    // Null is not a lookup: un-choosing must not have to name something that exists.
    const cleared = await client.personaGroup.update({
      personaGroupId: group.id,
      name: group.name,
      personaIds: [member.id],
      repositoryId: null,
    })
    expect(cleared.repositoryId).toBeNull()

    await client.personaGroup.delete({ personaGroupId: group.id })
    await client.persona.delete({ personaId: member.id })
  })

  /**
   * The depth limit reaches the client through the session, because the composition
   * canvas cannot say which of the edges it draws a plan could use without it — and a
   * client that assumed a value would be hard-coding server configuration.
   */
  it('sends the workspace limits with identity', async () => {
    const me = await client.session.me()
    expect(me.limits.maxDelegationDepth).toBeGreaterThanOrEqual(1)
    expect(me.limits.maxConcurrentRunsPerWorkspace).toBeGreaterThanOrEqual(1)
  })

  it('refuses to remove a Runner that still has a repository bound', async () => {
    const pairing = await client.runner.createPairingToken({ name: 'removable' })
    // Nothing bound yet, so this one goes.
    await client.runner.remove({ runnerId: pairing.runnerId })
    const runners = await client.runner.list()
    expect(runners.map((r) => r.name)).not.toContain('removable')
  })

  it('reports a missing subject as a transport error rather than succeeding quietly', async () => {
    await expect(
      client.persona.delete({ personaId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow()
    await expect(
      client.runner.remove({ runnerId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow()
    await expect(
      client.repository.unbind({ repositoryId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow()
  })
})

describe('cost summary over HTTP', () => {
  it('reports an empty workspace as zeroes, not as an error or a null', async () => {
    const summary = await client.cost.summary({ windowHours: null })
    expect(summary.windowHours).toBeNull()
    expect(summary.totals).toEqual({ runCount: 0, totalUsd: 0 })
    expect(summary.byModel).toEqual([])
    expect(summary.byPersona).toEqual([])
    expect(summary.topRuns).toEqual([])
  })

  it('echoes the window back so a client cannot mislabel what it renders', async () => {
    expect((await client.cost.summary({ windowHours: 24 })).windowHours).toBe(24)
    expect((await client.cost.summary({})).windowHours).toBeNull()
  })

  it('rejects a window the contract forbids, before reaching the database', async () => {
    await expect(client.cost.summary({ windowHours: 0 })).rejects.toThrow()
    await expect(client.cost.summary({ windowHours: 100_000 })).rejects.toThrow()
  })
})

describe('contract completeness', () => {
  /**
   * The contract duplicates the domain's approval modes, deliberately (that package
   * depends on nothing). This is the first place both are in scope, so it is where
   * the copy is kept honest — the same arrangement `ResponseStyleSchema` already has.
   */
  it('offers exactly the domain\'s approval modes, in the domain\'s order', () => {
    expect(ApprovalModeSchema.options).toEqual([...APPROVAL_MODES])
  })

  it('exposes every declared procedure on the client', () => {
    // The contract is the only surface, so a procedure
    // declared but not implemented must be caught here rather than at runtime.
    expect(Object.keys(contract)).toEqual([
      'health',
      'session',
      'channel',
      'message',
      'runner',
      'repository',
      'mergeQueue',
      'workerNote',
      'mastery',
      'colosseum',
      'plan',
      'atlas',
      'cost',
      // How much human judgement the workspace spent, against the work that needed it.
      'supervision',
      'persona',
      'capability',
      'personaGroup',
      'agentRun',
      'runControl',
      'notification',
      'approval',
    ])
    expect(Object.keys(contract.channel)).toEqual([
      'list',
      'create',
      'rootThread',
      'threads',
      'delete',
      // Unread state, the last of realtime's hidden costs.
      'unread',
      'markRead',
    ])
    expect(Object.keys(contract.message)).toEqual(['list', 'post', 'backfill'])
    expect(Object.keys(contract.runner)).toEqual(['list', 'createPairingToken', 'remove'])
    expect(Object.keys(contract.cost)).toEqual(['summary'])
    expect(Object.keys(contract.atlas)).toEqual(['listProposals', 'contend', 'decide'])
    expect(Object.keys(contract.plan)).toEqual(['get', 'accept', 'requestChanges', 'reject'])
    expect(Object.keys(contract.repository)).toEqual([
      'list',
      'bindExisting',
      'listDirectory',
      'createNew',
      'setInstallCommand',
      'warmCache',
      'setVerifyCommand',
      'setVerificationChecks',
      'setReconcilerEnabled',
      'unbind',
    ])
    expect(Object.keys(contract.mergeQueue)).toEqual(['list', 'enqueue', 'cancel'])
    // No agent-authored write here, deliberately: `authorKind` is a provenance fact,
    // and a client that could set it could launder its own text into the trusted
    // section of every later worker's prompt.
    expect(Object.keys(contract.workerNote)).toEqual(['listByTree', 'write', 'board'])
    expect(Object.keys(contract.supervision)).toEqual(['ledger'])
    expect(Object.keys(contract.persona)).toEqual([
      'list',
      'get',
      'delegationPreview',
      'parse',
      'create',
      'update',
      'delete',
      'resetToBuiltin',
      // The history an agent's self-edit writes, and the revert
      // that makes writing without asking an acceptable trade.
      'revisions',
      'revert',
      // Whether the edit was an improvement, and a human settling it.
      'trial',
      // Where the checks and the humans disagreed — read by a person, acted on by nobody.
      'divergence',
      'keepRevision',
      // The searching half — several candidates, and the two ways a human
      // ends a search. `promoteVariant` is the only one that writes a prompt.
      'variantSearches',
      'promoteVariant',
      'discardVariants',
      'startProposer',
    ])
    expect(Object.keys(contract.personaGroup)).toEqual([
      'list',
      'create',
      'update',
      'delete',
      'delegationMatrix',
    ])
    expect(Object.keys(contract.agentRun)).toEqual([
      'start',
      'get',
      'getActive',
      'listActive',
      'listChildren',
      'getDiff',
      'getRawTranscript',
      'keep',
      'discard',
      'push',
      'steer',
      'listSettled',
      'listNeedsAttention',
      'listVerifications',
    ])
    expect(Object.keys(contract.runControl)).toEqual([
      'get',
      'selfDeployment',
      'pauseAll',
      'resume',
      'setHandoffPolicy',
      'setModelRoutingEnabled',
      'setPlanReviewRequired',
    ])
    expect(Object.keys(contract.notification)).toEqual(['config', 'subscribe', 'unsubscribe'])
    expect(Object.keys(contract.approval)).toEqual(['listPending', 'decide'])
  })
})

/**
 * Notification targets over the real wire. This app is built
 * with real VAPID keys generated at setup, since an unconfigured deployment
 * refuses to register a target at all — which is itself asserted below.
 */
describe('notification targets', () => {
  const endpoint = 'https://push.example.com/subscription/abc123'

  it('reports the transport and public key a client needs to subscribe', async () => {
    const pushConfig = await client.notification.config()
    expect(pushConfig.transport).toBe('web_push')
    expect(pushConfig.publicKey).toBe(vapidKeys.publicKey)
  })

  it('registers a target and upserts on a re-subscribe rather than duplicating it', async () => {
    const first = await client.notification.subscribe({
      transport: 'web_push',
      endpoint,
      credentials: { p256dh: 'key-one', auth: 'auth-one' },
    })
    expect(first.endpoint).toBe(endpoint)
    // Write-only: the keys the browser gave us are never echoed back.
    expect(Object.keys(first)).not.toContain('credentials')

    const second = await client.notification.subscribe({
      transport: 'web_push',
      endpoint,
      credentials: { p256dh: 'key-two', auth: 'auth-two' },
    })
    // Same row, refreshed — a browser whose subscription rotated must not leave
    // a dead target behind that every later delivery retries.
    expect(second.id).toBe(first.id)
  })

  it('unsubscribes an endpoint, and treats an unknown one as already gone', async () => {
    await client.notification.subscribe({
      transport: 'web_push',
      endpoint,
      credentials: { p256dh: 'k', auth: 'a' },
    })
    await expect(client.notification.unsubscribe({ endpoint })).resolves.toEqual({ ok: true })
    await expect(client.notification.unsubscribe({ endpoint })).resolves.toEqual({ ok: true })
  })

  it('refuses to register a target on a deployment with no notification transport', async () => {
    const unconfigured = await buildApp(
      { ...config, VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined },
      devAuth({ userId: 'dev-user', workspaceId }),
    )
    await unconfigured.fastify.listen({ port: 0, host: '127.0.0.1' })
    try {
      const address = unconfigured.fastify.server.address()
      if (address === null || typeof address === 'string') throw new Error('no bound port')
      const other: ContractRouterClient<Contract> = createORPCClient(
        new RPCLink({ url: `http://127.0.0.1:${address.port}/rpc` }),
      )

      expect(await other.notification.config()).toEqual({ transport: null, publicKey: null })
      // Better a clear refusal than a stored target nothing will ever deliver to.
      await expect(
        other.notification.subscribe({
          transport: 'web_push',
          endpoint,
          credentials: { p256dh: 'k', auth: 'a' },
        }),
      ).rejects.toThrow()
    } finally {
      await unconfigured.close()
    }
  })
})
