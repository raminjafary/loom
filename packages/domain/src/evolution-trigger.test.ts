import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRIGGER_THRESHOLDS,
  TRIGGER_CHECK_FAILURES,
  TRIGGER_DISCARDED_DISPOSITIONS,
  evolutionTriggerVerdict,
  type TriggerPopulation,
} from './evolution-trigger.js'

/**
 * The trigger's gate. The cases worth having are the ones where two signals disagree, and the
 * ones where a verdict has to carry enough for a human to correct the threshold it used —
 * because the thresholds are a stated prior rather than a measurement.
 */

const population = (over: Partial<TriggerPopulation> = {}): TriggerPopulation => ({
  decided: 10,
  discarded: 0,
  recurringCheck: null,
  ...over,
})

const verdict = (over: Partial<TriggerPopulation> = {}) =>
  evolutionTriggerVerdict({ personaName: 'swe', population: population(over) })

describe('evolutionTriggerVerdict', () => {
  it('holds when nothing has crossed, and says what the counts were', () => {
    const held = verdict({ discarded: 2, recurringCheck: { name: 'build', failures: 2 } })
    expect(held.fire).toBe(false)
    if (held.fire) return
    // The held case is the only place the operator sees traffic before it crosses.
    expect(held.reason).toContain('2 discarded of 10')
    expect(held.reason).toContain('"build" at 2')
    expect(held.reason).toContain(String(TRIGGER_DISCARDED_DISPOSITIONS))
  })

  it('fires on discarded dispositions and shows the taste record', () => {
    const fired = verdict({ discarded: TRIGGER_DISCARDED_DISPOSITIONS })
    expect(fired.fire).toBe(true)
    if (!fired.fire) return
    expect(fired.signal).toBe('discarded-dispositions')
    expect(fired.source).toBe('taste-record')
    expect(fired.reason).toContain('3 of 10 decided runs')
  })

  it('fires on one named check repeating and shows the failure record', () => {
    const fired = verdict({ recurringCheck: { name: 'tests', failures: TRIGGER_CHECK_FAILURES } })
    expect(fired.fire).toBe(true)
    if (!fired.fire) return
    expect(fired.signal).toBe('recurring-check')
    expect(fired.source).toBe('failure-record')
    expect(fired.reason).toContain('"tests" failed 3 times')
  })

  /**
   * Both crossed is the case the ordering exists for: a failing check is visible to anyone
   * reading the Inbox, while work that passed and was discarded looks like success from every
   * automated angle, so the scarcer signal wins.
   */
  it('prefers the discarded signal when both have crossed', () => {
    const fired = verdict({ discarded: 5, recurringCheck: { name: 'build', failures: 9 } })
    expect(fired.fire).toBe(true)
    if (!fired.fire) return
    expect(fired.signal).toBe('discarded-dispositions')
  })

  /** The population travels with the verdict, or the threshold can never be corrected. */
  it('carries the population it fired on', () => {
    const fired = verdict({ discarded: 4, decided: 7 })
    expect(fired.fire).toBe(true)
    if (!fired.fire) return
    expect(fired.population).toEqual({ decided: 7, discarded: 4, recurringCheck: null })
  })

  it('honours a deployment that set its own thresholds', () => {
    const strict = evolutionTriggerVerdict({
      personaName: 'swe',
      population: population({ discarded: 3 }),
      thresholds: { ...DEFAULT_TRIGGER_THRESHOLDS, discardedDispositions: 9 },
    })
    expect(strict.fire).toBe(false)
    if (strict.fire) return
    expect(strict.reason).toContain('threshold 9')
  })

  /** A window that has decided nothing cannot have crossed anything. */
  it('holds on an empty window rather than firing on zeroes', () => {
    expect(verdict({ decided: 0 }).fire).toBe(false)
  })
})
