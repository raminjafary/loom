import { describe, expect, it } from 'vitest'
import {
  brokenCount,
  prosecutionAffectsMergeEligibility,
  prosecutionWantsAttention,
  summariseProsecution,
  type Prosecution,
  type ProsecutionObservation,
} from './prosecution.js'

/**
 * The prosecutor pass.
 *
 * The cases worth the file are the ones that would pass a careless implementation while
 * quietly giving a generated test authority it must not have: a summary that reads as a
 * verdict, and "no observations" collapsing into "nothing broke".
 */

const observation = (
  name: string,
  outcome: 'held' | 'broke',
  detail: string | null = null,
): ProsecutionObservation => ({ name, outcome, detail })

const prosecution = (overrides: Partial<Prosecution> = {}): Prosecution => ({
  id: 'p1',
  workspaceId: 'ws',
  agentRunId: 'run',
  prosecutorRunId: 'prosecutor',
  status: 'reported',
  observations: [],
  reason: null,
  createdAt: new Date(0),
  finishedAt: new Date(1),
  ...overrides,
})

describe('brokenCount', () => {
  it('counts what broke, and nothing else', () => {
    expect(
      brokenCount([observation('a', 'held'), observation('b', 'broke'), observation('c', 'broke')]),
    ).toBe(2)
    expect(brokenCount([])).toBe(0)
  })
})

describe('summariseProsecution', () => {
  it('says what was tried and what happened, never whether the branch is good', () => {
    const sentence = summariseProsecution(
      prosecution({ observations: [observation('a', 'held'), observation('b', 'broke')] }),
    )
    expect(sentence).toBe('2 probes written against this diff, 1 broke.')
    // The words a reader would take as authority. None of them belong to this pass.
    expect(sentence).not.toMatch(/fail|reject|block|verdict|passed/i)
  })

  it('counts one probe as one', () => {
    expect(summariseProsecution(prosecution({ observations: [observation('a', 'held')] }))).toBe(
      '1 probe written against this diff, all held.',
    )
  })

  /**
   * The distinction the status exists for. A prosecutor whose own tests would not run has
   * found nothing about the diff, and a summary that read "all held" would be telling a
   * reviewer that the diff survived scrutiny it never actually met.
   */
  it('does not let "produced nothing" read as "nothing broke"', () => {
    expect(
      summariseProsecution(
        prosecution({ status: 'inconclusive', reason: 'its own tests would not compile' }),
      ),
    ).toBe('its own tests would not compile')
    expect(summariseProsecution(prosecution({ observations: [] }))).toBe(
      'The prosecutor reported no observations.',
    )
  })

  it('says it is still working while it is', () => {
    expect(summariseProsecution(prosecution({ status: 'running' }))).toMatch(/Writing tests/)
  })
})

describe('prosecutionWantsAttention', () => {
  it('is true only for a finished prosecution that broke something', () => {
    expect(prosecutionWantsAttention(null)).toBe(false)
    expect(prosecutionWantsAttention(prosecution({ observations: [observation('a', 'held')] }))).toBe(false)
    expect(
      prosecutionWantsAttention(prosecution({ status: 'running', observations: [observation('a', 'broke')] })),
    ).toBe(false)
    expect(prosecutionWantsAttention(prosecution({ observations: [observation('a', 'broke')] }))).toBe(true)
  })
})

describe('the rule', () => {
  /**
   * Belt and braces beside the architecture check that no merge path imports this module.
   * A generated test that could refuse a merge would be a model writing its own gate.
   */
  it('never affects merge eligibility', () => {
    expect(prosecutionAffectsMergeEligibility()).toBe(false)
  })
})
