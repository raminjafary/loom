import { describe, expect, it } from 'vitest'
import {
  laneSources,
  nextWorkflowActions,
  parseWorkflowAnswer,
  renderWorkflowTask,
  resolveRouterChoice,
  ROUTER_FIELD,
  workflowMayStart,
  STEP_UNANSWERED,
  type WorkflowStepState,
} from './workflow-executor.js'
import { MAX_LOOP_ITERATIONS, parseWorkflowGraph, type WorkflowGraph } from './workflow-graph.js'

/**
 * The executor's decision, tested as what it is: a pure function of a shape and a journal.
 *
 * The claims worth holding down are the ones a scheduler gets wrong quietly — a lane waiting for
 * a lane it does not depend on, a barrier that never opens, a router's unchosen branch left
 * pending forever, a refusal that kills six healthy lanes with it, and a loop that does not stop.
 */

const graphOf = (value: unknown): WorkflowGraph => {
  const verdict = parseWorkflowGraph(value)
  if (!verdict.ok) throw new Error(`bad fixture: ${verdict.reason}`)
  return verdict.graph
}

const step = (
  nodeId: string,
  over: Partial<WorkflowStepState> = {},
): WorkflowStepState => ({
  nodeId,
  pass: 0,
  itemIndex: 0,
  attempt: 0,
  status: 'answered',
  answer: {},
  reason: null,
  ...over,
})

const plan = (graph: WorkflowGraph, steps: readonly WorkflowStepState[]) =>
  nextWorkflowActions({ graph, steps, input: 'the ask' })

const dealt = (graph: WorkflowGraph, steps: readonly WorkflowStepState[]) =>
  plan(graph, steps).deal.map((entry) => `${entry.nodeId}@${entry.pass}:${entry.itemIndex}`)

/** discover -> transform per site -> check per site -> barrier -> report. */
const sweep = graphOf({
  nodes: [
    {
      kind: 'step',
      id: 'discover',
      title: 'discover',
      persona: 'Scout',
      task: 'find the sites for {{input}}',
      answer: { fields: [{ kind: 'list', name: 'sites' }] },
    },
    {
      kind: 'fan',
      id: 'transform',
      title: 'transform',
      persona: 'Worker',
      task: 'rewrite {{item}}',
      source: 'discover',
      over: 'sites',
      maxWidth: 8,
      answer: { fields: [{ kind: 'text', name: 'diff' }] },
    },
    {
      kind: 'step',
      id: 'check',
      title: 'check',
      persona: 'Worker',
      task: 'verify {{transform.diff}}',
      answer: { fields: [{ kind: 'text', name: 'verdict' }] },
    },
    { kind: 'barrier', id: 'all-done', title: 'all done' },
    { kind: 'step', id: 'lint', title: 'lint', persona: 'Worker', task: 'lint', answer: null },
    {
      kind: 'step',
      id: 'report',
      title: 'report',
      persona: 'Writer',
      task: 'write up {{transform.diff}}',
      answer: null,
    },
  ],
  edges: [
    { from: 'discover', to: 'transform' },
    { from: 'transform', to: 'check' },
    { from: 'check', to: 'all-done' },
    { from: 'lint', to: 'all-done' },
    { from: 'all-done', to: 'report' },
  ],
})

describe('laneSources', () => {
  it('gives every node below a fan that fan, and resets at a barrier', () => {
    const lanes = laneSources(sweep)
    if (!lanes.ok) throw new Error(lanes.reason)
    expect(lanes.sources.get('discover')).toBeNull()
    expect(lanes.sources.get('transform')).toBe('transform')
    expect(lanes.sources.get('check')).toBe('transform')
    expect(lanes.sources.get('all-done')).toBeNull()
    expect(lanes.sources.get('report')).toBeNull()
  })

  it('refuses a node fed by two fans, which have no common lane', () => {
    const graph = graphOf({
      nodes: [
        {
          kind: 'step',
          id: 'seed',
          title: 'seed',
          persona: 'S',
          task: 'seed',
          answer: { fields: [{ kind: 'list', name: 'xs' }] },
        },
        {
          kind: 'fan',
          id: 'east',
          title: 'east',
          persona: 'W',
          task: 'do {{item}}',
          source: 'seed',
          over: 'xs',
          maxWidth: 4,
          answer: null,
        },
        {
          kind: 'fan',
          id: 'west',
          title: 'west',
          persona: 'W',
          task: 'do {{item}}',
          source: 'seed',
          over: 'xs',
          maxWidth: 4,
          answer: null,
        },
        { kind: 'step', id: 'join', title: 'join', persona: 'W', task: 'join', answer: null },
      ],
      edges: [
        { from: 'seed', to: 'east' },
        { from: 'seed', to: 'west' },
        { from: 'east', to: 'join' },
        { from: 'west', to: 'join' },
      ],
    })
    const lanes = laneSources(graph)
    expect(lanes.ok).toBe(false)
    if (!lanes.ok) expect(lanes.reason).toContain('2 different fans (east, west)')
  })

  it('refuses a fan inside a fan, which would need two lane indexes', () => {
    const graph = graphOf({
      nodes: [
        {
          kind: 'step',
          id: 'seed',
          title: 'seed',
          persona: 'S',
          task: 'seed',
          answer: { fields: [{ kind: 'list', name: 'xs' }] },
        },
        {
          kind: 'fan',
          id: 'outer',
          title: 'outer',
          persona: 'W',
          task: 'do {{item}}',
          source: 'seed',
          over: 'xs',
          maxWidth: 4,
          answer: { fields: [{ kind: 'list', name: 'ys' }] },
        },
        {
          kind: 'fan',
          id: 'inner',
          title: 'inner',
          persona: 'W',
          task: 'do {{item}}',
          source: 'outer',
          over: 'ys',
          maxWidth: 4,
          answer: null,
        },
      ],
      edges: [
        { from: 'seed', to: 'outer' },
        { from: 'outer', to: 'inner' },
      ],
    })
    const lanes = laneSources(graph)
    expect(lanes.ok).toBe(false)
    if (!lanes.ok) expect(lanes.reason).toContain('two dimensions')
  })
})

describe('nextWorkflowActions', () => {
  it('starts the nodes nothing waits for, and only those', () => {
    expect(dealt(sweep, []).sort()).toEqual(['discover@0:0', 'lint@0:0'])
  })

  it('deals one run per item once the fan source answers', () => {
    const steps = [step('discover', { answer: { sites: ['a', 'b', 'c'] } })]
    expect(dealt(sweep, steps)).toContain('transform@0:0')
    expect(dealt(sweep, steps)).toContain('transform@0:2')
    expect(plan(sweep, steps).deal.filter((entry) => entry.nodeId === 'transform')).toHaveLength(3)
  })

  it('gives each lane its own item, rendered into the prompt', () => {
    const steps = [step('discover', { answer: { sites: ['alpha', 'beta'] } })]
    const tasks = plan(sweep, steps)
      .deal.filter((entry) => entry.nodeId === 'transform')
      .map((entry) => entry.task)
    expect(tasks).toEqual(['rewrite alpha', 'rewrite beta'])
  })

  it('honours the width a human chose rather than the list a model wrote', () => {
    const wide = graphOf({
      ...sweep,
      nodes: sweep.nodes.map((node) => (node.id === 'transform' ? { ...node, maxWidth: 2 } : node)),
    })
    const steps = [step('discover', { answer: { sites: ['a', 'b', 'c', 'd'] } })]
    expect(plan(wide, steps).deal.filter((entry) => entry.nodeId === 'transform')).toHaveLength(2)
  })

  /** The whole reason the shape is drawn: lane 0 moves on while lane 1 is still working. */
  it('moves one lane on without waiting for its siblings', () => {
    const steps = [
      step('discover', { answer: { sites: ['a', 'b'] } }),
      step('transform', { itemIndex: 0, answer: { diff: 'first' } }),
      step('transform', { itemIndex: 1, status: 'running', answer: null }),
      step('lint'),
    ]
    expect(dealt(sweep, steps)).toEqual(['check@0:0'])
  })

  it('opens the barrier only when every lane above it has arrived', () => {
    const half = [
      step('discover', { answer: { sites: ['a', 'b'] } }),
      step('transform', { itemIndex: 0, answer: { diff: 'x' } }),
      step('transform', { itemIndex: 1, answer: { diff: 'y' } }),
      step('lint'),
      step('check', { itemIndex: 0, answer: { verdict: 'ok' } }),
    ]
    expect(plan(sweep, half).collect).toEqual([])

    const whole = [...half, step('check', { itemIndex: 1, answer: { verdict: 'ok' } })]
    expect(plan(sweep, whole).collect.map((entry) => entry.nodeId)).toEqual(['all-done'])
  })

  it('renders every lane of a fan for the step below the barrier, numbered', () => {
    const steps = [
      step('discover', { answer: { sites: ['a', 'b'] } }),
      step('transform', { itemIndex: 0, answer: { diff: 'first' } }),
      step('transform', { itemIndex: 1, answer: { diff: 'second' } }),
      step('lint'),
      step('check', { itemIndex: 0, answer: { verdict: 'ok' } }),
      step('check', { itemIndex: 1, answer: { verdict: 'ok' } }),
      step('all-done'),
    ]
    const report = plan(sweep, steps).deal.find((entry) => entry.nodeId === 'report')
    expect(report?.task).toBe('write up 1. first\n2. second')
  })

  /**
   * "Still coming" and "will never come" are different, and conflating them is how an execution
   * whose first step was refused ran forever: nothing ready, nothing skippable, an empty graph
   * beneath it and a `running` status.
   */
  it('closes a graph whose fan source was refused rather than waiting on lanes that cannot open', () => {
    const steps = [step('discover', { status: 'refused', answer: null }), step('lint')]
    const verdict = plan(sweep, steps)
    // No lanes opened, so the fan and the step in its lane have no rows at all — there was
    // nothing to run rather than something that was skipped.
    expect(verdict.deal).toEqual([])
    expect(verdict.collect.map((entry) => entry.nodeId)).toEqual(['all-done'])
    // And the barrier opens on the lane that did answer, rather than waiting on lanes that
    // will never exist.
    expect(plan(sweep, [...steps, step('all-done')]).deal.map((entry) => entry.nodeId)).toEqual([
      'report',
    ])
  })

  it('reports a graph that answered nowhere as a failure, with the reason', () => {
    const settled = [
      step('discover', { status: 'refused', answer: null }),
      step('lint', { status: 'refused', answer: null }),
    ]
    const verdict = plan(sweep, settled)
    expect(verdict.deal).toEqual([])
    expect(verdict.skip.map((entry) => entry.nodeId)).toEqual(['all-done'])
    // The skip cascades one stage per tick, and the execution closes as failed once it
    // reaches the bottom — the shape stays failed rather than running forever.
    const past = [...settled, step('all-done', { status: 'skipped', answer: null })]
    expect(plan(sweep, past).skip.map((entry) => entry.nodeId)).toEqual(['report'])
    const closed = plan(sweep, [...past, step('report', { status: 'skipped', answer: null })])
    expect(closed.done).toBe(true)
    expect(closed.failure).toContain('every terminal step was refused')
  })

  it('is done only when nothing is running and nothing more can be dealt', () => {
    expect(plan(sweep, []).done).toBe(false)
    const running = [step('discover', { status: 'running', answer: null }), step('lint')]
    expect(plan(sweep, running).done).toBe(false)
  })

  describe('a refusal stops its lane and not the others', () => {
    const steps = [
      step('discover', { answer: { sites: ['a', 'b'] } }),
      step('transform', { itemIndex: 0, status: 'refused', answer: null }),
      step('transform', { itemIndex: 1, answer: { diff: 'y' } }),
      step('lint'),
    ]

    it('skips the step below the refused lane, naming why', () => {
      const skipped = plan(sweep, steps).skip.find((entry) => entry.nodeId === 'check')
      expect(skipped?.itemIndex).toBe(0)
      expect(skipped?.reason).toContain('did not answer in this lane')
    })

    it('deals the healthy lane in the same tick', () => {
      expect(dealt(sweep, steps)).toEqual(['check@0:1'])
    })

    it('still opens the barrier, so the surviving lanes are worth having run', () => {
      const settled = [
        ...steps,
        step('check', { itemIndex: 0, status: 'skipped', answer: null }),
        step('check', { itemIndex: 1, answer: { verdict: 'ok' } }),
      ]
      expect(plan(sweep, settled).collect.map((entry) => entry.nodeId)).toEqual(['all-done'])
    })
  })

  /**
   * The refusal that is a dice roll rather than a verdict.
   *
   * A step at the top of a shape is a single point of failure for everything under it: the fan
   * below `discover` opens no lanes, so a whole execution produces nothing — which is how the
   * trial lost a task to a `scope` step that did the work and never called its answer tool. One
   * more attempt costs one step. It is the *reason* that decides, not the status, and the reason
   * is the one settlement writes.
   */
  describe('a step that completed and answered nothing', () => {
    const silent = (attempt: number) =>
      step('discover', {
        attempt,
        status: 'refused' as const,
        answer: null,
        reason: STEP_UNANSWERED,
      })

    it('is dealt again, as its own attempt', () => {
      const verdict = plan(sweep, [silent(0), step('lint')])
      expect(verdict.deal.map((entry) => `${entry.nodeId}@${entry.attempt}`)).toEqual([
        'discover@1',
      ])
    })

    it('does not skip the graph beneath it on the same tick', () => {
      // The bug this pins: the retry is dealt and the shape below it is written off at once,
      // because the row it was dealt from still says refused.
      const verdict = plan(sweep, [silent(0), step('lint')])
      expect(verdict.skip).toEqual([])
      expect(verdict.collect).toEqual([])
      expect(verdict.done).toBe(false)
      expect(verdict.failure).toBeNull()
    })

    it('is asked the same question, and told the last attempt said nothing', () => {
      const [retried] = plan(sweep, [silent(0), step('lint')]).deal
      expect(retried?.task).toContain('find the sites for the ask')
      expect(retried?.task).toContain('ended without submitting an answer')
    })

    it('is not dealt a third time, and the shape below it closes', () => {
      const twice = [silent(0), silent(1), step('lint')]
      expect(plan(sweep, twice).deal).toEqual([])
      expect(plan(sweep, twice).collect.map((entry) => entry.nodeId)).toEqual(['all-done'])
    })

    it('names itself in the closing reason, with how many attempts it had', () => {
      const settled = [
        silent(0),
        silent(1),
        step('lint', { status: 'refused', answer: null }),
        step('all-done', { status: 'skipped', answer: null }),
        step('report', { status: 'skipped', answer: null }),
      ]
      const closed = plan(sweep, settled)
      expect(closed.done).toBe(true)
      // A reader told only "report was skipped" learns nothing they can act on.
      expect(closed.failure).toContain('"discover"')
      expect(closed.failure).toContain('all 2 attempts')
      expect(closed.failure).toContain(STEP_UNANSWERED)
    })

    it('leaves every other refusal settled where it is', () => {
      // A failed or cancelled run, a timeout, a persona that has gone: something happened to the
      // run rather than to the answer, and a second one is the same bet at twice the price.
      const failed = step('discover', {
        status: 'refused',
        answer: null,
        reason: 'the run failed',
      })
      expect(plan(sweep, [failed, step('lint')]).deal).toEqual([])
    })
  })

  /**
   * A verifier that refutes one claim at a time opens lanes exactly as a fan does — the bug this
   * covers is the one where every rule about lanes was written for `kind === 'fan'` and a
   * per-item verifier ran once, against an empty item.
   */
  describe('a per-item verifier', () => {
    const review = graphOf({
      nodes: [
        {
          kind: 'step',
          id: 'claims',
          title: 'claims',
          persona: 'Researcher',
          task: 'research {{input}}',
          answer: { fields: [{ kind: 'list', name: 'findings' }] },
        },
        {
          kind: 'verifier',
          id: 'refute',
          title: 'refute',
          persona: 'Skeptic',
          task: 'try to refute {{item}}',
          verifies: 'claims',
          over: 'findings',
          maxWidth: 4,
          answer: { fields: [{ kind: 'flag', name: 'stands' }] },
        },
      ],
      edges: [{ from: 'claims', to: 'refute' }],
    })

    it('runs once per claim, each with its own claim in the prompt', () => {
      const steps = [step('claims', { answer: { findings: ['one', 'two'] } })]
      expect(plan(review, steps).deal.map((entry) => entry.task)).toEqual([
        'try to refute one',
        'try to refute two',
      ])
    })

    it('honours the width the graph set rather than the length the audited step wrote', () => {
      const steps = [step('claims', { answer: { findings: ['a', 'b', 'c', 'd', 'e', 'f'] } })]
      expect(plan(review, steps).deal).toHaveLength(4)
    })
  })

  describe('router', () => {
    const triage = graphOf({
      nodes: [
        {
          kind: 'router',
          id: 'triage',
          title: 'triage',
          persona: 'Triager',
          task: 'classify {{input}}',
          choices: ['bug', 'feature'],
        },
        { kind: 'step', id: 'fix', title: 'fix', persona: 'W', task: 'fix it', answer: null },
        { kind: 'step', id: 'build', title: 'build', persona: 'W', task: 'build it', answer: null },
      ],
      edges: [
        { from: 'triage', to: 'fix', when: 'bug' },
        { from: 'triage', to: 'build', when: 'feature' },
      ],
    })

    it('deals the branch it chose and skips the one it did not', () => {
      const steps = [step('triage', { answer: { [ROUTER_FIELD]: 'bug' } })]
      expect(dealt(triage, steps)).toEqual(['fix@0:0'])
      expect(plan(triage, steps).skip.map((entry) => entry.nodeId)).toEqual(['build'])
      expect(plan(triage, steps).skip[0]?.reason).toContain('chose "bug"')
    })

    it('skips both branches when the answer is not one of the choices', () => {
      const steps = [step('triage', { answer: { [ROUTER_FIELD]: 'neither' } })]
      expect(plan(triage, steps).deal).toEqual([])
      expect(plan(triage, steps).skip.map((entry) => entry.nodeId).sort()).toEqual(['build', 'fix'])
    })
  })

  describe('loop', () => {
    const draft = graphOf({
      nodes: [
        { kind: 'step', id: 'write', title: 'write', persona: 'W', task: 'draft {{input}}', answer: null },
        {
          kind: 'step',
          id: 'critique',
          title: 'critique',
          persona: 'C',
          task: 'critique it',
          answer: { fields: [{ kind: 'flag', name: 'settled' }] },
        },
        { kind: 'step', id: 'ship', title: 'ship', persona: 'W', task: 'ship it', answer: null },
      ],
      edges: [
        { from: 'write', to: 'critique' },
        { from: 'critique', to: 'ship' },
        { from: 'critique', to: 'write', loop: { until: 'settled' } },
      ],
    })

    it('takes another pass when the flag says it is not settled', () => {
      const steps = [step('write'), step('critique', { answer: { settled: false } })]
      expect(dealt(draft, steps)).toEqual(['write@1:0'])
    })

    it('holds the step below the loop until the loop stops', () => {
      const unsettled = [step('write'), step('critique', { answer: { settled: false } })]
      expect(dealt(draft, unsettled)).not.toContain('ship@0:0')

      const settled = [step('write'), step('critique', { answer: { settled: true } })]
      expect(dealt(draft, settled)).toEqual(['ship@0:0'])
    })

    it('stops at the bound however the flag answers', () => {
      const steps = Array.from({ length: MAX_LOOP_ITERATIONS }, (_unused, pass) => [
        step('write', { pass }),
        step('critique', { pass, answer: { settled: false } }),
      ]).flat()
      const verdict = plan(draft, steps)
      expect(verdict.deal.map((entry) => entry.nodeId)).toEqual(['ship'])
    })
  })
})

describe('parseWorkflowAnswer', () => {
  const schema = {
    fields: [
      { kind: 'text' as const, name: 'note' },
      { kind: 'list' as const, name: 'sites' },
      { kind: 'flag' as const, name: 'done' },
    ],
  }

  it('takes an answer that matches what the node declared', () => {
    const verdict = parseWorkflowAnswer(schema, { note: 'n', sites: ['a'], done: true, extra: 1 })
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.answer).toEqual({ note: 'n', sites: ['a'], done: true })
  })

  it('refuses a list that came back as a sentence', () => {
    const verdict = parseWorkflowAnswer(schema, { note: 'n', sites: 'a and b', done: false })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('rather than a list')
  })

  it('refuses a missing field rather than defaulting it', () => {
    const verdict = parseWorkflowAnswer(schema, { note: 'n', sites: [] })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('no "done"')
  })

  it('asks nothing of a node that declared no answer', () => {
    expect(parseWorkflowAnswer(null, 'anything at all')).toEqual({ ok: true, answer: {} })
  })
})

describe('resolveRouterChoice', () => {
  it('refuses a branch nobody drew rather than defaulting to one', () => {
    const verdict = resolveRouterChoice(['a', 'b'], { [ROUTER_FIELD]: 'c' })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('is not a default')
  })
})

describe('renderWorkflowTask', () => {
  it('leaves no braces behind for a reference that resolved to nothing', () => {
    const rendered = renderWorkflowTask({
      task: 'use {{missing.field}} carefully',
      input: 'x',
      item: null,
      answers: new Map(),
    })
    expect(rendered).toBe('use  carefully')
  })

  it('renders a flag as a word rather than as true', () => {
    const rendered = renderWorkflowTask({
      task: '{{a.done}}',
      input: 'x',
      item: null,
      answers: new Map([['a', [{ done: false }]]]),
    })
    expect(rendered).toBe('no')
  })
})

describe('workflowMayStart', () => {
  it('lets an uncapped run start anything', () => {
    expect(workflowMayStart({ capUsd: null, spentUsd: 99 })).toEqual({ ok: true })
  })

  it('refuses once the cap is reached in aggregate, and says the result is partial', () => {
    const verdict = workflowMayStart({ capUsd: 1, spentUsd: 1 })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('partial')
  })
})

/**
 * A tournament: three attempts made in parallel, then judged two at a time until one is left.
 *
 * The claims worth holding down here are the ones a bracket gets wrong silently — a round that
 * pairs by the order a model wrote its list, a judge shown one side, a champion produced by a
 * match nobody judged, and a second round dealt before the first has finished.
 */
const tournament = graphOf({
  nodes: [
    {
      kind: 'step',
      id: 'approaches',
      title: 'approaches',
      persona: 'Architect',
      task: 'name the approaches to {{input}}',
      answer: { fields: [{ kind: 'list', name: 'approaches' }] },
    },
    {
      kind: 'fan',
      id: 'attempt',
      title: 'attempt',
      persona: 'Worker',
      task: 'try {{item}}',
      source: 'approaches',
      over: 'approaches',
      maxWidth: 6,
      answer: { fields: [{ kind: 'text', name: 'result' }] },
    },
    { kind: 'barrier', id: 'attempted', title: 'every attempt in' },
    {
      kind: 'bracket',
      id: 'judge',
      title: 'judge',
      persona: 'Judge',
      task: 'which is better for {{input}} — {{left}} or {{right}}?',
      entrants: 'attempt',
      over: 'result',
      maxEntrants: 6,
      answer: { fields: [{ kind: 'text', name: 'why' }] },
    },
    {
      kind: 'step',
      id: 'ship',
      title: 'ship',
      persona: 'Worker',
      task: 'carry out {{judge.champion}}, chosen because {{judge.why}}',
      answer: null,
    },
  ],
  edges: [
    { from: 'approaches', to: 'attempt' },
    { from: 'attempt', to: 'attempted' },
    { from: 'approaches', to: 'attempted' },
    { from: 'attempted', to: 'judge' },
    { from: 'judge', to: 'ship' },
  ],
})

/** The journal of a tournament whose attempts have all answered, before any match is judged. */
const attempts = (results: readonly string[]): WorkflowStepState[] => [
  step('approaches', { answer: { approaches: results.map((_r, at) => `approach ${at}`) } }),
  ...results.map((result, at) =>
    step('attempt', { itemIndex: at, answer: { result } }),
  ),
  step('attempted', { answer: {} }),
]

const SEED = 'workflow-run-under-test'

const matchesOf = (steps: readonly WorkflowStepState[], round: number) =>
  nextWorkflowActions({ graph: tournament, steps, input: 'the ask', seed: SEED }).deal.filter(
    (entry) => entry.nodeId === 'judge' && entry.pass === round,
  )

describe('a bracket', () => {
  it('deals one match per pair of entrants, not one run per entrant', () => {
    const first = matchesOf(attempts(['a', 'b', 'c', 'd']), 0)
    expect(first).toHaveLength(2)
  })

  it('shows each judge both sides, and each side is a whole entrant', () => {
    const [match] = matchesOf(attempts(['alpha', 'beta']), 0)
    expect(match?.task).toMatch(/^which is better for the ask — (alpha|beta) or (alpha|beta)\?$/)
    expect(match?.task).toContain('alpha')
    expect(match?.task).toContain('beta')
  })

  it('names the pair on the row, so two matches are told apart in the journal', () => {
    const [match] = matchesOf(attempts(['alpha', 'beta']), 0)
    expect(['alpha ⟂ beta', 'beta ⟂ alpha']).toContain(match?.item)
  })

  /**
   * The seeding property, asserted the only way it can be: the same entrants, written in the
   * opposite order, meet the same opponents. A bracket that paired by list position would give
   * the first-written attempt the same short path every time.
   */
  it('pairs by the seed rather than by the order the entrants were written', () => {
    const pairsOf = (results: readonly string[]) =>
      matchesOf(attempts(results), 0)
        .map((match) => [match.task.match(/— (.*) or (.*)\?$/)?.slice(1, 3) ?? []])
        .map(([pair]) => [...(pair ?? [])].sort().join('/'))
        .sort()
    // Rotated rather than reversed: reversing four entrants pairs them the same way even by
    // list position, so it would pass against the bias this is asserting is gone.
    expect(pairsOf(['a', 'b', 'c', 'd'])).toEqual(pairsOf(['b', 'c', 'd', 'a']))
  })

  it('sits one entrant out rather than paying for a match against nothing', () => {
    expect(matchesOf(attempts(['a', 'b', 'c']), 0)).toHaveLength(1)
  })

  it('does not deal the second round until the first has settled', () => {
    const steps = [...attempts(['a', 'b', 'c', 'd']), step('judge', { itemIndex: 0, answer: { winner: 'left', why: 'w' } })]
    expect(matchesOf(steps, 1)).toHaveLength(0)
    expect(plan(tournament, steps).done).toBe(false)
  })

  it('advances the winners and pairs them in the next round', () => {
    const first = matchesOf(attempts(['a', 'b', 'c', 'd']), 0)
    const steps = [
      ...attempts(['a', 'b', 'c', 'd']),
      ...first.map((match) =>
        step('judge', { itemIndex: match.itemIndex, answer: { winner: 'left', why: 'w' } }),
      ),
    ]
    const second = matchesOf(steps, 1)
    expect(second).toHaveLength(1)
    const winners = first.map((match) => match.task.match(/— (.*) or/)?.[1])
    for (const winner of winners) expect(second[0]?.task).toContain(String(winner))
  })

  it('hands the champion down as an answer the step below reads', () => {
    const state = (results: readonly string[]) => {
      let steps: WorkflowStepState[] = attempts(results)
      for (let round = 0; round < 4; round += 1) {
        const matches = matchesOf(steps, round)
        if (matches.length === 0) break
        steps = [
          ...steps,
          ...matches.map((match) =>
            step('judge', {
              pass: round,
              itemIndex: match.itemIndex,
              answer: { winner: 'right', why: `round ${round}` },
            }),
          ),
        ]
      }
      return steps
    }
    const steps = state(['a', 'b', 'c', 'd'])
    const ship = nextWorkflowActions({
      graph: tournament,
      steps,
      input: 'the ask',
      seed: SEED,
    }).deal.find((entry) => entry.nodeId === 'ship')
    expect(ship).toBeDefined()
    expect(ship?.task).toMatch(/^carry out [abcd], chosen because round 1$/)
  })

  /**
   * The rule that keeps a bracket evidence rather than a rosette: a refusal advances nobody, so
   * a champion is always something a judge actually chose.
   */
  it('advances nobody out of a match that answered nothing', () => {
    const first = matchesOf(attempts(['a', 'b', 'c', 'd']), 0)
    const steps = [
      ...attempts(['a', 'b', 'c', 'd']),
      step('judge', { itemIndex: first[0]!.itemIndex, status: 'refused', answer: null }),
      step('judge', { itemIndex: first[1]!.itemIndex, answer: { winner: 'left', why: 'w' } }),
    ]
    // One survivor of four: the refused match sent neither of its entrants on.
    const ship = plan(tournament, steps)
    expect(matchesOf(steps, 1)).toHaveLength(0)
    expect(ship.deal.some((entry) => entry.nodeId === 'ship')).toBe(true)
  })

  it('treats a side outside the vocabulary as a match that judged nothing', () => {
    const first = matchesOf(attempts(['a', 'b']), 0)
    const steps = [
      ...attempts(['a', 'b']),
      step('judge', { itemIndex: first[0]!.itemIndex, answer: { winner: 'the second one', why: 'w' } }),
    ]
    const outcome = nextWorkflowActions({ graph: tournament, steps, input: 'x', seed: SEED })
    expect(outcome.deal.some((entry) => entry.nodeId === 'ship')).toBe(false)
    expect(outcome.skip.some((entry) => entry.nodeId === 'ship')).toBe(true)
    expect(outcome.skip.find((entry) => entry.nodeId === 'ship')?.reason).toContain('no champion')
  })

  it('carries a lone entrant through without a match, rather than losing the work', () => {
    const steps = attempts(['only one'])
    const outcome = nextWorkflowActions({ graph: tournament, steps, input: 'x', seed: SEED })
    expect(outcome.deal.filter((entry) => entry.nodeId === 'judge')).toHaveLength(0)
    const ship = outcome.deal.find((entry) => entry.nodeId === 'ship')
    expect(ship?.task).toBe('carry out only one, chosen because ')
  })

  it('is not done while its entrants are still being made', () => {
    const outcome = nextWorkflowActions({
      graph: tournament,
      steps: [step('approaches', { answer: { approaches: ['x', 'y'] } })],
      input: 'x',
      seed: SEED,
    })
    expect(outcome.done).toBe(false)
  })

  it('closes as failed when every attempt was refused, rather than running forever', () => {
    const steps = [
      step('approaches', { answer: { approaches: ['x', 'y'] } }),
      step('attempt', { itemIndex: 0, status: 'refused', answer: null }),
      step('attempt', { itemIndex: 1, status: 'refused', answer: null }),
      step('attempted', { answer: {} }),
    ]
    const outcome = nextWorkflowActions({ graph: tournament, steps, input: 'x', seed: SEED })
    expect(outcome.deal.filter((entry) => entry.nodeId === 'judge')).toHaveLength(0)
    expect(outcome.skip.some((entry) => entry.nodeId === 'ship')).toBe(true)
  })

  it('seats two executions of one shape differently, given different seeds', () => {
    const pairing = (seed: string) =>
      nextWorkflowActions({
        graph: tournament,
        steps: attempts(['a', 'b', 'c', 'd', 'e', 'f']),
        input: 'x',
        seed,
      })
        .deal.filter((entry) => entry.nodeId === 'judge')
        .map((entry) => entry.task)
        .join('|')
    const seeds = new Set(
      Array.from({ length: 12 }, (_unused, at) => pairing(`execution-${at}`)),
    )
    expect(seeds.size).toBeGreaterThan(1)
  })
})
