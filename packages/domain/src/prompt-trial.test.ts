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
  verificationFailed: 0,
  failingCheck: null,
  ...over,
})

describe('nextPromptArm', () => {
  /**
   * The asymmetry with the map trial, and the reason for it: the revision is
   * already live, so putting the first run on the old prompt would silently run a version
   * the persona no longer has.
   */
  it('gives the first run the version the agent actually wrote', () => {
    expect(nextPromptArm({ revised: 0, previous: 0 })).toBe('revised')
  })

  it('alternates, so a trial converges in the fewest runs a workspace will produce', () => {
    expect(nextPromptArm({ revised: 1, previous: 0 })).toBe('previous')
    expect(nextPromptArm({ revised: 1, previous: 1 })).toBe('revised')
    expect(nextPromptArm({ revised: 2, previous: 3 })).toBe('revised')
  })
})

describe('summarizePromptEffect', () => {
  it('says nothing until both sides have run enough times', () => {
    const effect = summarizePromptEffect([
      tally('revised'),
      tally('previous', { decided: MIN_DECIDED_RUNS_PER_ARM - 1, merged: 0 }),
    ])
    expect(effect.verdict).toBe('undecided')
    expect(effect.detail).toContain('Still measuring')
  })

  it('calls the agent"s version better when more of its work lands', () => {
    const effect = summarizePromptEffect([
      tally('revised', { merged: 5 }),
      tally('previous', { merged: 2, failed: 3 }),
    ])
    expect(effect.verdict).toBe('better')
  })

  /** The case a human most needs told, and the one an agent cannot be trusted to report. */
  it('calls it worse when less of its work lands', () => {
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
  it('prefers outcomes over cost when the two disagree', () => {
    const effect = summarizePromptEffect([
      tally('revised', { merged: 5, costUsdTotal: 5 }),
      tally('previous', { merged: 1, failed: 4, costUsdTotal: 0.05 }),
    ])
    expect(effect.verdict).toBe('better')
  })

  /**
   * The term the verification harness added, and the reason it sits where it sits: two
   * prompts whose work gets merged equally often are not equal when one of them keeps
   * leaving branches that fail the repository's definition of done. Before this, the
   * comparison fell through to cost and a difference of pennies decided it.
   */
  it('lets the definition of done decide when outcomes are level', () => {
    const effect = summarizePromptEffect([
      tally('revised', { merged: 2, discarded: 3, verificationFailed: 4, failingCheck: 'build' }),
      tally('previous', { merged: 2, discarded: 3 }),
    ])
    expect(effect.verdict).toBe('worse')
    expect(effect.detail).toContain('definition of done')
    // Names the check, because "failed" is not a next action and "the build failed" is.
    expect(effect.detail).toContain('most often the build check')
  })

  it('calls it better when the agent"s version leaves fewer branches broken', () => {
    const effect = summarizePromptEffect([
      tally('revised', { merged: 2, discarded: 3 }),
      tally('previous', { merged: 2, discarded: 3, verificationFailed: 4, failingCheck: 'tests' }),
    ])
    expect(effect.verdict).toBe('better')
    expect(effect.detail).toContain('most often the tests check')
  })

  /**
   * A human merging outranks the machine's check, in the one direction that matters: they
   * merged it knowing, and the security model makes that their call. The failure is still
   * reported.
   */
  it('keeps a merged branch a success even when its checks failed', () => {
    const effect = summarizePromptEffect([
      tally('revised', { merged: 5, verificationFailed: 5, failingCheck: 'tests' }),
      tally('previous', { merged: 1, discarded: 4 }),
    ])
    expect(effect.verdict).toBe('better')
    expect(effect.detail).toContain("5 of the agent's version's 5")
  })

  /**
   * The clause is the earliest hard evidence a trial has — it lands hours after a run,
   * where a merge waits on a person — so it is said before there is a verdict.
   */
  it('reports failing checks while the verdict is still undecided', () => {
    const effect = summarizePromptEffect([
      tally('revised', { decided: 2, merged: 0, verificationFailed: 2, failingCheck: 'build' }),
      tally('previous', { decided: 1, merged: 1 }),
    ])
    expect(effect.verdict).toBe('undecided')
    expect(effect.detail).toContain("2 of the agent's version's 2")
    expect(effect.detail).toContain("none of the one it replaced's 1")
  })

  /** Zero against zero is arithmetic nobody asked for, so it is not printed. */
  it('says nothing about verification when nothing failed', () => {
    const effect = summarizePromptEffect([tally('revised'), tally('previous')])
    expect(effect.detail).not.toContain('definition of done')
  })

  it('lets cost decide only when outcomes are level', () => {
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

  it('says so plainly when there is no difference to find', () => {
    const effect = summarizePromptEffect([tally('revised'), tally('previous')])
    expect(effect.verdict).toBe('no-better')
    expect(effect.detail).toContain('as defensible as reverting it')
  })

  /** An arm with no runs at all is a zero, not a crash — the state every trial starts in. */
  it('handles an arm nothing has run yet', () => {
    const effect = summarizePromptEffect([])
    expect(effect.verdict).toBe('undecided')
    expect(effect.revised.decided).toBe(0)
    expect(effect.previous.meanCostUsd).toBe(0)
  })
})
