<script setup lang="ts">
import type { SwarmBoard } from '@loom/api-contract'
import {
 activityLabel,
 buildSwarmGraph,
 describeAge,
 shortBranchName,
 type SwarmEdgeKind,
 type SwarmGraphNode,
} from '@loom/client-core'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'

/**
 * The tree view: nodes are runs, edges are delegation and report, click a node to open
 * its thread. Plus the "edges, not just nodes" — a path collision is an interaction
 * between two workers, and the board could only ever list it.
 *
 * **In an overlay, not in the sidebar.** The same reasoning as the diff review: this
 * panel's home column is ~21rem, and a graph rendered there is a graph nobody can read.
 * The sidebar keeps the button; the canvas gets the screen while it is being looked at.
 *
 * **Inline SVG rather than a graph library.** See `buildSwarmGraph` for why — briefly:
 * Vue Flow renders a layout rather than computing one, so a read-only view of a
 * two-level tree would need it *and* a layout engine to draw what the tree's own depth
 * already knows. The Vue Flow pin stands for the visual *creation* surface, where a
 * human authors the graph and interaction is the product.
 */

const props = defineProps<{
 board: SwarmBoard | null
 /**
 * The run currently being watched, so the canvas can say which node that is.
 *
 * Without it, clicking a node changed the app's state and the graph reflected
 * none of it — the one interaction the canvas offers was fire-and-forget, behind
 * a full-screen scrim, which reads as nothing having happened.
 */
 activeRunId: string | null
 /**
 * Bumped from outside to open the canvas — the same counter idiom `SidebarSection`
 * uses, and for the same reason: a boolean that stays true fires its watcher once.
 *
 * This exists because the canvas was unreachable in practice. It lives inside a
 * *collapsed* sidebar section, behind a panel, behind an Open button — three levels
 * down from anything a human looks at, on a surface the product shape names as one of the product's
 * defining views. Reported plainly by the operator as "canvas is not visible in the
 * UI at all", which was true.
 */
 openSignal?: number
}>
const emit = defineEmits<{
 /**
 * Renamed from `watch` because the footer has always said "click a run to watch
 * its thread" and watching was all it did: `watchRun` fetches the run, its
 * approvals and its board, and never opens the thread the label promises.
 * The product shape states the tree view's defining interaction as "click a node to open its
 * thread", so the handler does both and the overlay closes behind it.
 */
 open: [agentRunId: string]
 refresh: []
}>

const open = ref(false)
const stageEl = ref<HTMLElement | null>(null)

watch(
 => props.openSignal,
 (next, previous) => {
 if (next === undefined || next === previous) return
 if (graph.value.nodes.length === 0) return
 open.value = true
 emit('refresh')
 nextTick(fit)
 },
)

/**
 * Ages tick on their own — see the board panel. A canvas showing "quiet since 2m" must
 * keep counting while nothing arrives, because silence is the state no event announces.
 */
const tick = ref(new Date)
const clock = setInterval( => (tick.value = new Date), 5_000)
onUnmounted( => clearInterval(clock))

const graph = computed( => buildSwarmGraph(props.board, tick.value))

// Node geometry, in SVG user units. One place, because the edge maths depends on it.
const NODE_W = 210
const NODE_H = 76
const GAP_X = 46
const GAP_Y = 92

const centerX = (node: SwarmGraphNode) => node.order * (NODE_W + GAP_X) + NODE_W / 2
const centerY = (node: SwarmGraphNode) => node.depth * (NODE_H + GAP_Y) + NODE_H / 2
const left = (node: SwarmGraphNode) => centerX(node) - NODE_W / 2
const top = (node: SwarmGraphNode) => centerY(node) - NODE_H / 2

const positions = computed( => new Map(graph.value.nodes.map((node) => [node.card.runId, node])))

const canvas = computed( => ({
 width: Math.max(graph.value.width, 1) * (NODE_W + GAP_X),
 height: Math.max(graph.value.depth, 1) * (NODE_H + GAP_Y),
}))

/**
 * Edge geometry. A parent→child edge is drawn as a vertical-first cubic so several
 * children of one parent fan out legibly instead of overlapping near the source.
 *
 * A collision edge is deliberately different: it joins two *siblings*, so it is routed
 * below them as an arc rather than through the layer, and it is the one edge that is not
 * a claim about structure but a warning about the future.
 */
const edgePath = (fromId: string, toId: string, kind: SwarmEdgeKind): string => {
 const from = positions.value.get(fromId)
 const to = positions.value.get(toId)
 if (!from || !to) return ''

 if (kind === 'collision') {
 const [a, b] = centerX(from) <= centerX(to) ? [from, to]: [to, from]
 const y = Math.max(centerY(a), centerY(b)) + NODE_H / 2 + 22
 return `M ${centerX(a)} ${centerY(a) + NODE_H / 2} C ${centerX(a)} ${y}, ${centerX(b)} ${y}, ${centerX(b)} ${centerY(b) + NODE_H / 2}`
 }

 const x1 = centerX(from)
 const y1 = centerY(from) + NODE_H / 2
 const x2 = centerX(to)
 const y2 = centerY(to) - NODE_H / 2
 const mid = (y1 + y2) / 2
 return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
}

// Pan and zoom, kept to the two gestures a reader actually needs on a canvas that is
// wider than the screen. No minimap, no node dragging: position here is a fact about the
// tree, so there is nothing for a human to rearrange.
const pan = ref({ x: 40, y: 40 })
const zoom = ref(1)
let dragging: { x: number; y: number } | null = null

const startPan = (event: PointerEvent) => {
 dragging = { x: event.clientX - pan.value.x, y: event.clientY - pan.value.y }
;(event.currentTarget as Element).setPointerCapture(event.pointerId)
}

const movePan = (event: PointerEvent) => {
 if (!dragging) return
 pan.value = { x: event.clientX - dragging.x, y: event.clientY - dragging.y }
}

const endPan = => {
 dragging = null
}

const onWheel = (event: WheelEvent) => {
 event.preventDefault
 zoom.value = Math.min(Math.max(zoom.value * (event.deltaY < 0 ? 1.1: 0.9), 0.4), 2.5)
}

/**
 * Fits the whole tree, rather than returning to the fixed origin `reset` used to.
 *
 * `{40, 40}` at zoom 1 is only the right view for a tree that happens to be small:
 * a wide one starts partly off-screen, and a "Reset view" that returns to the same
 * off-screen origin is not a way back to the content.
 */
const fit = => {
 const stage = stageEl.value
 const nodes = graph.value.nodes
 if (!stage || nodes.length === 0) {
 pan.value = { x: 40, y: 40 }
 zoom.value = 1
 return
 }
 const maxX = Math.max(...nodes.map((node) => left(node) + NODE_W))
 const maxY = Math.max(...nodes.map((node) => top(node) + NODE_H))
 const { width, height } = stage.getBoundingClientRect
 const margin = 32
 const next = Math.min(
 (width - margin * 2) / Math.max(maxX, 1),
 (height - margin * 2) / Math.max(maxY, 1),
 1,
)
 zoom.value = Math.min(Math.max(next, 0.4), 2.5)
 pan.value = { x: margin, y: margin }
}

/**
 * Closing on click is what makes the click legible. The state it changes — the
 * watched run, its board, its thread — is all *behind* this overlay, so leaving the
 * scrim up shows the human the same picture they just acted on.
 */
const openNode = (agentRunId: string) => {
 emit('open', agentRunId)
 open.value = false
}

const money = (usd: number | null) => (usd === null ? null: `$${usd.toFixed(4)}`)

const collisionCount = computed(
 => graph.value.edges.filter((edge) => edge.kind === 'collision').length,
)
</script>

<template>
 <section class="panel">
 <header>
 <h3>Graph</h3>
 <button
 type="button"
:disabled="graph.nodes.length === 0"
 @click="
 => {
 open = true
 emit('refresh')
 // After paint, so the stage has a measurable size to fit against.
 nextTick(fit)
 }
 "
 >
 Open
 </button>
 </header>
 <p class="hint">
 <template v-if="graph.nodes.length === 0">Nothing to draw yet.</template>
 <template v-else>
 {{ graph.nodes.length }} run<span v-if="graph.nodes.length !== 1">s</span>,
 {{ graph.depth }} level<span v-if="graph.depth !== 1">s</span>
 <span v-if="collisionCount > 0" class="warn">
 · {{ collisionCount }} collision<span v-if="collisionCount !== 1">s</span>
 </span>
 </template>
 </p>

 <Teleport to="body">
 <div v-if="open" class="scrim" @click.self="open = false">
 <section class="viewer" role="dialog" aria-label="Swarm graph">
 <header class="viewer-head">
 <h2>Swarm graph</h2>
 <ul class="legend">
 <li><span class="swatch delegation"></span>delegation</li>
 <li><span class="swatch review"></span>review</li>
 <li><span class="swatch reconcile"></span>reconcile</li>
 <li><span class="swatch steer"></span>steer</li>
 <li><span class="swatch collision"></span>path collision</li>
 </ul>
 <button type="button" @click="emit('refresh')">Refresh</button>
 <button type="button" @click="fit">Fit</button>
 <button type="button" class="close" aria-label="Close graph" @click="open = false">
 ✕
 </button>
 </header>

 <div
 ref="stageEl"
 class="stage"
 @pointerdown="startPan"
 @pointermove="movePan"
 @pointerup="endPan"
 @pointercancel="endPan"
 @wheel="onWheel"
 >
 <svg:width="'100%'":height="'100%'" role="img" aria-label="Runs and their relationships">
 <g:transform="`translate(${pan.x} ${pan.y}) scale(${zoom})`">
 <!-- Edges first, so a node always sits on top of the lines touching it. -->
 <path
 v-for="(edge, index) in graph.edges"
:key="`e${index}`"
:d="edgePath(edge.from, edge.to, edge.kind)"
 class="edge"
:class="edge.kind"
 >
 <title>{{ edge.kind }}: {{ edge.detail }}</title>
 </path>

 <g
 v-for="node in graph.nodes"
:key="node.card.runId"
 class="node"
:class="[
 node.activity.kind,
 node.role,
 { blocked: node.card.blockerCount > 0 },
 ]"
:transform="`translate(${left(node)} ${top(node)})`"
 role="button"
 tabindex="0"
:aria-current="node.card.runId === props.activeRunId ? 'true': undefined"
 @click="openNode(node.card.runId)"
 @keydown.enter.prevent="openNode(node.card.runId)"
 @keydown.space.prevent="openNode(node.card.runId)"
 >
 <rect:width="NODE_W":height="NODE_H" rx="10" class="box" />
 <!--
 A planner reads as a different kind of thing, not a differently
 coloured one: with sub-planners, half the middle
 nodes of a tree decompose and half write code, and every one of them
 is an ordinary delegation child. The rail is on the leading edge so
 it survives the node being clipped at the canvas boundary.
 -->
 <rect v-if="node.role === 'planner'":height="NODE_H" width="4" rx="2" class="rail" />
 <!--
 Every string below is interpolated as SVG text, never markup: a title
 comes from a run's task and is model-adjacent.
 -->
 <text class="persona" x="12" y="20">{{ node.card.personaName }}</text>
 <text class="status":x="NODE_W - 12" y="20" text-anchor="end">
 {{ node.card.status }}
 </text>
 <text class="title" x="12" y="38">
 {{ node.card.title.length > 28 ? `${node.card.title.slice(0, 27)}…`: node.card.title }}
 </text>
 <text v-if="node.activity.kind !== 'finished'" class="activity" x="12" y="55">
 {{ activityLabel(node.activity) }}
 <template v-if="node.activity.target">
 {{
 node.activity.target.length > 22
 ? `…${node.activity.target.slice(-21)}`
: node.activity.target
 }}
 </template>
 </text>
 <text v-else-if="node.card.branchName" class="activity" x="12" y="55">
 {{ shortBranchName(node.card.branchName) }}
 </text>
 <text class="cost" x="12" y="70">
 {{ money(node.card.totalCostUsd) ?? 'not metered' }}
 <template v-if="node.activity.kind === 'quiet' && node.card.lastEventAt">
 · quiet since {{ describeAge(node.card.lastEventAt, tick) }}
 </template>
 </text>
 <!--
 Context pressure as a bar across the node's foot. Drawn only
 once past half, so an early-turn node carries no chrome, and turning
 warm near the ceiling — the point at which the worker is about to
 compact and get worse.
 -->
 <template v-if="(node.activity.contextUsedRatio ?? 0) >= 0.5">
 <rect
 class="ctx-track"
 x="12"
:y="NODE_H - 8"
:width="NODE_W - 24"
 height="3"
 rx="1.5"
 />
 <rect
 class="ctx-fill"
:class="{ warn: (node.activity.contextUsedRatio ?? 0) >= 0.85 }"
 x="12"
:y="NODE_H - 8"
:width="(NODE_W - 24) * Math.min(node.activity.contextUsedRatio ?? 0, 1)"
 height="3"
 rx="1.5"
 />
 </template>

 <!-- A dot rather than a pulse: one mark that means "this is the one moving". -->
 <circle
 v-if="node.activity.kind === 'working'"
 class="live-dot"
:cx="NODE_W - 16"
 cy="52"
 r="4"
 />
 <title>
 {{ node.card.title }} — {{ node.card.personaName }},
 {{ node.card.status }}{{ node.card.blockerCount > 0 ? `, ${node.card.blockerCount} blocker(s)`: '' }}
 </title>
 </g>
 </g>
 </svg>
 </div>

 <footer class="viewer-foot">
 <span>Drag to pan, scroll to zoom, click a run to open its thread.</span>
 <span v-if="collisionCount > 0" class="warn">
 {{ collisionCount }} pair<span v-if="collisionCount !== 1">s</span> claim overlapping
 paths — expect a rebase.
 </span>
 </footer>
 </section>
 </div>
 </Teleport>
 </section>
</template>

<style scoped>
.panel {
 border: 1px solid var(--border);
 border-radius: 0.5rem;
 padding: 0.6rem 0.7rem;
}

header {
 display: flex;
 align-items: center;
 justify-content: space-between;
 gap: 0.5rem;
}

h3 {
 margin: 0;
 font-size: 0.7rem;
 text-transform: uppercase;
 letter-spacing: 0.06em;
 color: var(--text-faint);
}

header button {
 padding: 0.15rem 0.5rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--surface-hover);
 color: var(--text);
 font: inherit;
 font-size: 0.7rem;
 cursor: pointer;
}

header button:disabled {
 opacity: 0.5;
 cursor: default;
}

.hint {
 margin: 0.35rem 0 0;
 font-size: 0.72rem;
 color: var(--text-faint);
}

.warn {
 color: var(--warn);
}

.scrim {
 position: fixed;
 inset: 0;
 z-index: 60;
 display: flex;
 align-items: center;
 justify-content: center;
 padding: 1.5rem;
 background: rgb(0 0 0 / 55%);
}

.viewer {
 display: flex;
 flex-direction: column;
 width: min(96vw, 1400px);
 height: min(92vh, 900px);
 border: 1px solid var(--border);
 border-radius: 0.7rem;
 background: var(--bg);
 overflow: hidden;
}

.viewer-head,
.viewer-foot {
 display: flex;
 align-items: center;
 gap: 0.6rem;
 padding: 0.6rem 0.9rem;
 border-bottom: 1px solid var(--border);
}

.viewer-foot {
 border-bottom: 0;
 border-top: 1px solid var(--border);
 font-size: 0.72rem;
 color: var(--text-faint);
 justify-content: space-between;
}

.viewer-head h2 {
 margin: 0;
 font-size: 0.95rem;
}

.legend {
 display: flex;
 gap: 0.75rem;
 margin: 0 auto 0 0.5rem;
 padding: 0;
 list-style: none;
 font-size: 0.7rem;
 color: var(--text-faint);
}

.legend li {
 display: flex;
 align-items: center;
 gap: 0.3rem;
}

.swatch {
 width: 1rem;
 height: 0;
 border-top: 2px solid var(--text-faint);
}

.swatch.delegation {
 border-color: var(--text-muted);
}

.swatch.review {
 border-color: var(--accent);
}

.swatch.reconcile {
 border-color: var(--ok);
}

.swatch.steer {
 border-color: var(--warn, var(--accent));
 border-top-style: dotted;
}

.swatch.collision {
 border-top-style: dashed;
 border-color: var(--danger);
}

.viewer-head button {
 padding: 0.25rem 0.5rem;
 border: 1px solid var(--border);
 border-radius: 0.35rem;
 background: var(--surface-hover);
 color: var(--text);
 font: inherit;
 font-size: 0.75rem;
 cursor: pointer;
}

.stage {
 flex: 1;
 min-height: 0;
 cursor: grab;
 touch-action: none;
 background:
 radial-gradient(circle at 1px 1px, var(--border) 1px, transparent 0) 0 0 / 24px 24px;
}

.stage:active {
 cursor: grabbing;
}

.edge {
 fill: none;
 stroke: var(--text-muted);
 stroke-width: 1.5;
}

.edge.review {
 stroke: var(--accent);
}

.edge.reconcile {
 stroke: var(--ok);
}

/* Dotted: a re-planning turn is a human's intervention on the tree, not work
 the Planner handed down — the one edge that points at a run nobody delegated. */
.edge.steer {
 stroke: var(--warn, var(--accent));
 stroke-dasharray: 2 3;
}

/* Dashed and red: the one edge that is a warning rather than a fact about structure. */
.edge.collision {
 stroke: var(--danger);
 stroke-dasharray: 5 4;
 stroke-width: 1.75;
}

.node {
 cursor: pointer;
}

.box {
 fill: var(--surface);
 stroke: var(--border);
 stroke-width: 1;
}

.node:hover.box {
 stroke: var(--accent);
}

.node:focus-visible.box {
 stroke: var(--accent);
 stroke-width: 2;
}

/* Which node the app is actually watching. Without it the canvas showed no trace of
 the one action it offers. */
.node[aria-current='true'].box {
 stroke: var(--accent);
 stroke-width: 2.5;
}

/*
 Deliberately not a colour: colour on this canvas already means activity (working,
 quiet, blocked), and a second meaning on the same channel would make both unreadable.
 A planner is a different shape of thing, so it gets a shape.
*/
.node.planner.box {
 stroke-dasharray: none;
 stroke-width: 1.5;
}

.node.planner.rail {
 fill: var(--muted);
}

.node.planner:hover.rail,
.node.planner.working.rail {
 fill: var(--accent);
}

.node.working.box {
 stroke: var(--accent);
}

.node.quiet.box {
 stroke: var(--warn);
}

.node.blocked.box {
 stroke: var(--danger);
 stroke-width: 1.75;
}

text {
 fill: var(--text);
 font-family: inherit;
}

.persona {
 font-size: 12px;
 font-weight: 600;
}

.status,
.cost {
 font-size: 10px;
 fill: var(--text-faint);
}

.title {
 font-size: 11px;
 fill: var(--text-muted);
}

.activity {
 font-size: 10px;
 fill: var(--text-muted);
 font-family: ui-monospace, monospace;
}

.node.working.activity {
 fill: var(--accent);
}

.node.quiet.activity {
 fill: var(--warn);
}

.live-dot {
 fill: var(--accent);
}

.ctx-track {
 fill: var(--surface-hover);
}

.ctx-fill {
 fill: var(--text-faint);
}

.ctx-fill.warn {
 fill: var(--warn);
}
</style>
