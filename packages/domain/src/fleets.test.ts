import { describe, expect, it } from 'vitest'
import {
  MAX_FLEET_SIZE,
  boundedFleet,
  describeFleetOverruns,
  describeFleetRefusal,
  detectFleetOverruns,
  parseFleetSizes,
} from './fleets.js'

/**
 * The fleets. Every test here exists because of one sentence in that section: "a
 * fleet size that the runtime never reads is a number a human tunes and a swarm ignores,
 * which is worse than not offering it." So the tests are about the count *biting* — the
 * clamp that keeps it under an operator's ceiling, the refusal when it is exceeded, and
 * the warning that comes before either.
 */
describe('parseFleetSizes', () => {
  it('treats an absent map as unsized rather than as empty widths', () => {
    // "Unsized" means the Planner decides, which is what every team did before this
    // existed. Reading absence as a width would have changed every existing team.
    expect(parseFleetSizes(undefined, ['a'])).toEqual({ ok: true, fleet: {} })
    expect(parseFleetSizes(null, ['a'])).toEqual({ ok: true, fleet: {} })
  })

  it('keeps a width of 1, because "one at a time" is a real design decision', () => {
    const verdict = parseFleetSizes({ a: 1 }, ['a'])
    expect(verdict).toEqual({ ok: true, fleet: { a: 1 } })
  })

  it('refuses 0, which is a removal dressed as a width', () => {
    /**
     * Stored, a 0 would make the roster offer a persona whose every start the
     * concurrency check then refuses — the "a listed name reads as permission" failure
     * `delegation-roster.ts` exists to prevent.
     */
    const verdict = parseFleetSizes({ a: 0 }, ['a'])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reason).toContain('remove the persona from the team')
  })

  it('refuses a negative, a fraction and a non-number', () => {
    expect(parseFleetSizes({ a: -2 }, ['a']).ok).toBe(false)
    expect(parseFleetSizes({ a: 1.5 }, ['a']).ok).toBe(false)
    expect(parseFleetSizes({ a: '3' }, ['a']).ok).toBe(false)
    expect(parseFleetSizes([1, 2], ['a']).ok).toBe(false)
  })

  it('refuses a width past the ceiling', () => {
    expect(parseFleetSizes({ a: MAX_FLEET_SIZE }, ['a']).ok).toBe(true)
    expect(parseFleetSizes({ a: MAX_FLEET_SIZE + 1 }, ['a']).ok).toBe(false)
  })

  it('drops an entry for someone no longer on the team, rather than refusing', () => {
    // Removing a member must not make the stored map unsaveable, and the orphaned entry
    // means nothing.
    expect(parseFleetSizes({ a: 2, gone: 3 }, ['a'])).toEqual({ ok: true, fleet: { a: 2 } })
  })
})

describe('boundedFleet', () => {
  it('is null when unsized, so the workspace limit alone applies', () => {
    expect(boundedFleet(undefined, 3)).toBeNull()
  })

  it('never widens the workspace limit', () => {
    // The fleet design: "bounded above by the workspace limit — never widening it, which
    // would make a design-time field a way around an operator's ceiling."
    expect(boundedFleet(8, 3)).toBe(3)
  })

  it('narrows under it', () => {
    expect(boundedFleet(2, 3)).toBe(2)
  })
})

describe('describeFleetRefusal', () => {
  it("says it is the team's own size refusing, and what to do", () => {
    const text = describeFleetRefusal({ personaName: 'swe', limit: 2, active: 2 })
    expect(text).toContain('sized for 2 concurrent swe')
    expect(text).toContain('Widen the fleet')
  })
})

describe('detectFleetOverruns', () => {
  it('finds a persona asked for more times than its width', () => {
    expect(detectFleetOverruns(['swe', 'swe', 'swe'], { swe: 2 })).toEqual([
      { personaName: 'swe', asked: 3, limit: 2 },
    ])
  })

  it('says nothing about an unsized persona', () => {
    expect(detectFleetOverruns(['swe', 'swe', 'swe'], {})).toEqual([])
  })

  it('says nothing when the plan fits', () => {
    expect(detectFleetOverruns(['swe', 'qa'], { swe: 2, qa: 1 })).toEqual([])
  })

  it('reports each over-asked role once', () => {
    const overruns = detectFleetOverruns(['swe', 'swe', 'qa', 'qa', 'qa'], { swe: 1, qa: 2 })
    expect(overruns.map((overrun) => overrun.personaName)).toEqual(['qa', 'swe'])
  })
})

describe('describeFleetOverruns', () => {
  it('is null when nothing over-asks', () => {
    expect(describeFleetOverruns([])).toBeNull()
  })

  it('states the consequence, not just the mismatch', () => {
    /**
     * A warning that leaves the consequence vague reads as advice. What actually happens
     * is that the runs past the width are *refused as they start* — the work in them is
     * simply not done — which is the fact that makes this worth reading before the plan
     * runs.
     */
    const text = describeFleetOverruns([{ personaName: 'swe', asked: 5, limit: 3 }])
    expect(text).toContain('5 × swe')
    expect(text).toContain('sized for 3')
    expect(text).toContain('refused as they try to start, not queued')
  })

  it('offers both directions, because either side can be the stale one', () => {
    // The count is a human's design and the plan is a model's judgement about one goal.
    const text = describeFleetOverruns([{ personaName: 'swe', asked: 5, limit: 3 }])
    expect(text).toContain('Widen the fleet')
    expect(text).toContain('re-split the work')
  })
})
