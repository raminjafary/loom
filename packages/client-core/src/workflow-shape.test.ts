import { describe, expect, it } from 'vitest'
import {
  describeWorkflowProgress,
  layoutWorkflow,
  stateOf,
  type WorkflowStepRow,
} from './workflow-shape.js'

/**
 * The reader, tested for the two things a viewer of a drawn shape gets wrong: putting a node in
 * the wrong stage, and collapsing lanes that disagree into one word.
 */

const graph = {
  nodes: [
    { kind: 'step', id: 'discover', title: 'Find the sites', persona: 'scout' },
    {
      kind: 'fan',
      id: 'transform',
      title: 'Change each',
      persona: 'hand',
      source: 'discover',
      over: 'sites',
      maxWidth: 3,
    },
    { kind: 'step', id: 'lint', title: 'Lint', persona: 'hand' },
    { kind: 'barrier', id: 'swept', title: 'Every site done' },
    { kind: 'step', id: 'report', title: 'Report', persona: 'scout' },
  ],
  edges: [
    { from: 'discover', to: 'transform' },
    { from: 'discover', to: 'lint' },
    { from: 'transform', to: 'swept' },
    { from: 'lint', to: 'swept' },
    { from: 'swept', to: 'report' },
  ],
}

const step = (over: Partial<WorkflowStepRow> & { nodeId: string }): WorkflowStepRow => ({
  pass: 0,
  itemIndex: 0,
  item: null,
  status: 'answered',
  agentRunId: 'run_1',
  reason: null,
  costUsd: null,
  ...over,
})

describe('layoutWorkflow', () => {
  it('puts the lanes that start together in one column and the barrier after both', () => {
    const shape = layoutWorkflow(graph)
    const at = (id: string) => shape.nodes.find((node) => node.id === id)
    expect(at('transform')?.x).toBe(at('lint')?.x)
    expect(at('transform')?.y).not.toBe(at('lint')?.y)
    expect(at('swept')?.x).toBeGreaterThan(at('transform')!.x)
    expect(at('report')?.x).toBeGreaterThan(at('swept')!.x)
  })

  it('draws a barrier as a bar rather than a box', () => {
    const shape = layoutWorkflow(graph)
    const barrier = shape.nodes.find((node) => node.id === 'swept')
    const ordinary = shape.nodes.find((node) => node.id === 'report')
    expect(barrier!.height).toBeLessThan(ordinary!.height)
  })

  it('says what makes a node open lanes, and how wide it may get', () => {
    const shape = layoutWorkflow(graph)
    expect(shape.nodes.find((node) => node.id === 'transform')?.fans).toBe(
      'discover.sites, up to 3',
    )
    expect(shape.nodes.find((node) => node.id === 'lint')?.fans).toBeNull()
  })

  it('renders a shape it only partly recognizes rather than refusing to draw', () => {
    const shape = layoutWorkflow({
      nodes: [{ kind: 'something-new', id: 'a', title: 'A' }, { id: 'b' }],
      edges: [{ from: 'a', to: 'b' }],
    })
    expect(shape.nodes.map((node) => node.kind)).toEqual(['unknown', 'unknown'])
    // A node with no title is named by its id rather than drawn blank.
    expect(shape.nodes[1]?.title).toBe('b')
  })

  it('is empty rather than broken for a graph it cannot read at all', () => {
    expect(layoutWorkflow(null).nodes).toEqual([])
    expect(layoutWorkflow({ nodes: 'not an array' }).nodes).toEqual([])
  })

  it('routes a loop edge under the shape rather than back through every stage', () => {
    const shape = layoutWorkflow({
      nodes: [
        { kind: 'step', id: 'draft', title: 'Draft', persona: 'a' },
        { kind: 'step', id: 'critique', title: 'Critique', persona: 'b' },
      ],
      edges: [
        { from: 'draft', to: 'critique' },
        { from: 'critique', to: 'draft', loop: { until: 'settled' } },
      ],
    })
    const back = shape.edges.find((edge) => edge.loop)
    expect(back).toBeDefined()
    expect(back?.path).not.toBe(shape.edges.find((edge) => !edge.loop)?.path)
  })

  it('carries a router branch label onto the edge that takes it', () => {
    const shape = layoutWorkflow({
      nodes: [
        { kind: 'router', id: 'triage', title: 'Triage', persona: 'a' },
        { kind: 'step', id: 'fix', title: 'Fix', persona: 'b' },
      ],
      edges: [{ from: 'triage', to: 'fix', when: 'bug' }],
    })
    expect(shape.edges[0]?.label).toBe('bug')
  })

  describe('with an execution under it', () => {
    const steps: WorkflowStepRow[] = [
      step({ nodeId: 'discover', costUsd: 0.4 }),
      step({ nodeId: 'transform', itemIndex: 0, item: 'a', costUsd: 0.2 }),
      step({ nodeId: 'transform', itemIndex: 1, item: 'b', status: 'refused', costUsd: 0.1 }),
      step({ nodeId: 'transform', itemIndex: 2, item: 'c', status: 'running', agentRunId: 'r3' }),
    ]

    it('lists a node’s lanes in lane order, so a reader can point at one', () => {
      const shape = layoutWorkflow(graph, steps)
      const fan = shape.nodes.find((node) => node.id === 'transform')
      expect(fan?.lanes.map((lane) => lane.item)).toEqual(['a', 'b', 'c'])
    })

    it('sums what a node has cost across its lanes', () => {
      const shape = layoutWorkflow(graph, steps)
      expect(shape.nodes.find((node) => node.id === 'transform')?.costUsd).toBeCloseTo(0.3)
      // Null rather than zero for a node nothing has spent on: they are different facts.
      expect(shape.nodes.find((node) => node.id === 'report')?.costUsd).toBeNull()
    })

    it('leaves a node nothing has been dealt for as waiting', () => {
      const shape = layoutWorkflow(graph, steps)
      expect(shape.nodes.find((node) => node.id === 'report')?.state).toBe('waiting')
    })
  })
})

describe('stateOf', () => {
  it('is running while any lane is', () => {
    expect(
      stateOf([step({ nodeId: 'a' }), step({ nodeId: 'a', status: 'running' })]),
    ).toBe('running')
  })

  /** A fan's ordinary end state is disagreement, and either single word for it would be a lie. */
  it('is mixed when settled lanes disagree', () => {
    expect(
      stateOf([step({ nodeId: 'a' }), step({ nodeId: 'a', status: 'refused' })]),
    ).toBe('mixed')
  })

  it('is the one status when every lane agrees', () => {
    expect(stateOf([step({ nodeId: 'a', status: 'skipped' })])).toBe('skipped')
  })
})

describe('describeWorkflowProgress', () => {
  it('counts lanes rather than nodes, because a fan of six is six runs', () => {
    const line = describeWorkflowProgress([
      step({ nodeId: 'a' }),
      step({ nodeId: 'b', itemIndex: 0 }),
      step({ nodeId: 'b', itemIndex: 1, status: 'refused' }),
      step({ nodeId: 'c', status: 'skipped' }),
    ])
    expect(line).toBe('4 step(s): 2 answered, 1 refused, 1 not taken.')
  })

  it('says so plainly when nothing has been dealt', () => {
    expect(describeWorkflowProgress([])).toBe('Nothing dealt yet.')
  })
})
