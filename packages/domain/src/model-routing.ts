import { compareTrialArms } from './expertise-trial.js'
import { findModelPrice, modelTierRank, SELECTABLE_MODELS } from './model-pricing.js'

/**
 * Model routing — which model a run gets, and what happens when the cheap one was not enough.
 *
 * The largest single cost lever in this platform, and the reason is arithmetic rather than
 * insight: the tier table spans 10× on input and 10× on output, so the difference between
 * running a fleet on Haiku with escalation and running it on Opus by default is the difference
 * between two invoices with the same work behind them. Everything here exists to make the cheap
 * default safe rather than to make an expensive default cheaper.
 *
 * ## Escalation, and what it deliberately is not
 *
 * A run whose branch failed the repository's definition of done is the one honest signal this
 * platform has that a model was too small for a task: the checks are the repository's, the
 * verdict is derived server-side, and the model had no part in either. So that — and only that —
 * buys a retry one tier up.
 *
 * **Not a crashed run.** A run that failed is not evidence about capability, and retrying it at
 * a higher tier pays more for the same disconnected Runner, the same missing dependency, the
 * same cancelled session. Cost is the whole point of routing, and an escalation that fires on
 * infrastructure is a lever pulling the wrong way.
 *
 * **Exactly one step, and exactly one retry.** Haiku to Sonnet, never Haiku to Fable: the point
 * is to find the cheapest model that does the work, and jumping the tier that would probably
 * have done it is how routing becomes "use the expensive one, slowly". And a second escalation
 * is a task the model tier is not the problem with — paying twice more to learn that is the
 * lever backwards again.
 *
 * **Never past a ceiling a human set.** The envelope bounds what a persona may *become*, and an
 * escalation that widened the model past it would be a widening nobody granted, arriving through
 * a retry rather than through a self-edit. Same for a delegated child against its parent's tier.
 *
 * **Never past the budget.** A higher tier costs more per token by a known ratio, so the estimate
 * is the first attempt's actual spend scaled by that ratio — a real number from a real run rather
 * than a guess. A retry the cap would kill halfway is worse than no retry: it spends most of the
 * money and produces nothing.
 */

/** What the platform knows about a finished attempt, in the terms the decision needs. */
export type AttemptOutcome =
  /** The branch failed the repository's definition of done — the only outcome that escalates. */
  | 'checks-failed'
  /** The branch passed. */
  | 'checks-passed'
  /** The run itself failed, was cancelled, or was reaped. Says nothing about the model. */
  | 'run-failed'
  /** No verdict: no checks are configured, or the verification never ran. */
  | 'unverified'

export type EscalationRule =
  | 'not-a-check-failure'
  | 'already-escalated'
  | 'unpriced'
  | 'at-top-tier'
  | 'at-ceiling'
  | 'over-budget'

export type EscalationVerdict =
  | {
      readonly ok: true
      /** The model the retry runs on — exactly one tier above the attempt that failed. */
      readonly model: string
      /** What the retry is expected to cost, from the first attempt's real spend. */
      readonly estimatedCostUsd: number | null
      readonly detail: string
    }
  | { readonly ok: false; readonly rule: EscalationRule; readonly reason: string }

const nextTierUp = (model: string): string | null => {
  const rank = modelTierRank(model)
  if (rank === null) return null
  const candidates = SELECTABLE_MODELS.filter((entry) => entry.tier === rank + 1)
  return candidates[0]?.id ?? null
}

/**
 * What a retry at `to` would cost, from what the attempt at `from` actually cost.
 *
 * The ratio of the two tiers' prices applied to a measured figure, which is the only estimate
 * here worth having: token counts vary by an order of magnitude between tasks, so any absolute
 * guess would be wrong by more than the tier difference it is trying to price. Null when either
 * model is unpriced, or when the attempt has no recorded cost — and null must not read as free.
 *
 * Input and output are averaged rather than modelled separately: the split is unknown at decision
 * time, the two ratios are identical across this table today, and a weighted estimate that
 * pretended otherwise would be precision nobody supplied.
 */
export const scaleCostForTier = (input: {
  readonly from: string
  readonly to: string
  readonly spentUsd: number | null
}): number | null => {
  if (input.spentUsd === null) return null
  const from = findModelPrice(input.from)
  const to = findModelPrice(input.to)
  if (from === null || to === null) return null
  const fromRate = from.inputPerMTok + from.outputPerMTok
  if (fromRate === 0) return null
  const ratio = (to.inputPerMTok + to.outputPerMTok) / fromRate
  return input.spentUsd * ratio
}

export const escalateAfterFailure = (input: {
  readonly outcome: AttemptOutcome
  readonly model: string
  /**
   * How many attempts this task has already had, this one included. 1 is a first run.
   *
   * A count rather than a boolean, because "was this an escalation" and "how many times has
   * this been tried" are different questions and only the second one bounds the spend.
   */
  readonly attempt: number
  /**
   * The highest model this run may reach — an envelope's ceiling, or a parent's tier for a
   * delegated child. Null means nothing narrower than the tier table bounds it.
   */
  readonly ceilingModel: string | null
  /** What the failed attempt actually cost, for the estimate. */
  readonly spentUsd: number | null
  /** What is left of the cap this run is measured against. Null is an uncapped run. */
  readonly budgetRemainingUsd: number | null
}): EscalationVerdict => {
  if (input.outcome !== 'checks-failed') {
    return {
      ok: false,
      rule: 'not-a-check-failure',
      reason:
        input.outcome === 'run-failed'
          ? 'The run failed rather than its branch failing the checks, which is not evidence ' +
            'about the model: a disconnected Runner, a cancelled session and a missing ' +
            'dependency all look like this, and a higher tier fixes none of them.'
          : input.outcome === 'unverified'
            ? 'Nothing judged this branch, so there is no failure to escalate from. A ' +
              'repository with no definition of done gets no routing signal at all — which is ' +
              'the honest answer rather than a default.'
            : 'The branch passed its checks. There is nothing to retry.',
    }
  }

  if (input.attempt >= 2) {
    return {
      ok: false,
      rule: 'already-escalated',
      reason:
        `This task has already been attempted ${input.attempt} times. One escalation is the ` +
        'limit: a second says the tier was not what was wrong, and paying more again to learn ' +
        'that is the cost lever pulling backwards. A human reads the two attempts.',
    }
  }

  const next = nextTierUp(input.model)
  if (modelTierRank(input.model) === null) {
    return {
      ok: false,
      rule: 'unpriced',
      reason:
        `"${input.model}" is not in the tier table, so there is no "one tier up" and no way to ` +
        'estimate what a retry would cost. Both of those are required, so nothing is retried.',
    }
  }
  if (next === null) {
    return {
      ok: false,
      rule: 'at-top-tier',
      reason:
        `"${input.model}" is already the highest tier this platform prices, so a failure here ` +
        'is a failure a bigger model does not fix. This is the task a human looks at.',
    }
  }

  if (input.ceilingModel !== null) {
    const ceiling = modelTierRank(input.ceilingModel)
    const wanted = modelTierRank(next)
    if (ceiling === null || wanted === null || wanted > ceiling) {
      return {
        ok: false,
        rule: 'at-ceiling',
        reason:
          `A retry would need "${next}", which is above the ceiling of "${input.ceilingModel}" ` +
          'this run is bounded by. A ceiling is a human\'s decision about how far this persona ' +
          'may reach, and an escalation that stepped over it would be a widening nobody granted.',
      }
    }
  }

  const estimatedCostUsd = scaleCostForTier({ from: input.model, to: next, spentUsd: input.spentUsd })
  if (
    input.budgetRemainingUsd !== null &&
    estimatedCostUsd !== null &&
    estimatedCostUsd > input.budgetRemainingUsd
  ) {
    return {
      ok: false,
      rule: 'over-budget',
      reason:
        `A retry on "${next}" is estimated at $${estimatedCostUsd.toFixed(4)} from what the ` +
        `first attempt actually spent, and $${input.budgetRemainingUsd.toFixed(4)} is left. A ` +
        'retry the cap kills halfway is worse than none: it spends most of the money and ' +
        'produces nothing.',
    }
  }

  return {
    ok: true,
    model: next,
    estimatedCostUsd,
    detail:
      `The branch failed this repository's checks on "${input.model}", so the task is retried ` +
      `once on "${next}" — one tier up, never two, because the point of routing is to find the ` +
      'cheapest model that does the work' +
      (estimatedCostUsd === null
        ? '. What it will cost is unknown: the first attempt has no recorded spend.'
        : `. Estimated at $${estimatedCostUsd.toFixed(4)}, from what the first attempt cost.`),
  }
}

/**
 * What has actually happened on one model for one class of task.
 *
 * The same four terms every other fitness in this platform uses — decided, merged,
 * verification-failed, mean cost — because a human reading a routing table beside a prompt trial
 * must not be reading two different definitions of "worked".
 */
export interface ModelObservation {
  readonly model: string
  /** Finished runs with a disposition, a failure, or a definition-of-done verdict. */
  readonly decided: number
  readonly merged: number
  readonly verificationFailed: number
  readonly meanCostUsd: number
}

export type RoutingKind =
  /** Enough evidence, and the cheapest model nothing beats is the choice. */
  | 'measured'
  /** The evidence points above the ceiling this run is bounded by, so the ceiling is the choice. */
  | 'clamped'
  /** Not enough decided runs. The persona's own model stands. */
  | 'no-evidence'

export interface RoutingVerdict {
  /** Null means "use what the persona says" — never a silent default to something else. */
  readonly model: string | null
  readonly kind: RoutingKind
  readonly detail: string
}

const rate = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole)

const asPercent = (value: number): string => `${Math.round(value * 100)}%`

const asMoney = (value: number): string => `$${value.toFixed(4)}`

/**
 * The cheapest model that nothing more expensive beats, for one class of task.
 *
 * ## This table is observational, and that is the most important sentence about it
 *
 * Every other measurement in this platform is an experiment: a prompt trial alternates arms, the
 * held-out screen replays the same items, the expertise trial withholds a baseline deliberately.
 * This one reads runs that were already happening — nothing was randomised, and nothing was
 * withheld. So the table is **confounded by whoever chose the model**: a persona whose hard tasks
 * were all handed to Opus by a human will show Opus with the worse merge rate, and a naive reader
 * of that number concludes Opus is worse at the work it was brought in to rescue.
 *
 * Three things follow, and they are the design rather than caveats:
 *
 * - **The comparison is `compareTrialArms`**, the same one every trial here uses, so the
 *   tolerances and the order of terms — what a human decided, then what the repository's checks
 *   decided, then money — are not re-invented for a weaker kind of evidence.
 * - **It only ever routes *down*, by preferring the cheapest model nothing beats.** The
 *   asymmetry is deliberate: the confound above biases *against* expensive models, so acting on
 *   it to save money risks the mistake this table is most likely to be making, and acting on it
 *   to spend more compounds it. Escalation is what moves a task up a tier, and escalation runs on
 *   a real signal.
 * - **`no-evidence` is a first-class answer.** Below the minimum sample the persona's own model
 *   stands, and the sentence says how far off the evidence is rather than implying a default.
 */
export const routeModel = (input: {
  readonly taskClass: string
  readonly observations: readonly ModelObservation[]
  /** The highest model this run may reach, or null for unbounded by anything but the table. */
  readonly ceilingModel: string | null
  /** How many decided runs one model needs before it counts. */
  readonly minDecided: number
}): RoutingVerdict => {
  const ranked = input.observations
    .filter((entry) => entry.decided >= input.minDecided && modelTierRank(entry.model) !== null)
    .map((entry) => ({
      ...entry,
      tier: modelTierRank(entry.model) as number,
      facts: {
        successRate: rate(entry.merged, entry.decided),
        verificationFailureRate: rate(entry.verificationFailed, entry.decided),
        meanCostUsd: entry.meanCostUsd,
      },
    }))
    .sort((a, b) => a.tier - b.tier)

  if (ranked.length < 2) {
    const seen = input.observations.reduce((total, entry) => total + entry.decided, 0)
    return {
      model: null,
      kind: 'no-evidence',
      detail:
        `Nothing to route "${input.taskClass}" on yet: ${ranked.length} of ` +
        `${input.observations.length} model(s) have the ${input.minDecided} decided runs this ` +
        `needs, across ${seen} finished run(s) in total. Two models have to have been used ` +
        'before one can be compared to the other, so the persona\'s own model stands.',
    }
  }

  const ceiling = input.ceilingModel === null ? null : modelTierRank(input.ceilingModel)

  /**
   * Walk up from the cheapest and stop at the first model nothing more expensive beats on
   * outcomes or on the repository's checks. Cost is excluded from "beats" on purpose: this walk
   * is already ordered by cost, so letting cost decide would be the sort order voting twice.
   *
   * The walk always stops, and it is worth saying why rather than leaving a branch for the case
   * that cannot happen: "beaten" means beaten by something *above* it, and nothing is above the
   * most expensive model observed. A first version of this had an unreachable block after the
   * loop for that case, which a test caught by asserting on a sentence it could never produce.
   */
  let beatenCheaper = 0
  let chosen: (typeof ranked)[number] | null = null
  for (const candidate of ranked) {
    const beatenBy = ranked.find((other) => {
      if (other.tier <= candidate.tier) return false
      const { favours, term } = compareTrialArms(other.facts, candidate.facts)
      return favours === 'candidate' && (term === 'outcomes' || term === 'verification')
    })
    if (beatenBy !== undefined) {
      beatenCheaper += 1
      continue
    }
    chosen = candidate
    break
  }
  // Non-null by the argument above: the last element can never be skipped.
  const winner = chosen ?? ranked[ranked.length - 1]!

  if (ceiling !== null && winner.tier > ceiling) {
    return {
      model: input.ceilingModel,
      kind: 'clamped',
      detail:
        `What has happened on "${input.taskClass}" points at "${winner.model}", which is above ` +
        `the ceiling of "${input.ceilingModel}" this run is bounded by — so it runs at the ` +
        'ceiling. Worth a human raising if the work keeps failing there.',
    }
  }

  return {
    model: winner.model,
    kind: 'measured',
    detail:
      (beatenCheaper === 0
        ? `"${winner.model}" is the cheapest model nothing better has beaten on ` +
          `"${input.taskClass}"`
        : `Every cheaper model has been beaten on "${input.taskClass}", so "${winner.model}" is ` +
          'the choice') +
      `: ${asPercent(winner.facts.successRate)} of ${winner.decided} finished runs merged, at ` +
      `${asMoney(winner.meanCostUsd)} a run. Read as what has happened rather than as what ` +
      'works — nothing was randomised here, so the model a human reached for on the hard tasks ' +
      'carries their difficulty with it.',
  }
}
