import { describe, expect, it } from 'vitest'
import { MIN_DECIDED_RUNS_PER_ARM } from './expertise-trial.js'
import {
  MIN_LESSONS_TO_TRIAL,
  experienceAssignment,
  experienceStateFor,
  nextExperienceArm,
  summarizeExperienceEffect,
  type ExperienceArm,
  type ExperienceArmTally,
} from './experience-trial.js'

/**
 * The withheld-baseline instrument for distilled experience.
 *
 * The tests worth having are about the three things this can get wrong in a way no typecheck
 * would notice: a verdict announced before the evidence exists, a run denied a memory it
 * should have been shown, and a `no-better` verdict that quietly withdraws a live capability
 * — the last of which is the one thing this file exists to *not* do.
 */

const tally = (
  arm: ExperienceArm,
  over: Partial<ExperienceArmTally> = {},
): ExperienceArmTally => ({
  arm,
  decided: MIN_DECIDED_RUNS_PER_ARM,
  merged: 0,
  discarded: 0,
  failed: 0,
  costUsdTotal: MIN_DECIDED_RUNS_PER_ARM * 0.1,
  verificationFailed: 0,
  failingCheck: null,
  ...over,
})

describe('summarizeExperienceEffect', () => {
  it('says nothing until both arms have enough finished runs', () => {
    const effect = summarizeExperienceEffect([
      tally('retrieved', { merged: 5 }),
      tally('withheld', { decided: MIN_DECIDED_RUNS_PER_ARM - 1, merged: 0 }),
    ])
    expect(effect.verdict).toBe('undecided')
    expect(effect.detail).toContain('Still measuring')
    // The cost of the trial is stated while it is being paid, not afterwards.
    expect(effect.detail).toContain('working without a memory this persona has')
  })

  it('reports that the memory helps when its runs get more work merged', () => {
    const effect = summarizeExperienceEffect([
      tally('retrieved', { merged: 5 }),
      tally('withheld', { merged: 1 }),
    ])
    expect(effect.verdict).toBe('helps')
    expect(effect.detail).toContain('100% of the time against 20%')
  })

  /**
   * The failure the whole instrument exists to be able to see: a memory that is actively
   * costing the persona work. It is reported in the strongest terms available and still
   * turns nothing off.
   */
  it('says plainly when the memory is making things worse, and turns nothing off', () => {
    const effect = summarizeExperienceEffect([
      tally('retrieved', { merged: 1 }),
      tally('withheld', { merged: 5 }),
    ])
    expect(effect.verdict).toBe('no-better')
    expect(effect.detail).toContain('making things worse')
    expect(effect.detail).toContain('that is your call')
  })

  it('separates level arms by the repository"s definition of done', () => {
    const effect = summarizeExperienceEffect([
      tally('retrieved', { merged: 3, verificationFailed: 0 }),
      tally('withheld', { merged: 3, verificationFailed: 4, failingCheck: 'build' }),
    ])
    expect(effect.verdict).toBe('helps')
    expect(effect.detail).toContain('Outcomes are level')
    expect(effect.detail).toContain('the build check')
  })

  /**
   * Every lesson is charged to every run that reads it, so a memory that produces the same
   * work for materially more money has not earned its context.
   */
  it('catches a memory that buys nothing but costs something', () => {
    const effect = summarizeExperienceEffect([
      tally('retrieved', { merged: 3, costUsdTotal: 5 }),
      tally('withheld', { merged: 3, costUsdTotal: 1 }),
    ])
    expect(effect.verdict).toBe('no-better')
    expect(effect.detail).toContain('costing context and buying nothing')
    expect(effect.detail).toContain('that is your call')
  })

  it('handles a pairing nothing has run yet without dividing by zero', () => {
    const effect = summarizeExperienceEffect([])
    expect(effect.verdict).toBe('undecided')
    expect(effect.retrieved.successRate).toBe(0)
    expect(effect.withheld.meanCostUsd).toBe(0)
  })
})

describe('nextExperienceArm', () => {
  /**
   * The opposite tie-break from the map trial, and deliberately: a new map is an untested
   * artifact so its first run is the baseline, while a persona's lessons are what this
   * platform already does. A pairing armed and used once has measured the live behaviour.
   */
  it('gives the first run the memory the persona actually has', () => {
    expect(nextExperienceArm({ retrieved: 0, withheld: 0 })).toBe('retrieved')
  })

  it('sends the next run to whichever arm is behind', () => {
    expect(nextExperienceArm({ retrieved: 2, withheld: 1 })).toBe('withheld')
    expect(nextExperienceArm({ retrieved: 1, withheld: 2 })).toBe('retrieved')
  })
})

describe('experienceStateFor', () => {
  const base = {
    override: null,
    trialArmed: true,
    liveLessons: MIN_LESSONS_TO_TRIAL,
    verdict: 'undecided',
  } as const

  /**
   * The shipped behaviour, and the reason this instrument differs from the map's: tier 5 is
   * live everywhere, so a workspace that has not asked for a trial must keep getting exactly
   * what it got before this module existed.
   */
  it('shows the lessons in a workspace that has not armed the trial', () => {
    expect(experienceStateFor({ ...base, trialArmed: false })).toBe('on')
    expect(experienceStateFor({ ...base, trialArmed: false, verdict: 'no-better' })).toBe('on')
  })

  /**
   * The kill criterion, doing its work before a single run is denied anything. A pairing
   * under the floor differs from an empty one by a couple of lines of prose.
   */
  it('does not deny runs on a pairing too small to show a difference', () => {
    expect(experienceStateFor({ ...base, liveLessons: MIN_LESSONS_TO_TRIAL - 1 })).toBe('on')
    expect(experienceStateFor({ ...base, liveLessons: MIN_LESSONS_TO_TRIAL })).toBe('trial')
  })

  it('stops withholding once the question has an answer', () => {
    expect(experienceStateFor({ ...base, verdict: 'undecided' })).toBe('trial')
    expect(experienceStateFor({ ...base, verdict: 'helps' })).toBe('on')
    // The one that matters: a verdict against the memory reports and never withdraws it.
    expect(experienceStateFor({ ...base, verdict: 'no-better' })).toBe('on')
  })

  it('lets a human decide in both directions, over everything else', () => {
    expect(experienceStateFor({ ...base, override: 'off', verdict: 'helps' })).toBe('off')
    expect(
      experienceStateFor({ ...base, override: 'on', liveLessons: 0, trialArmed: true }),
    ).toBe('on')
  })
})

describe('experienceAssignment', () => {
  it('records an on pairing as retrieved rather than as nothing', () => {
    expect(experienceAssignment('on', { retrieved: 3, withheld: 0 })).toBe('retrieved')
  })

  /**
   * An off pairing writes no row at all. Withheld rows for a memory nobody is asking about
   * would inflate the baseline of a question that is no longer open.
   */
  it('records nothing at all for a pairing a human turned off', () => {
    expect(experienceAssignment('off', { retrieved: 0, withheld: 0 })).toBeNull()
  })

  it('alternates while the trial is running', () => {
    expect(experienceAssignment('trial', { retrieved: 0, withheld: 0 })).toBe('retrieved')
    expect(experienceAssignment('trial', { retrieved: 1, withheld: 0 })).toBe('withheld')
    expect(experienceAssignment('trial', { retrieved: 1, withheld: 1 })).toBe('retrieved')
  })
})
