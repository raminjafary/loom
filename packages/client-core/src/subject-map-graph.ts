import type { MapEdge, MapNode, MasteryView } from '@loom/api-contract'

/**
 * A subject map as something a human can look at.
 *
 * Layout is computed here rather than authored, for the same reason `swarm-graph.ts`
 * computes its own: a map's shape is a fact about the graph, so there is nothing to drag
 * and nothing to persist. The design canvas is where a human owns the layout; this is a
 * projection.
 *
 * **The one rule this module exists to enforce visually**: mastery makes provenance the
 * trust boundary inside the graph, and "an inferred edge must not look like a parsed
 * one". A renderer that drew both the same way would be the place that distinction
 * quietly stopped mattering — so provenance rides on every node and edge here, and the
 * component's job is only to honour it.
 */

export interface MapGraphNode {
 readonly id: string
 readonly key: string
 readonly label: string
 readonly kind: MapNode['kind']
 readonly provenance: MapNode['provenance']
 readonly summary: string
 readonly paths: readonly string[]
 readonly x: number
 readonly y: number
 readonly radius: number
 /** Degree among live edges — what makes a hub visible without reading a list. */
 readonly degree: number
 readonly hub: boolean
 /** Concept-register nodes sit on the inner ring; code entities on the outer one. */
 readonly ring: 'concept' | 'code'
}

export interface MapGraphEdge {
 readonly id: string
 readonly fromKey: string
 readonly toKey: string
 readonly kind: MapEdge['kind']
 readonly provenance: MapEdge['provenance']
 readonly x1: number
 readonly y1: number
 readonly x2: number
 readonly y2: number
}

export interface MapGraph {
 readonly nodes: MapGraphNode[]
 readonly edges: MapGraphEdge[]
 readonly width: number
 readonly height: number
 /** Live claims by provenance — the header line that says how much of this is checkable. */
 readonly counts: { extracted: number; inferred: number; ambiguous: number }
 /** Live claims that have been retired, so "the map shrank" is visible rather than silent. */
 readonly invalidated: number
}

const CONCEPT_KINDS = new Set<MapNode['kind']>(['concept', 'convention', 'constraint', 'hazard'])

const WIDTH = 900
const HEIGHT = 620
const CENTRE = { x: WIDTH / 2, y: HEIGHT / 2 }
const INNER_RADIUS = 130
const OUTER_RADIUS = 260

/**
 * How many nodes are drawn.
 *
 * A map may hold two thousand; a picture of two thousand circles is not a picture of
 * anything. The cut keeps the ranked head — concepts and hubs — for the same reason
 * `selectMapForContext` does, so what a human sees and what a worker is handed are the
 * same claims. The count dropped is reported by the caller, never hidden.
 */
export const MAX_GRAPH_NODES = 80

/**
 * Two concentric rings rather than a force simulation.
 *
 * A force layout would need a tick loop, a stable seed to avoid the graph rearranging
 * itself on every refresh, and a dependency — and it would encode nothing. The rings
 * encode the one distinction mastery says the map is *for*: the inner ring is what has no
 * single location, the outer ring is the code, and the spokes between them are the
 * `implements` edges that make a concept worth a node at all.
 */
export const buildMapGraph = (view: MasteryView): MapGraph => {
 const liveNodes = view.nodes.filter((node) => node.invalidatedAt === null)
 const liveEdges = view.edges.filter((edge) => edge.invalidatedAt === null)
 const hubs = new Set(view.hubs.map((hub) => hub.key))

 const degrees = new Map<string, number>
 for (const edge of liveEdges) {
 degrees.set(edge.fromKey, (degrees.get(edge.fromKey) ?? 0) + 1)
 degrees.set(edge.toKey, (degrees.get(edge.toKey) ?? 0) + 1)
 }

 const rank = (node: MapNode): number => {
 if (CONCEPT_KINDS.has(node.kind)) return 0
 if (hubs.has(node.key)) return 1
 return 2
 }

 const drawn = [...liveNodes]
.sort(
 (a, b) =>
 rank(a) - rank(b) ||
 (degrees.get(b.key) ?? 0) - (degrees.get(a.key) ?? 0) ||
 (a.key < b.key ? -1: 1),
)
.slice(0, MAX_GRAPH_NODES)

 const inner = drawn.filter((node) => CONCEPT_KINDS.has(node.kind))
 const outer = drawn.filter((node) => !CONCEPT_KINDS.has(node.kind))

 const place = (
 nodes: readonly MapNode[],
 radius: number,
 ring: 'concept' | 'code',
): MapGraphNode[] =>
 nodes.map((node, index) => {
 // Offset by a quarter turn so the first node sits at the top rather than the
 // right, which reads as an arbitrary starting point.
 const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2
 const degree = degrees.get(node.key) ?? 0
 return {
 id: node.id,
 key: node.key,
 label: node.label,
 kind: node.kind,
 provenance: node.provenance,
 summary: node.summary,
 paths: node.paths,
 x: CENTRE.x + Math.cos(angle) * radius,
 y: CENTRE.y + Math.sin(angle) * radius,
 // Size tracks degree, capped: an unbounded radius would let one god node cover
 // the graph it is supposed to be a feature of.
 radius: Math.min(26, 10 + degree * 1.5),
 degree,
 hub: hubs.has(node.key),
 ring,
 }
 })

 const nodes = [
...place(inner, inner.length === 1 ? 0: INNER_RADIUS, 'concept'),
...place(outer, OUTER_RADIUS, 'code'),
 ]
 const byKey = new Map(nodes.map((node) => [node.key, node]))

 const edges: MapGraphEdge[] = []
 for (const edge of liveEdges) {
 const from = byKey.get(edge.fromKey)
 const to = byKey.get(edge.toKey)
 // An edge to a node that was cut is dropped rather than drawn to nowhere — the same
 // rule `selectMapForContext` applies, since a dangling edge invites a question the
 // picture cannot answer.
 if (!from || !to) continue
 edges.push({
 id: edge.id,
 fromKey: edge.fromKey,
 toKey: edge.toKey,
 kind: edge.kind,
 provenance: edge.provenance,
 x1: from.x,
 y1: from.y,
 x2: to.x,
 y2: to.y,
 })
 }

 return {
 nodes,
 edges,
 width: WIDTH,
 height: HEIGHT,
 counts: {
 extracted: liveNodes.filter((node) => node.provenance === 'extracted').length,
 inferred: liveNodes.filter((node) => node.provenance === 'inferred').length,
 ambiguous: liveNodes.filter((node) => node.provenance === 'ambiguous').length,
 },
 invalidated: view.nodes.length - liveNodes.length,
 }
}

/** How many live nodes the picture left out, so truncation is stated and not implied. */
export const undrawnNodeCount = (view: MasteryView): number =>
 Math.max(0, view.nodes.filter((node) => node.invalidatedAt === null).length - MAX_GRAPH_NODES)

/**
 * Coverage as a percentage a human reads, or null when nothing has been measured.
 *
 * Null rather than 0: mastery is explicit that an unmeasured quantity must not render as a
 * measured zero, since "0%" and "we have not checked yet" send a watcher to different
 * places.
 */
export const coveragePercent = (view: MasteryView): number | null =>
 view.progress ? Math.round(view.progress.coverage * 100): null

/**
 * What the map's state means, in one line, for a human deciding whether to intervene.
 *
 * `yieldFlat` is the one worth surfacing loudly — mastery calls reading-without-learning
 * "the specific thing worth interrupting", and it is invisible from a spinner and from a
 * coverage bar alike, both of which keep climbing while it happens.
 */
/**
 * Mirrors the application's `PENDING_REVISION`.
 *
 * Duplicated rather than imported, the same trade `models.ts` makes with its price list:
 * The rule is that a client depends on the contract and never on the domain. The
 * duplication is safe here in the way a parser's would not be — the failure is a
 * slightly less specific sentence on a map that already says it failed, not a wrong
 * behaviour — and the string is part of what the contract already sends.
 */
const PENDING_REVISION = 'pending'

export const describeMasteryState = (view: MasteryView): string => {
 if (view.map.status === 'failed') {
 return view.map.revision === PENDING_REVISION
 ? 'Failed before it learned which commit it was reading, so nothing here could ever be checked again.'
: 'The mastery run failed. Whatever it recorded before stopping is kept.'
 }
 if (view.map.status === 'ready') {
 const count = view.nodes.filter((node) => node.invalidatedAt === null).length
 return `${count} live claim(s) at ${view.map.revision.slice(0, 8)}.`
 }
 if (view.progress?.yieldFlat) {
 return 'Still reading, but it has stopped concluding anything — worth a look.'
 }
 return 'Mastering.'
}
