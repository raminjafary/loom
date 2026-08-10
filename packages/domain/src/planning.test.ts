import { describe, expect, it } from 'vitest'
import { asAgentRunId } from './ids.js'
import {
 MAX_SUBTASKS,
 parseDecomposition,
 summarizeChildOutcomes,
 type ChildOutcome,
} from './planning.js'

/**
 * The risk register names "vague delegation" as a risk and "schema-validated
 * decomposition, both directions" as its mitigation. These cover both legs: what
 * a Planner is allowed to ask for, and what its children are reported to have
 * done.
 */

const subtask = (over: Record<string, unknown> = {}) => ({
 title: 'Add docs',
 task: 'Write docs/api.md describing the exported functions.',
 personaName: 'swe',
...over,
})

describe('parseDecomposition', => {
 it('accepts a well-formed plan and trims its fields', => {
 const verdict = parseDecomposition({ subtasks: [subtask({ title: ' Add docs ' })] })
 expect(verdict.ok).toBe(true)
 if (!verdict.ok) return
 expect(verdict.decomposition.subtasks[0]?.title).toBe('Add docs')
 })

 /**
 * Every rejection names the offending subtask. A Planner told only "invalid
 * plan" learns nothing and produces the same thing again — being able to say
 * what was wrong is the point of validating rather than guessing.
 */
 it('names the offending subtask in every rejection', => {
 const cases: [unknown, RegExp][] = [
 [{ subtasks: [subtask({ title: '' })] }, /Subtask 0/],
 [{ subtasks: [subtask, subtask({ task: '' })] }, /Subtask 1/],
 [{ subtasks: [subtask({ personaName: '' })] }, /personaName/],
 ]
 for (const [value, pattern] of cases) {
 const verdict = parseDecomposition(value)
 expect(verdict.ok).toBe(false)
 if (verdict.ok) continue
 expect(verdict.reason).toMatch(pattern)
 }
 })

 it('refuses a plan that is not a plan at all', => {
 for (const value of [null, 'a plan', 42, [], { subtasks: 'lots' }]) {
 expect(parseDecomposition(value).ok).toBe(false)
 }
 })

 it('refuses an empty plan', => {
 expect(parseDecomposition({ subtasks: [] }).ok).toBe(false)
 })

 /**
 * The cost model and the security model both care: a Planner that can fan out without bound is how a
 * runaway loop gets expensive, and the workspace concurrency limit only bounds
 * what runs at once, not what gets queued behind it.
 */
 it('refuses a plan past the subtask ceiling', => {
 const verdict = parseDecomposition({
 subtasks: Array.from({ length: MAX_SUBTASKS + 1 }, (_, i) => subtask({ title: `t${i}` })),
 })
 expect(verdict.ok).toBe(false)
 if (verdict.ok) return
 expect(verdict.reason).toContain(String(MAX_SUBTASKS))
 })

 // Two identical subtasks are the model repeating itself, and they produce two
 // branches doing the same work for the merge queue to then conflict over.
 it('refuses duplicate subtask titles', => {
 const verdict = parseDecomposition({ subtasks: [subtask, subtask] })
 expect(verdict.ok).toBe(false)
 if (verdict.ok) return
 expect(verdict.reason).toContain('Add docs')
 })
})

describe('summarizeChildOutcomes', => {
 const outcome = (over: Partial<ChildOutcome> = {}): ChildOutcome => ({
 runId: asAgentRunId('run-1'),
 personaName: 'swe',
 title: 'Add docs',
 status: 'completed',
 branchName: 'loom/run-1',
 totalCostUsd: 0.5,
 errorMessage: null,
...over,
 })

 it('reports every child, its branch and the total cost', => {
 const text = summarizeChildOutcomes([outcome, outcome({ title: 'Add tests' })])
 expect(text).toContain('2/2 subtasks completed')
 expect(text).toContain('$1.0000')
 expect(text).toContain('loom/run-1')
 })

 /**
 * The failures are the point. This is the moment a human judges whether the
 * decomposition was any good, and a summary that smoothed over a failed child
 * would hide exactly what they need to see.
 */
 it('shows failures rather than smoothing them over', => {
 const text = summarizeChildOutcomes([
 outcome,
 outcome({ title: 'Add tests', status: 'failed', errorMessage: 'budget cap reached' }),
 ])
 expect(text).toContain('1/2 subtasks completed')
 expect(text).toContain('failed')
 expect(text).toContain('budget cap reached')
 expect(text).toContain('did not complete')
 })

 it('says so when a plan produced nothing', => {
 expect(summarizeChildOutcomes([])).toContain('no child runs')
 })
})
