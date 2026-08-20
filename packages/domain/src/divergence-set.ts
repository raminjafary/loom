/**
 * Where the definition of done and the human disagreed — in both directions.
 *
 * Two populations, and they are the only place in this platform's exhaust where *taste* is
 * observable at all:
 *
 * - **Passed and discarded.** The branch built, the checks were green, and a person threw it
 *   away. Everything a verifiable reward can measure said yes; the thing that decides said
 *   no. Whatever the reason was — wrong approach, right answer to the wrong question, work
 *   nobody wanted — it is not in any check, and it is exactly what a prompt could be rewritten
 *   to avoid.
 * - **Failed and merged.** The checks said no and a person took it anyway. Usually the checks
 *   were wrong, or incidental, or the repository's definition of done is stricter than its
 *   humans are. Also a fact about taste, pointing the other way.
 *
 * This is the dataset the taste-mining hypothesis needs, and its own denominator: a workspace
 * where the two never disagree has told you something real about itself, and a divergence set
 * that stays tiny after a month of traffic is a finding rather than a failure — it says the
 * checks are already carrying the judgement.
 *
 * **Deliberately not in the proposer's brief.** It would help, and wiring it in now would
 * destroy the comparison it exists for: the experiment is a lineage evolved on the taste
 * record against a matched lineage evolved on the failure record, and if every brief carried
 * both there would be no failure-record arm left to compare against. The brief's evidence
 * gets declared as a *source* before this becomes one of them. Until then it is read by
 * people, which is why `describeDivergence` writes a sentence rather than a score.
 *
 * Nothing here scores anything. A disagreement is not a mistake by either side, and a
 * platform that treated "the human discarded a passing branch" as a defect would be grading
 * a review — the same line the reverted-merge tripwire refuses to cross.
 */

/** Which way the two disagreed. Both directions are kept; they are different evidence. */
export type DivergenceKind =
  /** The checks passed and a person discarded the branch. */
  | 'passed-and-discarded'
  /** The checks failed and a person merged or pushed it anyway. */
  | 'failed-and-merged'

export interface DivergentRun {
  readonly runId: string
  /** The task, so a disagreement is attached to work rather than to an id. */
  readonly task: string
  readonly kind: DivergenceKind
  /**
   * The check that failed, on a `failed-and-merged` run. Null on the other direction, where
   * nothing failed, and null where the harness named no check.
   */
  readonly failingCheck: string | null
  readonly decidedAt: Date
}

export interface DivergenceSet {
  /** Newest first, bounded by the caller. */
  readonly runs: readonly DivergentRun[]
  readonly passedAndDiscarded: number
  readonly failedAndMerged: number
  /**
   * Decided runs that had **both** a verdict and a disposition — the population a
   * disagreement was possible in.
   *
   * The denominator, and it is not the same as "decided runs": a run nobody ruled on, or one
   * no definition of done ran against, cannot disagree with anything, and counting it would
   * make a workspace with no checks configured look like one whose humans always agree.
   */
  readonly comparable: number
}

/**
 * How often the two decided differently, in a sentence.
 *
 * Written for a person rather than for a score: the useful reading is a rate with its
 * denominator and the direction it leans, because the two directions mean opposite things —
 * work that passes and is thrown away is a prompt problem, and work that fails and is taken
 * anyway is usually a checks problem.
 */
export const describeDivergence = (set: DivergenceSet): string => {
  const total = set.passedAndDiscarded + set.failedAndMerged
  if (set.comparable === 0) {
    return (
      'No run of this persona has both a verdict from the definition of done and a human ' +
      'disposition, so there is nothing the two could have disagreed about yet.'
    )
  }
  if (total === 0) {
    return (
      `The definition of done and the humans agreed on all ${set.comparable} runs where both ` +
      'ruled. Nothing here says the checks are missing anything.'
    )
  }
  const percent = Math.round((total / set.comparable) * 100)
  const lean =
    set.passedAndDiscarded > set.failedAndMerged
      ? 'Mostly work that passed and was thrown away — that is a fact about the prompt, not ' +
        'about the checks.'
      : set.failedAndMerged > set.passedAndDiscarded
        ? 'Mostly work that failed and was taken anyway — that is usually a fact about the ' +
          'checks, not about the prompt.'
        : 'Evenly split between the two directions.'
  return (
    `${total} of ${set.comparable} runs where both ruled (${percent}%) had the definition of ` +
    `done and the human disagree: ${set.passedAndDiscarded} passed and were discarded, ` +
    `${set.failedAndMerged} failed and were kept. ${lean}`
  )
}
