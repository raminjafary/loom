import { describe, expect, it } from 'vitest'
import { seededHash, seededOrder, seededPair, seededSwap } from './seeded-choice.js'

describe('seededHash', () => {
  it('is stable across calls, which is the whole property', () => {
    expect(seededHash('workflow-run-1:bracket:0')).toBe(seededHash('workflow-run-1:bracket:0'))
  })

  it('moves somewhere unrelated for a one-character change', () => {
    const near = Math.abs(seededHash('bracket:0:0') - seededHash('bracket:0:1'))
    expect(near).toBeGreaterThan(1_000_000)
  })

  it('is unsigned, so a rank comparison cannot go negative for one seed and not another', () => {
    for (const seed of ['a', 'b', 'zzzz', '⟂', '']) {
      expect(seededHash(seed)).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('seededOrder', () => {
  const entrants = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']

  it('is a permutation — nothing lost, nothing invented', () => {
    const ordered = seededOrder('run-1', entrants, (entrant) => entrant)
    expect([...ordered].sort()).toEqual([...entrants].sort())
  })

  it('does not leave the input order alone', () => {
    expect(seededOrder('run-1', entrants, (entrant) => entrant)).not.toEqual(entrants)
  })

  it('gives the same order for the same seed and a different one for another', () => {
    const first = seededOrder('run-1', entrants, (entrant) => entrant)
    expect(seededOrder('run-1', entrants, (entrant) => entrant)).toEqual(first)
    expect(seededOrder('run-2', entrants, (entrant) => entrant)).not.toEqual(first)
  })

  /**
   * The property the bracket depends on: a permutation that depended on how the list arrived
   * would hand the first-written entrant a reliably short path to the final, which is the bias
   * seeding exists to remove.
   */
  it('depends on the keys and not on the order they arrived in', () => {
    const forwards = seededOrder('run-1', entrants, (entrant) => entrant)
    const backwards = seededOrder('run-1', [...entrants].reverse(), (entrant) => entrant)
    expect(backwards).toEqual(forwards)
  })

  it('is total over duplicate keys rather than throwing them away', () => {
    expect(seededOrder('run-1', ['same', 'same', 'other'], (entry) => entry)).toHaveLength(3)
  })

  it('spreads six entrants over more than one first place across seeds', () => {
    const firsts = new Set(
      Array.from({ length: 24 }, (_unused, at) =>
        seededOrder(`run-${at}`, entrants, (entrant) => entrant)[0],
      ),
    )
    expect(firsts.size).toBeGreaterThan(1)
  })
})

describe('seededSwap', () => {
  it('answers the same way for the same seed', () => {
    expect(seededSwap('match:0:0')).toBe(seededSwap('match:0:0'))
  })

  it('is not constant across seeds, or a side assignment would be no assignment', () => {
    const answers = new Set(Array.from({ length: 32 }, (_unused, at) => seededSwap(`match:${at}`)))
    expect(answers).toEqual(new Set([true, false]))
  })
})

describe('seededPair', () => {
  it('holds both entrants whichever way round it comes back', () => {
    const [left, right] = seededPair('match:1', 'first', 'second')
    expect([left, right].sort()).toEqual(['first', 'second'])
  })

  it('presents the pair in the order the swap decided', () => {
    const seed = 'match:1'
    expect(seededPair(seed, 'first', 'second')).toEqual(
      seededSwap(seed) ? ['second', 'first'] : ['first', 'second'],
    )
  })
})
