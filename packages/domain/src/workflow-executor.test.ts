import { describe, expect, it } from 'vitest'
import {
  laneSources,
  nextWorkflowActions,
  parseWorkflowAnswer,
  renderWorkflowTask,
  resolveRouterChoice,
  ROUTER_FIELD,
  workflowMayStart,
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
  status: 'answered',
  answer: {},
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
          id: 'left',
          title: 'left',
          persona: 'W',
          task: 'do {{item}}',
          source: 'seed',
          over: 'xs',
          maxWidth: 4,
          answer: null,
        },
        {
          kind: 'fan',
          id: 'right',
          title: 'right',
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
        { from: 'seed', to: 'left' },
        { from: 'seed', to: 'right' },
        { from: 'left', to: 'join' },
        { from: 'right', to: 'join' },
      ],
    })
    const lanes = laneSources(graph)
    expect(lanes.ok).toBe(false)
    if (!lanes.ok) expect(lanes.reason).toContain('2 different fans (left, right)')
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
