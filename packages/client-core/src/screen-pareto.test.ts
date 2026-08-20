import { describe, expect, it } from 'vitest'
import {
  compareScreenedSiblings,
  describeScreenedSiblings,
  type ScreenedArm,
} from './screen-pareto.js'

/**
 * The sibling comparison.
 *
 * What matters is the two readings a pass rate hides — one candidate strictly better than
 * another, and two candidates good at different things — and the one claim this must never
 * make: strictly better on evidence one of the two arms never produced.
 */

const arm = (
  variantId: string | null,
  outcomes: readonly ('pending' | 'passed' | 'failed' | 'not-scored')[],
): ScreenedArm => ({
  variantId,
  items: outcomes.map((outcome, index) => ({ position: index + 1, outcome })),
})

const label = (variantId: string) => `candidate ${variantId}`

describe('compareScreenedSiblings', () => {
  it('finds the sibling that passed everything the other did and more', () => {
    const [pair] = compareScreenedSiblings([
      arm(null, ['passed', 'passed', 'passed']),
      arm('a', ['passed', 'failed', 'failed']),
      arm('b', ['passed', 'passed', 'failed']),
    ])
    // The dominating arm leads, whichever order the arms arrived in.
    expect(pair).toMatchObject({
      variantId: 'b',
      otherVariantId: 'a',
      relation: 'dominates',
      onlyHere: [2],
      onlyThere: [],
      compared: 3,
    })
  })

  it('reads two arms with the same rate on different items as incomparable', () => {
    const [pair] = compareScreenedSiblings([
      arm('a', ['passed', 'failed', 'passed', 'failed']),
      arm('b', ['failed', 'passed', 'failed', 'passed']),
    ])
    expect(pair).toMatchObject({ relation: 'incomparable', onlyHere: [1, 3], onlyThere: [2, 4] })
  })

  it('compares only items both arms scored, so a hiccup is never strict superiority', () => {
    const [pair] = compareScreenedSiblings([
      arm('a', ['passed', 'not-scored']),
      arm('b', ['passed', 'failed']),
    ])
    // Over item 1 alone, they are identical — item 2 says nothing about `a`'s prompt.
    expect(pair).toMatchObject({ relation: 'identical', compared: 1 })
  })

  it('does not compare an arm that is still being screened', () => {
    expect(
      compareScreenedSiblings([arm('a', ['passed', 'pending']), arm('b', ['passed', 'failed'])]),
    ).toEqual([])
  })

  it('says nothing about two arms with no scored item in common', () => {
    expect(
      compareScreenedSiblings([
        arm('a', ['passed', 'not-scored']),
        arm('b', ['not-scored', 'failed']),
      ]),
    ).toEqual([])
  })

  it('emits each pair once, not once per direction', () => {
    const pairs = compareScreenedSiblings([
      arm('a', ['passed', 'failed']),
      arm('b', ['failed', 'passed']),
      arm('c', ['passed', 'passed']),
    ])
    expect(pairs).toHaveLength(3)
  })
})

describe('describeScreenedSiblings', () => {
  it('says which items the better one also passed', () => {
    const said = describeScreenedSiblings(
      compareScreenedSiblings([arm('a', ['passed', 'failed']), arm('b', ['passed', 'passed'])]),
      label,
    )
    expect(said).toEqual([
      'candidate b passed every held-out item candidate a passed, and item 2 as well.',
    ])
  })

  it('names both sides of a split, and that a pass rate cannot choose', () => {
    const [said] = describeScreenedSiblings(
      compareScreenedSiblings([arm('a', ['passed', 'failed']), arm('b', ['failed', 'passed'])]),
      label,
    )
    expect(said).toContain('good at different things')
    expect(said).toContain('pass rate cannot')
  })

  it('stays silent about two arms that behaved identically', () => {
    expect(
      describeScreenedSiblings(
        compareScreenedSiblings([arm('a', ['passed', 'failed']), arm('b', ['passed', 'failed'])]),
        label,
      ),
    ).toEqual([])
  })
})
