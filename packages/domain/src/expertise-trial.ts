/**
 * Whether an expertise actually helps, measured.
 *
 * The map works mechanically and is verified end to end. What was unmeasured is the only
 * question that decides whether any of it was worth building: **does a run that read a
 * map do better than one that did not?** the own default is that a new expertise is
 * *off* for a pairing until it has beaten the unaided baseline, because "an expertise
 * that cannot be shown to help is a context-window tax with a reassuring name" — and
 * arXiv 2608.10319 is the reason that default is not pessimism: it replayed 206 real
 * sessions and found personalized skills gave "small and inconsistent" improvements,
 * with pooled generic ones winning outright. Assuming a map helps is assuming the
 * configuration the evidence says underperforms doing nothing.
 *
 * **The hard part is that "off by default" has no data.** An expertise withheld until it
 * proves itself can never prove itself: nothing retrieves, so nothing is measured, and
 * the honest default silently becomes a permanent one. So the third state is the real
 * design here — a **trial**, in which the platform alternates: some runs are handed the
 * map and some are deliberately not, and the withheld ones are recorded as the baseline
 * rather than being merely absent. A baseline nobody wrote down is not a baseline.
 *
 * Three properties this deliberately keeps:
 *
 * - **Assignment is deterministic**, from the counts already recorded, never random. A
 *   random arm cannot be tested, cannot be replayed from the journal, and would make two
 *   runs of the same suite disagree — and balance is what an alternating rule gives for
 *   free that a coin gives only asymptotically.
 * - **The verdict is computed, never stored.** A stored decision is a decision that goes
 *   stale: a map re-mastered at a newer revision is a different artifact, and a flag
 *   written last month would keep answering for it. What *is* stored is the human's
 *   override, because domain expertise and mastery are consistent that promotion is a human
 *   act.
 * - **"No difference" is a refusal, not a pass.** An expertise that neither helps nor
 *   hurts is spending context for nothing, which is exactly the failure the worker-notes
 *   design bounds notes against.
 */

/** Which side of the trial a run was on. `withheld` rows *are* the baseline. */
export type ExpertiseArm = 'retrieved' | 'withheld'

export const EXPERTISE_ARMS: readonly ExpertiseArm[] = ['retrieved', 'withheld']

/**
 * What the platform does with a map when an ordinary run starts.
 *
 * `trial` is not a lesser `on`. It is the state in which the question is still open, and
 * the platform is deliberately paying for an answer.
 */
export type RetrievalState = 'trial' | 'on' | 'off'

/** A human's standing answer, which overrides the measurement in either direction. */
export type RetrievalOverride = 'on' | 'off' | null

/**
 * One arm's record, as the storage layer can aggregate it in a single query.
 *
 * `merged` and `discarded` are the outcome, and they come from the run's disposition rather
 * than from its status: a run that *completed* produced a branch, and whether that branch
 * was any good is the thing a human said afterwards by merging or discarding it. portable
 * expertise names exactly this — "every run has a disposition, a cost, and a persona
 * snapshot" — and the disposition is the only one of the three that is a judgement.
 */
/**
 * What a repository's definition of done said about an arm's branches.
 *
 * Shared by both trials because it is the same fact about a run either way, and because
 * the two tallies are one query written twice: a second definition of "a branch that did
 * not pass" would drift, and the first time they disagreed nobody would know which one
 * the platform meant.
 *
 * **Only `failed` is counted, and only failure.** `skipped`, `refused` and `error` say
 * something about the operator's setup or the Runner, not about the branch — folding them
 * in would make every unconfigured repository look like it produced broken work. And a
 * verification *pass* is not counted as a success anywhere: passing the checks is the
 * floor, not the goal, and only a human merging says the work was wanted. The asymmetry
 * is the honest one — the harness can prove a branch is not done and cannot prove it was
 * worth having.
 */
export interface VerificationTally {
  /** Runs on this arm whose branch failed its repository's definition of done. */
  readonly verificationFailed: number
  /**
   * The check that failed most often on this arm, or null when none did.
   *
   * The harness names its checks because "failed" is unactionable, and this is where the
   * name earns its keep in a measurement: "the new prompt breaks the build" and "the new
   * prompt has flaky tests" are the same number and different decisions.
   */
  readonly failingCheck: string | null
}

export interface ExpertiseArmTally extends VerificationTally {
  readonly arm: ExpertiseArm
  /** Runs on this arm that have reached a disposition. Undecided runs are not counted. */
  readonly decided: number
  readonly merged: number
  readonly discarded: number
  /** Runs that failed outright — counted against the arm, since a failure is an outcome. */
  readonly failed: number
  readonly costUsdTotal: number
}

export interface ExpertiseArmSummary extends ExpertiseArmTally {
  /** Merged (or pushed, or kept) over decided. Zero when nothing has been decided. */
  readonly successRate: number
  readonly meanCostUsd: number
  readonly verificationFailureRate: number
}

export type ExpertiseVerdict =
  /** Not enough decided runs on both arms yet — keep sampling. */
  | 'undecided'
  /** Beat the unaided baseline. */
  | 'helps'
  /** Did not beat it, on outcome or on cost. Off, per the default. */
  | 'no-better'

export interface ExpertiseEffect {
  readonly retrieved: ExpertiseArmSummary
  readonly withheld: ExpertiseArmSummary
  readonly verdict: ExpertiseVerdict
  /** One sentence a human can read, naming the numbers the verdict rests on. */
  readonly detail: string
}

/**
 * How many decided runs each arm needs before the comparison means anything.
 *
 * Five, and the number is a compromise rather than a statistic: a real power calculation
 * on a difference in merge rate would want dozens per arm, which is more runs than most
 * pairings will ever have, and waiting for it would make the gate never fire. Five is
 * enough that one lucky run cannot decide it, and small enough that a pairing in ordinary
 * use reaches a verdict within a week rather than a quarter. The verdict is recomputed
 * from the rows on every read, so it tightens as evidence accumulates instead of being
 * frozen at the moment the fifth run landed.
 */
export const MIN_DECIDED_RUNS_PER_ARM = 5

/**
 * How much better the retrieved arm has to be before "better" is claimed.
 *
 * Ten percentage points on the success rate. Below that, five-run samples differ by
 * chance more often than by cause, and a gate that flips on noise is a gate that teaches
 * a human to ignore it.
 */
export const SUCCESS_RATE_TOLERANCE = 0.1

/**
 * How much more expensive retrieval may be while still counting as no worse.
 *
 * Retrieval costs context, and context costs money — that is the whole of the "tax with
 * a reassuring name". Twenty percent is the band inside which the two arms are called
 * equal on cost; outside it, a map that produces the same outcomes for materially more
 * money has not earned its place.
 */
export const COST_TOLERANCE = 0.2

const EMPTY_TALLY = (arm: ExpertiseArm): ExpertiseArmTally => ({
  arm,
  decided: 0,
  merged: 0,
  discarded: 0,
  failed: 0,
  costUsdTotal: 0,
  verificationFailed: 0,
  failingCheck: null,
})

const summarizeArm = (tally: ExpertiseArmTally): ExpertiseArmSummary => ({
  ...tally,
  successRate: tally.decided === 0 ? 0 : tally.merged / tally.decided,
  meanCostUsd: tally.decided === 0 ? 0 : tally.costUsdTotal / tally.decided,
  verificationFailureRate: verificationFailureRate(tally),
})

/**
 * How often this arm's branches failed their repository's definition of done.
 *
 * Over `decided` rather than over the arm's whole run count, so it is on the same
 * denominator as `successRate` and the two can be read against each other. A run still in
 * flight has no verdict yet and counting it would make every arm look better the busier
 * the workspace is — the mirror of the bias `decided` exists to avoid.
 */
export const verificationFailureRate = (tally: {
  readonly decided: number
  readonly verificationFailed: number
}): number => (tally.decided === 0 ? 0 : tally.verificationFailed / tally.decided)

/**
 * Which of two arms did better, and **on which term**.
 *
 * The one comparison every trial in this platform makes, written once. The map trial,
 * The prompt trial and the variant search all ask the same question of two arms
 * and have to answer it the same way, or a human reading two panels sees two verdicts about
 * the same evidence. Only the *sentences* belong to the callers, because "runs that read
 * this map" and "the agent's version" are not the same phrase.
 *
 * **The order is the judgement**, and it is the whole content of this function:
 *
 * 1. **What a human decided** — merged over decided. The strongest evidence there is,
 *    because somebody looked at the work and took it.
 * 2. **What the repository's definition of done decided**. The strongest
 *    evidence available *without* waiting for a human, and the reason this is a fitness
 *    rather than a record of what reviewers had time for.
 * 3. **Money**. Last, and only where the first two are level: a version that produces
 *    the same results for materially less is worth having, and one that costs materially
 *    more for the same results is not.
 *
 * `term` is returned rather than inferred by the caller so a sentence cannot claim cost
 * decided something outcomes did.
 */
export interface TrialArmFacts {
  readonly successRate: number
  readonly verificationFailureRate: number
  readonly meanCostUsd: number
}

export type TrialTerm = 'outcomes' | 'verification' | 'cost' | 'none'

export interface TrialComparison {
  readonly favours: 'candidate' | 'control' | 'neither'
  readonly term: TrialTerm
}

export const compareTrialArms = (
  candidate: TrialArmFacts,
  control: TrialArmFacts,
): TrialComparison => {
  const outcomeGap = candidate.successRate - control.successRate
  if (outcomeGap > SUCCESS_RATE_TOLERANCE) return { favours: 'candidate', term: 'outcomes' }
  if (outcomeGap < -SUCCESS_RATE_TOLERANCE) return { favours: 'control', term: 'outcomes' }

  const verificationGap = control.verificationFailureRate - candidate.verificationFailureRate
  if (verificationGap > SUCCESS_RATE_TOLERANCE) {
    return { favours: 'candidate', term: 'verification' }
  }
  if (verificationGap < -SUCCESS_RATE_TOLERANCE) {
    return { favours: 'control', term: 'verification' }
  }

  /**
   * A zero-cost control means nothing has been metered on that side, not that it was free —
   * so there is no ratio to take and cost decides nothing.
   */
  const costGap =
    control.meanCostUsd === 0
      ? 0
      : (candidate.meanCostUsd - control.meanCostUsd) / control.meanCostUsd
  if (costGap < -COST_TOLERANCE) return { favours: 'candidate', term: 'cost' }
  if (costGap > COST_TOLERANCE) return { favours: 'control', term: 'cost' }

  return { favours: 'neither', term: 'none' }
}

/**
 * One clause a human reads, naming the check rather than only the count.
 *
 * Empty string when nothing failed on either side, so a caller can append it
 * unconditionally and a trial in a healthy workspace says nothing about verification at
 * all. A zero reported next to a zero is arithmetic nobody asked for.
 */
export const describeVerificationFailures = (
  candidate: { label: string } & VerificationTally & { decided: number },
  control: { label: string } & VerificationTally & { decided: number },
): string => {
  if (candidate.verificationFailed === 0 && control.verificationFailed === 0) return ''
  const side = (arm: { label: string } & VerificationTally & { decided: number }) =>
    arm.verificationFailed === 0
      ? `none of ${arm.label}'s ${arm.decided}`
      : `${arm.verificationFailed} of ${arm.label}'s ${arm.decided}` +
        (arm.failingCheck ? ` (most often the ${arm.failingCheck} check)` : '')
  return ` Branches that failed their repository's definition of done: ${side(candidate)}, ${side(control)}.`
}

/**
 * Which arm the next run against this map goes on.
 *
 * Alternating from the counts rather than sampling, for the reason in the header. Ties go
 * to `withheld`, and that is deliberate: at zero-and-zero the first run of a brand new
 * expertise is the baseline, so a pairing that is only ever used once has measured the
 * *unaided* case rather than having handed a run an untested map and learned nothing.
 */
export const nextTrialArm = (used: { retrieved: number; withheld: number }): ExpertiseArm =>
  used.retrieved > used.withheld ? 'withheld' : used.retrieved < used.withheld ? 'retrieved' : 'withheld'

export const summarizeExpertiseEffect = (
  tallies: readonly ExpertiseArmTally[],
): ExpertiseEffect => {
  const retrieved = summarizeArm(
    tallies.find((tally) => tally.arm === 'retrieved') ?? EMPTY_TALLY('retrieved'),
  )
  const withheld = summarizeArm(
    tallies.find((tally) => tally.arm === 'withheld') ?? EMPTY_TALLY('withheld'),
  )

  if (
    retrieved.decided < MIN_DECIDED_RUNS_PER_ARM ||
    withheld.decided < MIN_DECIDED_RUNS_PER_ARM
  ) {
    return {
      retrieved,
      withheld,
      verdict: 'undecided',
      detail:
        `Still measuring: ${retrieved.decided} decided run(s) that read this map against ` +
        `${withheld.decided} that were deliberately not given it. Each side needs ` +
        `${MIN_DECIDED_RUNS_PER_ARM} before the comparison says anything.` +
        // Said early on purpose: a failing check is the first hard evidence a trial has,
        // and it arrives long before anyone has merged five branches a side.
        describeVerificationFailures(
          { label: 'runs that read it', ...retrieved },
          { label: 'runs denied it', ...withheld },
        ),
    }
  }

  const asPercent = (rate: number) => `${Math.round(rate * 100)}%`
  const money = (usd: number) => `$${usd.toFixed(4)}`
  const verification = describeVerificationFailures(
    { label: 'runs that read it', ...retrieved },
    { label: 'runs denied it', ...withheld },
  )
  const level = `${asPercent(retrieved.successRate)} against ${asPercent(withheld.successRate)}`

  // The comparison is `compareTrialArms`; only the wording is this section's. `no-better`
  // covers both "worse" and "level" here on purpose — the default is off, and an
  // expertise that cannot be shown to help is context spent for nothing either way.
  const { favours, term } = compareTrialArms(retrieved, withheld)

  if (term === 'outcomes') {
    return favours === 'candidate'
      ? {
          retrieved,
          withheld,
          verdict: 'helps',
          detail:
            `Runs that read this map merged ${asPercent(retrieved.successRate)} of the time ` +
            `against ${asPercent(withheld.successRate)} for runs deliberately denied it.` +
            verification,
        }
      : {
          retrieved,
          withheld,
          verdict: 'no-better',
          detail:
            `Runs that read this map merged ${asPercent(retrieved.successRate)} of the time ` +
            `against ${asPercent(withheld.successRate)} without it — it is making things ` +
            `worse, not better.${verification}`,
        }
  }

  if (term === 'verification') {
    return favours === 'candidate'
      ? {
          retrieved,
          withheld,
          verdict: 'helps',
          detail:
            `Outcomes are level (${level}), and runs that read this map leave fewer branches ` +
            `failing their checks.${verification}`,
        }
      : {
          retrieved,
          withheld,
          verdict: 'no-better',
          detail:
            `Outcomes are level (${level}), and runs that read this map leave *more* branches ` +
            `failing their checks.${verification}`,
        }
  }

  /**
   * Cost, last. This is where "a context-window tax with a reassuring name" is actually
   * caught: the same work, done as well, for more money, is the shape a useless map takes
   * when it is not an actively harmful one.
   */
  if (term === 'cost' && favours === 'candidate') {
    return {
      retrieved,
      withheld,
      verdict: 'helps',
      detail:
        `Outcomes are level (${level}), and runs that read this map cost ` +
        `${money(retrieved.meanCostUsd)} against ${money(withheld.meanCostUsd)} — it is ` +
        `paying for itself in rediscovery it replaced.${verification}`,
    }
  }

  return {
    retrieved,
    withheld,
    verdict: 'no-better',
    detail:
      `Outcomes are level (${asPercent(retrieved.successRate)} against ` +
      `${asPercent(withheld.successRate)}) and so is the cost (${money(retrieved.meanCostUsd)} ` +
      `against ${money(withheld.meanCostUsd)}). An expertise that cannot be shown to help ` +
      `is context spent for nothing, so it stays off until something changes.${verification}`,
  }
}

/**
 * What the platform will actually do, given the measurement and the human.
 *
 * The override wins in both directions and is checked first, because domain expertise and
 * mastery are consistent that promotion is a human act — and the same must be true of
 * demotion, or an operator watching a map produce bad advice would have to wait for five
 * more runs to agree with them.
 */
export const retrievalStateFor = (
  override: RetrievalOverride,
  verdict: ExpertiseVerdict,
): RetrievalState => {
  if (override === 'on') return 'on'
  if (override === 'off') return 'off'
  return verdict === 'helps' ? 'on' : verdict === 'no-better' ? 'off' : 'trial'
}

/**
 * Whether this run is handed the map, and which arm it goes on the record as.
 *
 * `null` means the map is not offered and nothing is recorded — an `off` map is off, and
 * writing withheld rows for it forever would inflate the baseline it is being judged
 * against and make the decision unreachable. Putting it back into trial is a human act
 * (clear the override, or re-master the subject).
 */
export const trialAssignment = (
  state: RetrievalState,
  used: { retrieved: number; withheld: number },
): ExpertiseArm | null => {
  if (state === 'off') return null
  if (state === 'on') return 'retrieved'
  return nextTrialArm(used)
}
