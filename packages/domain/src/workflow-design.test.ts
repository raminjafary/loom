import { describe, expect, it } from 'vitest'
import type { PersonaSpec } from './agents.js'
import {
  describeEscalations,
  describeWorkflowVocabulary,
  designEscalations,
  renderDesignerBrief,
  summarizeWorkflowShape,
} from './workflow-design.js'
import { parseWorkflowGraph, type WorkflowGraph } from './workflow-graph.js'

/**
 * The designer's rules, which are two: what a proposal may name, and what a designer is told.
 *
 * The first is the security half — a shape is capability, so a designer that could name any
 * persona could grant a shell by drawing. The second is the reason the whole thing is a
 * conversation rather than a form, and its failure mode is silent: a vocabulary a designer is
 * told about that is not the vocabulary the validator enforces produces proposals that are
 * refused on arrival, forever.
 */

const spec = (over: Partial<PersonaSpec> = {}): PersonaSpec => ({
  name: 'designer',
  systemPrompt: '',
  model: 'claude-opus-5',
  tools: ['Read', 'Grep', 'Glob'],
  approvalMode: 'auto',
  budgetCapUsd: null,
  planner: true,
  delegates: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
  ...over,
})

const graphOf = (persona: string): WorkflowGraph => {
  const verdict = parseWorkflowGraph({
    nodes: [
      {
        kind: 'step',
        id: 'one',
        title: 'one',
        persona: 'designer',
        task: 'scope {{input}}',
        answer: { fields: [{ kind: 'list', name: 'parts' }] },
      },
      {
        kind: 'fan',
        id: 'work',
        title: 'work',
        persona,
        task: 'do {{item}}',
        source: 'one',
        over: 'parts',
        maxWidth: 3,
        answer: null,
      },
    ],
    edges: [{ from: 'one', to: 'work' }],
  })
  if (!verdict.ok) throw new Error(verdict.reason)
  return verdict.graph
}

describe('designEscalations', () => {
  it('passes a shape whose personas are inside the designer’s envelope', () => {
    const escalations = designEscalations({
      designer: spec(),
      graph: graphOf('worker'),
      personas: [spec(), spec({ name: 'worker', planner: false, tools: ['Read', 'Edit'] })],
      remainingDepth: 1,
    })
    expect(escalations).toEqual([])
  })

  /**
   * The escalation the whole file exists for: a designer that holds no shell and may not hand
   * one down must not be able to mint a harness whose every run has one.
   */
  it('refuses a step that runs a persona holding a tool the designer may not hand down', () => {
    const escalations = designEscalations({
      designer: spec(),
      graph: graphOf('shell-worker'),
      personas: [
        spec(),
        spec({ name: 'shell-worker', planner: false, tools: ['Read', 'Bash'] }),
      ],
      remainingDepth: 1,
    })
    expect(escalations).toHaveLength(1)
    expect(escalations[0]?.nodeId).toBe('work')
    expect(escalations[0]?.refusals.map((refusal) => refusal.rule)).toContain('tools')
    expect(describeEscalations(escalations)).toContain('Bash')
    // And it names what would have to change rather than only that it will not.
    expect(describeEscalations(escalations)).toContain('widened by a person')
  })

  it('refuses a persona that may skip more approvals than the designer', () => {
    const escalations = designEscalations({
      designer: spec({ approvalMode: 'ask' }),
      graph: graphOf('worker'),
      personas: [
        spec({ approvalMode: 'ask' }),
        spec({ name: 'worker', planner: false, tools: ['Read'], approvalMode: 'auto' }),
      ],
      remainingDepth: 1,
    })
    expect(escalations[0]?.refusals.map((refusal) => refusal.rule)).toContain('autoApprove')
  })

  it('refuses a persona above the designer’s own model tier', () => {
    const escalations = designEscalations({
      designer: spec({ model: 'claude-haiku-4-5-20251001' }),
      graph: graphOf('worker'),
      personas: [
        spec({ model: 'claude-haiku-4-5-20251001' }),
        spec({ name: 'worker', planner: false, tools: ['Read'], model: 'claude-opus-5' }),
      ],
      remainingDepth: 1,
    })
    expect(escalations[0]?.refusals.map((refusal) => refusal.rule)).toContain('model')
  })

  /**
   * A persona the workspace does not have is not an escalation — it is a shape drawn against
   * another workspace's roster, and the validator that owns that refusal says so in its own
   * words. Two answers to one question is how a designer gets told the wrong thing.
   */
  it('says nothing about a persona this workspace does not have', () => {
    expect(
      designEscalations({
        designer: spec(),
        graph: graphOf('nobody-here'),
        personas: [spec()],
        remainingDepth: 1,
      }),
    ).toEqual([])
  })
})

describe('describeWorkflowVocabulary', () => {
  /**
   * The drift this is built against: a node kind the validator accepts and the brief never
   * mentions is a kind no designer will ever draw. The `Record` over the union is what makes
   * that a compile error; this is the runtime half of the same check.
   */
  it('describes every node kind the validator accepts', () => {
    const text = describeWorkflowVocabulary()
    for (const kind of ['step', 'fan', 'router', 'verifier', 'bracket', 'barrier']) {
      expect(text).toContain(`\`${kind}\``)
    }
  })

  it('states the bounds as the numbers the validator enforces', () => {
    const text = describeWorkflowVocabulary()
    expect(text).toContain('at most 16')
    expect(text).toContain('at most 8')
    expect(text).toContain('at most 24 nodes')
    expect(text).toContain('5 times')
  })

  it('tells a designer that a plain edge is the default rather than a barrier', () => {
    expect(describeWorkflowVocabulary()).toContain('pipeline')
  })
})

describe('summarizeWorkflowShape', () => {
  it('reads as what happens, then what, with the lanes marked', () => {
    expect(summarizeWorkflowShape(graphOf('worker'))).toBe('one → work(×3)')
  })
})

describe('renderDesignerBrief', () => {
  const brief = (over: Partial<Parameters<typeof renderDesignerBrief>[0]> = {}) =>
    renderDesignerBrief({
      ask: 'something for triaging flaky tests',
      designerName: 'workflow-designer',
      available: [
        {
          name: 'swe',
          description: 'implements a scoped change',
          model: 'claude-sonnet-5',
          tools: ['Read', 'Edit'],
        },
      ],
      refused: [],
      existing: [],
      ...over,
    })

  it('carries the ask verbatim rather than a paraphrase of it', () => {
    expect(brief()).toContain('something for triaging flaky tests')
  })

  it('names what each persona holds, so a shape is drawn against real tools', () => {
    expect(brief()).toContain('swe (claude-sonnet-5; Read, Edit)')
  })

  /**
   * A designer that finds out at submission submits four times. The refused list is the
   * difference between one round trip and several, and every round trip is a paid run.
   */
  it('names the personas it may not use, with the reason, before it draws', () => {
    const text = brief({ refused: [{ name: 'ops', why: 'holds Bash, which is outside your envelope' }] })
    expect(text).toContain('may NOT name')
    expect(text).toContain('outside your envelope')
  })

  it('offers the answer that costs nothing when the workspace already has the shape', () => {
    const text = brief({
      existing: [{ name: 'code review', version: 2, shape: 'dimensions → review(×4) → [reviewed]' }],
    })
    expect(text).toContain('"code review" (v2)')
    expect(text).toContain('submit nothing')
    // And that reusing the name is what makes a proposal a new version rather than a rival.
    expect(text).toContain('same name means a new version')
  })

  it('says plainly that nothing it submits runs', () => {
    expect(brief()).toContain('Nothing you submit runs')
  })
})
