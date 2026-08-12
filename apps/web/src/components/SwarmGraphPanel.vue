<script setup lang="ts">
import type { MergeQueueEntry, SwarmBoard } from '@loom/api-contract'
import {
 activityLabel,
 buildSwarmGraph,
 describeAge,
 shortBranchName,
 type SwarmEdgeKind,
 type SwarmGraphNode,
 type SwarmQueueNode,
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
 * The workspace's merge queue, drawn as its own band below the runs.
 *
 * Passed in rather than fetched here because the queue is workspace-scoped and this
 * canvas is tree-scoped — `buildSwarmGraph` keeps only the entries whose run is on this
 * board, and it needs the whole queue to work out a branch's *place in line*, since a
 * branch from another tree ahead of this one really is ahead of it.
 */
 mergeQueue: readonly MergeQueueEntry[]
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
 /**
 * Live-activity frames for this tree — see `AgentSnapshot.recentActivity`.
 *
 * The canvas already rendered live *facts*: the call in flight, idle time, cost
 * against cap. What it could not show was anything *happening*, because every one of
 * those facts arrives by refetch and a refetch lands after the moment it describes.
 * These frames are what make an edge light up while work is crossing it.
 */
 activity?: readonly {
 agentRunId: string
 parentRunId: string | null
 kind: string
 label: string | null
 at: number
 }[]
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
 /** Load and show the selected run's branch diff, without leaving the canvas. */
 review: [agentRunId: string]
 /** Re-enter a planner with a message. Only offered on planner nodes. */
 steer: [agentRunId: string]
}>

const open = ref(false)
const stageEl = ref<HTMLElement | null>(null)
const scrimEl = ref<HTMLElement | null>(null)

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
let clock: ReturnType<typeof setInterval> | null = null

/**
 * One second while the canvas is open, five while it is not.
 *
 * The clock is what *expires* a pulse, so its interval is the resolution of every
 * animation here — at five seconds a highlight lingers seconds after the work ended,
 * which is the stale-liveness claim this canvas exists to avoid making. Slowed back
 * down when closed because the panel still renders ages in the sidebar and nothing
 * there needs per-second accuracy.
 */
const startClock = (ms: number) => {
 if (clock !== null) clearInterval(clock)
 clock = setInterval( => (tick.value = new Date), ms)
}
startClock(5_000)
watch(open, (isOpen) => {
 startClock(isOpen ? 1_000: 5_000)
 // Focused so the arrow keys reach `onKeydown` at all — the same lesson the Settings
 // overlay's Escape handler taught, which sat on an element nothing ever focused.
 if (isOpen) void nextTick( => scrimEl.value?.focus)
 else selectedId.value = null
})
onUnmounted( => {
 if (clock !== null) clearInterval(clock)
})

const graph = computed( => buildSwarmGraph(props.board, props.mergeQueue, tick.value))

/**
 * Which runs and edges are lit right now.
 *
 * Recomputed off `tick` as well as the frames themselves so a pulse *expires* on its
 * own: without the clock in the dependency list a canvas with no new frames would
 * hold its last highlight forever, which is exactly the stale-liveness lie the quiet
 * label elsewhere in this app is careful not to tell.
 */
const PULSE_MS = 2_500

const liveRuns = computed( => {
 const now = tick.value.getTime
 const map = new Map<string, string>
 for (const entry of props.activity ?? []) {
 if (now - entry.at > PULSE_MS) continue
 map.set(entry.agentRunId, entry.label ?? entry.kind)
 }
 return map
})

/** The lit edges themselves, for drawing a packet along each. */
const liveEdgeList = computed( =>
 graph.value.edges.filter((edge) => liveEdges.value.has(`${edge.from}->${edge.to}`)),
)

/** Edges lit because work just crossed them — a delegation, or a child reporting up. */
const liveEdges = computed( => {
 const now = tick.value.getTime
 const set = new Set<string>
 for (const entry of props.activity ?? []) {
 if (now - entry.at > PULSE_MS) continue
 if (entry.parentRunId) set.add(`${entry.parentRunId}->${entry.agentRunId}`)
 }
 return set
})

// Node geometry, in SVG user units. One place, because the edge maths depends on it.
const NODE_W = 210
const NODE_H = 76
const GAP_X = 46
const GAP_Y = 92
/**
 * The queue band's boxes are shorter than a run's, and centred in the same layer height
 * so one set of layout maths serves both. A queue entry carries three short facts where a
 * run carries six, and giving it a run's height would leave it mostly empty and read as
 * equally important.
 */
const QUEUE_H = 42

interface Placed {
 readonly depth: number
 readonly order: number
}

const centerX = (node: Placed) => node.order * (NODE_W + GAP_X) + NODE_W / 2
const centerY = (node: Placed) => node.depth * (NODE_H + GAP_Y) + NODE_H / 2
const left = (node: Placed) => centerX(node) - NODE_W / 2
const top = (node: Placed) => centerY(node) - NODE_H / 2

/**
 * How many layers the runs occupy, so the queue band can start where they end.
 * `graph.depth` counts the queue's own layers too, which is what the canvas needs and
 * not what this needs.
 */
const runLayers = computed( =>
 graph.value.nodes.reduce((deepest, node) => Math.max(deepest, node.depth + 1), 0),
)

/**
 * The queue band gets **its own vertical rhythm**, tighter than the
 * runs'.
 *
 * Laying it out on the run grid was the obvious thing and looked wrong in a browser: the
 * gap is sized for 76px nodes, so 42px queue boxes ended up 120px apart and the pipeline
 * read as three unrelated boxes stacked down the canvas rather than as one flow. Its own
 * spacing is what makes `run → entry → verification` legible as a sequence.
 */
const QUEUE_GAP_Y = 30
const queueTop = computed( => runLayers.value * (NODE_H + GAP_Y))
const queueBand = (node: SwarmQueueNode) => node.depth - runLayers.value
const queueY = (node: SwarmQueueNode) =>
 queueTop.value + queueBand(node) * (QUEUE_H + QUEUE_GAP_Y) + QUEUE_H / 2

/**
 * Resolved geometry per drawable endpoint — runs by `runId`, queue nodes by their
 * namespaced `id`.
 *
 * Resolved rather than derived-on-demand because the two bands no longer share one
 * formula: an edge has to leave a box at *that box's* edge, and a single `NODE_H / 2`
 * left every queue edge ending 17px short of the node it pointed at. Visible immediately
 * in a browser and invisible to every test, which is the usual split.
 */
const positions = computed(
 =>
 new Map<string, { cx: number; cy: number; h: number }>([
...graph.value.nodes.map(
 (node) => [node.card.runId, { cx: centerX(node), cy: centerY(node), h: NODE_H }] as const,
),
...graph.value.queue.map(
 (node) => [node.id, { cx: centerX(node), cy: queueY(node), h: QUEUE_H }] as const,
),
 ]),
)

/**
 * What a verification node says when it has no output of its own to show — which is every
 * outcome except a failure. Each line states the thing the `verified` flag exists to
 * distinguish: merged-and-tested is not the same as merged-with-no-tests-configured.
 */
const verificationNote = (node: SwarmQueueNode): string => {
 switch (node.verification) {
 case 'passed':
 return "the repository's checks passed"
 case 'skipped':
 return 'merged unverified — no command configured'
 case 'refused':
 return 'not run — no sandbox available'
 case 'failed':
 return 'the checks failed'
 case 'pending':
 return node.status === 'merging' ? 'running…': 'not reached'
 }
}

const queueTitle = (node: SwarmQueueNode): string => {
 if (node.kind === 'verification') {
 return `Verification: ${node.verification}${node.detail ? ` — ${node.detail}`: ''}`
 }
 const place = node.place === null ? node.status: `${node.status}, #${node.place} in line`
 return `${node.branchName} — ${place}${node.detail ? ` — ${node.detail}`: ''}`
}

const canvas = computed( => ({
 width: Math.max(graph.value.width, 1) * (NODE_W + GAP_X),
 // The queue band's layers are shorter than a run's, so the height is the two bands
 // added rather than one grid multiplied — otherwise a tree with a queue reserves space
 // it does not use and `fit` zooms out past what there is to read.
 height:
 Math.max(runLayers.value, 1) * (NODE_H + GAP_Y) +
 new Set(graph.value.queue.map((node) => node.depth)).size * (QUEUE_H + QUEUE_GAP_Y),
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
 const [a, b] = from.cx <= to.cx ? [from, to]: [to, from]
 const y = Math.max(a.cy + a.h / 2, b.cy + b.h / 2) + 22
 return `M ${a.cx} ${a.cy + a.h / 2} C ${a.cx} ${y}, ${b.cx} ${y}, ${b.cx} ${b.cy + b.h / 2}`
 }

 const x1 = from.cx
 const y1 = from.cy + from.h / 2
 const x2 = to.cx
 const y2 = to.cy - to.h / 2
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

/**
 * Zooms about the pointer, not the origin.
 *
 * Zooming about the origin walks whatever you were looking at off the screen, which
 * on a wide tree means every zoom is followed by a hunt. Keeping the point under the
 * cursor fixed is what makes the gesture usable: solve for the pan that leaves the
 * cursor's graph-space coordinate where it was.
 */
const onWheel = (event: WheelEvent) => {
 event.preventDefault
 const next = Math.min(Math.max(zoom.value * (event.deltaY < 0 ? 1.1: 0.9), 0.4), 2.5)
 const stage = stageEl.value
 if (stage) {
 const rect = stage.getBoundingClientRect
 const cx = event.clientX - rect.left
 const cy = event.clientY - rect.top
 const ratio = next / zoom.value
 pan.value = { x: cx - (cx - pan.value.x) * ratio, y: cy - (cy - pan.value.y) * ratio }
 }
 zoom.value = next
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
 * The selected node.
 *
 * A click used to leave the canvas immediately. That was right when the canvas offered
 * exactly one action, and wrong as soon as it offered several: every useful thing a
 * human wants to do about a run — read its thread, review its branch, re-plan it,
 * leave it a note — lived somewhere else, so the graph was a picture you looked at and
 * then navigated away from. Selecting keeps you here and puts the actions on the node.
 */
const selectedId = ref<string | null>(null)

const selected = computed(
 => graph.value.nodes.find((node) => node.card.runId === selectedId.value) ?? null,
)

// A selection that outlived its node — the tree changed underneath it — is cleared
// rather than left pointing at nothing.
watch(graph, (next) => {
 if (selectedId.value && !next.nodes.some((node) => node.card.runId === selectedId.value)) {
 selectedId.value = null
 }
})

const selectNode = (agentRunId: string) => {
 selectedId.value = selectedId.value === agentRunId ? null: agentRunId
}

/**
 * Leaving the canvas is now an explicit action rather than a side effect of clicking.
 * It still closes the overlay, because the thread it opens is behind this scrim and
 * leaving it up would show the human the same picture they just acted on.
 */
const openSelected = => {
 if (!selectedId.value) return
 emit('open', selectedId.value)
 open.value = false
}

/** Same reasoning as `openSelected`: the panel it reveals is behind this scrim. */
const steerSelected = => {
 if (!selectedId.value) return
 emit('steer', selectedId.value)
 open.value = false
}

/**
 * Arrow keys walk the tree in reading order, so the canvas is navigable without a
 * mouse — the nodes were already focusable, but tabbing through thirty of them to
 * reach one is not navigation.
 */
const moveSelection = (delta: number) => {
 const nodes = graph.value.nodes
 if (nodes.length === 0) return
 const at = nodes.findIndex((node) => node.card.runId === selectedId.value)
 const next = at === -1 ? 0: (at + delta + nodes.length) % nodes.length
 selectedId.value = nodes[next]?.card.runId ?? null
}

const onKeydown = (event: KeyboardEvent) => {
 if (!open.value) return
 if (event.key === 'Escape') {
 if (selectedId.value) {
 selectedId.value = null
 event.preventDefault
 }
 return
 }
 const step =
 event.key === 'ArrowRight' || event.key === 'ArrowDown'
 ? 1
: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
 ? -1
: 0
 if (step !== 0) {
 moveSelection(step)
 event.preventDefault
 }
}

/**
 * The activity line, budgeted as one string rather than two.
 *
 * It used to truncate the label and the target independently, so a long tool name and
 * a long path each passed their own check and the concatenation overflowed the node.
 * The clip in `<defs>` is what makes overflow impossible; this is what makes the text
 * end in an ellipsis instead of being sliced mid-word by it.
 */
const ACTIVITY_BUDGET = 30

const activityLine = (node: SwarmGraphNode): string => {
 const label = activityLabel(node.activity)
 const target = node.activity.target ?? ''
 const full = target ? `${label} ${target}`: label
 if (full.length <= ACTIVITY_BUDGET) return full
 // Trimmed from the *front* of a path, because the tail is the part that identifies
 // a file — `…/src/cart.js` is useful, `/work/very/long/pa…` is not.
 if (target && target.length > 8) {
 const room = Math.max(ACTIVITY_BUDGET - label.length - 2, 8)
 return `${label} …${target.slice(-room)}`
 }
 return `${full.slice(0, ACTIVITY_BUDGET - 1)}…`
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
 <div
 v-if="open"
 ref="scrimEl"
 class="scrim"
 tabindex="-1"
 @click.self="open = false"
 @keydown="onKeydown"
 >
 <section class="viewer" role="dialog" aria-label="Swarm graph">
 <header class="viewer-head">
 <h2>Swarm graph</h2>
 <ul class="legend">
 <li><span class="swatch delegation"></span>delegation</li>
 <li><span class="swatch review"></span>review</li>
 <li><span class="swatch reconcile"></span>reconcile</li>
 <li><span class="swatch steer"></span>steer</li>
 <li><span class="swatch collision"></span>path collision</li>
 <!-- Only shown when there is a queue to explain: a legend entry for an
 absent band is a promise the canvas is not keeping. -->
 <li v-if="graph.queue.length > 0"><span class="swatch queue"></span>merge queue</li>
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
 <defs>
 <!--
 Nothing may leave the box. The text budgets below are guesses about
 glyph width — a line of capitals is far wider than the same count of
 `i`s — so a tool line like `Bash +1 more git -C /work/branch -a`
 escaped the node and drew over its neighbour. A clip is a boundary
 rather than a guess, which is the same preference this codebase makes
 everywhere else; the budgets stay so text ends in an ellipsis rather
 than mid-glyph.
 -->
 <clipPath id="loom-node-clip" clipPathUnits="userSpaceOnUse">
 <rect x="0" y="0":width="NODE_W":height="NODE_H" rx="10" />
 </clipPath>
 <!-- The queue band's own boundary — same argument, shorter box. -->
 <clipPath id="loom-queue-clip" clipPathUnits="userSpaceOnUse">
 <rect x="0" y="0":width="NODE_W":height="QUEUE_H" rx="8" />
 </clipPath>
 </defs>
 <g:transform="`translate(${pan.x} ${pan.y}) scale(${zoom})`">
 <!-- Edges first, so a node always sits on top of the lines touching it. -->
 <path
 v-for="(edge, index) in graph.edges"
:key="`e${index}`"
:d="edgePath(edge.from, edge.to, edge.kind)"
 class="edge"
:class="[edge.kind, { live: liveEdges.has(`${edge.from}->${edge.to}`) }]"
 >
 <title>{{ edge.kind }}: {{ edge.detail }}</title>
 </path>

 <!--
 A packet, travelling. The dash flow on a live edge says "this edge is
 busy"; a thing moving along it says which way the work is going, which
 is the question a tree of agents actually raises. Rendered between the
 edges and the nodes so it passes under a node rather than over its text.
 -->
 <circle
 v-for="edge in liveEdgeList"
:key="`p${edge.from}->${edge.to}`"
 class="packet"
 r="4"
 >
 <animateMotion
:path="edgePath(edge.from, edge.to, edge.kind)"
 dur="1.1s"
 repeatCount="indefinite"
 />
 </circle>

 <g
 v-for="node in graph.nodes"
:key="node.card.runId"
 class="node"
:class="[
 node.activity.kind,
 node.role,
 {
 blocked: node.card.blockerCount > 0,
 live: liveRuns.has(node.card.runId),
 selected: node.card.runId === selectedId,
 },
 ]"
:transform="`translate(${left(node)} ${top(node)})`"
 clip-path="url(#loom-node-clip)"
 role="button"
 tabindex="0"
:aria-current="node.card.runId === props.activeRunId ? 'true': undefined"
 @click="selectNode(node.card.runId)"
 @keydown.enter.prevent="selectNode(node.card.runId)"
 @keydown.space.prevent="selectNode(node.card.runId)"
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
 {{ activityLine(node) }}
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

 <!--
 The merge-queue band. Deliberately narrower and
 quieter than a run: a queue entry is bookkeeping about a branch, not an
 agent doing something, and drawing it at equal weight would make the
 pipeline compete with the work for attention.

 Not clickable, unlike a run. Every action on an entry — cancel, requeue
 — belongs to the merge-queue panel that owns the queue, and a second
 place to act on it would be a second place to keep correct. This band
 answers "what is happening to my branches", which is the question the canvas design
 says a human currently has to assemble from four surfaces.
 -->
 <g
 v-for="qnode in graph.queue"
:key="qnode.id"
 class="qnode"
:class="[qnode.kind, qnode.kind === 'verification' ? qnode.verification: qnode.status]"
:transform="`translate(${left(qnode)} ${queueY(qnode) - QUEUE_H / 2})`"
 clip-path="url(#loom-queue-clip)"
 >
 <rect:width="NODE_W":height="QUEUE_H" rx="8" class="box" />
 <template v-if="qnode.kind === 'entry'">
 <!--
 Place in line leads, because order is the merge queue's whole
 semantics — and it is the one thing a list renders badly.
 -->
 <text class="qplace" x="10" y="17">
 {{ qnode.place === null ? 'merge': `#${qnode.place} in line` }}
 </text>
 <text class="qstatus":x="NODE_W - 10" y="17" text-anchor="end">
 {{ qnode.status }}
 </text>
 <!--
 The reason replaces the branch name when it failed. The branch is
 already on the run node directly above — repeating it costs the one
 line the node has, and a browser showed the cost plainly: a failed
 entry said only "failed", with why it failed reachable by hovering.
 -->
 <text class="qbranch" x="10" y="32">
 {{
 qnode.status === 'failed' && qnode.detail
 ? qnode.detail.length > 30
 ? `${qnode.detail.slice(0, 29)}…`
: qnode.detail
: shortBranchName(qnode.branchName)
 }}
 </text>
 </template>
 <template v-else>
 <text class="qplace" x="10" y="17">verification</text>
 <text class="qstatus":x="NODE_W - 10" y="17" text-anchor="end">
 {{ qnode.verification }}
 </text>
 <!--
 The canvas design: a failed verification's own output "is the most useful
 thing on the screen when it fails", so it is on the node rather than
 only in a tooltip. Interpolated, never markup — it is a command's
 stdout.
 -->
 <text v-if="qnode.detail" class="qbranch" x="10" y="32">
 {{ qnode.detail.length > 30 ? `${qnode.detail.slice(0, 29)}…`: qnode.detail }}
 </text>
 <text v-else class="qbranch" x="10" y="32">
 {{ verificationNote(qnode) }}
 </text>
 </template>
 <title>{{ queueTitle(qnode) }}</title>
 </g>
 </g>
 </svg>
 </div>

 <!--
 The inspector. Everything here is already on the board payload — this panel
 exists because none of it was reachable *from the node*, which is what made
 a canvas full of live detail something you could only look at.
 -->
 <aside v-if="selected" class="inspector">
 <header>
 <div>
 <strong>{{ selected.card.personaName }}</strong>
 <span class="chip">{{ selected.card.status }}</span>
 </div>
 <button type="button" class="close" aria-label="Clear selection" @click="selectedId = null">
 ✕
 </button>
 </header>
 <!-- Plain interpolation: a title is a run's task, which is model-adjacent. -->
 <p class="task">{{ selected.card.title }}</p>
 <dl>
 <div><dt>Cost</dt><dd>{{ money(selected.card.totalCostUsd) ?? 'not metered' }}</dd></div>
 <div v-if="selected.card.branchName">
 <dt>Branch</dt><dd>{{ shortBranchName(selected.card.branchName) }}</dd>
 </div>
 <div v-if="selected.card.ownedPaths.length > 0">
 <dt>Owns</dt><dd>{{ selected.card.ownedPaths.join(', ') }}</dd>
 </div>
 <div v-if="selected.card.blockerCount > 0" class="warn">
 <dt>Blockers</dt><dd>{{ selected.card.blockerCount }}</dd>
 </div>
 </dl>
 <div class="actions">
 <button type="button" @click="openSelected">Open thread</button>
 <button
 v-if="selected.card.branchName"
 type="button"
 @click="emit('review', selected.card.runId)"
 >
 Review diff
 </button>
 <button
 v-if="selected.card.planner"
 type="button"
 @click="steerSelected"
 >
 Re-plan this
 </button>
 </div>
 </aside>

 <footer class="viewer-foot">
 <span>
 Drag to pan, scroll to zoom, click a run to inspect it, arrow keys to walk
 the tree.
 </span>
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

.swatch.queue {
 border-color: var(--text-faint);
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

/* The merge-queue edges. Thinner than a delegation on purpose: these describe
 what is happening to a branch, not who asked whom for work, and the tree's own shape
 should stay the loudest thing on the canvas. */
.edge.queue,
.edge.verify {
 stroke: var(--text-faint);
 stroke-width: 1.25;
}

.edge.verify {
 stroke-dasharray: 3 3;
}

.node {
 cursor: pointer;
}

/* The merge-queue band — quieter than a run, and not interactive: every action
 on an entry belongs to the panel that owns the queue. */
.qnode.box {
 fill: var(--bg);
 stroke: var(--border);
 stroke-dasharray: 3 2;
}

/* The accent means "this is in flight", and it belongs to the entry that is merging —
 not to a verification whose state is `pending`, which means the opposite: nothing is
 known yet. Drawn in the accent, a pending verification read as selected or running, and
 sat under a *failed* entry claiming attention it had not earned. It stays dashed and
 quiet; the entry above it is what lights up while the merge is actually running. */
.qnode.merging.box {
 stroke: var(--accent);
 stroke-dasharray: none;
}

.qnode.merged.box,
.qnode.passed.box {
 stroke: var(--ok);
 stroke-dasharray: none;
}

.qnode.failed.box,
.qnode.refused.box {
 stroke: var(--danger);
 stroke-dasharray: none;
}

/* Skipped is neither good nor bad — it merged, and nothing vouched for it. Left dashed,
 because that is exactly the "no claim was made" state the dashes mean here. */
.qnode.skipped.box {
 stroke: var(--warn, var(--border));
}

.qplace {
 font-size: 10px;
 font-weight: 600;
 fill: var(--text);
 text-transform: uppercase;
 letter-spacing: 0.04em;
}

.qstatus {
 font-size: 10px;
 fill: var(--text-faint);
}

.qbranch {
 font-size: 10.5px;
 fill: var(--text-muted);
 font-family: ui-monospace, monospace;
}

.box {
 fill: var(--surface);
 stroke: var(--border);
 stroke-width: 1;
}

.node:hover.box {
 stroke: var(--accent);
}

/*
 Work crossing a node, right now. A halo rather than a fill change: fill on this
 canvas already means activity state (working / quiet / blocked), and a second
 meaning on the same channel would make both unreadable — the same reasoning that
 made a planner a different *shape* rather than a different colour.
*/
.node.live.box {
 stroke: var(--accent);
 stroke-width: 2;
 filter: drop-shadow(0 0 6px color-mix(in oklab, var(--accent) 70%, transparent));
}

/*
 An edge with something on it. The dash *moves*, which is the only property here
 that says "in flight" rather than "recently true" — a brighter static line would be
 indistinguishable from the selected state.
*/
.edge.live {
 stroke: var(--accent);
 stroke-width: 2.5;
 stroke-dasharray: 6 6;
 animation: flow 0.7s linear infinite;
}

@keyframes flow {
 to {
 stroke-dashoffset: -12;
 }
}

.packet {
 fill: var(--accent);
 filter: drop-shadow(0 0 4px color-mix(in oklab, var(--accent) 80%, transparent));
}

/*
 A node that is executing, breathing. Distinct from `.live`, which is a *pulse* on an
 event: this is the continuous state, so a human scanning a wide tree can see where
 work is without waiting for the next frame to arrive.
*/
.node.working.box {
 animation: breathe 2.2s ease-in-out infinite;
}

@keyframes breathe {
 0%,
 100% {
 filter: none;
 }
 50% {
 filter: drop-shadow(0 0 5px color-mix(in oklab, var(--accent) 45%, transparent));
 }
}

/*
 Motion is the whole point of the three rules above, so honouring this preference has
 to remove the motion without removing the *information*: the live edge keeps its
 colour and weight, the packet stops travelling but stays visible at the source, and a
 working node keeps a static halo.
*/
@media (prefers-reduced-motion: reduce) {
.edge.live {
 animation: none;
 }

.packet {
 display: none;
 }

.node.working.box {
 animation: none;
 filter: drop-shadow(0 0 5px color-mix(in oklab, var(--accent) 45%, transparent));
 }
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

/* The selection, distinct from the watched run: one is what you are inspecting, the
 other is what the rest of the app is pointed at, and they are often not the same. */
.node.selected.box {
 stroke: var(--text);
 stroke-width: 2.5;
}

.inspector {
 position: absolute;
 right: 1rem;
 bottom: 3.4rem;
 width: 19rem;
 padding: 0.7rem 0.8rem;
 border: 1px solid var(--border);
 border-radius: 0.6rem;
 background: var(--surface);
 box-shadow: 0 8px 30px rgb(0 0 0 / 45%);
 font-size: 0.8rem;
}

.inspector header {
 display: flex;
 align-items: baseline;
 justify-content: space-between;
 gap: 0.5rem;
}

.inspector.chip {
 margin-left: 0.4rem;
 color: var(--text-faint);
 font-size: 0.7rem;
}

.inspector.task {
 margin: 0.35rem 0 0.5rem;
 color: var(--text-muted);
 line-height: 1.4;
}

.inspector dl {
 display: grid;
 gap: 0.15rem;
 margin: 0 0 0.6rem;
}

.inspector dl > div {
 display: flex;
 gap: 0.4rem;
}

.inspector dt {
 min-width: 4rem;
 color: var(--text-faint);
}

.inspector dd {
 margin: 0;
 overflow-wrap: anywhere;
}

.inspector.warn dd {
 color: var(--danger, #b4443a);
}

.inspector.actions {
 display: flex;
 flex-wrap: wrap;
 gap: 0.35rem;
}

.inspector.actions button {
 padding: 0.28rem 0.5rem;
 font-size: 0.75rem;
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
