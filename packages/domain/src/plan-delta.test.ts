import { describe, expect, it } from 'vitest'
import {
 MAX_DELTA_OPS,
 buildSteeringBrief,
 describeAppliedDelta,
 parsePlanDelta,
} from './plan-delta.js'

/**
 * The re-planning turn's schema.
 *
 * What these assert is mostly *refusals*, and deliberately: a delta becomes
 * cancellations and new runs, so the expensive failures are the ones that get applied
 * to the wrong thing. The cap and the one-op-per-subtask rule are the two that keep a
 * delta from quietly becoming a plan.
 */

const cancel = { op: 'cancel', runId: 'run-a', reason: 'the schema is not changing after all' }

describe('parsePlanDelta', => {
 it('accepts a delta that changes nothing, and that is a real answer', => {
 // Mid-flight steering point 2: agents repair disrupted plans badly. A re-planning turn that
 // cannot say "the plan is right" will invent work to justify itself.
 const verdict = parsePlanDelta({ rationale: 'The plan already covers this.', ops: [] })
 expect(verdict.ok).toBe(true)
 if (verdict.ok) expect(verdict.delta.ops).toEqual([])
 })

 it('treats a missing ops list as no changes rather than a malformed delta', => {
 const verdict = parsePlanDelta({ rationale: 'Nothing to do.' })
 expect(verdict.ok).toBe(true)
 })

 it('requires a rationale even when nothing changes', => {
 const verdict = parsePlanDelta({ ops: [] })
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toContain('rationale')
 })

 it('parses the three verbs', => {
 const verdict = parsePlanDelta({
 rationale: 'Re-scoping after the message.',
 ops: [
 cancel,
 { op: 'revise', runId: 'run-b', guidance: 'Leave the API surface alone.' },
 {
 op: 'add',
 subtask: { title: 'Docs', task: 'Write the docs', personaName: 'swe', paths: ['./docs/'] },
 },
 ],
 })
 expect(verdict.ok).toBe(true)
 if (!verdict.ok) return
 expect(verdict.delta.ops.map((op) => op.op)).toEqual(['cancel', 'revise', 'add'])
 // An added subtask goes through the plan's own validator, normalization included.
 const added = verdict.delta.ops[2]
 expect(added?.op === 'add' && added.subtask.paths).toEqual(['docs'])
 })

 it(`refuses more than ${MAX_DELTA_OPS} changes rather than letting a delta become a plan`, => {
 const verdict = parsePlanDelta({
 rationale: 'Everything changes.',
 ops: Array.from({ length: MAX_DELTA_OPS + 1 }, (_unused, index) => ({
...cancel,
 runId: `run-${index}`,
 })),
 })
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toContain(String(MAX_DELTA_OPS))
 })

 it('refuses two changes to the same subtask', => {
 // Cancelling and revising the same run has no coherent order.
 const verdict = parsePlanDelta({
 rationale: 'Both.',
 ops: [cancel, { op: 'revise', runId: 'run-a', guidance: 'Do it differently' }],
 })
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toContain('same subtask')
 })

 it('names the offending change, because the writer is a model', => {
 const verdict = parsePlanDelta({ rationale: 'x', ops: [{ op: 'cancel', runId: 'run-a' }] })
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toContain('reason')
 })

 it('refuses an unknown verb rather than skipping it', => {
 const verdict = parsePlanDelta({
 rationale: 'x',
 ops: [{ op: 'restart_everything', runId: 'run-a' }],
 })
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toContain('unknown')
 })
})

describe('buildSteeringBrief', => {
 const brief = =>
 buildSteeringBrief({
 goal: 'Ship the export endpoint',
 subtasks: [
 {
 runId: 'run-a' as never,
 personaName: 'swe',
 status: 'running',
 task: 'Write the handler',
 paths: ['src/api'],
 branchName: 'loom/run-a',
 totalCostUsd: 0.12,
 },
 ],
 message: 'Drop the CSV format, JSON only.',
 steeredBy: 'user u1',
 })

 it('carries all four of mid-flight steerings inputs', => {
 const text = brief
 expect(text).toContain('Ship the export endpoint')
 expect(text).toContain('Write the handler')
 expect(text).toContain('running')
 expect(text).toContain('Drop the CSV format, JSON only.')
 })

 it('names run ids, because a delta references subtasks by id', => {
 // Without these a Planner would have to describe which subtask it meant in
 // prose, and applying the delta would need fuzzy matching.
 expect(brief).toContain('runId run-a')
 })

 it('puts the human message after the plan it is about', => {
 const text = brief
 expect(text.indexOf('Write the handler')).toBeLessThan(
 text.indexOf('Drop the CSV format, JSON only.'),
)
 })

 it('says a plan with no subtasks has none rather than rendering an empty list', => {
 expect(
 buildSteeringBrief({ goal: null, subtasks: [], message: 'go', steeredBy: 'a human' }),
).toContain('no subtasks yet')
 })
})

describe('describeAppliedDelta', => {
 it('states the no-change case plainly', => {
 expect(describeAppliedDelta([], 'user u1')).toContain('no change to the plan')
 })

 it('counts what was applied and lists what was refused', => {
 const text = describeAppliedDelta(
 [
 { op: 'cancel', subject: 'swe (run-a)', applied: true },
 { op: 'revise', subject: 'swe (run-b)', applied: false, refusal: 'already completed' },
 ],
 'user u1',
)
 expect(text).toContain('1 cancelled')
 expect(text).toContain('✗ revise swe (run-b): already completed')
 // Not counted as done — a refused op that inflated the count would misreport
 // exactly the case a human needs to notice.
 expect(text).not.toContain('1 revised')
 })
})
