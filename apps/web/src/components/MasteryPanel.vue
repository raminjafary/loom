<script setup lang="ts">
import { computed, ref } from 'vue'
import {
 buildMapGraph,
 coveragePercent,
 describeMasteryState,
 undrawnNodeCount,
 type MapGraphNode,
} from '@loom/client-core'
import type { AgentPersona, MasteryView, Repository, SubjectMap } from '@loom/api-contract'

/**
 * A persona's expertise, drawn.
 *
 * **The provenance split is a security requirement here, not a style choice**, exactly
 * as the author split is in WorkerNotesPanel. Mastery: the map's trusted half is parsed and
 * its untrusted half is a model's conclusion, and "an inferred edge must not look like a
 * parsed one". So parsed claims are solid and plain; inferred ones are dashed, tinted,
 * and labelled as conclusions wherever they appear. A viewer who cannot tell them apart
 * has no basis for trusting either.
 *
 * Everything is interpolation. No `v-html` near a label or a summary — a node's
 * text is model-authored in the general case.
 */

const props = defineProps<{
 personas: AgentPersona[]
 personaId: string | null
 repositories: Repository[]
 maps: SubjectMap[]
 view: MasteryView | null
 loading: boolean
 error: string | null
 /** Repository id → display name, so a map says which codebase it is of. */
 repositoryNames: Record<string, string>
 /** The repository this persona's team works on, for the "is this expertise live here". */
 activeRepositoryId: string | null
}>

const emit = defineEmits<{
 'select-persona': [personaId: string]
 select: [mapId: string]
 refresh: []
 master: [repositoryId: string]
}>

const masterTarget = ref('')

const selectedKey = ref<string | null>(null)

const graph = computed( => (props.view ? buildMapGraph(props.view): null))
const undrawn = computed( => (props.view ? undrawnNodeCount(props.view): 0))
const coverage = computed( => (props.view ? coveragePercent(props.view): null))
const state = computed( => (props.view ? describeMasteryState(props.view): ''))

const selected = computed<MapGraphNode | null>(
 => graph.value?.nodes.find((node) => node.key === selectedKey.value) ?? null,
)

const repositoryName = (map: SubjectMap): string =>
 map.repositoryId ? (props.repositoryNames[map.repositoryId] ?? 'a repository'): 'no repository'

/**
 * Portable expertise: "a team's canvas must show, per member, which of its subjects are live for
 * the repository this team merges into", because an expert on the wrong codebase is an
 * ordinary agent with a misleading name. This is the same statement at the map level.
 */
const liveHere = (map: SubjectMap): boolean =>
 props.activeRepositoryId === null || map.repositoryId === props.activeRepositoryId

const strokeFor = (provenance: string): string =>
 provenance === 'extracted' ? 'var(--map-parsed)': 'var(--map-inferred)'

const dashFor = (provenance: string): string | undefined =>
 provenance === 'extracted' ? undefined: '5 4'
</script>

<template>
 <section class="mastery">
 <header class="head">
 <div>
 <h3>Expertise</h3>
 <p class="sub">
 What this agent has learned about a subject, and how much of it is checkable.
 </p>
 </div>
 <div class="actions">
 <select
:value="personaId ?? ''"
 aria-label="Agent"
 @change="emit('select-persona', ($event.target as HTMLSelectElement).value)"
 >
 <option value="" disabled>Choose an agent…</option>
 <option v-for="persona in personas":key="persona.id":value="persona.id">
 {{ persona.name }}
 </option>
 </select>
 <button type="button":disabled="!personaId" @click="emit('refresh')">Refresh</button>
 </div>
 </header>

 <div v-if="personaId" class="start">
 <select v-model="masterTarget" aria-label="Repository to master">
 <option value="" disabled>Repository to learn…</option>
 <option v-for="repository in repositories":key="repository.id":value="repository.id">
 {{ repository.displayName }}
 </option>
 </select>
 <button
 type="button"
 class="primary"
:disabled="masterTarget === ''"
 @click="emit('master', masterTarget)"
 >
 Start a mastery run
 </button>
 <!--
 Said before it is started, not after. Mastery: a mastery run is a normal run — same
 sandbox, same metering, same cap — and a human authorising one should know it
 costs money and produces no diff.
 -->
 <p class="sub">
 Reads the repository and records what it learns. It changes no code, and it spends
 against this agent's budget cap like any other run.
 </p>
 </div>

 <p v-if="error" class="error">{{ error }}</p>

 <p v-else-if="!personaId" class="empty">
 Choose an agent to see what it has learned.
 </p>

 <p v-else-if="maps.length === 0 && !loading" class="empty">
 This agent has mastered nothing yet. A mastery run reads a repository and records a
 map of it — it changes no code, and later runs are handed what it found.
 </p>

 <ul v-if="maps.length > 0" class="subjects">
 <li v-for="map in maps":key="map.id">
 <button
 type="button"
:class="{ active: view?.map.id === map.id }"
 @click="
 => {
 selectedKey = null
 emit('select', map.id)
 }
 "
 >
 <span class="ref">{{ map.subjectRef }}</span>
 <span class="meta">
 {{ map.subjectKind }} · {{ repositoryName(map) }} ·
 <span:class="['status', map.status]">{{ map.status }}</span>
 </span>
 <!--
 Stated rather than implied. Putting the flight expert on a team bound to the
 hotel repository is not an error and must not look like one — it just means
 this expertise contributes nothing here, and a human should know that before
 reading a confident-looking graph.
 -->
 <span v-if="!liveHere(map)" class="not-live">
 not used on the repository in view
 </span>
 </button>
 </li>
 </ul>

 <p v-if="loading" class="empty">Loading the map…</p>

 <template v-if="view && graph">
 <div class="summary">
 <p class="state">{{ state }}</p>
 <dl>
 <div>
 <dt>Coverage</dt>
 <!-- Null is "not measured yet", never 0% — see coveragePercent. -->
 <dd>{{ coverage === null ? 'not measured': `${coverage}%` }}</dd>
 </div>
 <div>
 <dt>Parsed</dt>
 <dd>{{ graph.counts.extracted }}</dd>
 </div>
 <div>
 <dt>Concluded</dt>
 <dd>{{ graph.counts.inferred }}</dd>
 </div>
 <div v-if="graph.counts.ambiguous > 0">
 <dt>Unresolved</dt>
 <dd>{{ graph.counts.ambiguous }}</dd>
 </div>
 <div v-if="graph.invalidated > 0">
 <dt>Retired</dt>
 <dd>{{ graph.invalidated }}</dd>
 </div>
 <div v-if="view.progress">
 <dt>Spend</dt>
 <dd>${{ view.progress.spendUsd.toFixed(4) }}</dd>
 </div>
 </dl>
 <p v-if="view.progress?.yieldFlat" class="flat">
 Coverage is still climbing but nothing new is being recorded — it is reading
 without learning.
 </p>
 </div>

 <div class="legend">
 <span><i class="swatch parsed"></i> parsed from the source — reliable</span>
 <span><i class="swatch inferred"></i> concluded by an agent — check before relying on it</span>
 </div>

 <div class="canvas">
 <svg:viewBox="`0 0 ${graph.width} ${graph.height}`" role="img" aria-label="Subject map">
 <line
 v-for="edge in graph.edges"
:key="edge.id"
:x1="edge.x1"
:y1="edge.y1"
:x2="edge.x2"
:y2="edge.y2"
:stroke="strokeFor(edge.provenance)"
:stroke-dasharray="dashFor(edge.provenance)"
 stroke-width="1.4"
 opacity="0.55"
 />
 <g
 v-for="node in graph.nodes"
:key="node.key"
:class="['node', node.provenance, { picked: node.key === selectedKey }]"
 @click="selectedKey = node.key === selectedKey ? null: node.key"
 >
 <circle
:cx="node.x"
:cy="node.y"
:r="node.radius"
:fill="node.ring === 'concept' ? 'var(--map-concept-fill)': 'var(--map-code-fill)'"
:stroke="strokeFor(node.provenance)"
:stroke-dasharray="dashFor(node.provenance)"
:stroke-width="node.hub ? 3: 1.5"
 />
 <text:x="node.x":y="node.y + node.radius + 13" text-anchor="middle">
 {{ node.label.length > 24 ? `${node.label.slice(0, 23)}…`: node.label }}
 </text>
 </g>
 </svg>
 </div>

 <p v-if="undrawn > 0" class="empty">
 {{ undrawn }} further node(s) are in this map and not drawn. The picture keeps the
 concepts and the most-connected nodes.
 </p>

 <div v-if="selected" class="detail">
 <h4>{{ selected.label }}</h4>
 <p class="meta">
 {{ selected.kind }} ·
 <span:class="['prov', selected.provenance]">{{
 selected.provenance === 'extracted'
 ? 'parsed from the source'
: selected.provenance === 'ambiguous'
 ? 'the parser found more than one answer'
: 'an agent concluded this'
 }}</span>
 · {{ selected.degree }} connection(s)<span v-if="selected.hub">
 · this is a hub, so a change here reaches further than it looks</span
 >
 </p>
 <p v-if="selected.summary" class="summary-text">{{ selected.summary }}</p>
 <p v-if="selected.paths.length > 0" class="paths">
 {{ selected.paths.join(', ') }}
 </p>
 </div>
 </template>
 </section>
</template>

<style scoped>
.mastery {
 --map-parsed: #3f7f5f;
 --map-inferred: #9a6b2f;
 --map-concept-fill: rgba(63, 127, 95, 0.12);
 --map-code-fill: rgba(120, 120, 130, 0.1);
 display: flex;
 flex-direction: column;
 gap: 0.75rem;
}

.head {
 display: flex;
 justify-content: space-between;
 align-items: flex-start;
 gap: 1rem;
}

h3 {
 margin: 0;
 font-size: 0.95rem;
}

.sub,
.empty,
.meta {
 margin: 0.15rem 0 0;
 font-size: 0.78rem;
 opacity: 0.72;
}

.actions {
 display: flex;
 gap: 0.4rem;
}

.start {
 display: flex;
 flex-wrap: wrap;
 align-items: center;
 gap: 0.4rem;
}

.start.sub {
 flex-basis: 100%;
}

select {
 font: inherit;
 font-size: 0.78rem;
 padding: 0.25rem 0.4rem;
 border: 1px solid rgba(128, 128, 128, 0.5);
 border-radius: 4px;
 background: transparent;
 color: inherit;
}

button:disabled {
 opacity: 0.45;
 cursor: not-allowed;
}

button {
 font: inherit;
 font-size: 0.78rem;
 padding: 0.3rem 0.6rem;
 border: 1px solid currentColor;
 border-radius: 4px;
 background: transparent;
 cursor: pointer;
 opacity: 0.85;
}

button.primary {
 opacity: 1;
}

.error {
 font-size: 0.8rem;
 color: #b3261e;
}

.subjects {
 list-style: none;
 margin: 0;
 padding: 0;
 display: flex;
 flex-direction: column;
 gap: 0.3rem;
}

.subjects button {
 width: 100%;
 text-align: left;
 display: flex;
 flex-direction: column;
 gap: 0.1rem;
 border-color: rgba(128, 128, 128, 0.4);
}

.subjects button.active {
 border-color: currentColor;
}

.ref {
 font-weight: 600;
 font-size: 0.82rem;
}

.status.ready {
 color: #3f7f5f;
}
.status.failed {
 color: #b3261e;
}

.not-live {
 font-size: 0.74rem;
 opacity: 0.75;
 font-style: italic;
}

.summary dl {
 display: flex;
 flex-wrap: wrap;
 gap: 0.9rem;
 margin: 0.4rem 0 0;
}

.summary dt {
 font-size: 0.7rem;
 text-transform: uppercase;
 letter-spacing: 0.04em;
 opacity: 0.6;
}

.summary dd {
 margin: 0;
 font-size: 0.85rem;
 font-variant-numeric: tabular-nums;
}

.state {
 margin: 0;
 font-size: 0.8rem;
}

.flat {
 margin: 0.4rem 0 0;
 font-size: 0.78rem;
 color: #9a6b2f;
}

.legend {
 display: flex;
 flex-wrap: wrap;
 gap: 1rem;
 font-size: 0.74rem;
 opacity: 0.8;
}

.swatch {
 display: inline-block;
 width: 1.4rem;
 border-top: 2px solid var(--map-parsed);
 vertical-align: middle;
 margin-right: 0.3rem;
}

.swatch.inferred {
 border-top-style: dashed;
 border-top-color: var(--map-inferred);
}

.canvas {
 border: 1px solid rgba(128, 128, 128, 0.25);
 border-radius: 6px;
 overflow: hidden;
}

svg {
 display: block;
 width: 100%;
 height: auto;
}

.node {
 cursor: pointer;
}

.node text {
 font-size: 11px;
 fill: currentColor;
 opacity: 0.85;
}

.node.picked circle {
 filter: brightness(1.15);
}

.detail {
 border-top: 1px solid rgba(128, 128, 128, 0.25);
 padding-top: 0.5rem;
}

.detail h4 {
 margin: 0;
 font-size: 0.85rem;
}

.prov.inferred,
.prov.ambiguous {
 color: #9a6b2f;
}

.summary-text {
 margin: 0.3rem 0 0;
 font-size: 0.8rem;
}

.paths {
 margin: 0.25rem 0 0;
 font-size: 0.74rem;
 opacity: 0.7;
 font-family: ui-monospace, monospace;
 word-break: break-all;
}
</style>
