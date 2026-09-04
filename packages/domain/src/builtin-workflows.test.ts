import { describe, expect, it } from 'vitest'
import { BUILTIN_WORKFLOWS } from './builtin-workflows.js'
import { BUILTIN_PERSONAS } from './builtin-personas.js'
import { laneSources, nextWorkflowActions } from './workflow-executor.js'
import { fanningOf, isRunNode, parseWorkflowGraph, workflowStages } from './workflow-graph.js'

/**
 * The shipped harnesses, put through the same gate an operator's would go through.
 *
 * These fail a build rather than a workspace's first login, which is the point: a shipped shape
 * that the validator refuses would arrive as an empty workflow list and a log line nobody reads.
 */

const shipped = BUILTIN_PERSONAS.map((persona) => persona.name)

describe('BUILTIN_WORKFLOWS', () => {
  it('ships the five named shapes, each with a line about when to reach for it', () => {
    expect(BUILTIN_WORKFLOWS.map((workflow) => workflow.name)).toEqual([
      'deep research',
      'code review',
      'security analysis',
      'agent team',
      'tournament',
      'migration sweep',
    ])
    for (const workflow of BUILTIN_WORKFLOWS) {
      expect(workflow.description.length).toBeGreaterThan(40)
    }
  })

  for (const workflow of BUILTIN_WORKFLOWS) {
    describe(workflow.name, () => {
      it('passes the validator every drawn shape passes', () => {
        const verdict = parseWorkflowGraph(workflow.graph)
        if (!verdict.ok) throw new Error(verdict.reason)
        expect(verdict.ok).toBe(true)
      })

      it('has lanes the executor can count', () => {
        const lanes = laneSources(workflow.graph)
        if (!lanes.ok) throw new Error(lanes.reason)
        expect(lanes.ok).toBe(true)
      })

      it('names only personas this platform ships', () => {
        for (const node of workflow.graph.nodes) {
          if (!isRunNode(node)) continue
          expect(shipped).toContain(node.persona)
        }
      })

      /** A shipped harness is the first one an operator runs, and its width is the one they keep. */
      it('keeps every fan narrow enough to be a first run', () => {
        for (const node of workflow.graph.nodes) {
          const fanning = fanningOf(node)
          if (fanning === null) continue
          expect(fanning.maxWidth).toBeLessThanOrEqual(6)
        }
      })

      it('starts from exactly one step, so a reader knows where it begins', () => {
        const starts = workflowStages(workflow.graph)[0] ?? []
        expect(starts).toHaveLength(1)
      })

      it('deals its first step and nothing else against an empty journal', () => {
        const plan = nextWorkflowActions({
          graph: workflow.graph,
          steps: [],
          input: 'the thing to work on',
        })
        expect(plan.deal).toHaveLength(1)
        expect(plan.done).toBe(false)
        // The execution's own input is interpolated, not left as braces for a model to read.
        expect(plan.deal[0]?.task).toContain('the thing to work on')
        expect(plan.deal[0]?.task).not.toContain('{{')
      })
    })
  }

  /**
   * The rule the surrogate verifier rests on, applied to the shipped set: measured stance
   * homogenization is worst where two agents share a model, so a refutation by the author is a
   * refutation that agrees.
   */
  it('never has a step checked or judged by the persona that wrote it', () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      const byId = new Map(workflow.graph.nodes.map((node) => [node.id, node]))
      for (const node of workflow.graph.nodes) {
        const read =
          node.kind === 'verifier' ? node.verifies : node.kind === 'bracket' ? node.entrants : null
        if (read === null) continue
        const author = byId.get(read)
        expect(author !== undefined && isRunNode(author) ? author.persona : null).not.toBe(
          isRunNode(node) ? node.persona : null,
        )
      }
    }
  })

  /**
   * The tournament earns its place only if the comparison is between the attempts themselves.
   * A bracket judging a summary somebody wrote of them would be a bracket judging the summary.
   */
  it('judges the attempts themselves rather than a collated list of them', () => {
    const tournament = BUILTIN_WORKFLOWS.find((workflow) => workflow.name === 'tournament')
    const bracket = tournament?.graph.nodes.find((node) => node.kind === 'bracket')
    expect(bracket?.kind === 'bracket' ? bracket.entrants : null).toBe('attempt')
    const attempt = tournament?.graph.nodes.find((node) => node.id === 'attempt')
    expect(attempt?.kind).toBe('fan')
    // Every attempt that ran can enter: a bracket narrower than the fan above it would judge
    // a subset and report a champion of the whole.
    const width = attempt !== undefined ? (fanningOf(attempt)?.maxWidth ?? 0) : 0
    expect(bracket?.kind === 'bracket' ? bracket.maxEntrants : 0).toBeGreaterThanOrEqual(width)
  })

  /**
   * The reported mistake in hand-written harnesses is waiting for every lane when only one
   * predecessor was needed, so a shipped set that put a barrier under every fan would teach it.
   */
  it('checks a migration site in its own lane rather than behind a barrier', () => {
    const sweep = BUILTIN_WORKFLOWS.find((workflow) => workflow.name === 'migration sweep')
    const lanes = laneSources(sweep!.graph)
    if (!lanes.ok) throw new Error(lanes.reason)
    expect(lanes.sources.get('verify')).toBe('transform')
  })
})
