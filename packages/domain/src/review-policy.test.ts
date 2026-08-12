import { describe, expect, it } from 'vitest'
import {
 MAX_REVIEWERS_PER_PERSONA,
 describeMissingReviews,
 describeReviewPolicy,
 detectMissingReviews,
 parseReviewPolicy,
} from './review-policy.js'

/**
 * The design-canvas half — `reviews` as *policy* rather than as an event.
 *
 * The rule these tests are written against is the roadmap's, quoted in the canvas design: a design canvas
 * "may only draw what the runtime executes, so each of these has to be a field the
 * platform already reads — never a decoration." So what is pinned here is the two things
 * the runtime does with it: what a Planner is *told*, and what a plan is *warned* about.
 */
describe('parseReviewPolicy', => {
 it('treats an absent policy as no expectation', => {
 expect(parseReviewPolicy(undefined, ['a'], [])).toEqual({ ok: true, reviewers: {} })
 expect(parseReviewPolicy(null, ['a'], [])).toEqual({ ok: true, reviewers: {} })
 })

 it('keeps a reviewer and the personas it reviews', => {
 expect(parseReviewPolicy({ qa: ['swe'] }, ['qa', 'swe'], [])).toEqual({
 ok: true,
 reviewers: { qa: ['swe'] },
 })
 })

 it('refuses a self-review, which the plan validator would refuse anyway', => {
 // `parsePlanSubtask` refuses a subtask that reviews itself, so a roster clause asking
 // for one would be an instruction the Planner cannot follow.
 const verdict = parseReviewPolicy({ qa: ['qa'] }, ['qa'], [])
 expect(verdict.ok).toBe(false)
 if (verdict.ok) return
 expect(verdict.reason).toContain('cannot review its own work')
 })

 it('refuses a planner as the reviewed party, and says what to review instead', => {
 // A planner's output is a decomposition, not a branch — there is nothing to read.
 const verdict = parseReviewPolicy({ qa: ['lead'] }, ['qa', 'lead'], ['lead'])
 expect(verdict.ok).toBe(false)
 if (verdict.ok) return
 expect(verdict.reason).toContain('not a branch')
 expect(verdict.reason).toContain('workers it delegates to')
 })

 it('allows a planner to *be* a reviewer', => {
 // Nothing stops a lead reading a worker's branch; only being reviewed is meaningless.
 expect(parseReviewPolicy({ lead: ['swe'] }, ['lead', 'swe'], ['lead']).ok).toBe(true)
 })

 it('drops entries naming personas who have left the team', => {
 expect(parseReviewPolicy({ qa: ['gone'], gone: ['swe'] }, ['qa', 'swe'], [])).toEqual({
 ok: true,
 reviewers: {},
 })
 })

 it('caps how many one persona may review, since a roster clause is prompt budget', => {
 const many = Array.from({ length: MAX_REVIEWERS_PER_PERSONA + 1 }, (_, i) => `w${i}`)
 expect(parseReviewPolicy({ qa: many }, ['qa',...many], []).ok).toBe(false)
 })

 it('deduplicates rather than refusing a repeat', => {
 expect(parseReviewPolicy({ qa: ['swe', 'swe'] }, ['qa', 'swe'], [])).toEqual({
 ok: true,
 reviewers: { qa: ['swe'] },
 })
 })
})

describe('describeReviewPolicy', => {
 it('is null with no expectations, so a team without one gets the old prompt', => {
 expect(describeReviewPolicy([])).toBeNull
 })

 it('names the field, because the failure is a review expressed as dependsOn', => {
 /**
 * The whole distinction is invisible unless the instruction points at the
 * field carrying it: a reviewing subtask written as an ordinary `dependsOn` step gets a
 * worker with a write scope over someone else's paths and no access to their branch.
 */
 const text = describeReviewPolicy([{ reviewerName: 'qa', reviewedName: 'swe' }])
 expect(text).toContain("swe's work is reviewed by qa")
 expect(text).toContain('reviews field')
 expect(text).toContain('not dependsOn')
 })
})

describe('detectMissingReviews', => {
 const sub = (title: string, personaName: string, reviews: number | null = null) => ({
 title,
 personaName,
 reviews,
 })

 it('finds work nobody is checking', => {
 const missing = detectMissingReviews(
 [sub('Build', 'swe')],
 [{ reviewerName: 'qa', reviewedName: 'swe' }],
)
 expect(missing).toEqual([{ reviewedName: 'swe', reviewerName: 'qa', titles: ['Build'] }])
 })

 it('accepts a review by a different persona than the policy names', => {
 /**
 * Deliberate: a Planner that chose another reviewer made a judgement about *this* goal,
 * and warning about it would be arguing with a decision rather than catching an
 * omission. The case worth reporting is work nobody checks at all.
 */
 const missing = detectMissingReviews(
 [sub('Build', 'swe'), sub('Check', 'security-reviewer', 0)],
 [{ reviewerName: 'qa', reviewedName: 'swe' }],
)
 expect(missing).toEqual([])
 })

 it('says nothing when the team expects nothing', => {
 expect(detectMissingReviews([sub('Build', 'swe')], [])).toEqual([])
 })

 it('reports only the unreviewed subtasks when several use the same persona', => {
 const missing = detectMissingReviews(
 [sub('A', 'swe'), sub('B', 'swe'), sub('Check A', 'qa', 0)],
 [{ reviewerName: 'qa', reviewedName: 'swe' }],
)
 expect(missing[0]?.titles).toEqual(['B'])
 })
})

describe('describeMissingReviews', => {
 it('is null when nothing is missing', => {
 expect(describeMissingReviews([])).toBeNull
 })

 it('says the plan still runs, so nobody looks for a button that is not there', => {
 // The distinction from a fleet overrun: nothing is refused here. Enforcing would mean
 // the platform adding a subtask the Planner did not ask for.
 const text = describeMissingReviews([
 { reviewedName: 'swe', reviewerName: 'qa', titles: ['Build the API'] },
 ])
 expect(text).toContain('qa reviews swe')
 expect(text).toContain('Build the API')
 expect(text).toContain('The plan still runs')
 })
})
