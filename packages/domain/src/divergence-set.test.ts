import { describe, expect, it } from 'vitest'
import { describeDivergence, type DivergenceSet } from './divergence-set.js'

/**
 * The divergence set's sentence.
 *
 * The distinctions that matter are the ones a reader would otherwise get backwards: nothing
 * comparable is not agreement, and the two directions do not mean the same thing.
 */

const set = (over: Partial<DivergenceSet> = {}): DivergenceSet => ({
  runs: [],
  passedAndDiscarded: 0,
  failedAndMerged: 0,
  comparable: 0,
  ...over,
})

describe('describeDivergence', () => {
  it('does not read an empty population as agreement', () => {
    expect(describeDivergence(set())).toContain('nothing the two could have disagreed about')
  })

  it('says plainly when they never disagreed, with the population', () => {
    expect(describeDivergence(set({ comparable: 14 }))).toContain('agreed on all 14 runs')
  })

  it('reads a passed-and-discarded lean as a fact about the prompt', () => {
    const detail = describeDivergence(
      set({ comparable: 20, passedAndDiscarded: 4, failedAndMerged: 1 }),
    )
    expect(detail).toContain('5 of 20 runs where both ruled (25%)')
    expect(detail).toContain('fact about the prompt')
  })

  it('reads a failed-and-merged lean as a fact about the checks', () => {
    const detail = describeDivergence(
      set({ comparable: 10, passedAndDiscarded: 1, failedAndMerged: 3 }),
    )
    expect(detail).toContain('fact about the checks')
  })

  it('does not pick a side when the two directions are level', () => {
    const detail = describeDivergence(
      set({ comparable: 10, passedAndDiscarded: 2, failedAndMerged: 2 }),
    )
    expect(detail).toContain('Evenly split')
  })
})
