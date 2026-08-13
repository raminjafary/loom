import { describe, expect, it } from 'vitest'
import {
 MIN_DECIDED_RUNS_PER_ARM,
 nextTrialArm,
 retrievalStateFor,
 summarizeExpertiseEffect,
 trialAssignment,
 type ExpertiseArmTally,
} from './expertise-trial.js'

/**
 * The gate: an expertise is off for a pairing until it beats the unaided baseline,
 * and "improves over time has to be a measurement or it is a feeling".
 */

const tally = (overrides: Partial<ExpertiseArmTally> & { arm: 'retrieved' | 'withheld' }): ExpertiseArmTally => ({
 decided: 0,
 merged: 0,
 discarded: 0,
 failed: 0,
 costUsdTotal: 0,
...overrides,
})

describe('nextTrialArm — how the baseline gets written down at all', => {
 /**
 * The whole reason a trial exists. "Off until it proves itself" cannot be implemented
 * literally: nothing retrieves, so nothing is measured, and the honest default becomes
 * a permanent one.
 */
 it('alternates, so both arms accumulate', => {
 expect(nextTrialArm({ retrieved: 0, withheld: 0 })).toBe('withheld')
 expect(nextTrialArm({ retrieved: 0, withheld: 1 })).toBe('retrieved')
 expect(nextTrialArm({ retrieved: 1, withheld: 1 })).toBe('withheld')
 expect(nextTrialArm({ retrieved: 3, withheld: 1 })).toBe('withheld')
 })

 /**
 * A tie goes to the baseline, so a pairing used exactly once has measured the *unaided*
 * case rather than having handed one run an untested map and learned nothing from it.
 */
 it('makes the first run of a new expertise the baseline', => {
 expect(nextTrialArm({ retrieved: 0, withheld: 0 })).toBe('withheld')
 })
})

describe('summarizeExpertiseEffect', => {
 it('refuses to decide before either arm has enough decided runs', => {
 const effect = summarizeExpertiseEffect([
 tally({ arm: 'retrieved', decided: 9, merged: 9, costUsdTotal: 1 }),
 tally({ arm: 'withheld', decided: 2, merged: 0, costUsdTotal: 1 }),
 ])
 expect(effect.verdict).toBe('undecided')
 expect(effect.detail).toContain(String(MIN_DECIDED_RUNS_PER_ARM))
 })

 it('counts a map that merges more often than the baseline as helping', => {
 const effect = summarizeExpertiseEffect([
 tally({ arm: 'retrieved', decided: 5, merged: 4, discarded: 1, costUsdTotal: 1 }),
 tally({ arm: 'withheld', decided: 5, merged: 2, discarded: 3, costUsdTotal: 1 }),
 ])
 expect(effect.verdict).toBe('helps')
 expect(effect.detail).toContain('80%')
 expect(effect.detail).toContain('40%')
 })

 it('says so when a map is making things worse, rather than only failing to help', => {
 const effect = summarizeExpertiseEffect([
 tally({ arm: 'retrieved', decided: 5, merged: 1, discarded: 4, costUsdTotal: 1 }),
 tally({ arm: 'withheld', decided: 5, merged: 4, discarded: 1, costUsdTotal: 1 }),
 ])
 expect(effect.verdict).toBe('no-better')
 expect(effect.detail).toContain('making things worse')
 })

 /**
 * The case portable expertise actually names: same outcomes, more money. That is the
 * context-window tax with a reassuring name, and a rule that only compared outcomes
 * would pass it.
 */
 it('refuses a map that produces the same outcomes for materially more money', => {
 const effect = summarizeExpertiseEffect([
 tally({ arm: 'retrieved', decided: 5, merged: 3, costUsdTotal: 2.0 }),
 tally({ arm: 'withheld', decided: 5, merged: 3, costUsdTotal: 1.0 }),
 ])
 expect(effect.verdict).toBe('no-better')
 expect(effect.detail).toContain('context spent for nothing')
 })

 it('counts level outcomes for materially less money as paying for itself', => {
 const effect = summarizeExpertiseEffect([
 tally({ arm: 'retrieved', decided: 5, merged: 3, costUsdTotal: 1.0 }),
 tally({ arm: 'withheld', decided: 5, merged: 3, costUsdTotal: 2.0 }),
 ])
 expect(effect.verdict).toBe('helps')
 expect(effect.detail).toContain('rediscovery it replaced')
 })

 /** A difference inside the tolerance is noise on a five-run sample, not a finding. */
 it('does not flip on a difference a five-run sample produces by chance', => {
 const effect = summarizeExpertiseEffect([
 tally({ arm: 'retrieved', decided: 5, merged: 3, costUsdTotal: 1.0 }),
 tally({ arm: 'withheld', decided: 5, merged: 3, costUsdTotal: 1.05 }),
 ])
 expect(effect.verdict).toBe('no-better')
 })

 it('reports both arms whole, so a human can disagree with the verdict', => {
 const effect = summarizeExpertiseEffect([
 tally({ arm: 'retrieved', decided: 4, merged: 2, discarded: 1, failed: 1, costUsdTotal: 4 }),
 ])
 expect(effect.retrieved.meanCostUsd).toBe(1)
 expect(effect.retrieved.successRate).toBe(0.5)
 expect(effect.withheld.decided).toBe(0)
 // No division by zero on an arm nothing has landed on.
 expect(effect.withheld.meanCostUsd).toBe(0)
 })
})

describe('retrievalStateFor — the measurement, and the human over it', => {
 it('keeps a new expertise in trial until the measurement decides', => {
 expect(retrievalStateFor(null, 'undecided')).toBe('trial')
 })

 it('turns it on once it has beaten the baseline, and off when it has not', => {
 expect(retrievalStateFor(null, 'helps')).toBe('on')
 expect(retrievalStateFor(null, 'no-better')).toBe('off')
 })

 /**
 * Promotion is a human act, and so is demotion — an operator watching a map
 * produce bad advice should not have to wait for five more runs to agree with them.
 */
 it('lets a human overrule the measurement in either direction', => {
 expect(retrievalStateFor('on', 'no-better')).toBe('on')
 expect(retrievalStateFor('off', 'helps')).toBe('off')
 })
})

describe('trialAssignment', => {
 it('always retrieves once the map is on', => {
 expect(trialAssignment('on', { retrieved: 9, withheld: 0 })).toBe('retrieved')
 })

 /**
 * An `off` map records nothing at all. Writing withheld rows for it forever would
 * inflate the very baseline it is being judged against, so the decision could never be
 * revisited — off would become unreachable rather than reversible.
 */
 it('records nothing for a map that is off', => {
 expect(trialAssignment('off', { retrieved: 0, withheld: 0 })).toBeNull
 })

 it('alternates while the question is open', => {
 expect(trialAssignment('trial', { retrieved: 0, withheld: 1 })).toBe('retrieved')
 expect(trialAssignment('trial', { retrieved: 1, withheld: 1 })).toBe('withheld')
 })
})
