/**
 * Choice that is random in distribution and byte-reproducible from the journal.
 *
 * Nothing in this platform may branch on `Math.random`, a clock or a sampled token: a run that
 * cannot be replayed from its own rows cannot be evidence about anything, and every arm
 * assignment here alternates from counts rather than flipping a coin for exactly that reason.
 *
 * But two things genuinely need a choice **no author made**, and both are cases where ordering
 * *is* the bias:
 *
 * - **Blinding.** The prompt a verifier sees as option A must not reliably be the first one
 *   proposed, or the shuffle is decoration.
 * - **Seeding a bracket.** Which attempt meets which, and which of a pair is presented first,
 *   must not be a property of the order a model happened to write the list in. Position bias in
 *   pairwise judging is the effect this exists to defeat, and a bracket seeded by list order
 *   hands the first-written entrant the shortest path to the final.
 *
 * So the choice is taken from a **hash of a seed string**, and the seed is always something the
 * rows already hold — an execution's id, a node's id, a round number. Same rows, same bracket,
 * forever; and nobody drawing a shape gets to decide who meets whom.
 *
 * A hash rather than an index because the point is decorrelation from the input order: sorting
 * by id would be deterministic and would still put the same entrant first every time.
 */

/**
 * FNV-1a, 32-bit.
 *
 * Not a cryptographic hash and not asked to be one: what is needed is that a one-character
 * change in the seed moves the result somewhere unrelated, which this gives in four lines and
 * with no dependency — a requirement, since this package is parsed by the browser and holds no
 * `node:` imports on any path a browser reaches.
 */
export const seededHash = (value: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * The items in an order the seed decides, and nothing else does.
 *
 * `keyOf` supplies the part of an item that identifies it — an id, or the item's own text where
 * that is all there is. The rank is a hash of the seed and that key alone, so two callers asking
 * about the same set get the same order whatever order they hold it in. Ties break on the key and
 * only then on position, which is the one place arrival order is allowed to decide anything: two
 * entries with identical keys are indistinguishable, and something has to be first.
 */
export const seededOrder = <T>(
  seed: string,
  items: readonly T[],
  keyOf: (item: T, index: number) => string,
): T[] =>
  items
    .map((item, index) => {
      const key = keyOf(item, index)
      return { item, key, index, rank: seededHash(`${seed}:${key}`) }
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.key.localeCompare(right.key) ||
        left.index - right.index,
    )
    .map((entry) => entry.item)

/**
 * Whether a pair is presented the way it arrived or the other way round.
 *
 * One bit, and it is the whole of the position-bias mitigation: a judge that mildly prefers
 * whichever answer it read first is a judge whose verdict is half about the ordering, and an
 * ordering the seed chose is one no author and no earlier step controls.
 */
export const seededSwap = (seed: string): boolean => (seededHash(seed) & 1) === 1

/**
 * The pair, in the order the judge will see it.
 *
 * Returned as a pair rather than by mutating a list so the caller can recover which side won
 * without re-deriving the swap: `[left, right]` is what the prompt renders, and the winner names
 * a side rather than an entrant.
 */
export const seededPair = <T>(seed: string, first: T, second: T): readonly [T, T] =>
  seededSwap(seed) ? [second, first] : [first, second]
