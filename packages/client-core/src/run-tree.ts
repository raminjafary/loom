import type { SwarmBoard } from '@loom/api-contract'

/**
 * The swarm tree, derived from the board's own cards.
 *
 * Pure, and in client-core rather than in the component, for the reason the rest of
 * this package exists: a TUI should render the same tree without reimplementing
 * how a parent, a subtotal or a root is decided. The Vue panel is a view over this.
 *
 * Nothing here re-fetches. `parentRunId` and `relation` are already on every card, so
 * a separate tree endpoint would be a second source of truth for a swarm's shape —
 * exactly what the worker-notes design refuses for the board and the ledger.
 */

export type RunTreeCard = SwarmBoard['cards'][number]

export interface RunTreeNode {
  readonly card: RunTreeCard
  /** 0 for a root of this slice; used only for indentation. */
  readonly depth: number
  /**
   * This run's own metered cost plus every descendant's.
   *
   * The number that actually answers "what did this goal cost". A Planner holds
   * `tools: []` and spends almost nothing itself while its children spend
   * everything, so its own `totalCostUsd` is close to meaningless on its own.
   */
  readonly subtotalUsd: number
  readonly childCount: number
}

/**
 * Depth-first, parents before children.
 *
 * **Roots are cards whose parent is not on this board**, not only cards with a null
 * parent. A board is a tree *slice*: watch a worker rather than its planner and the
 * parent genuinely is not in `cards`. Keying on null alone would render an empty tree
 * for exactly the case a human asked to look at.
 *
 * Cycles cannot occur — a run may only spawn children of itself, so parentage is
 * assigned once at creation — but the walk guards against revisiting a node anyway,
 * because an infinite loop in a render path is a hung tab rather than a wrong number.
 */
export const buildRunTree = (cards: readonly RunTreeCard[]): RunTreeNode[] => {
  if (cards.length === 0) return []

  const childrenOf = new Map<string | null, RunTreeCard[]>()
  for (const card of cards) {
    childrenOf.set(card.parentRunId, [...(childrenOf.get(card.parentRunId) ?? []), card])
  }

  const subtotals = new Map<string, number>()
  const subtotal = (card: RunTreeCard): number => {
    const cached = subtotals.get(card.runId)
    if (cached !== undefined) return cached
    // Seeded before recursing so a malformed cycle terminates instead of overflowing.
    subtotals.set(card.runId, card.totalCostUsd ?? 0)
    const total =
      (card.totalCostUsd ?? 0) +
      (childrenOf.get(card.runId) ?? []).reduce((sum, child) => sum + subtotal(child), 0)
    subtotals.set(card.runId, total)
    return total
  }

  const known = new Set(cards.map((card) => card.runId))
  const roots = cards.filter(
    (card) => card.parentRunId === null || !known.has(card.parentRunId),
  )

  const seen = new Set<string>()
  const out: RunTreeNode[] = []
  const walk = (card: RunTreeCard, depth: number): void => {
    if (seen.has(card.runId)) return
    seen.add(card.runId)
    const children = childrenOf.get(card.runId) ?? []
    out.push({ card, depth, subtotalUsd: subtotal(card), childCount: children.length })
    for (const child of children) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return out
}

/** Total metered spend across the slice. */
export const totalCostUsd = (cards: readonly RunTreeCard[]): number =>
  cards.reduce((sum, card) => sum + (card.totalCostUsd ?? 0), 0)

/**
 * Spend split by `relation`, highest first.
 *
 * The single total cannot answer the actual question — whether a planner plus cheap
 * workers beats one strong model — because that is a claim about *where* the money
 * goes. A root with no relation is reported as `root`.
 */
export const costByRelation = (cards: readonly RunTreeCard[]): [string, number][] => {
  const totals = new Map<string, number>()
  for (const card of cards) {
    const key = card.relation ?? 'root'
    totals.set(key, (totals.get(key) ?? 0) + (card.totalCostUsd ?? 0))
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])
}
