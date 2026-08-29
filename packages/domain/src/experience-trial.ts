import {
  MIN_DECIDED_RUNS_PER_ARM,
  compareTrialArms,
  describeVerificationFailures,
  verificationFailureRate,
  type VerificationTally,
} from './expertise-trial.js'

/**
 * Whether a persona's memory of a repository actually helps, measured.
 *
 * Tier 5 works: a run records a convention, the next run against that repository is told it,
 * a merge that changes the files it named retires it. What has never been measured is the
 * only question that decides whether any of it earns its context — **does a run that was
 * shown its persona's lessons do better than one deliberately denied them?** The lessons are
 * ranked by the dispositions of the runs that read them, which orders them against each
 * other and says nothing about whether the whole apparatus beats showing nothing at all.
 *
 * This is the withheld-baseline instrument, applied a third time: the map trial and the
 * held-out screen are the other two, and the shape is deliberately theirs rather than a new
 * one. What differs is what happens afterwards, and that difference is the whole of the
 * design — see "what this does not do" below.
 *
 * ## The registration
 *
 * The research program's rule is that an experiment is registered with success *and* kill
 * criteria before its first run, which is why this was left unbuilt when tier 5 shipped
 * rather than bolted on. The registration is here, next to the instrument that answers it,
 * because a criterion recorded somewhere else is one nothing enforces.
 *
 * **Hypothesis.** Distilled experience transfers: a persona shown what it concluded about
 * this repository on earlier runs produces work that gets kept more often than the same
 * persona working from its document alone.
 *
 * **Success.** On a pairing with a real store, runs shown the lessons beat runs denied them
 * on `compareTrialArms`' order — what a human merged, then what the repository's definition
 * of done said, then cost. The same bar and the same tolerances as the map trial, imported
 * rather than restated: two instruments answering "did this context help" against two
 * thresholds would disagree, and the first time they did nobody would know which the
 * platform meant.
 *
 * **Kill.** A workspace whose pairings do not reach `MIN_LESSONS_TO_TRIAL` live lessons
 * after a month of traffic kills it — and that is a finding rather than a failure: it says
 * personas do not accumulate enough durable memory per repository for the question to be
 * worth asking, which is the same shape as the taste-mining kill criterion ("divergence set
 * under ~8 items after a month — itself a finding about how often taste disagrees with the
 * checks"). It is also the *cheap* kill, because it fires before a single run is denied
 * anything.
 *
 * **The cost, stated because a trial that hides its cost is not registered.** Half the runs
 * against an armed pairing are denied a memory the persona has. That is real work done
 * worse, on purpose, to find out whether it was being done better. Which is why the trial is
 * **off unless an operator arms it**, and why the floor above exists: a pairing with two
 * lessons cannot show a difference, so denying half its runs buys nothing.
 *
 * ## What this does not do, and the reason it differs from the map trial
 *
 * **It does not turn anything off.** The map trial's default is off-until-proven, and that
 * costs nothing because a map is newly built per pairing — there is no behaviour to
 * withdraw. Tier 5 is already live in every workspace, so a `no-better` verdict that
 * silently stopped showing lessons would be a policy change nobody registered, decided on
 * five runs a side. So the verdict is **computed and reported**; what the platform does
 * about it is a human's override, in both directions. The measurement ranks and a person
 * decides, which is the same division the variant search keeps.
 *
 * The trial does stop once it has an answer, because continuing to withhold after the
 * question is settled is spend with nothing left to buy.
 */

/** Which side of the trial a run was on. `withheld` rows *are* the baseline. */
export type ExperienceArm = 'retrieved' | 'withheld'

export const EXPERIENCE_ARMS: readonly ExperienceArm[] = ['retrieved', 'withheld']

/**
 * How many live lessons a pairing needs before it is worth denying runs.
 *
 * Four, the floor a held-out screen uses and for the same reason: below it the comparison is
 * not a comparison. A persona holding two lessons about a repository differs from a persona
 * holding none by two lines of prose, and a trial over that difference spends real runs to
 * measure noise. A pairing under the floor is simply shown what it has.
 */
export const MIN_LESSONS_TO_TRIAL = 4

/**
 * What the platform does with a persona's memory of a repository when a run starts.
 *
 * `trial` is the state in which the question is open and the platform is deliberately paying
 * for an answer. `on` is the shipped behaviour and the default everywhere the trial is not
 * armed — which is not the map trial's default, and the header says why.
 */
export type ExperienceState = 'trial' | 'on' | 'off'

/** A human's standing answer, which overrides the measurement in either direction. */
export type ExperienceOverride = 'on' | 'off' | null

export interface ExperienceArmTally extends VerificationTally {
  readonly arm: ExperienceArm
  /** Runs on this arm that reached a disposition, failed, or failed their checks. */
  readonly decided: number
  readonly merged: number
  readonly discarded: number
  readonly failed: number
  readonly costUsdTotal: number
}

export interface ExperienceArmSummary extends ExperienceArmTally {
  readonly successRate: number
  readonly meanCostUsd: number
  readonly verificationFailureRate: number
}

export type ExperienceVerdict =
  /** Not enough decided runs on both arms yet — keep sampling. */
  | 'undecided'
  /** The lessons beat working without them. */
  | 'helps'
  /** They did not — level, or worse, or the same outcomes for materially more money. */
  | 'no-better'

export interface ExperienceEffect {
  readonly retrieved: ExperienceArmSummary
  readonly withheld: ExperienceArmSummary
  readonly verdict: ExperienceVerdict
  /** One sentence a human reads instead of doing the arithmetic. */
  readonly detail: string
}

const EMPTY = (arm: ExperienceArm): ExperienceArmTally => ({
  arm,
  decided: 0,
  merged: 0,
  discarded: 0,
  failed: 0,
  costUsdTotal: 0,
  verificationFailed: 0,
  failingCheck: null,
})

const summarizeArm = (tally: ExperienceArmTally): ExperienceArmSummary => ({
  ...tally,
  successRate: tally.decided === 0 ? 0 : tally.merged / tally.decided,
  meanCostUsd: tally.decided === 0 ? 0 : tally.costUsdTotal / tally.decided,
  verificationFailureRate: verificationFailureRate(tally),
})

const RETRIEVED_LABEL = 'runs shown what it had learned'
const WITHHELD_LABEL = 'runs denied it'

/**
 * Which arm the next run against this pairing goes on.
 *
 * Alternating from the counts already recorded, never sampling — the same three reasons
 * every arm assignment in this platform gives: a random arm cannot be replayed from the
 * journal, cannot be tested, and reaches balance only asymptotically, which with five runs a
 * side means spending half the evidence on an imbalance nobody wanted.
 *
 * **Ties go to `retrieved`**, and here the asymmetry runs the opposite way from the map's.
 * A new map is an untested artifact, so its first run is the baseline; a persona's lessons
 * are what this platform already does, so at zero-and-zero the honest first sample is the
 * live behaviour. A pairing armed and then used once has measured what actually happens
 * rather than a counterfactual.
 */
export const nextExperienceArm = (used: {
  retrieved: number
  withheld: number
}): ExperienceArm =>
  used.retrieved > used.withheld ? 'withheld' : used.retrieved < used.withheld ? 'retrieved' : 'retrieved'

export const summarizeExperienceEffect = (
  tallies: readonly ExperienceArmTally[],
): ExperienceEffect => {
  const retrieved = summarizeArm(
    tallies.find((tally) => tally.arm === 'retrieved') ?? EMPTY('retrieved'),
  )
  const withheld = summarizeArm(
    tallies.find((tally) => tally.arm === 'withheld') ?? EMPTY('withheld'),
  )

  const verification = describeVerificationFailures(
    { label: RETRIEVED_LABEL, ...retrieved },
    { label: WITHHELD_LABEL, ...withheld },
  )

  if (retrieved.decided < MIN_DECIDED_RUNS_PER_ARM || withheld.decided < MIN_DECIDED_RUNS_PER_ARM) {
    return {
      retrieved,
      withheld,
      verdict: 'undecided',
      detail:
        `Still measuring: ${retrieved.decided} decided run(s) shown this persona's lessons ` +
        `about this repository against ${withheld.decided} deliberately denied them. Each ` +
        `side needs ${MIN_DECIDED_RUNS_PER_ARM} before the comparison says anything — and ` +
        'until then half the runs here are working without a memory this persona has, which ' +
        'is what the trial costs.' +
        verification,
    }
  }

  const asPercent = (rate: number) => `${Math.round(rate * 100)}%`
  const money = (usd: number) => `$${usd.toFixed(4)}`
  const level = `${asPercent(retrieved.successRate)} against ${asPercent(withheld.successRate)}`

  /**
   * The comparison is `compareTrialArms` — the same function, the same order, the same
   * tolerances as the map trial and the variant search. Only the sentences are this file's,
   * because "runs shown what it had learned" is not "runs that read this map".
   */
  const { favours, term } = compareTrialArms(retrieved, withheld)

  if (term === 'outcomes') {
    return favours === 'candidate'
      ? {
          retrieved,
          withheld,
          verdict: 'helps',
          detail:
            `Runs shown this persona's lessons about this repository got work merged ` +
            `${asPercent(retrieved.successRate)} of the time against ` +
            `${asPercent(withheld.successRate)} for runs deliberately denied them.` +
            verification,
        }
      : {
          retrieved,
          withheld,
          verdict: 'no-better',
          detail:
            `Runs shown this persona's lessons merged ${asPercent(retrieved.successRate)} of ` +
            `the time against ${asPercent(withheld.successRate)} without them — the memory is ` +
            `making things worse. Nothing has been turned off; that is your call.${verification}`,
        }
  }

  if (term === 'verification') {
    return favours === 'candidate'
      ? {
          retrieved,
          withheld,
          verdict: 'helps',
          detail:
            `Outcomes are level (${level}), and runs shown this persona's lessons leave fewer ` +
            `branches failing this repository's definition of done.${verification}`,
        }
      : {
          retrieved,
          withheld,
          verdict: 'no-better',
          detail:
            `Outcomes are level (${level}), and runs shown this persona's lessons leave *more* ` +
            `branches failing this repository's definition of done. Nothing has been turned ` +
            `off; that is your call.${verification}`,
        }
  }

  /**
   * Cost, last, and this is where a memory that neither helps nor hurts is actually caught:
   * the same work, done as well, for more money, is the shape a useless context takes when
   * it is not an actively harmful one. Every lesson is charged to every run that reads it.
   */
  if (term === 'cost' && favours === 'candidate') {
    return {
      retrieved,
      withheld,
      verdict: 'helps',
      detail:
        `Outcomes are level (${level}), and runs shown this persona's lessons cost ` +
        `${money(retrieved.meanCostUsd)} against ${money(withheld.meanCostUsd)} — the memory ` +
        `is paying for itself in rediscovery it replaced.${verification}`,
    }
  }

  return {
    retrieved,
    withheld,
    verdict: 'no-better',
    detail:
      `No measurable difference: ${level} merged, at ${money(retrieved.meanCostUsd)} against ` +
      `${money(withheld.meanCostUsd)} a run. This persona's memory of this repository is ` +
      `costing context and buying nothing here. Nothing has been turned off; that is your ` +
      `call.${verification}`,
  }
}

/**
 * What the platform will actually do, given the arming, the store, the measurement and the
 * human.
 *
 * The order is the argument. A human's override wins first, in both directions, because
 * promotion and demotion are both human acts. Then the arming: a workspace that has not
 * asked for a trial gets the shipped behaviour, which is `on`. Then the floor, which is the
 * kill criterion doing its work before anything is denied. Only then does the verdict
 * decide, and it decides only between `trial` and `on` — **`no-better` is reported and never
 * enforced**, for the reason this module's header gives: withdrawing a live capability
 * across a workspace on five runs a side is a policy change, and this is an instrument.
 */
export const experienceStateFor = (input: {
  readonly override: ExperienceOverride
  /** Whether an operator has armed the trial for this workspace. Off by default. */
  readonly trialArmed: boolean
  /** Live lessons this `(persona, repository)` pair holds. */
  readonly liveLessons: number
  readonly verdict: ExperienceVerdict
}): ExperienceState => {
  if (input.override === 'on') return 'on'
  if (input.override === 'off') return 'off'
  if (!input.trialArmed) return 'on'
  if (input.liveLessons < MIN_LESSONS_TO_TRIAL) return 'on'
  return input.verdict === 'undecided' ? 'trial' : 'on'
}

/**
 * Whether this run is shown the lessons, and which arm it goes on the record as.
 *
 * `null` means nothing is recorded: an `off` pairing is off, and writing withheld rows for
 * it would inflate a baseline against a question nobody is asking any more. An `on` pairing
 * records `retrieved` rather than nothing, so a trial armed later starts against a real
 * history instead of an empty one — the rows are cheap and the alternative is a workspace
 * that has to wait five runs to learn what it already did.
 */
export const experienceAssignment = (
  state: ExperienceState,
  used: { retrieved: number; withheld: number },
): ExperienceArm | null => {
  if (state === 'off') return null
  if (state === 'on') return 'retrieved'
  return nextExperienceArm(used)
}
