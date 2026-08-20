import { describe, expect, it } from 'vitest'
import {
  escalateAfterFailure,
  routeModel,
  scaleCostForTier,
  type AttemptOutcome,
} from './model-routing.js'

/**
 * Escalation after a definition-of-done failure.
 *
 * Every refusal here is money, which is what makes them the interesting half: an escalation that
 * fires on the wrong signal spends 3× on a disconnected Runner, and one that fires twice spends
 * 9× to learn that the tier was never the problem.
 */

const HAIKU = 'claude-haiku-4-5-20251001'
const SONNET = 'claude-sonnet-5'
const OPUS = 'claude-opus-5'
const FABLE = 'claude-fable-5'

const escalate = (over: {
  outcome?: AttemptOutcome
  model?: string
  attempt?: number
  ceilingModel?: string | null
  spentUsd?: number | null
  budgetRemainingUsd?: number | null
} = {}) =>
  escalateAfterFailure({
    outcome: over.outcome ?? 'checks-failed',
    model: over.model ?? HAIKU,
    attempt: over.attempt ?? 1,
    ceilingModel: over.ceilingModel === undefined ? null : over.ceilingModel,
    spentUsd: over.spentUsd === undefined ? 0.2 : over.spentUsd,
    budgetRemainingUsd: over.budgetRemainingUsd === undefined ? 5 : over.budgetRemainingUsd,
  })

const refusal = (verdict: ReturnType<typeof escalate>) => {
  expect(verdict.ok).toBe(false)
  if (verdict.ok) throw new Error('expected a refusal')
  return verdict
}

describe('escalateAfterFailure', () => {
  it('retries one tier up when the branch failed the repository\'s checks', () => {
    const verdict = escalate()
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.model).toBe(SONNET)
    // One step. Haiku to Fable would skip the tier that would probably have done it.
    expect(verdict.detail).toContain('one tier up, never two')
  })

  /**
   * The estimate is a measured number scaled by a known ratio. Haiku is 1+5 and Sonnet is 3+15,
   * so a retry is three times what the first attempt actually cost.
   */
  it('estimates the retry from what the first attempt really spent', () => {
    const verdict = escalate({ spentUsd: 0.2 })
    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.estimatedCostUsd).toBeCloseTo(0.6, 6)
    expect(verdict.detail).toContain('0.6000')
  })

  it('escalates without an estimate rather than refusing when the attempt has no recorded spend', () => {
    const verdict = escalate({ spentUsd: null })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.estimatedCostUsd).toBeNull()
    expect(verdict.detail).toContain('unknown')
  })

  /**
   * The signal, and it is the whole design. A crashed run is not evidence about capability: a
   * disconnected Runner, a cancelled session and a missing dependency all look like this.
   */
  it('refuses to escalate a run that failed rather than a branch that failed its checks', () => {
    const verdict = refusal(escalate({ outcome: 'run-failed' }))
    expect(verdict.rule).toBe('not-a-check-failure')
    expect(verdict.reason).toContain('disconnected Runner')
  })

  it('refuses when nothing judged the branch, rather than defaulting to a retry', () => {
    const verdict = refusal(escalate({ outcome: 'unverified' }))
    expect(verdict.rule).toBe('not-a-check-failure')
    expect(verdict.reason).toContain('no definition of done')
  })

  it('refuses when the checks passed', () => {
    expect(refusal(escalate({ outcome: 'checks-passed' })).rule).toBe('not-a-check-failure')
  })

  /** Once. A second escalation says the tier was not what was wrong. */
  it('refuses a second escalation', () => {
    const verdict = refusal(escalate({ attempt: 2 }))
    expect(verdict.rule).toBe('already-escalated')
    expect(verdict.reason).toContain('cost lever pulling backwards')
  })

  it('refuses at the top tier, because a bigger model does not exist', () => {
    expect(refusal(escalate({ model: FABLE })).rule).toBe('at-top-tier')
  })

  it('refuses a model it cannot rank, since there is no "one tier up" for it', () => {
    expect(refusal(escalate({ model: 'some-local-llm' })).rule).toBe('unpriced')
  })

  /**
   * The ceiling is a human's decision about how far a persona may reach. An escalation that
   * stepped over it would be a widening nobody granted, arriving by retry rather than by edit.
   */
  it('refuses to step over a ceiling a human set', () => {
    const verdict = refusal(escalate({ model: SONNET, ceilingModel: SONNET }))
    expect(verdict.rule).toBe('at-ceiling')
    expect(verdict.reason).toContain('nobody granted')
  })

  it('escalates up to the ceiling but not past it', () => {
    const verdict = escalate({ model: HAIKU, ceilingModel: SONNET })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.model).toBe(SONNET)
  })

  it('refuses a ceiling it cannot rank rather than treating it as no ceiling', () => {
    expect(refusal(escalate({ ceilingModel: 'some-local-llm' })).rule).toBe('at-ceiling')
  })

  /**
   * A retry the cap kills halfway is worse than no retry: it spends most of the money and
   * produces nothing.
   */
  it('refuses when the estimate exceeds what is left of the cap', () => {
    const verdict = refusal(escalate({ spentUsd: 0.5, budgetRemainingUsd: 1 }))
    expect(verdict.rule).toBe('over-budget')
    expect(verdict.reason).toContain('1.0000')
  })

  it('escalates on an uncapped run without inventing a limit', () => {
    expect(escalate({ spentUsd: 1000, budgetRemainingUsd: null }).ok).toBe(true)
  })
})

describe('scaleCostForTier', () => {
  it('scales by the ratio of the two tiers, in both directions', () => {
    expect(scaleCostForTier({ from: HAIKU, to: SONNET, spentUsd: 1 })).toBeCloseTo(3, 6)
    expect(scaleCostForTier({ from: OPUS, to: HAIKU, spentUsd: 3 })).toBeCloseTo(0.6, 6)
  })

  /** Null must never read as free — every caller of this treats it as "unknown". */
  it('returns null rather than a number it cannot justify', () => {
    expect(scaleCostForTier({ from: HAIKU, to: SONNET, spentUsd: null })).toBeNull()
    expect(scaleCostForTier({ from: 'some-local-llm', to: SONNET, spentUsd: 1 })).toBeNull()
    expect(scaleCostForTier({ from: HAIKU, to: 'some-local-llm', spentUsd: 1 })).toBeNull()
  })
})

/**
 * The routing table.
 *
 * Observational, which is the fact every one of these tests is shaped by: nothing was randomised
 * and nothing withheld, so the table is confounded by whoever chose the model. That is why it
 * only ever routes *down* — the confound biases against expensive models, so using it to save
 * money risks the mistake it is most likely making, while using it to spend more compounds one.
 */
const observation = (
  model: string,
  over: Partial<{ decided: number; merged: number; verificationFailed: number; meanCostUsd: number }> = {},
) => ({
  model,
  decided: over.decided ?? 5,
  merged: over.merged ?? 4,
  verificationFailed: over.verificationFailed ?? 0,
  meanCostUsd: over.meanCostUsd ?? 0.1,
})

const route = (
  observations: ReturnType<typeof observation>[],
  over: { ceilingModel?: string | null; minDecided?: number } = {},
) =>
  routeModel({
    taskClass: 'swe',
    observations,
    ceilingModel: over.ceilingModel === undefined ? null : over.ceilingModel,
    minDecided: over.minDecided ?? 5,
  })

describe('routeModel', () => {
  it('picks the cheapest model nothing more expensive has beaten', () => {
    const verdict = route([
      observation(HAIKU, { merged: 4 }),
      observation(SONNET, { merged: 4, meanCostUsd: 0.3 }),
    ])
    expect(verdict.kind).toBe('measured')
    expect(verdict.model).toBe(HAIKU)
    // The sentence has to say what kind of evidence this is, because it is the weak kind.
    expect(verdict.detail).toContain('what has happened rather than as what works')
  })

  it('moves up when the cheap model is beaten on what humans merged', () => {
    const verdict = route([
      observation(HAIKU, { merged: 1 }),
      observation(SONNET, { merged: 5, meanCostUsd: 0.3 }),
    ])
    expect(verdict.model).toBe(SONNET)
  })

  /**
   * And on the repository's checks, which is the term that exists so a fitness is more than a
   * record of what a reviewer had time for.
   */
  it('moves up when outcomes are level but the cheap model leaves more failing checks', () => {
    const verdict = route([
      observation(HAIKU, { merged: 4, verificationFailed: 4 }),
      observation(SONNET, { merged: 4, verificationFailed: 0, meanCostUsd: 0.3 }),
    ])
    expect(verdict.model).toBe(SONNET)
  })

  /**
   * Cost is excluded from "beats" deliberately: the walk is already ordered cheapest-first, so
   * letting cost decide would be the sort order voting twice.
   */
  it('does not move up merely because an expensive model is cheaper per run', () => {
    const verdict = route([
      observation(HAIKU, { merged: 4, meanCostUsd: 0.9 }),
      observation(SONNET, { merged: 4, meanCostUsd: 0.1 }),
    ])
    expect(verdict.model).toBe(HAIKU)
  })

  it('takes the best observed when every cheaper model has been beaten', () => {
    const verdict = route([
      observation(HAIKU, { merged: 0 }),
      observation(SONNET, { merged: 2 }),
      observation(OPUS, { merged: 5 }),
    ])
    expect(verdict.model).toBe(OPUS)
    expect(verdict.detail).toContain('Every cheaper model has been beaten')
  })

  /** Below the sample, the persona's own model stands and the sentence says how far off it is. */
  it('says it has no evidence rather than defaulting to something', () => {
    const verdict = route([observation(HAIKU, { decided: 2 }), observation(SONNET, { decided: 1 })])
    expect(verdict.kind).toBe('no-evidence')
    expect(verdict.model).toBeNull()
    expect(verdict.detail).toContain('3 finished run(s)')
  })

  it('refuses to route on one model alone, however much of it there is', () => {
    const verdict = route([observation(HAIKU, { decided: 500 })])
    expect(verdict.kind).toBe('no-evidence')
    expect(verdict.detail).toContain('Two models have to have been used')
  })

  it('ignores a model it cannot rank rather than guessing where it sits', () => {
    const verdict = route([observation(HAIKU), observation('some-local-llm', { merged: 5 })])
    expect(verdict.kind).toBe('no-evidence')
  })

  /**
   * A ceiling is a human's bound. Where the evidence points above it, the run goes to the ceiling
   * and the sentence says the evidence disagrees — which is the actionable half.
   */
  it('runs at the ceiling when the evidence points above it, and says so', () => {
    const verdict = route(
      [observation(HAIKU, { merged: 0 }), observation(OPUS, { merged: 5 })],
      { ceilingModel: SONNET },
    )
    expect(verdict.kind).toBe('clamped')
    expect(verdict.model).toBe(SONNET)
    expect(verdict.detail).toContain('Worth a human raising')
  })

  it('clamps the every-cheaper-model-beaten case to the ceiling too', () => {
    const verdict = route(
      [
        observation(HAIKU, { merged: 0 }),
        observation(SONNET, { merged: 2 }),
        observation(OPUS, { merged: 5 }),
      ],
      { ceilingModel: SONNET },
    )
    expect(verdict.kind).toBe('clamped')
    expect(verdict.model).toBe(SONNET)
  })
})
