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
