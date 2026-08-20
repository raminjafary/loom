import { describe, expect, it } from 'vitest'
import { escalateAfterFailure, scaleCostForTier, type AttemptOutcome } from './model-routing.js'

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
