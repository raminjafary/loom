import { describe, expect, it } from 'vitest'
import {
  canonicalWorkflow,
  describeWorkflowCost,
  loopedNodes,
  MAX_FAN_WIDTH,
  MAX_WORKFLOW_NODES,
  parseWorkflowGraph,
  templateReferences,
  workflowStages,
  type WorkflowGraph,
} from './workflow-graph.js'

/**
 * The gate, tested for the graphs that *look* fine.
 *
 * A malformed graph is caught by anything. What matters here is the shape that parses, draws
 * cleanly on a canvas, and would only misbehave once it was spending: a template reading an
 * answer that has not happened, a fan whose runs are all identical, a verifier grading its own
 * author, a loop edge that goes forwards, and a barrier that joins one lane.
 */

const refusal = (value: unknown): string => {
  const verdict = parseWorkflowGraph(value)
  if (verdict.ok) throw new Error('expected a refusal, got a graph')
  return verdict.reason
}

const accepted = (value: unknown): WorkflowGraph => {
  const verdict = parseWorkflowGraph(value)
  if (!verdict.ok) throw new Error(`expected a graph, got: ${verdict.reason}`)
  return verdict.graph
}

const step = (id: string, over: Record<string, unknown> = {}) => ({
  kind: 'step',
  id,
  title: id,
  persona: 'Worker',
  task: `do ${id}`,
  ...over,
})

const listAnswer = (name: string) => ({ fields: [{ kind: 'list', name }] })

/** discover -> transform each site -> a barrier -> report. The migration sweep, in miniature. */
const sweep = {
  nodes: [
    step('discover', { answer: listAnswer('sites') }),
    {
      kind: 'fan',
      id: 'transform',
      title: 'transform',
      persona: 'Worker',
      task: 'rewrite {{item}} the way {{discover}} describes',
      source: 'discover',
      over: 'sites',
      maxWidth: 8,
      answer: { fields: [{ kind: 'text', name: 'diff' }] },
    },
    step('lint', { task: 'lint the tree' }),
    { kind: 'barrier', id: 'all-done', title: 'every site transformed' },
    step('report', { task: 'write up {{transform.diff}}' }),
  ],
  edges: [
    { from: 'discover', to: 'transform' },
    { from: 'discover', to: 'lint' },
    { from: 'transform', to: 'all-done' },
    { from: 'lint', to: 'all-done' },
    { from: 'all-done', to: 'report' },
  ],
}

describe('templateReferences', () => {
  it('reads a whole answer and one field of it', () => {
    expect(templateReferences('use {{a}} and {{b.claims}}')).toEqual([
      { node: 'a', field: null },
      { node: 'b', field: 'claims' },
    ])
  })

  it('ignores prose that is not a reference', () => {
    expect(templateReferences('two braces {{ }} and a { single }')).toEqual([])
  })
})

describe('parseWorkflowGraph', () => {
  it('accepts a fan into a barrier', () => {
    expect(accepted(sweep).nodes).toHaveLength(5)
  })

  it('refuses a vocabulary it cannot enumerate', () => {
    expect(refusal({ nodes: [{ ...step('a'), kind: 'subagent' }], edges: [] })).toContain(
      'the vocabulary is step, fan, router, verifier and barrier',
    )
  })

  it('refuses two nodes with one id', () => {
    expect(refusal({ nodes: [step('a'), step('a')], edges: [] })).toContain('share the id "a"')
  })

  it('refuses an edge to a node that is not there', () => {
    expect(refusal({ nodes: [step('a')], edges: [{ from: 'a', to: 'ghost' }] })).toContain(
      'which is not a node',
    )
  })

  it('names the loop when a graph cycles without a loop edge', () => {
    const reason = refusal({
      nodes: [step('a'), step('b'), step('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    })
    expect(reason).toContain('"a" -> "b" -> "c"')
    expect(reason).toContain('has to be drawn as one')
  })

  it('refuses more nodes than a person can review', () => {
    const nodes = Array.from({ length: MAX_WORKFLOW_NODES + 1 }, (_, at) => step(`n${at}`))
    expect(refusal({ nodes, edges: [] })).toContain(`at most ${MAX_WORKFLOW_NODES} nodes`)
  })

  describe('a template may only read an ancestor', () => {
    it('refuses a step reading a sibling lane', () => {
      expect(
        refusal({
          nodes: [step('a', { answer: { fields: [{ kind: 'text', name: 'note' }] } }), step('b', { task: 'read {{a.note}}' })],
          edges: [],
        }),
      ).toContain('not one of its ancestors')
    })

    it('refuses a field the ancestor does not answer', () => {
      expect(
        refusal({
          nodes: [step('a', { answer: { fields: [{ kind: 'text', name: 'note' }] } }), step('b', { task: 'read {{a.other}}' })],
          edges: [{ from: 'a', to: 'b' }],
        }),
      ).toContain('which "a" does not answer')
    })

    it('accepts a grandchild reading its grandparent', () => {
      expect(
        accepted({
          nodes: [
            step('a', { answer: { fields: [{ kind: 'text', name: 'note' }] } }),
            step('b'),
            step('c', { task: 'read {{a.note}}' }),
          ],
          edges: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
          ],
        }).nodes,
      ).toHaveLength(3)
    })
  })

  describe('fan', () => {
    it('refuses a fan whose runs would all be identical', () => {
      expect(
        refusal({
          nodes: [
            step('discover', { answer: listAnswer('sites') }),
            { ...sweep.nodes[1], task: 'rewrite every site' },
          ],
          edges: [{ from: 'discover', to: 'transform' }],
        }),
      ).toContain('every one of those runs would be given the same instructions')
    })

    it('refuses fanning over something that is not a list', () => {
      expect(
        refusal({
          nodes: [
            step('discover', { answer: { fields: [{ kind: 'text', name: 'sites' }] } }),
            sweep.nodes[1],
          ],
          edges: [{ from: 'discover', to: 'transform' }],
        }),
      ).toContain('is a text and not a list')
    })

    it('refuses a width no human chose', () => {
      expect(
        refusal({
          nodes: [step('discover', { answer: listAnswer('sites') }), { ...sweep.nodes[1], maxWidth: MAX_FAN_WIDTH + 1 }],
          edges: [{ from: 'discover', to: 'transform' }],
        }),
      ).toContain(`${MAX_FAN_WIDTH} is the ceiling`)
    })

    it('refuses {{item}} in a step that does not run per item', () => {
      expect(refusal({ nodes: [step('a', { task: 'do {{item}}' })], edges: [] })).toContain(
        'does not run once per item',
      )
    })
  })

  describe('verifier', () => {
    const author = step('claims', {
      persona: 'Researcher',
      answer: { fields: [{ kind: 'list', name: 'findings' }] },
    })

    it('refuses an author who refutes itself', () => {
      expect(
        refusal({
          nodes: [
            author,
            {
              kind: 'verifier',
              id: 'refute',
              title: 'refute',
              persona: 'Researcher',
              task: 'refute {{item}}',
              verifies: 'claims',
              over: 'findings',
              maxWidth: 4,
            },
          ],
          edges: [{ from: 'claims', to: 'refute' }],
        }),
      ).toContain('An author does not refute itself')
    })

    it('refuses a per-item verifier with no width, since the audited step wrote the list', () => {
      expect(
        refusal({
          nodes: [
            author,
            {
              kind: 'verifier',
              id: 'refute',
              title: 'refute',
              persona: 'Skeptic',
              task: 'refute {{item}}',
              verifies: 'claims',
              over: 'findings',
            },
          ],
          edges: [{ from: 'claims', to: 'refute' }],
        }),
      ).toContain('needs a whole `maxWidth`')
    })

    it('accepts a different persona refuting one finding at a time', () => {
      expect(
        accepted({
          nodes: [
            author,
            {
              kind: 'verifier',
              id: 'refute',
              title: 'refute',
              persona: 'Skeptic',
              task: 'refute {{item}}',
              verifies: 'claims',
              over: 'findings',
              maxWidth: 4,
            },
          ],
          edges: [{ from: 'claims', to: 'refute' }],
        }).nodes,
      ).toHaveLength(2)
    })
  })

  describe('router', () => {
    const router = (over: Record<string, unknown> = {}) => ({
      kind: 'router',
      id: 'triage',
      title: 'triage',
      persona: 'Triager',
      task: 'classify it',
      choices: ['bug', 'feature'],
      ...over,
    })

    it('refuses a declared choice no edge takes', () => {
      expect(
        refusal({
          nodes: [router(), step('fix')],
          edges: [{ from: 'triage', to: 'fix', when: 'bug' }],
        }),
      ).toContain('declares the choice "feature" and no edge takes it')
    })

    it('refuses a choice label on an edge out of something that is not a router', () => {
      expect(
        refusal({
          nodes: [step('a'), step('b')],
          edges: [{ from: 'a', to: 'b', when: 'bug' }],
        }),
      ).toContain('is not a router')
    })

    it('accepts one edge per choice', () => {
      expect(
        accepted({
          nodes: [router(), step('fix'), step('build')],
          edges: [
            { from: 'triage', to: 'fix', when: 'bug' },
            { from: 'triage', to: 'build', when: 'feature' },
          ],
        }).edges,
      ).toHaveLength(2)
    })
  })

  describe('barrier', () => {
    it('refuses a bar across a single lane', () => {
      expect(
        refusal({
          nodes: [step('a'), { kind: 'barrier', id: 'wait', title: 'wait' }, step('b')],
          edges: [
            { from: 'a', to: 'wait' },
            { from: 'wait', to: 'b' },
          ],
        }),
      ).toContain('joins fewer than two lanes')
    })
  })

  describe('loop', () => {
    const loop = (over: Record<string, unknown> = {}) => ({
      nodes: [
        step('draft', { answer: { fields: [{ kind: 'flag', name: 'done' }] } }),
        step('critique', { answer: { fields: [{ kind: 'flag', name: 'settled' }] } }),
      ],
      edges: [
        { from: 'draft', to: 'critique' },
        { from: 'critique', to: 'draft', loop: { until: 'settled' }, ...over },
      ],
    })

    it('accepts an edge back to an ancestor with a flag to stop on', () => {
      expect(accepted(loop()).edges).toHaveLength(2)
    })

    it('refuses a forward edge wearing a loop label', () => {
      expect(
        refusal({
          nodes: [step('a', { answer: { fields: [{ kind: 'flag', name: 'done' }] } }), step('b')],
          edges: [{ from: 'a', to: 'b', loop: { until: 'done' } }],
        }),
      ).toContain("a forward edge wearing a loop's label")
    })

    it('refuses stopping on something that is not a flag', () => {
      expect(
        refusal({
          nodes: [
            step('draft'),
            step('critique', { answer: { fields: [{ kind: 'text', name: 'settled' }] } }),
          ],
          edges: [
            { from: 'draft', to: 'critique' },
            { from: 'critique', to: 'draft', loop: { until: 'settled' } },
          ],
        }),
      ).toContain('is a text and not a flag')
    })

    it('refuses a node inside two loops, which has no single pass number', () => {
      expect(
        refusal({
          nodes: [
            step('a'),
            step('b', { answer: { fields: [{ kind: 'flag', name: 'done' }] } }),
            step('c', { answer: { fields: [{ kind: 'flag', name: 'done' }] } }),
          ],
          edges: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
            { from: 'b', to: 'a', loop: { until: 'done' } },
            { from: 'c', to: 'a', loop: { until: 'done' } },
          ],
        }),
      ).toContain('inside more than one loop')
    })

    it('refuses stopping on a field the looping node does not answer', () => {
      expect(
        refusal({
          nodes: [step('draft'), step('critique')],
          edges: [
            { from: 'draft', to: 'critique' },
            { from: 'critique', to: 'draft', loop: { until: 'settled' } },
          ],
        }),
      ).toContain('which "critique" does not answer')
    })
  })
})

describe('a barrier answers nothing of its own', () => {
  it('refuses a template that reads one', () => {
    expect(
      refusal({
        nodes: [
          step('a'),
          step('b'),
          { kind: 'barrier', id: 'wait', title: 'wait' },
          step('c', { task: 'read {{wait}}' }),
        ],
        edges: [
          { from: 'a', to: 'wait' },
          { from: 'b', to: 'wait' },
          { from: 'wait', to: 'c' },
        ],
      }),
    ).toContain('Name the step above it')
  })
})

describe('workflowStages', () => {
  it('puts the lanes that start together in one wave and the barrier after both', () => {
    expect(workflowStages(accepted(sweep))).toEqual([
      ['discover'],
      ['transform', 'lint'],
      ['all-done'],
      ['report'],
    ])
  })
})

describe('loopedNodes', () => {
  it('includes the steps between the loop edge and its target, not only the two ends', () => {
    const graph = accepted({
      nodes: [
        step('draft'),
        step('review'),
        step('decide', { answer: { fields: [{ kind: 'flag', name: 'settled' }] } }),
      ],
      edges: [
        { from: 'draft', to: 'review' },
        { from: 'review', to: 'decide' },
        { from: 'decide', to: 'draft', loop: { until: 'settled' } },
      ],
    })
    expect([...loopedNodes(graph)].sort()).toEqual(['decide', 'draft', 'review'])
  })

  it('is empty for a graph with no loop', () => {
    expect(loopedNodes(accepted(sweep)).size).toBe(0)
  })
})

describe('describeWorkflowCost', () => {
  const costs = (usd: number | null) =>
    accepted(sweep).nodes.map((node) => ({ id: node.id, budgetCapUsd: usd }))

  it('multiplies a fan by the width a human chose', () => {
    // discover 1 + transform 8 + lint 1 + report 1, at $1 each.
    expect(describeWorkflowCost(accepted(sweep), costs(1))).toContain('$11.00')
  })

  it('names the fan and its bound rather than only the total', () => {
    expect(describeWorkflowCost(accepted(sweep), costs(1))).toContain(
      'runs once per item of discover.sites, up to 8 times',
    )
  })

  it('refuses to sum around an uncapped persona', () => {
    expect(describeWorkflowCost(accepted(sweep), costs(null))).toContain('unbounded')
  })

  it('says when nothing waits for everything', () => {
    const graph = accepted({ nodes: [step('a'), step('b')], edges: [{ from: 'a', to: 'b' }] })
    expect(describeWorkflowCost(graph, [
      { id: 'a', budgetCapUsd: 1 },
      { id: 'b', budgetCapUsd: 1 },
    ])).toContain('no barrier')
  })
})

describe('canonicalWorkflow', () => {
  const base = {
    nodes: [step('a', { answer: { fields: [{ kind: 'text', name: 'note' }] } }), step('b')],
    edges: [{ from: 'a', to: 'b' }],
  }

  it('does not depend on the order nodes or fields were drawn in', () => {
    const reordered = {
      nodes: [step('b'), step('a', { answer: { fields: [{ kind: 'text', name: 'note' }] } })],
      edges: [{ from: 'a', to: 'b' }],
    }
    expect(canonicalWorkflow(accepted(base))).toBe(canonicalWorkflow(accepted(reordered)))
  })

  it('changes when a task changes, because a task is part of the shape', () => {
    const edited = {
      ...base,
      nodes: [base.nodes[0], step('b', { task: 'do b differently' })],
    }
    expect(canonicalWorkflow(accepted(base))).not.toBe(canonicalWorkflow(accepted(edited)))
  })

  it('separates fields a hand-rolled join could run together', () => {
    const left = accepted({ nodes: [step('a', { task: 'x' }), step('b', { task: 'yz' })], edges: [] })
    const right = accepted({ nodes: [step('a', { task: 'xy' }), step('b', { task: 'z' })], edges: [] })
    expect(canonicalWorkflow(left)).not.toBe(canonicalWorkflow(right))
  })
})
