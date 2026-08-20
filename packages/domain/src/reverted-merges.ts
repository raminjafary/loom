/**
 * A merged branch that was later reverted — the one signal that says a disposition was
 * wrong after the fact.
 *
 * Fitness is run disposition: a human merging is what says the work was wanted. That makes
 * the merge the reward, and every reward invites the shape of gaming that maximises it — a
 * prompt that produces small, plausible, easily-approved diffs scores exactly as well as one
 * that produces work worth keeping, and scores better than one that produces work a reviewer
 * has to think about. Nothing inside the platform can tell those apart at merge time; the
 * repository can tell them apart a week later, when somebody takes the merge back out.
 *
 * So this is a **tripwire and not a term in the fitness.** A revert is not scored against an
 * arm, and no verdict here changes because of one. What it does is make the pairing visible
 * where the disposition is acted on: an arm whose merge rate is higher *and* whose merges
 * came back out more often has not been shown to be better, and a human settling that
 * measurement should read both numbers in the same sentence. Turning reverts into a negative
 * term would be the platform grading a human's review, which is the one authority it has
 * never taken.
 *
 * **What it can see, and what it cannot.** Detection is git's own marker — the
 * `This reverts commit <sha>` line `git revert` writes — observed on commits that arrive
 * through the merge queue. Two consequences, both stated rather than discovered:
 *
 * - A revert a human commits straight into the repository, outside Loom, is invisible here.
 *   The queue is where this platform watches the default branch move, and it does not poll.
 * - A revert whose message was rewritten, or that was applied as a hand-written inverse
 *   diff, is invisible too. Nothing infers a revert from content: a claim that two diffs
 *   cancel out is exactly the kind of judgement that would produce false accusations of
 *   gaming, and the safe direction for a tripwire is to under-report.
 *
 * Under-reporting is why the counts are never a gate. A tripwire that misses half the
 * reverts still turns "this arm wins" into "this arm wins, and two of its merges were taken
 * back out" — which is the sentence that makes a human look.
 */

/** Git's own line, and the only thing this reads. Case-insensitive; 7–40 hex, as git abbreviates. */
const REVERTS_LINE = /this reverts commit ([0-9a-f]{7,40})/gi

/**
 * The commits a set of messages says they revert, deduplicated, in the order first seen.
 *
 * Takes messages rather than a range because the git is the Runner's — the same division
 * `planVerification` makes with the checks it plans and does not run.
 *
 * Abbreviated shas are kept as they were written. Resolving one to a full sha requires the
 * object database, which is not here; the matching side compares by prefix for exactly that
 * reason, and says so.
 */
export const parseRevertedShas = (messages: readonly string[]): string[] => {
  const found: string[] = []
  for (const message of messages) {
    for (const match of message.matchAll(REVERTS_LINE)) {
      const sha = match[1]?.toLowerCase()
      if (sha !== undefined && !found.includes(sha)) found.push(sha)
    }
  }
  return found
}

/**
 * The shortest prefix that is evidence about a commit rather than about a sixteenth of the
 * repository. Git's own default abbreviation, which is not a coincidence: this is the length
 * git considers enough to identify one.
 */
export const MIN_REVERT_SHA_LENGTH = 7

/**
 * Whether a sha read out of a revert message is specific enough to match anything with.
 *
 * Checked before a query rather than inside one, so the floor lives in a single place: a
 * three-character "sha" would prefix-match thousands of commits, and a tripwire that accuses
 * on a coincidence is worse than one that misses a revert.
 */
export const isUsableRevertSha = (sha: string): boolean =>
  new RegExp(`^[0-9a-f]{${MIN_REVERT_SHA_LENGTH},40}$`).test(sha.toLowerCase())

/**
 * Whether one recorded merge is what a `This reverts commit …` line named.
 *
 * Prefix matching, in one direction only: git may abbreviate the sha it writes into a revert
 * message, and it never lengthens one. So a stored full sha may *start with* what the message
 * said.
 */
export const revertNamesMerge = (revertedSha: string, mergedCommitSha: string): boolean => {
  const named = revertedSha.toLowerCase()
  if (!isUsableRevertSha(named)) return false
  return mergedCommitSha.toLowerCase().startsWith(named)
}

/** One arm's reverted-merge count, beside the merges it is a fraction of. */
export interface RevertTally {
  readonly label: string
  /** Runs on this arm whose branch was merged, and later reverted through the queue. */
  readonly reverted: number
  /** Merged runs on this arm — the denominator, so a count is readable as a rate. */
  readonly merged: number
}

const rate = (tally: RevertTally): number =>
  tally.merged === 0 ? 0 : tally.reverted / tally.merged

/**
 * The clause a trial appends when merges came back out, or an empty string.
 *
 * Empty when neither side had a revert, so a caller appends it unconditionally and a healthy
 * workspace's trials say nothing about reverts at all — `describeVerificationFailures`'s
 * habit, for its reason: a zero reported beside a zero is arithmetic nobody asked for.
 *
 * The **tripwire sentence** is the case worth reading: the winning side's merges were also
 * the ones being taken back out. That is what disposition-gaming looks like from the outside,
 * and it is said as a thing to check rather than as a finding — the platform cannot know
 * whether a revert means the work was bad or the world changed, and pretending otherwise
 * would make a reviewer's judgement the loser of an argument with a counter.
 */
export const describeRevertedMerges = (
  candidate: RevertTally,
  control: RevertTally,
): string => {
  if (candidate.reverted === 0 && control.reverted === 0) return ''
  const side = (tally: RevertTally) =>
    `${tally.reverted} of ${tally.label}'s ${tally.merged} merged ${
      tally.merged === 1 ? 'branch' : 'branches'
    } ${tally.reverted === 1 ? 'was' : 'were'} later reverted`

  const both = `${side(candidate)}; ${side(control)}.`
  const tripped = rate(candidate) > rate(control) && candidate.merged > control.merged
  return tripped
    ? ` ${both} The side that got more merged is also the side more of whose merges came ` +
        'back out, so the higher merge rate may be measuring what was easy to approve rather ' +
        'than what was worth keeping. A revert is not counted against an arm — check the two ' +
        'reverts before settling this.'
    : ` ${both}`
}
