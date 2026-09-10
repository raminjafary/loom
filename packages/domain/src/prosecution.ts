/**
 * The prosecutor pass: tests written **against the diff**, run, and reported as evidence.
 *
 * The argument for it is an asymmetry the definition of done cannot fix. A repository's
 * standing suite is exactly the set an agent's change is *least* likely to be caught by —
 * it was written before the change existed, by people who were not thinking about it, and a
 * change that breaks nothing in it has demonstrated only that. What is missing is a test
 * somebody wrote *because of* this diff, and then ran.
 *
 * ## Evidence, never a verdict — and why that is structural rather than a promise
 *
 * A prosecution never enters the definition of done, never refuses a merge, and never
 * contributes to `verified`. That is §4k's rule — the arbiter is the repository — and it holds
 * here for a precise reason: a generated test is *run*, so what it produces is an observation
 * rather than an opinion, and an observation that could block a merge would be a model writing
 * its own gate. The operator's list is the gate; this is what a reviewer reads beside it.
 *
 * The rule is enforced by *nothing reading these rows* on the verification or merge path,
 * which is checked in `tools/architecture.test.ts` rather than left to reviewer memory. A
 * status here is deliberately not called `passed`/`failed`: those are verdict words, and the
 * first time somebody reaches for `prosecution.failed` in a merge condition the type will not
 * have the word they need.
 *
 * ## What a failing observation means
 *
 * That a test somebody wrote against this diff did not pass — which is *usually* a defect in
 * the diff and is sometimes a defect in the test. Both are worth a human's thirty seconds, and
 * neither is worth a machine's authority. The reason a prosecution can be `inconclusive` at
 * all is that a prosecutor whose own tests would not run has found nothing about the diff.
 */

/** One test the prosecutor wrote and ran. */
export interface ProsecutionObservation {
  /** What it was probing, in the prosecutor's own words. Rendered as the row's title. */
  readonly name: string
  /**
   * `held` — the diff survived this probe. `broke` — it did not.
   *
   * Not `passed`/`failed`, deliberately. Those are the words the definition of done uses, and
   * this is not one; a reader who sees `failed` beside a branch reasonably assumes something
   * was blocked, and nothing here blocks anything.
   */
  readonly outcome: 'held' | 'broke'
  /** What the prosecutor saw — the tail of the run, an assertion message, a diff. */
  readonly detail: string | null
}

export type ProsecutionStatus =
  /** A prosecutor is running. */
  | 'running'
  /** It reported. Some observations may have broken; that is what evidence looks like. */
  | 'reported'
  /**
   * It finished without usable observations — its own tests would not run, or it never
   * reported. Distinct from "reported nothing broke", which is a real result.
   */
  | 'inconclusive'

export interface Prosecution {
  readonly id: string
  readonly workspaceId: string
  /** The run whose branch is under prosecution. */
  readonly agentRunId: string
  /** The run doing the prosecuting — a child of the one above, relation `prosecute`. */
  readonly prosecutorRunId: string | null
  readonly status: ProsecutionStatus
  readonly observations: readonly ProsecutionObservation[]
  /** Why it is inconclusive, when it is. Recorded, never implied. */
  readonly reason: string | null
  readonly createdAt: Date
  readonly finishedAt: Date | null
}

/** How many observations broke. The only arithmetic anyone should be doing on these. */
export const brokenCount = (observations: readonly ProsecutionObservation[]): number =>
  observations.filter((entry) => entry.outcome === 'broke').length

/**
 * The sentence a reviewer reads on the card.
 *
 * Deliberately not a verdict sentence: it says what was tried and what happened, and it never
 * says whether the branch is good. "3 probes, 1 broke" is a reason to look; "failed" is a
 * reason to stop reading, which is exactly the authority this pass does not have.
 */
export const summariseProsecution = (prosecution: Prosecution): string => {
  if (prosecution.status === 'running') return 'Writing tests against this diff…'
  if (prosecution.status === 'inconclusive') {
    return prosecution.reason ?? 'The prosecutor produced no usable observations.'
  }
  const total = prosecution.observations.length
  if (total === 0) return 'The prosecutor reported no observations.'
  const broke = brokenCount(prosecution.observations)
  const probes = `${total} probe${total === 1 ? '' : 's'} written against this diff`
  return broke === 0 ? `${probes}, all held.` : `${probes}, ${broke} broke.`
}

/**
 * Whether a prosecution is worth a reviewer's attention *first*.
 *
 * Ordering, not gating. The Inbox ranks the review lane by it, and a branch whose diff broke
 * a probe someone wrote for it is a better use of the next thirty seconds than one that did
 * not. It still merges if the repository's own checks pass.
 *
 * The client mirrors this rather than importing it — a client depends on the contract, never
 * on the domain — which is safe here in a way it would not be for a rule with authority: a
 * mirror that drifted would put a card second instead of first. This is the authority for what
 * the rule *is*.
 */
export const prosecutionWantsAttention = (prosecution: Prosecution | null): boolean =>
  prosecution !== null &&
  prosecution.status === 'reported' &&
  brokenCount(prosecution.observations) > 0

/**
 * The guard the whole file exists for, in executable form.
 *
 * A merge decision takes a verification verdict and nothing else. This function exists so the
 * rule has a name a test can hold onto, and so that a future reader looking for "where does
 * prosecution affect the merge" finds this and its answer rather than searching the codebase
 * and concluding from absence.
 */
export const prosecutionAffectsMergeEligibility = (): false => false
