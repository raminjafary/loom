/**
 * Who reviews whom, as a design-time fact.
 *
 * The reviewing role built `reviews` as a **per-plan** edge: one subtask names a sibling it
 * reviews, and a Planner decides that fresh for every goal. The canvas design asks for the same
 * relation "as *policy* rather than as events, because that is the only form [it has]
 * before anything runs" — a human saying once that this team's `security-reviewer` reads
 * whatever `swe` writes, instead of hoping each plan remembers to ask.
 *
 * **The rule that keeps it honest is the roadmap's**, quoted in the canvas design: "a design canvas may only
 * draw what the runtime executes, so each of these has to be a field the platform already
 * reads — never a decoration." So this is read in two places, and both are places the
 * fleet's width is read, for the same reasons:
 *
 * 1. **The Planner's roster** — it is told, at plan time, which of its workers this team
 * expects to be reviewed and by whom. That is an instruction to a model that is at
 * that moment choosing subtasks, which is the only moment it can act on it.
 * 2. **Plan validation** — a decomposition that gives work to a reviewed persona and asks
 * for no review of it gets a warning, before the first child starts.
 *
 * **Why it warns rather than refuses**, unlike the fleet's concurrency check: enforcing
 * would mean the platform *adding a subtask the Planner did not ask for*, and the
 * decomposition is the Planner's to author — the "schema-validated decomposition, both
 * directions" validates a plan's shape, it does not write its content. A refusal is no
 * better: throwing away an otherwise good plan because a review is missing costs the whole
 * planning turn to fix one omission a human can also just accept.
 *
 * What this is **not**: a second `reviews`. The runtime edge stays the one in the plan
 * — this only decides what a Planner is told to ask for.
 */

/**
 * Reviewer persona id → the persona ids whose work it reviews.
 *
 * Keyed by *reviewer* rather than by the reviewed, because that is the direction the
 * relation is named in ("qa reviews swe") and the direction the canvas draws. Both are
 * derivable from either; matching the wording keeps the stored shape readable.
 */
export type ReviewPolicy = Readonly<Record<string, readonly string[]>>

/** How many reviewers one persona may be given. Small: a roster clause is prompt budget. */
export const MAX_REVIEWERS_PER_PERSONA = 4

export type ReviewPolicyVerdict =
 | { readonly ok: true; readonly reviewers: Record<string, string[]> }
 | { readonly ok: false; readonly reason: string }

/**
 * Validates a policy a client sent, and drops what says nothing.
 *
 * The two refusals are the two that would produce an instruction a Planner cannot follow:
 * a persona reviewing **itself** (the own rule — `parsePlanSubtask` refuses a subtask
 * that reviews itself, so the roster must never ask for one), and a **planner** as the
 * reviewed party (a planner's output is a decomposition, not a branch; there is nothing
 * for a reviewer to read). Entries naming personas who have left the team are dropped
 * rather than refused, for the reason `parseFleetSizes` drops stale widths.
 */
export const parseReviewPolicy = (
 value: unknown,
 memberIds: readonly string[],
 /** Which members are planners, so a planner cannot be the reviewed party. */
 plannerIds: readonly string[],
): ReviewPolicyVerdict => {
 if (value === undefined || value === null) return { ok: true, reviewers: {} }
 if (typeof value !== 'object' || Array.isArray(value)) {
 return { ok: false, reason: 'A review policy must be an object keyed by reviewer persona id' }
 }

 const members = new Set(memberIds)
 const planners = new Set(plannerIds)
 const reviewers: Record<string, string[]> = {}

 for (const [reviewerId, reviewed] of Object.entries(value as Record<string, unknown>)) {
 if (!members.has(reviewerId)) continue
 if (!Array.isArray(reviewed)) {
 return { ok: false, reason: `The reviewed list for ${reviewerId} must be an array` }
 }
 if (reviewed.length > MAX_REVIEWERS_PER_PERSONA) {
 return {
 ok: false,
 reason: `A persona may review at most ${MAX_REVIEWERS_PER_PERSONA} others on one team`,
 }
 }

 const kept: string[] = []
 for (const reviewedId of reviewed) {
 if (typeof reviewedId !== 'string') {
 return { ok: false, reason: `The reviewed list for ${reviewerId} holds a non-id` }
 }
 if (!members.has(reviewedId)) continue
 if (reviewedId === reviewerId) {
 return {
 ok: false,
 reason: 'A persona cannot review its own work — a reviewer reads a branch it did not write',
 }
 }
 if (planners.has(reviewedId)) {
 return {
 ok: false,
 reason:
 'A planner cannot be reviewed: its output is a decomposition, not a branch, so there is nothing for a reviewer to read. Review the workers it delegates to instead.',
 }
 }
 if (!kept.includes(reviewedId)) kept.push(reviewedId)
 }
 if (kept.length > 0) reviewers[reviewerId] = kept
 }

 return { ok: true, reviewers }
}

/** One expectation, resolved to names for a prompt or a warning. */
export interface ReviewExpectation {
 readonly reviewerName: string
 readonly reviewedName: string
}

/**
 * The clause appended to a Planner's roster.
 *
 * Null when the team expects nothing, so a team with no policy gets the prompt it got
 * before this existed.
 *
 * It names the *field* to use, because the failure this prevents is not a Planner that
 * refuses to add a reviewer — it is one that adds a reviewing subtask as an ordinary
 * `dependsOn` step, which gets a worker with a write scope over someone else's paths and
 * no access to their branch. The whole distinction is invisible unless the
 * instruction points at the field that carries it.
 */
export const describeReviewPolicy = (
 expectations: readonly ReviewExpectation[],
): string | null => {
 if (expectations.length === 0) return null
 return [
 '',
 '',
 'This team expects some work to be reviewed:',
...expectations.map(
 (expectation) =>
 `- ${expectation.reviewedName}'s work is reviewed by ${expectation.reviewerName}`,
),
 'When your plan gives work to one of those, add a subtask for its reviewer and set the ' +
 'reviews field to the index of the subtask being reviewed. Use reviews, not dependsOn: ' +
 'a reviewer needs the reviewed branch checked out and must claim no paths, which only ' +
 'that field arranges.',
 ].join('\n')
}

/** A persona given work with no review asked for, though the team expects one. */
export interface MissingReview {
 readonly reviewedName: string
 readonly reviewerName: string
 /** The subtask titles that went unreviewed, for a message that names them. */
 readonly titles: readonly string[]
}

/**
 * Which of a team's review expectations a decomposition did not meet.
 *
 * A subtask counts as reviewed when *any* sibling reviews it — not specifically the
 * persona the policy names. That is deliberate: a Planner that assigned a different
 * reviewer made a judgement about this goal, and warning about it would be arguing with
 * a decision rather than catching an omission. The case worth reporting is work that
 * nobody is checking at all.
 */
export const detectMissingReviews = (
 subtasks: readonly { readonly title: string; readonly personaName: string; readonly reviews: number | null }[],
 expectations: readonly ReviewExpectation[],
): MissingReview[] => {
 const reviewedPositions = new Set(
 subtasks.map((subtask) => subtask.reviews).filter((index): index is number => index !== null),
)

 const missing: MissingReview[] = []
 for (const expectation of expectations) {
 const titles = subtasks
.map((subtask, index) => ({ subtask, index }))
.filter(
 ({ subtask, index }) =>
 subtask.personaName === expectation.reviewedName && !reviewedPositions.has(index),
)
.map(({ subtask }) => subtask.title)
 if (titles.length > 0) {
 missing.push({
 reviewedName: expectation.reviewedName,
 reviewerName: expectation.reviewerName,
 titles,
 })
 }
 }
 return missing
}

/**
 * The plan-time disclosure. Null when nothing is missing.
 *
 * Says who was supposed to review it and what went unreviewed, and states plainly that
 * the plan still runs — a warning that reads like a refusal makes a human look for a
 * button that is not there.
 */
export const describeMissingReviews = (missing: readonly MissingReview[]): string | null => {
 if (missing.length === 0) return null
 return [
 missing.length === 1
 ? 'This team expects a review that this plan did not ask for:'
: `This team expects ${missing.length} reviews that this plan did not ask for:`,
...missing.map(
 (entry) =>
 `• ${entry.reviewerName} reviews ${entry.reviewedName}'s work, and nothing reviews ${entry.titles
.map((title) => `"${title}"`)
.join(', ')}`,
),
 'The plan still runs — this is the team\'s standing expectation, not a rule about this ' +
 'goal. Steer the planner to add the review, or accept it for this one.',
 ].join('\n')
}
