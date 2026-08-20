/**
 * Sibling against sibling on the held-out set — the comparison the gate never makes.
 *
 * `screenGate` compares each candidate to the incumbent and to nothing else, on purpose:
 * ranking candidates against each other would multiply the comparisons a small set has to
 * support, and the incumbent is the thing a promotion would displace. But the human doing
 * the promoting is choosing *between candidates*, and a pass rate cannot help them: two
 * candidates level at 4 of 6 may have passed different four, and "good at different things"
 * is the fact that decides which one to keep — or that says a search found two answers and
 * should be run again rather than settled.
 *
 * The per-item rows have been stored since the screen existed and nothing read them; this
 * reads them, in the client, because it is a *reading* rather than a rule. Nothing here
 * gates, promotes or scores. It is a sentence beside the arms.
 *
 * ## Dominance, and the unknown
 *
 * A candidate dominates a sibling when it passed every item the sibling passed and at least
 * one more — the Pareto relation, over the set's items.
 *
 * Restricted to items **both arms scored**. An item that errored for one arm and passed for
 * the other says nothing about either prompt, and counting a `not-scored` as a failure would
 * turn an infrastructure hiccup into a claim that one candidate is strictly better — the same
 * substitution `screenOutcomeFor` refuses when it declines to score a run that never
 * produced a branch. Two arms with nothing in common are simply not compared.
 */

/** One arm's per-item results, as `screenForSearch` puts them on the wire. */
export interface ScreenedArm {
  /** Null is the incumbent, which is excluded here: the gate already compares against it. */
  readonly variantId: string | null
  readonly items: readonly {
    readonly position: number
    readonly outcome: 'pending' | 'passed' | 'failed' | 'not-scored'
  }[]
}

export type SiblingRelation =
  /** One passed everything the other did, and more. */
  | 'dominates'
  /** Each passed something the other failed. The interesting one. */
  | 'incomparable'
  /** Identical on every item both scored. */
  | 'identical'

export interface SiblingComparison {
  readonly variantId: string
  readonly otherVariantId: string
  readonly relation: SiblingRelation
  /** Items this one passed and the other did not. Empty unless it won something. */
  readonly onlyHere: readonly number[]
  /** Items the other passed and this one did not. */
  readonly onlyThere: readonly number[]
  /** How many items both arms actually scored — the population the relation holds over. */
  readonly compared: number
}

const scored = (arm: ScreenedArm) =>
  new Map(
    arm.items
      .filter((item) => item.outcome === 'passed' || item.outcome === 'failed')
      .map((item) => [item.position, item.outcome === 'passed']),
  )

/**
 * Every pair of candidates, compared once.
 *
 * Once and not twice: `dominates` is directional, so the pair is emitted with whichever arm
 * dominates first, and an incomparable or identical pair is emitted in the order the arms
 * arrived. A panel rendering both directions of the same pair would read as four findings
 * where there are two.
 *
 * Arms still being screened are skipped rather than partially compared — a pending item is a
 * verdict that has not arrived, and half a comparison is the kind of number that gets quoted
 * as a whole one.
 */
export const compareScreenedSiblings = (
  arms: readonly ScreenedArm[],
): SiblingComparison[] => {
  const candidates = arms.filter(
    (arm): arm is ScreenedArm & { variantId: string } =>
      arm.variantId !== null && !arm.items.some((item) => item.outcome === 'pending'),
  )

  const pairs: SiblingComparison[] = []
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i]!
      const right = candidates[j]!
      const here = scored(left)
      const there = scored(right)

      const onlyHere: number[] = []
      const onlyThere: number[] = []
      let compared = 0
      for (const [position, passedHere] of here) {
        const passedThere = there.get(position)
        if (passedThere === undefined) continue
        compared += 1
        if (passedHere && !passedThere) onlyHere.push(position)
        if (passedThere && !passedHere) onlyThere.push(position)
      }
      if (compared === 0) continue

      const relation: SiblingRelation =
        onlyHere.length > 0 && onlyThere.length > 0
          ? 'incomparable'
          : onlyHere.length === 0 && onlyThere.length === 0
            ? 'identical'
            : 'dominates'
      // The dominating arm leads, so a reader never has to invert the sentence.
      const flip = relation === 'dominates' && onlyThere.length > 0
      pairs.push({
        variantId: flip ? right.variantId : left.variantId,
        otherVariantId: flip ? left.variantId : right.variantId,
        relation,
        onlyHere: flip ? onlyThere : onlyHere,
        onlyThere: flip ? onlyHere : onlyThere,
        compared,
      })
    }
  }
  return pairs
}

/**
 * The pairs worth saying something about, as sentences.
 *
 * Identical pairs are dropped: "these two behaved the same on every item" is true and is
 * already implied by two equal pass rates, and a panel that listed it would bury the two
 * readings that change a decision — one candidate strictly better than a sibling, and two
 * candidates good at different things.
 *
 * `label` names an arm the way the panel already names it, so this module needs to know
 * nothing about rationales or ids.
 */
export const describeScreenedSiblings = (
  pairs: readonly SiblingComparison[],
  label: (variantId: string) => string,
): string[] =>
  pairs.flatMap((pair) => {
    const items = (positions: readonly number[]) => positions.join(', ')
    if (pair.relation === 'dominates') {
      return [
        `${label(pair.variantId)} passed every held-out item ${label(pair.otherVariantId)} ` +
          `passed, and ${pair.onlyHere.length === 1 ? 'item' : 'items'} ` +
          `${items(pair.onlyHere)} as well.`,
      ]
    }
    if (pair.relation === 'incomparable') {
      return [
        `${label(pair.variantId)} and ${label(pair.otherVariantId)} are good at different ` +
          `things: ${items(pair.onlyHere)} only the first passed, ${items(pair.onlyThere)} ` +
          'only the second. Neither is strictly better on the set, so a pass rate cannot ' +
          'choose between them.',
      ]
    }
    return []
  })
