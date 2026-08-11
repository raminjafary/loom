import type { SwarmBoard } from '@loom/api-contract'
import { describeCardActivity, type BoardCard, type CardActivity } from './board-activity.js'

/**
 * The swarm as nodes and edges (the product shape — "Tree view (graph canvas): nodes are runs,
 * edges are delegation/report", and live swarm observability — "Edges, not just nodes").
 *
 * **Layout is computed here, not authored.** A run's position is a fact about the tree,
 * so there is nothing for a human to drag and nothing to persist: the graph is a
 * projection of `parentRunId` exactly as `buildRunTree` is, and the two must never
 * disagree about a swarm's shape. That is also why this takes the board's own payload
 * rather than a second endpoint — the rule about second sources of truth.
 *
 * **On not using a graph library.** the tech stack pins Vue Flow for the graph canvas, and it is
 * still the right choice for the surface the product shape calls *visual creation* — dragging personas
 * and drawing planner→worker edges to author a roster, where the human owns the layout
 * and interaction is the point. It is the wrong tool here. Vue Flow does not lay out
 * graphs; it renders a layout you supply, so a read-only view of a two-level tree would
 * need Vue Flow *and* a layout engine (dagre or elk) to draw what the depth ordering
 * below already knows. Two dependencies to render forty lines of SVG is the trade the no-`v-html` rule
 * declined for markdown, for the same reason: the honest version is smaller than the
 * integration.
 */

export type SwarmEdgeKind = 'delegation' | 'review' | 'reconcile' | 'collision'

export interface SwarmGraphNode {
 readonly card: BoardCard
 readonly activity: CardActivity
 /** Layer index: 0 is the tree root, 1 its children, and so on. */
 readonly depth: number
 /** Position within its layer, left to right. */
 readonly order: number
}

export interface SwarmGraphEdge {
 readonly from: string
 readonly to: string
 readonly kind: SwarmEdgeKind
 /**
 * What the edge is about, for a title or a label. For a collision, the paths both
 * ends claim — which is the whole content of the warning.
 */
 readonly detail: string
}

export interface SwarmGraph {
 readonly nodes: SwarmGraphNode[]
 readonly edges: SwarmGraphEdge[]
 /** Widest layer, so a renderer can size the canvas without measuring. */
 readonly width: number
 readonly depth: number
}

/**
 * A run's depth, walking parents within the board.
 *
 * Bounded rather than recursive-until-root for the same reason `resolveTreeRunId` is: a
 * cycle introduced by a bad backfill should degrade this view, not hang the tab. A node
 * whose parent is not on the board is treated as a root — that is what a card whose
 * parent scrolled out of the tree actually is.
 */
const MAX_DEPTH = 16

const depthOf = (card: BoardCard, byId: Map<string, BoardCard>): number => {
 let depth = 0
 let current = card
 while (depth < MAX_DEPTH) {
 const parentId = current.parentRunId
 if (parentId === null) return depth
 const parent = byId.get(parentId)
 if (!parent) return depth
 current = parent
 depth += 1
 }
 return depth
}

/**
 * `relation` describes what a child *is* to its parent, and the three are genuinely
 * different edges: a reconciler is not a worker the planner asked for, and a
 * reviewer's finding can gate a branch. Drawing them identically would hide the
 * only structural distinction the data carries.
 */
const edgeKindOf = (card: BoardCard): Exclude<SwarmEdgeKind, 'collision'> => {
 if (card.relation === 'review') return 'review'
 if (card.relation === 'reconcile') return 'reconcile'
 return 'delegation'
}

export const buildSwarmGraph = (board: SwarmBoard | null, now: Date = new Date): SwarmGraph => {
 const cards = board?.cards ?? []
 const byId = new Map(cards.map((card) => [card.runId, card]))

 const withDepth = cards.map((card) => ({ card, depth: depthOf(card, byId) }))

 // Stable ordering within a layer: a graph that reshuffled on every refresh would be
 // unreadable while a swarm was moving, which is precisely when it is being watched.
 const perLayer = new Map<number, number>
 const nodes: SwarmGraphNode[] = withDepth
.slice
.sort((a, b) => a.depth - b.depth || a.card.runId.localeCompare(b.card.runId))
.map(({ card, depth }) => {
 const order = perLayer.get(depth) ?? 0
 perLayer.set(depth, order + 1)
 return { card, activity: describeCardActivity(card, now), depth, order }
 })

 const edges: SwarmGraphEdge[] = []
 for (const node of nodes) {
 const parentId = node.card.parentRunId
 if (parentId === null || !byId.has(parentId)) continue
 edges.push({
 from: parentId,
 to: node.card.runId,
 kind: edgeKindOf(node.card),
 detail: node.card.relation ?? 'delegation',
 })
 }

 /**
 * Collision edges. Live swarm observability: path collisions "are an edge and should be drawn as one".
 *
 * The board reports them by card *title*, which is what a list needs and not what a
 * graph does, so titles are resolved back to run ids here. A title that matches no
 * card — or matches two, since nothing makes a title unique — is skipped rather than
 * guessed at: a wrong collision edge would send someone to rebase the wrong branch.
 */
 const idsByTitle = new Map<string, string[]>
 for (const card of cards) {
 idsByTitle.set(card.title, [...(idsByTitle.get(card.title) ?? []), card.runId])
 }

 for (const collision of board?.pathCollisions ?? []) {
 const [leftTitle, rightTitle] = collision.titles
 const left = idsByTitle.get(leftTitle)
 const right = idsByTitle.get(rightTitle)
 if (left?.length !== 1 || right?.length !== 1) continue
 edges.push({
 from: left[0]!,
 to: right[0]!,
 kind: 'collision',
 detail: collision.paths.join(', '),
 })
 }

 return {
 nodes,
 edges,
 width: Math.max(...[...perLayer.values], 0),
 depth: perLayer.size,
 }
}
