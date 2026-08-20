import { describe, expect, it } from 'vitest'
import {
  describeRevertedMerges,
  parseRevertedShas,
  revertNamesMerge,
} from './reverted-merges.js'

/**
 * The tripwire.
 *
 * What matters here is the two ways a tripwire becomes something worse: a detector that
 * infers a revert from a diff and accuses a reviewer of gaming on a guess, and a counter
 * that quietly becomes a term in the fitness.
 */

describe('parseRevertedShas', () => {
  it('reads git\'s own line and nothing else', () => {
    expect(
      parseRevertedShas([
        'Revert "feat: the thing"\n\nThis reverts commit 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b.',
      ]),
    ).toEqual(['1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'])
  })

  it('does not read a revert out of a title alone — a title names no commit', () => {
    expect(parseRevertedShas(['Revert "feat: the thing"\n\nIt was wrong.'])).toEqual([])
  })

  it('finds every revert in a range, once each', () => {
    const shas = parseRevertedShas([
      'This reverts commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.',
      'This reverts commit BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB.',
      'This reverts commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.',
    ])
    expect(shas).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ])
  })
})

describe('revertNamesMerge', () => {
  it('matches an abbreviated sha against the full one that was stored', () => {
    expect(revertNamesMerge('1a2b3c4', '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b')).toBe(true)
  })

  it('refuses a prefix too short to be evidence about a commit', () => {
    expect(revertNamesMerge('1a2b3c', '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b')).toBe(false)
  })

  it('does not match a different commit that happens to share a few characters', () => {
    expect(revertNamesMerge('1a2b3c4', '1a2b3c5d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b')).toBe(false)
  })
})

describe('describeRevertedMerges', () => {
  const tally = (label: string, reverted: number, merged: number) => ({ label, reverted, merged })

  it('says nothing when nothing came back out', () => {
    expect(describeRevertedMerges(tally('the candidate', 0, 4), tally('the control', 0, 3))).toBe('')
  })

  it('trips when the side that got more merged is the side losing more of it', () => {
    const detail = describeRevertedMerges(tally('the candidate', 2, 4), tally('the control', 0, 2))
    expect(detail).toContain("2 of the candidate's 4 merged branches were later reverted")
    expect(detail).toContain('what was easy to approve')
    // Said as something to check, never as a score against the arm.
    expect(detail).toContain('not counted against an arm')
  })

  it('reports both sides without tripping when the loser is the one being reverted', () => {
    const detail = describeRevertedMerges(tally('the candidate', 1, 5), tally('the control', 3, 4))
    expect(detail).toContain("3 of the control's 4 merged branches were later reverted")
    expect(detail).not.toContain('easy to approve')
  })
})
