import type { AgentPersona, DelegationEdge } from '@loom/api-contract'
import { describe, expect, it } from 'vitest'
import {
  composerEdges,
  composerNodes,
  derivedPersonaMarkdown,
  plannerLikeMarkdown,
  connectVerdict,
  layoutForGroup,
  summarizeRefusals,
  withWiderEnvelope,
  withoutDelegate,
  removeDelegateVerdict,
  arrangeByTier,
  chooseOrchestrator,
  orchestrate,
  teamRepositoryFor,
} from './team-composition.js'

const persona = (overrides: Partial<AgentPersona> = {}): AgentPersona => ({
  id: 'p1',
  workspaceId: 'w1',
  name: 'swe',
  description: 'Writes code',
  markdownSource:
    '---\nname: swe\ndescription: Writes code\nmodel: claude-haiku-4-5-20251001\ntools: [Read]\n---\n\nBody.',
  model: 'claude-haiku-4-5-20251001',
  tools: ['Read'],
  harnessEffort: null,
  harnessMaxTurns: null,
  harnessApprovalMode: 'ask' as const,
  harnessPlanner: false,
  harnessDelegates: [],
  harnessBudgetCapUsd: null,
  envelope: null,
  builtinStatus: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
})

const edge = (overrides: Partial<DelegationEdge> = {}): DelegationEdge => ({
  plannerId: 'planner',
  workerId: 'swe',
  ok: true,
  refusals: [],
  ...overrides,
})

describe('layoutForGroup', () => {
  it('keeps every position a human already chose', () => {
    const stored = { p1: { x: 999, y: -40 } }
    const layout = layoutForGroup([persona({ id: 'p1' }), persona({ id: 'p2' })], stored)
    expect(layout.p1).toEqual({ x: 999, y: -40 })
    expect(layout.p2).toBeDefined()
  })

  /**
   * The one relationship this canvas exists to show is which workers hang off which
   * planner; a grid that interleaves them makes it the hardest thing to see.
   */
  it('puts planners on their own row, above the workers', () => {
    const layout = layoutForGroup(
      [
        persona({ id: 'w1' }),
        persona({ id: 'lead', harnessPlanner: true }),
        persona({ id: 'w2' }),
      ],
      {},
    )
    expect(layout.lead?.y).toBeLessThan(layout.w1?.y ?? 0)
    expect(layout.w1?.y).toBe(layout.w2?.y)
  })
})

describe('composerEdges', () => {
  it('draws only pairs where both personas are on the canvas', () => {
    const edges = composerEdges(
      ['planner', 'swe'],
      [edge(), edge({ workerId: 'elsewhere' })],
    )
    expect(edges.map((e) => e.id)).toEqual(['planner->swe'])
  })

  it('leaves the self-edge out of the drawn edges — it belongs on the node', () => {
    // Not dropped: `composerNodes` carries it as `recurses`. Between one node's own
    // handles it would be a line behind the box, which is the same as hiding it.
    expect(composerEdges(['planner'], [edge({ workerId: 'planner' })])).toEqual([])
  })

  it('carries the refusals through so an edge can be drawn refused', () => {
    const edges = composerEdges(
      ['planner', 'swe'],
      [
        edge({
          ok: false,
          refusals: [{ rule: 'model', detail: 'higher tier', fix: 'move the planner up' }],
        }),
      ],
    )
    expect(edges[0]?.ok).toBe(false)
    expect(edges[0]?.summary).toBe('model')
  })
})

describe('summarizeRefusals', () => {
  it('counts them when there is more than one, which is the case that matters', () => {
    expect(
      summarizeRefusals([
        { rule: 'tools', detail: '', fix: '' },
        { rule: 'budget', detail: '', fix: '' },
      ]),
    ).toBe('2 refusals: tools, budget')
  })
})

describe('connectVerdict', () => {
  const source = { personaId: 'planner', name: 'planner', planner: true }

  it('refuses a connection from a persona that is not a planner', () => {
    const verdict = connectVerdict({ ...source, planner: false }, { name: 'swe' }, undefined)
    expect(verdict.kind).toBe('not-a-planner')
  })

  it('says nothing needs doing when the edge already exists', () => {
    expect(connectVerdict(source, { name: 'swe' }, edge()).kind).toBe('already')
  })

  it('offers to widen the envelope when that is the whole of the refusal', () => {
    const verdict = connectVerdict(
      source,
      { name: 'swe' },
      edge({
        ok: false,
        refusals: [{ rule: 'tools', detail: '', fix: '', widenEnvelopeWith: ['Bash', 'Edit'] }],
      }),
    )
    expect(verdict).toMatchObject({ kind: 'widen', tools: ['Bash', 'Edit'] })
  })

  /**
   * The case the whole shape is built around. A composer that quietly lowered a
   * worker's model tier or turned off its auto-approve because someone dragged a line
   * would be changing what that worker *is* — a persona other teams also use — to
   * satisfy a gesture.
   */
  it('refuses rather than editing the worker, when any refusal is about the worker', () => {
    const verdict = connectVerdict(
      source,
      { name: 'swe' },
      edge({
        ok: false,
        refusals: [
          { rule: 'tools', detail: '', fix: '', widenEnvelopeWith: ['Bash'] },
          { rule: 'model', detail: 'higher tier', fix: 'move it down' },
        ],
      }),
    )
    expect(verdict.kind).toBe('refused')
  })
})

describe('withWiderEnvelope', () => {
  const planner = persona({
    id: 'planner',
    name: 'planner',
    tools: ['Read', 'Grep', 'Glob'],
    harnessPlanner: true,
    harnessDelegates: ['Read'],
    markdownSource: [
      '---',
      'name: planner',
      'description: Decomposes',
      'model: claude-sonnet-5',
      'tools: [Read, Grep, Glob]',
      'harness:',
      '  planner: true',
      '  delegates: [Read]',
      '---',
      '',
      'You decompose.',
    ].join('\n'),
  })

  it('adds the tools and keeps everything else, including the prompt', () => {
    const markdown = withWiderEnvelope(planner, ['Bash'])
    expect(markdown).toContain('delegates: [Read, Bash]')
    expect(markdown).toContain('planner: true')
    expect(markdown).toContain('tools: [Read, Grep, Glob]')
    expect(markdown.endsWith('You decompose.')).toBe(true)
  })

  it('never widens the planner\'s own tools, only what it may hand down', () => {
    expect(withWiderEnvelope(planner, ['Bash'])).toContain('tools: [Read, Grep, Glob]')
  })

  it('is idempotent, so a second drag does not duplicate an entry', () => {
    const once = withWiderEnvelope(planner, ['Bash'])
    expect(withWiderEnvelope({ ...planner, harnessDelegates: ['Read', 'Bash'] }, ['Bash'])).toBe(
      once,
    )
  })
})

/**
 * The recursion edge. The reason it matters is stated in that section: "a planner
 * may delegate to another run of itself, that is how depth works, and hiding it makes
 * The own shape invisible on the surface built to show shape."
 *
 * It is the answer to "I cannot add multiple planners" — several planners on a team are
 * several planner *personas*, and one planner going deeper is this.
 */
describe('composerNodes recursion', () => {
  it('marks a planner whose self-edge is allowed', () => {
    const nodes = composerNodes(
      [persona({ id: 'planner', harnessPlanner: true })],
      {},
      [edge({ plannerId: 'planner', workerId: 'planner', ok: true })],
    )
    expect(nodes[0]?.recurses).toBe(true)
    expect(nodes[0]?.recursionSummary).toBe('')
  })

  it('says why a planner cannot recurse, rather than looking like an ordinary planner', () => {
    // A narrowed envelope that does not admit the planner's own tools makes depth
    // impossible — worth saying at design time instead of as a refused child start at
    // depth 2.
    const nodes = composerNodes(
      [persona({ id: 'planner', harnessPlanner: true })],
      {},
      [
        edge({
          plannerId: 'planner',
          workerId: 'planner',
          ok: false,
          refusals: [
            {
              rule: 'tools',
              detail: 'Bash is outside the envelope',
              fix: "Add Bash to this planner's delegation envelope",
            },
          ],
        }),
      ],
    )
    expect(nodes[0]?.recurses).toBe(false)
    expect(nodes[0]?.recursionSummary).toContain('tools')
  })

  it('never marks a worker, which cannot delegate at all', () => {
    const nodes = composerNodes(
      [persona({ id: 'swe' })],
      {},
      [edge({ plannerId: 'swe', workerId: 'swe', ok: true })],
    )
    expect(nodes[0]?.recurses).toBe(false)
  })

  it('renders nodes when no matrix is available yet', () => {
    // A node without its recursion mark is incomplete; a canvas without nodes is empty.
    const nodes = composerNodes([persona({ id: 'planner', harnessPlanner: true })], {})
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.recurses).toBe(false)
  })

  it('keeps the position a human chose', () => {
    const nodes = composerNodes([persona({ id: 'p1' })], { p1: { x: 12, y: 34 } })
    expect(nodes[0]?.position).toEqual({ x: 12, y: 34 })
  })
})

/**
 * The fleet design: "the answer to 'how do I put several planners on a team' ... is several
 * planner **personas**, one per area", and "the canvas should make authoring the second
 * one a first-class act rather than a trip to Settings."
 */
describe('plannerLikeMarkdown', () => {
  const lead = persona({
    id: 'lead',
    name: 'lead-planner',
    harnessPlanner: true,
    tools: ['Read', 'Grep'],
    harnessDelegates: ['Read', 'Edit', 'Bash'],
    model: 'claude-opus-5',
    harnessBudgetCapUsd: 5,
  })

  it('copies the envelope, which is the whole reason to model it on an existing planner', () => {
    /**
     * A planner authored with a narrower envelope than its siblings produces refusals two
     * hops away from the mistake — the second area simply cannot reach the workers the
     * first one can, and the failure surfaces as a refused child start.
     */
    const markdown = plannerLikeMarkdown(lead, { name: 'backend-planner', description: 'Backend.' })
    expect(markdown).toContain('delegates: [Read, Edit, Bash]')
    expect(markdown).toContain('planner: true')
    expect(markdown).toContain('model: claude-opus-5')
    expect(markdown).toContain('tools: [Read, Grep]')
  })

  it('takes the name and description from the human, since those are what must differ', () => {
    const markdown = plannerLikeMarkdown(lead, { name: 'backend-planner', description: 'Backend.' })
    expect(markdown).toContain('name: backend-planner')
    expect(markdown).toContain('description: Backend.')
    expect(markdown).not.toContain('name: lead-planner')
  })

  it('is a planner even when modelled on something that was not', () => {
    // A copy of a worker claiming to be a planner would be refused server-side for
    // holding acting tools — a confusing way to learn the template was wrong.
    const markdown = plannerLikeMarkdown(persona({ id: 'w', name: 'swe' }), {
      name: 'x-planner',
      description: 'X.',
    })
    expect(markdown).toContain('planner: true')
  })
})

/**
 * The review policy, drawn. The property that matters is that it is a *different*
 * kind of edge: a delegation edge is the matrix's answer about what the runtime would
 * allow, a review edge is a human's standing expectation, and nothing gates on the second.
 * Drawn alike, the canvas would claim a rule that does not exist.
 */
describe('composerEdges review policy', () => {
  it('draws a review edge from the reviewer to the reviewed', () => {
    const edges = composerEdges(['qa', 'swe'], [], { qa: ['swe'] })
    expect(edges).toEqual([
      {
        id: 'reviews:qa->swe',
        source: 'qa',
        target: 'swe',
        kind: 'reviews',
        ok: true,
        refusals: [],
        summary: "reviews this persona's work",
      },
    ])
  })

  it('keeps delegation and review edges apart', () => {
    const edges = composerEdges(['planner', 'swe'], [edge()], { planner: ['swe'] })
    expect(edges.map((e) => e.kind).sort()).toEqual(['delegates', 'reviews'])
  })

  it('draws only pairs where both personas are on this team', () => {
    // The policy is stored per team, but a member can be removed without the policy being
    // rewritten — a line to a persona that is not on the canvas would point at nothing.
    expect(composerEdges(['qa'], [], { qa: ['elsewhere'], gone: ['qa'] })).toEqual([])
  })

  it('is never refusable, because nothing in the runtime refuses it', () => {
    const edges = composerEdges(['qa', 'swe'], [], { qa: ['swe'] })
    expect(edges[0]?.ok).toBe(true)
    expect(edges[0]?.refusals).toEqual([])
  })

  it('draws nothing extra when the team has no policy', () => {
    const edges = composerEdges(['planner', 'swe'], [edge()])
    expect(edges).toHaveLength(1)
    expect(edges[0]?.kind).toBe('delegates')
  })
})

describe('removeDelegateVerdict / withoutDelegate — taking an edge off the canvas', () => {
  const planner = persona({
    id: 'planner',
    name: 'planner',
    tools: ['Read', 'Grep', 'Glob'],
    harnessPlanner: true,
    harnessDelegates: ['Read', 'Edit', 'Bash'],
    markdownSource: [
      '---',
      'name: planner',
      'description: Decomposes',
      'model: claude-sonnet-5',
      'tools: [Read, Grep, Glob]',
      'harness:',
      '  planner: true',
      '  delegates: [Read, Edit, Bash]',
      '---',
      '',
      'You decompose.',
    ].join('\n'),
  })

  it('removes cleanly when the worker needs a tool no other delegate does', () => {
    const verdict = removeDelegateVerdict(
      planner,
      { name: 'swe', tools: ['Read', 'Bash'] },
      [{ name: 'qa', tools: ['Read'] }],
    )

    expect(verdict.kind).toBe('clean')
    if (verdict.kind === 'clean') expect(verdict.tools).toEqual(['Bash'])
  })

  it('names who else would be lost, because narrowing is not a per-pair act', () => {
    const verdict = removeDelegateVerdict(
      planner,
      { name: 'swe', tools: ['Read', 'Edit'] },
      [
        { name: 'qa', tools: ['Read'] },
        { name: 'frontend', tools: ['Read', 'Edit'] },
      ],
    )

    expect(verdict.kind).toBe('collateral')
    if (verdict.kind === 'collateral') {
      expect(verdict.tools).toEqual(['Edit'])
      expect(verdict.alsoLoses).toEqual(['frontend'])
    }
  })

  it('offers the removal with its cost when every tool is shared, rather than refusing', () => {
    const verdict = removeDelegateVerdict(
      planner,
      { name: 'swe', tools: ['Read'] },
      [{ name: 'qa', tools: ['Read'] }],
    )

    // Dropping Read really does remove swe — it just takes qa with it. Saying so is more
    // useful than refusing, and it is what actually happens.
    expect(verdict.kind).toBe('collateral')
    if (verdict.kind === 'collateral') expect(verdict.alsoLoses).toEqual(['qa'])
  })

  /**
   * The complaint this answers, verbatim from the operator: selecting one edge produced a
   * notice that read as though every worker would lose something. It was accurate and it
   * was one option out of several — reporting only the winner is what made a specific cost
   * read as a general one.
   */
  it('returns every narrowing that would work, not only the cheapest', () => {
    const verdict = removeDelegateVerdict(
      planner,
      { name: 'swe', tools: ['Read', 'Edit', 'Bash'] },
      [
        { name: 'qa', tools: ['Read'] },
        { name: 'frontend', tools: ['Read', 'Edit'] },
      ],
    )

    expect(verdict.kind).toBe('clean')
    if (verdict.kind !== 'clean') return
    expect(verdict.tools).toEqual(['Bash'])
    expect(verdict.options.map((option) => option.tool)).toEqual(['Bash', 'Edit', 'Read'])
    expect(verdict.options.find((option) => option.tool === 'Read')?.alsoLoses).toEqual([
      'qa',
      'frontend',
    ])
  })

  it('narrows by the tool a human picked from the alternatives, not by the minimum', () => {
    const verdict = removeDelegateVerdict(
      planner,
      { name: 'swe', tools: ['Read', 'Edit', 'Bash'] },
      [{ name: 'frontend', tools: ['Read', 'Edit'] }],
      'Edit',
    )

    expect(verdict.kind).toBe('collateral')
    if (verdict.kind !== 'collateral') return
    expect(verdict.tools).toEqual(['Edit'])
    expect(verdict.alsoLoses).toEqual(['frontend'])
    // Bash costs nothing, so this is not the case where the team is the price.
    expect(verdict.everyOptionCosts).toBe(false)
  })

  it('ignores a preferred tool the envelope does not grant', () => {
    const verdict = removeDelegateVerdict(
      planner,
      { name: 'swe', tools: ['Read', 'Bash'] },
      [{ name: 'qa', tools: ['Read'] }],
      'WebFetch',
    )

    expect(verdict.kind).toBe('clean')
    if (verdict.kind === 'clean') expect(verdict.tools).toEqual(['Bash'])
  })

  it('says when no narrowing spares anyone, which is the only honest "everyone loses"', () => {
    const verdict = removeDelegateVerdict(
      planner,
      { name: 'swe', tools: ['Read', 'Edit'] },
      [{ name: 'qa', tools: ['Read', 'Edit'] }],
    )

    expect(verdict.kind).toBe('collateral')
    if (verdict.kind === 'collateral') expect(verdict.everyOptionCosts).toBe(true)
  })

  it('refuses when the envelope grants the worker nothing to begin with', () => {
    const verdict = removeDelegateVerdict(planner, { name: 'oddball', tools: ['WebFetch'] }, [])
    expect(verdict.kind).toBe('impossible')
  })

  it('narrows the markdown through the same serializer, keeping everything else', () => {
    const markdown = withoutDelegate(planner, ['Bash'])

    expect(markdown).toContain('delegates: [Read, Edit]')
    expect(markdown).toContain('tools: [Read, Grep, Glob]')
    expect(markdown.endsWith('You decompose.')).toBe(true)
  })
})

/**
 * The chain of command on the canvas (`orchestrate`).
 *
 * The bug this is written against is not a crash: it is a five-member team with two
 * planners rendering as a tangle in which nothing says which planner is the root and
 * both appear to own every worker. The matrix is computed "from a root" for every pair
 * because a workspace-wide matrix has nowhere else to stand, so two planner personas
 * each admit the other and the canvas draws a chain no run tree can have.
 */
describe('orchestrate — the chain of command', () => {
  const plannerPersona = (id: string) =>
    persona({ id, name: id, harnessPlanner: true, harnessDelegates: ['Read', 'Edit'] })
  const workerPersona = (id: string) => persona({ id, name: id, tools: ['Read'] })

  const nodesOf = (personas: AgentPersona[], matrix: DelegationEdge[]) =>
    composerNodes(personas, {}, matrix)
  const edgesOf = (personas: AgentPersona[], matrix: DelegationEdge[]) =>
    composerEdges(
      personas.map((entry) => entry.id),
      matrix,
    )

  /** Two planners that each admit the other, and three workers both admit — the screenshot. */
  const twoPlanners = [
    plannerPersona('lead'),
    plannerPersona('second'),
    workerPersona('swe'),
    workerPersona('qa'),
  ]
  const mutual: DelegationEdge[] = [
    edge({ plannerId: 'lead', workerId: 'second' }),
    edge({ plannerId: 'second', workerId: 'lead' }),
    edge({ plannerId: 'lead', workerId: 'swe' }),
    edge({ plannerId: 'lead', workerId: 'qa' }),
    edge({ plannerId: 'second', workerId: 'swe' }),
    edge({ plannerId: 'second', workerId: 'qa' }),
  ]

  it('seats the chosen root at the top and everything it reaches below it', () => {
    const result = orchestrate(nodesOf(twoPlanners, mutual), edgesOf(twoPlanners, mutual), 'lead', 2)

    expect(result.orchestratorId).toBe('lead')
    expect(result.seats.lead).toMatchObject({ depth: 0, role: 'orchestrator' })
    expect(result.seats.second).toMatchObject({ depth: 1, role: 'sub-planner' })
    expect(result.seats.swe).toMatchObject({ depth: 1, role: 'worker' })
    expect(result.unreachable).toEqual([])
  })

  /**
   * The edge that only exists because the matrix has no vantage. `second` may delegate to
   * `lead` between those two personas; at depth 1 with a limit of 2 there is no hop below
   * it for another planner, so no plan can ever use it. Drawing it as ordinary is the
   * canvas claiming a chain the runtime refuses.
   */
  it('marks an edge the pair allows and this arrangement does not', () => {
    const result = orchestrate(nodesOf(twoPlanners, mutual), edgesOf(twoPlanners, mutual), 'lead', 2)

    expect(result.outOfDepth['second->lead']).toContain('nothing below it could run')
    expect(result.outOfDepth['lead->second']).toBeUndefined()
    expect(result.outOfDepth['second->swe']).toBeUndefined()
  })

  it('refuses a hop past the limit, in the child-start gate\'s own terms', () => {
    const deep = [plannerPersona('lead'), plannerPersona('second'), workerPersona('swe')]
    const chain: DelegationEdge[] = [
      edge({ plannerId: 'lead', workerId: 'second' }),
      edge({ plannerId: 'second', workerId: 'swe' }),
    ]
    // A limit of 1 means the root's children are leaves, so `second` is not offered at all.
    const result = orchestrate(nodesOf(deep, chain), edgesOf(deep, chain), 'lead', 1)

    expect(result.outOfDepth['lead->second']).toContain('nothing below it could run')
    expect(result.unreachable).toEqual(['second', 'swe'])
  })

  it('names a member no chain from the root reaches, rather than drawing it as ordinary', () => {
    const personas = [plannerPersona('lead'), workerPersona('swe'), workerPersona('orphan')]
    const matrix = [edge({ plannerId: 'lead', workerId: 'swe' })]
    const result = orchestrate(nodesOf(personas, matrix), edgesOf(personas, matrix), 'lead', 2)

    expect(result.unreachable).toEqual(['orphan'])
    expect(result.seats.orphan).toMatchObject({ depth: null, role: 'unreachable' })
  })

  it('drops the recursion mark at a depth with no hop left for it', () => {
    const selfEdges = [...mutual, edge({ plannerId: 'second', workerId: 'second' })]
    const result = orchestrate(
      nodesOf(twoPlanners, selfEdges),
      edgesOf(twoPlanners, selfEdges),
      'lead',
      2,
    )

    // The matrix says `second` may recurse — from a root. One hop down it cannot.
    expect(composerNodes(twoPlanners, {}, selfEdges).find((n) => n.personaId === 'second')?.recurses).toBe(true)
    expect(result.seats.second?.canRecurse).toBe(false)
  })

  describe('choosing a root when nobody has', () => {
    it('picks the planner that reaches the most members', () => {
      const personas = [plannerPersona('lead'), plannerPersona('narrow'), workerPersona('swe')]
      const matrix = [
        edge({ plannerId: 'lead', workerId: 'swe' }),
        edge({ plannerId: 'lead', workerId: 'narrow' }),
      ]
      expect(
        chooseOrchestrator(nodesOf(personas, matrix), edgesOf(personas, matrix), '', 2),
      ).toBe('lead')
    })

    it('falls back rather than rendering an empty tier when the stored root is gone', () => {
      const personas = [plannerPersona('lead'), workerPersona('swe')]
      const matrix = [edge({ plannerId: 'lead', workerId: 'swe' })]
      expect(
        chooseOrchestrator(nodesOf(personas, matrix), edgesOf(personas, matrix), 'deleted', 2),
      ).toBe('lead')
    })

    it('keeps a stored root that is still a planner on the team', () => {
      const result = orchestrate(
        nodesOf(twoPlanners, mutual),
        edgesOf(twoPlanners, mutual),
        'second',
        2,
      )
      expect(result.orchestratorId).toBe('second')
      expect(result.seats.lead).toMatchObject({ depth: 1, role: 'sub-planner' })
    })
  })
})

describe('arrangeByTier — the layout the chain implies', () => {
  it('puts each tier on its own row, centred, and overwrites what was stored', () => {
    const personas = [
      persona({ id: 'lead', name: 'lead', harnessPlanner: true }),
      persona({ id: 'swe', name: 'swe' }),
      persona({ id: 'qa', name: 'qa' }),
    ]
    const layout = arrangeByTier(personas, { lead: 0, swe: 1, qa: 1 })

    expect(layout.lead?.y).toBe(0)
    expect(layout.swe?.y).toBe(layout.qa?.y)
    expect(layout.swe?.y).toBeGreaterThan(layout.lead!.y)
    // Centred: the root sits over the middle of the two under it.
    expect(layout.lead?.x).toBe((layout.swe!.x + layout.qa!.x) / 2)
  })

  it('honours a stored position through layoutForGroup, and tiers only fill the gaps', () => {
    const personas = [
      persona({ id: 'lead', name: 'lead', harnessPlanner: true }),
      persona({ id: 'swe', name: 'swe' }),
    ]
    const layout = layoutForGroup(personas, { lead: { x: 999, y: 999 } }, { lead: 0, swe: 1 })

    expect(layout.lead).toEqual({ x: 999, y: 999 })
    expect(layout.swe?.y).toBeGreaterThan(0)
  })
})

/**
 * The answer to "two agents in one role, one of which learned this subsystem": two
 * personas, because a map hangs off a persona and travels with it. Expertise scoped to a
 * slot on a team would be the same bug as the `team_expertise` join table one level down —
 * the expert that learned something would forget it on the next team.
 */
describe('derivedPersonaMarkdown — a second expert from one role', () => {
  const reviewer = persona({
    id: 'sec',
    name: 'security-reviewer',
    model: 'claude-haiku-4-5-20251001',
    tools: ['Read', 'Grep'],
    markdownSource: [
      '---',
      'name: security-reviewer',
      'description: Reviews for security',
      'model: claude-haiku-4-5-20251001',
      'tools: [Read, Grep]',
      'harness:',
      '  approvalMode: ask',
      '---',
      '',
      'You review.',
    ].join('\n'),
  })

  it('keeps everything the team was designed against, and takes the new name', () => {
    const markdown = derivedPersonaMarkdown(reviewer, {
      name: 'security-reviewer-payments',
      description: 'Reviews payments for security',
    })

    expect(markdown).toContain('name: security-reviewer-payments')
    expect(markdown).toContain('tools: [Read, Grep]')
    expect(markdown).toContain('model: claude-haiku-4-5-20251001')
    expect(markdown.endsWith('You review.')).toBe(true)
  })

  it('overrides the model only when one is asked for', () => {
    expect(
      derivedPersonaMarkdown(reviewer, { name: 'a', description: 'd', model: 'claude-sonnet-5' }),
    ).toContain('model: claude-sonnet-5')
    // Empty is "leave it alone", not "clear it" — the field is required downstream.
    expect(derivedPersonaMarkdown(reviewer, { name: 'a', description: 'd', model: '' })).toContain(
      'model: claude-haiku-4-5-20251001',
    )
  })

  /**
   * A copy of a worker is a worker. Forcing `planner: true` on one would be refused by
   * the server for holding acting tools, which is a confusing way to learn the
   * template was wrong.
   */
  it('does not make a planner out of a worker', () => {
    expect(derivedPersonaMarkdown(reviewer, { name: 'a', description: 'd' })).not.toContain(
      'planner: true',
    )
    expect(plannerLikeMarkdown(reviewer, { name: 'a', description: 'd' })).toContain(
      'planner: true',
    )
  })
})

/**
 * The reader that keeps the team repository from being a decoration.
 */
describe('teamRepositoryFor', () => {
  const team = (personaIds: string[], repositoryId: string | null) => ({ personaIds, repositoryId })

  it('answers with the repository of the one team that has one', () => {
    expect(teamRepositoryFor('swe', [team(['swe', 'qa'], 'repo-a')])).toBe('repo-a')
  })

  it('has no answer for a persona on no team, or on a team that chose none', () => {
    expect(teamRepositoryFor('swe', [])).toBeNull()
    expect(teamRepositoryFor('swe', [team(['qa'], 'repo-a')])).toBeNull()
    expect(teamRepositoryFor('swe', [team(['swe'], null)])).toBeNull()
  })

  /**
   * Two teams naming the same repository is not the ambiguity the widths have —
   * every candidate answer is identical, so there is nothing to guess between.
   */
  it('answers when several teams agree, and refuses when they disagree', () => {
    expect(
      teamRepositoryFor('swe', [team(['swe'], 'repo-a'), team(['swe', 'qa'], 'repo-a')]),
    ).toBe('repo-a')
    expect(teamRepositoryFor('swe', [team(['swe'], 'repo-a'), team(['swe'], 'repo-b')])).toBeNull()
  })

  /** A team with no repository does not veto one that has chosen. */
  it('ignores teams that have chosen nothing', () => {
    expect(teamRepositoryFor('swe', [team(['swe'], null), team(['swe'], 'repo-a')])).toBe('repo-a')
  })
})
