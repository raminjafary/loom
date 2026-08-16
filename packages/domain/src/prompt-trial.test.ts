import { describe, expect, it } from 'vitest'
import { MIN_DECIDED_RUNS_PER_ARM } from './expertise-trial.js'
import {
 nextPromptArm,
 summarizePromptEffect,
 type PromptArm,
 type PromptArmTally,
} from './prompt-trial.js'

/**
 * Whether a self-edit was an improvement.
 *
 * The tests worth having are the ones about *order*: outcomes decide first, cost decides
 * only where outcomes are level, and neither decides anything before both arms have run
 * enough times. A trial that announced a winner early would be worse than no trial, since
 * a human would act on it.
 */

const tally = (arm: PromptArm, over: Partial<PromptArmTally> = {}): PromptArmTally => ({
 arm,
 decided: MIN_DECIDED_RUNS_PER_ARM,
 merged: MIN_DECIDED_RUNS_PER_ARM,
 discarded: 0,
 failed: 0,
 costUsdTotal: MIN_DECIDED_RUNS_PER_ARM * 0.1,
...over,
})

describe('nextPromptArm', => {
 /**
 * The asymmetry with the map trial, and the reason for it: the revision is
 * already live, so putting the first run on the old prompt would silently run a version
 * the persona no longer has.
 */
 it('gives the first run the version the agent actually wrote', => {
 expect(nextPromptArm({ revised: 0, previous: 0 })).toBe('revised')
 })

 it('alternates, so a trial converges in the fewest runs a workspace will produce', => {
 expect(nextPromptArm({ revised: 1, previous: 0 })).toBe('previous')
 expect(nextPromptArm({ revised: 1, previous: 1 })).toBe('revised')
 expect(nextPromptArm({ revised: 2, previous: 3 })).toBe('revised')
 })
})

describe('summarizePromptEffect', => {
 it('says nothing until both sides have run enough times', => {
 const effect = summarizePromptEffect([
 tally('revised'),
 tally('previous', { decided: MIN_DECIDED_RUNS_PER_ARM - 1, merged: 0 }),
 ])
 expect(effect.verdict).toBe('undecided')
 expect(effect.detail).toContain('Still measuring')
 })

 it('calls the agent"s version better when more of its work lands', => {
 const effect = summarizePromptEffect([
 tally('revised', { merged: 5 }),
 tally('previous', { merged: 2, failed: 3 }),
 ])
 expect(effect.verdict).toBe('better')
 })

 /** The case a human most needs told, and the one an agent cannot be trusted to report. */
 it('calls it worse when less of its work lands', => {
 const effect = summarizePromptEffect([
 tally('revised', { merged: 1, failed: 4 }),
 tally('previous', { merged: 5 }),
 ])
 expect(effect.verdict).toBe('worse')
 expect(effect.detail).toContain('Restoring the old one')
 })

 /**
 * Order matters more than either rule: a version that merges more is better even when
 * it costs more. A cost-first comparison would retire the prompt that does the work.
 */
 it('prefers outcomes over cost when the two disagree', => {
 const effect = summarizePromptEffect([
 tally('revised', { merged: 5, costUsdTotal: 5 }),
 tally('previous', { merged: 1, failed: 4, costUsdTotal: 0.05 }),
 ])
 expect(effect.verdict).toBe('better')
 })

 it('lets cost decide only when outcomes are level', => {
 const cheaper = summarizePromptEffect([
 tally('revised', { costUsdTotal: 0.1 }),
 tally('previous', { costUsdTotal: 1 }),
 ])
 expect(cheaper.verdict).toBe('better')
 expect(cheaper.detail).toContain('cheaper per run')

 const dearer = summarizePromptEffect([
 tally('revised', { costUsdTotal: 1 }),
 tally('previous', { costUsdTotal: 0.1 }),
 ])
 expect(dearer.verdict).toBe('worse')
 })

 it('says so plainly when there is no difference to find', => {
 const effect = summarizePromptEffect([tally('revised'), tally('previous')])
 expect(effect.verdict).toBe('no-better')
 expect(effect.detail).toContain('as defensible as reverting it')
 })

 /** An arm with no runs at all is a zero, not a crash — the state every trial starts in. */
 it('handles an arm nothing has run yet', => {
 const effect = summarizePromptEffect([])
 expect(effect.verdict).toBe('undecided')
 expect(effect.revised.decided).toBe(0)
 expect(effect.previous.meanCostUsd).toBe(0)
 })
})
