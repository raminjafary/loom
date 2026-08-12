<script setup lang="ts">
import type { AgentPersona, DelegationEdge, PersonaGroup } from '@loom/api-contract'
import { MAX_FLEET_SIZE } from '@loom/domain'
import {
 composerEdges,
 composerNodes,
 connectVerdict,
 layoutForGroup,
 plannerLikeMarkdown,
 withWiderEnvelope,
 type ComposerEdge,
 type ConnectVerdict,
} from '@loom/client-core'
import { VueFlow, useVueFlow, type Connection, type NodeDragEvent } from '@vue-flow/core'
import { computed, nextTick, ref, watch } from 'vue'

/**
 * The canvas-based team composition, on the pinned Vue Flow.
 *
 * The tech stack pins Vue Flow for exactly this and not for the observability graph, and the
 * distinction is the whole design: **two canvases, not one.** The swarm graph draws
 * runs whose positions are computed from the tree's own depth ordering — facts, worth
 * nothing to persist, which is why forty lines of inline SVG beat two dependencies
 * there. This one draws personas a human arranged, where position is a choice worth
 * keeping, dragging is the interaction, and the layout is a fact about the team.
 *
 * The roadmap gives it two cautions and both are load-bearing here:
 *
 * - **It must not draw what the runtime cannot execute.** Every edge is
 * `personaGroup.delegationMatrix`'s answer — computed server-side by the same rules
 * that refuse a child start — never a line someone drew. Dragging between two nodes
 * does not create an edge; it *asks* for one.
 * - **Its highest-value job is showing the attenuation envelope at design time.**
 * A refused edge is drawn refused, with every reason at once and what to change for
 * each. The failure this replaces is a human discovering three separate correct
 * refusals one runtime error at a time.
 */

const props = defineProps<{
 personas: AgentPersona[]
 groups: PersonaGroup[]
 matrix: DelegationEdge[]
 busy?: boolean
}>

const emit = defineEmits<{
 close: []
 /** Creating a team from the canvas — the "visual creation", available before one exists. */
 'create-group': [input: { name: string; personaIds: string[] }]
 'save-group': [
 input: {
 personaGroupId: string
 name: string
 personaIds: string[]
 layout: Record<string, { x: number; y: number }>
 /** The widths, keyed by persona id. Always sent — see `setFleet`. */
 fleet: Record<string, number>
 /** The review policy, keyed by reviewer persona id. Always sent, likewise. */
 reviewers: Record<string, string[]>
 },
 ]
 'update-persona': [input: { personaId: string; markdownSource: string }]
 /**
 * Author a new persona from the canvas.
 *
 * The callback returns the created persona's id so the composer can put it on the team
 * in the same gesture — creating one and then hunting for it in the Add list would be
 * the trip to Settings with extra steps.
 */
 'create-persona': [
 input: { markdownSource: string; done: (personaId: string | null) => void },
 ]
}>

const selectedGroupId = ref(props.groups[0]?.id ?? '')
const creating = ref(false)
const draftName = ref('')

/**
 * The team this canvas just asked for, by name, until it arrives.
 *
 * By name because the id is the server's to mint. Found by creating one in the
 * browser: the team was stored, and the canvas went on showing the previous one —
 * so a create looked like nothing happening at all.
 */
const awaitingName = ref('')

const createTeam = => {
 const name = draftName.value.trim
 if (!name) return
 awaitingName.value = name
 emit('create-group', { name, personaIds: [] })
 draftName.value = ''
 creating.value = false
}

watch(
 => props.groups,
 (groups) => {
 /**
 * Selecting the team that was just created. The rule below — reselect when the
 * current selection is gone — cannot do this: the previous selection is still
 * there, so nothing looked wrong and nothing changed.
 */
 if (awaitingName.value) {
 const created = groups.find((entry) => entry.name === awaitingName.value)
 if (created) {
 selectedGroupId.value = created.id
 awaitingName.value = ''
 return
 }
 }
 // Whatever was selected has been deleted, or nothing was selected yet.
 if (!groups.some((entry) => entry.id === selectedGroupId.value)) {
 selectedGroupId.value = groups[groups.length - 1]?.id ?? ''
 }
 },
 { immediate: true, deep: true },
)

const group = computed(
 => props.groups.find((entry) => entry.id === selectedGroupId.value) ?? null,
)

/** Members, in the group's own order, skipping ids whose persona is gone. */
const members = computed<AgentPersona[]>( => {
 const current = group.value
 if (!current) return []
 return current.personaIds
.map((id) => props.personas.find((persona) => persona.id === id))
.filter((persona): persona is AgentPersona => persona !== undefined)
})

const layout = ref<Record<string, { x: number; y: number }>>({})
/** The widths, mirrored locally so an edit renders before the save round-trips. */
const fleet = ref<Record<string, number>>({})
/** The review policy, mirrored for the same reason. Keyed by reviewer persona id. */
const reviewers = ref<Record<string, string[]>>({})

watch(
 [group, members],
 => {
 // Recomputed only for members with no stored position, so opening a group never
 // rearranges what someone put where they wanted it.
 layout.value = layoutForGroup(members.value, group.value?.layout ?? {})
 fleet.value = {...(group.value?.fleet ?? {}) }
 reviewers.value = Object.fromEntries(
 Object.entries(group.value?.reviewers ?? {}).map(([id, list]) => [id, [...list]]),
)
 },
 { immediate: true },
)

/**
 * Built from `composerNodes` rather than mapped here.
 *
 * It was mapped here, and `composerNodes` — which exists so a TUI can compose a team
 * without reimplementing what a node means — had no callers at all. Two copies of
 * "what a node is", and the one the product rendered was the one that could drift.
 */
const nodes = computed( => composerNodes(members.value, layout.value, props.matrix))

const flowNodes = computed( =>
 nodes.value.map((node) => ({
 id: node.personaId,
 type: 'default' as const,
 position: node.position,
 data: { node },
 class: [
 'persona-node',
 node.planner ? 'planner': '',
 // The recursion edge, as a mark on the node that starts it — see
 // `ComposerNode.recurses` for why it is not drawn as a loop.
 node.recurses ? 'recurses': '',
 ]
.filter(Boolean)
.join(' '),
 /**
 * The width on the node, because the fleet design says a fleet *is* one node carrying a
 * number — not N copies of a persona, which would be two runs and belongs on the * board. Unsized members show nothing, so a team that never set a width looks exactly
 * as it did before this existed.
 */
 label: [node.name, fleet.value[node.personaId] ? `×${fleet.value[node.personaId]}`: '', node.recurses ? '↻': '']
.filter(Boolean)
.join(' '),
 })),
)

const edges = computed<ComposerEdge[]>( =>
 composerEdges(
 members.value.map((persona) => persona.id),
 props.matrix,
 reviewers.value,
),
)

const recursivePlanners = computed( => nodes.value.filter((node) => node.recurses))

/**
 * Planners that cannot recurse, and why — a narrowed envelope that does not admit the
 * planner's own tools makes depth impossible, and that is worth saying on the canvas
 * rather than discovering as a refused child start at depth 2.
 */
const blockedRecursion = computed( =>
 nodes.value
.filter((node) => node.planner && !node.recurses && node.recursionSummary !== '')
.map((node) => `${node.name} cannot: ${node.recursionSummary}`),
)

const flowEdges = computed( =>
 edges.value.map((edge) => ({
 id: edge.id,
 source: edge.source,
 target: edge.target,
 // A review edge is labelled always, a delegation only when refused: the delegation's
 // label is a *problem*, and the review's is the whole content of the edge.
 label: edge.kind === 'reviews' ? 'reviews': edge.ok ? '': edge.summary,
 animated: false,
 class:
 edge.kind === 'reviews' ? 'reviews': edge.ok ? 'delegates ok': 'delegates refused',
 style:
 edge.kind === 'reviews'
 ? // Dotted and in the "ok" colour, and deliberately not the accent: it is not a
 // permission the platform granted, it is a human's expectation, and nothing
 // refuses a branch for missing it.
 { stroke: 'var(--ok)', strokeWidth: 1.5, strokeDasharray: '2 4' }
: edge.ok
 ? { stroke: 'var(--accent)', strokeWidth: 2 }
: { stroke: 'var(--danger, #b42318)', strokeWidth: 1.5, strokeDasharray: '5 4' },
 })),
)

/**
 * Two things `fit-view-on-init` alone got wrong, both found by opening the canvas.
 *
 * It fits **once**, so adding a member put the new node outside the viewport — the
 * edge to it was drawn heading off the bottom of the canvas with nothing at the end.
 * And it fits *to fill*, so a team of one rendered a single node at several times its
 * natural size; `maxZoom` is what keeps a two-node team from looking like a poster.
 */
const { fitView } = useVueFlow

const FIT = { maxZoom: 1, padding: 0.2 }

watch(
 => members.value.map((persona) => persona.id).join(','),
 async => {
 // Two ticks and a frame: Vue Flow fits to the nodes it has *measured*, and a node
 // added this tick has no dimensions yet — fitting too early leaves the newest
 // member outside the viewport, which is exactly the case a re-fit exists for.
 await nextTick
 await nextTick
 requestAnimationFrame( => fitView(FIT))
 },
)

const selectedEdgeId = ref('')
const selectedEdge = computed(
 => edges.value.find((edge) => edge.id === selectedEdgeId.value) ?? null,
)

const personaById = (id: string) => props.personas.find((persona) => persona.id === id) ?? null

const saveLayout = => {
 const current = group.value
 if (!current) return
 emit('save-group', {
 personaGroupId: current.id,
 name: current.name,
 personaIds: current.personaIds,
 layout: layout.value,
 fleet: fleet.value,
 reviewers: reviewers.value,
 })
}

/**
 * Saved on drag *stop* rather than on every frame. A position is a fact worth
 * persisting; sixty of them per second on the way to that position are not.
 */
const onNodeDragStop = (event: NodeDragEvent) => {
 layout.value = {...layout.value, [event.node.id]: {...event.node.position } }
 saveLayout
}

const setMembers = (personaIds: string[]) => {
 const current = group.value
 if (!current) return
 emit('save-group', {
 personaGroupId: current.id,
 name: current.name,
 personaIds,
 layout: layout.value,
 fleet: fleet.value,
 reviewers: reviewers.value,
 })
}

/**
 * The fleet — how many of each member this team runs at once.
 *
 * Sent on every save rather than only when it changes, like `layout`: the server treats
 * an absent `fleet` as "leave the stored widths alone", so a save that omitted it after a
 * width was set would be indistinguishable from one that never had one.
 */
const setFleet = (personaId: string, size: number | null) => {
 const current = group.value
 if (!current) return
 const next = {...fleet.value }
 // Removing the entry rather than writing 0: unsized means "the Planner decides", and
 // 0 is refused by the server as a width that is really a removal.
 if (size === null) delete next[personaId]
 else next[personaId] = size
 fleet.value = next
 emit('save-group', {
 personaGroupId: current.id,
 name: current.name,
 personaIds: current.personaIds,
 layout: layout.value,
 fleet: next,
 reviewers: reviewers.value,
 })
}

/**
 * Sets who reviews one member's work. One reviewer per reviewed persona
 * from this control — the stored shape allows several, and a team that wants two can say
 * so from either side, but a single picker is the gesture that matches the sentence a
 * human is making ("qa checks swe").
 *
 * Empty clears it, which is a real state: no expectation is what every team has by default.
 */
const setReviewer = (reviewedId: string, reviewerId: string) => {
 const current = group.value
 if (!current) return
 const next: Record<string, string[]> = {}
 for (const [existingReviewer, reviewed] of Object.entries(reviewers.value)) {
 const kept = reviewed.filter((id) => id !== reviewedId)
 if (kept.length > 0) next[existingReviewer] = kept
 }
 if (reviewerId !== '') next[reviewerId] = [...(next[reviewerId] ?? []), reviewedId]
 reviewers.value = next
 emit('save-group', {
 personaGroupId: current.id,
 name: current.name,
 personaIds: current.personaIds,
 layout: layout.value,
 fleet: fleet.value,
 reviewers: next,
 })
}

/**
 * Who may be named a reviewer: anyone on the team. Not filtered to read-only personas —
 * a reviewer's *persona* decides what it can do and the runtime edge gives it no path
 * ownership regardless, so narrowing the list here would be this canvas inventing a rule
 * the runtime does not have.
 */
const reviewCandidates = computed( => members.value)

/** Who currently reviews this persona, for the picker's value. */
const reviewerOf = (reviewedId: string): string =>
 Object.entries(reviewers.value).find(([, reviewed]) => reviewed.includes(reviewedId))?.[0] ?? ''

const addMember = (personaId: string) => {
 const current = group.value
 if (!current || current.personaIds.includes(personaId)) return
 setMembers([...current.personaIds, personaId])
}

const removeMember = (personaId: string) => {
 const current = group.value
 if (!current) return
 setMembers(current.personaIds.filter((id) => id !== personaId))
}

/**
 * A width from the number input. Anything that is not a usable width — empty, zero,
 * negative, non-numeric — reads as **unsized** rather than as an error: the box is how a
 * human says "let the Planner decide", and rejecting a cleared field would make the only
 * way back from a width a page reload.
 */
const onFleetInput = (personaId: string, event: Event) => {
 const raw = (event.target as HTMLInputElement).value.trim
 const size = Number.parseInt(raw, 10)
 if (raw === '' || !Number.isFinite(size) || size < 1) {
 setFleet(personaId, null)
 return
 }
 setFleet(personaId, Math.min(size, MAX_FLEET_SIZE))
}

/**
 * The planner a new one is modelled on: the team's own, so the copy inherits the envelope
 * the rest of this team was designed against. Null on a team with no planner, where
 * "another planner" is not the thing being asked for.
 */
const plannerTemplate = computed( => members.value.find((persona) => persona.harnessPlanner) ?? null)

const plannerName = ref('')
const creatingPlanner = ref(false)

/**
 * Creates the persona and puts it on the team in one gesture. Two steps rather than one
 * contract call because they are two facts — a persona exists in the workspace, and this
 * team uses it — and conflating them would make a persona that could not be authored
 * without joining a team.
 */
const addPlanner = => {
 const template = plannerTemplate.value
 const name = plannerName.value.trim
 if (!template || name === '' || creatingPlanner.value) return
 creatingPlanner.value = true
 emit('create-persona', {
 markdownSource: plannerLikeMarkdown(template, {
 name,
 description: `Plans and delegates one area, modelled on ${template.name}.`,
 }),
 done: (personaId) => {
 creatingPlanner.value = false
 if (personaId === null) return
 plannerName.value = ''
 addMember(personaId)
 },
 })
}

const available = computed( =>
 props.personas.filter((persona) => !(group.value?.personaIds ?? []).includes(persona.id)),
)

/** What the last connection attempt meant, and what it would take to grant it. */
const pending = ref<{ verdict: ConnectVerdict; sourceId: string; targetName: string } | null>(null)

const onConnect = (connection: Connection) => {
 const source = personaById(connection.source)
 const target = personaById(connection.target)
 if (!source || !target) return

 const edge = props.matrix.find(
 (entry) => entry.plannerId === source.id && entry.workerId === target.id,
)
 pending.value = {
 verdict: connectVerdict(
 { personaId: source.id, name: source.name, planner: source.harnessPlanner },
 { name: target.name },
 edge,
),
 sourceId: source.id,
 targetName: target.name,
 }
 // Nothing is added to `edges` here, deliberately: the edge set is the matrix's
 // answer, and it changes when the personas change — not when someone drags.
}

const applyWidening = => {
 const request = pending.value
 if (!request || request.verdict.kind !== 'widen') return
 const planner = personaById(request.sourceId)
 if (!planner) return
 emit('update-persona', {
 personaId: planner.id,
 markdownSource: withWiderEnvelope(planner, request.verdict.tools),
 })
 pending.value = null
}

const onKeydown = (event: KeyboardEvent) => {
 if (event.key !== 'Escape') return
 if (pending.value) pending.value = null
 else if (selectedEdgeId.value) selectedEdgeId.value = ''
 else emit('close')
}
</script>

<template>
 <div
 class="scrim"
 role="dialog"
 aria-modal="true"
 aria-label="Compose a team"
 tabindex="-1"
 @keydown="onKeydown"
 @click.self="emit('close')"
 >
 <div class="sheet">
 <header>
 <h2>Compose a team</h2>
 <select v-if="props.groups.length > 0" v-model="selectedGroupId" aria-label="Team">
 <option v-for="entry in props.groups":key="entry.id":value="entry.id">
 {{ entry.name }}
 </option>
 </select>
 <button
 v-if="props.groups.length > 0 && !creating"
 type="button"
 class="link"
 @click="creating = true"
 >
 + New team
 </button>
 <button
 v-if="members.length > 0"
 type="button"
 class="link"
 title="Bring every member back into view"
 @click="fitView(FIT)"
 >
 Fit
 </button>
 <span class="hint">
 Edges are what the platform would allow, not what you drew. Drag a planner onto a
 worker to ask for one.
 </span>
 <button type="button" class="close" aria-label="Close composer" @click="emit('close')">
 ✕
 </button>
 </header>

 <!--
 Creating a team is on the canvas rather than only behind Settings, so designing
 one never starts by leaving the surface you design on.
 -->
 <form v-if="creating || props.groups.length === 0" class="new-team" @submit.prevent="createTeam">
 <label>
 <span>Name this team</span>
 <input v-model="draftName" type="text" placeholder="Frontend squad" />
 </label>
 <button type="submit":disabled="!draftName.trim">Create</button>
 <button v-if="props.groups.length > 0" type="button" class="link" @click="creating = false">
 Cancel
 </button>
 <p v-if="props.groups.length === 0" class="fine">
 A team is a named set of personas. Nothing here starts a run — this is where the
 roster and what each planner may hand down get decided, before anything runs.
 </p>
 </form>

 <div v-if="props.groups.length > 0" class="body">
 <div class="canvas">
 <!--
 An empty team was a black void with no indication that anything was
 expected of the human — the panel on the right says "Nobody yet" in
 eleven-pixel grey, which is not where someone looking at a blank canvas
 is looking.
 -->
 <p v-if="members.length === 0" class="canvas-empty">
 <strong>{{ group?.name }} has nobody on it yet.</strong>
 Add personas from the list on the right. Once a planner and a worker are
 both here, the edge between them shows whether the platform would let that
 planner delegate to that worker — and why not, when it would not.
 </p>
 <VueFlow
 v-else
:nodes="flowNodes"
:edges="flowEdges"
:nodes-draggable="true"
:edges-updatable="false"
:fit-view-on-init="true"
:max-zoom="1.5"
:min-zoom="0.2"
:default-viewport="{ zoom: 0.9, x: 0, y: 0 }"
 @node-drag-stop="onNodeDragStop"
 @connect="onConnect"
 @edge-click="(event) => (selectedEdgeId = event.edge.id)"
 />
 <!--
 The recursion mark, explained where it is drawn. Without
 this, `↻` is a glyph nobody can look up — and the fact it stands for is the
 one whole shape depends on, so it is worth a sentence rather than a
 tooltip. Only shown when something on the canvas actually carries it.
 -->
 <p v-if="recursivePlanners.length > 0" class="fine recursion-note">
 <strong>↻</strong> means that planner may delegate to another run of
 <em>itself</em> — a sub-planner taking one area of its own plan. That is how
 depth happens: several planners on a team are several planner
 <em>personas</em>, and one planner going deeper is this.
 <template v-if="blockedRecursion.length > 0">
 {{ blockedRecursion.join('; ') }}
 </template>
 </p>
 </div>

 <aside class="side">
 <section>
 <h3>On this team</h3>
 <ul class="chips">
 <li v-for="persona in members":key="persona.id">
 <span:class="{ planner: persona.harnessPlanner }">{{ persona.name }}</span>
 <!--
 The width, edited where the roster is. The node carries the
 number and this is where it is set: a number input on an SVG-ish canvas
 node is a worse control than a number input in a list, and the canvas is
 where the *consequence* is read.

 Empty means unsized — "the Planner decides", which is what every team
 did before this existed — so clearing the box is a real state and not a
 broken value.
 -->
 <input
 class="fleet"
 type="number"
 min="1"
:max="MAX_FLEET_SIZE"
:value="fleet[persona.id] ?? ''"
:aria-label="`How many ${persona.name} at once`"
 placeholder="any"
 @change="onFleetInput(persona.id, $event)"
 />
 <!--
 The design-canvas half: who reviews this persona's work, as *policy*
 rather than as a per-plan edge. Offered only on non-planners, because a
 planner's output is a decomposition and not a branch — the server refuses a
 policy that says otherwise, and offering it here would be asking for a
 refusal.
 -->
 <select
 v-if="!persona.harnessPlanner && reviewCandidates.length > 0"
 class="reviewer"
:value="reviewerOf(persona.id)"
:aria-label="`Who reviews ${persona.name}'s work`"
 @change="setReviewer(persona.id, ($event.target as HTMLSelectElement).value)"
 >
 <option value="">unreviewed</option>
 <option v-for="candidate in reviewCandidates.filter((c) => c.id !== persona.id)":key="candidate.id":value="candidate.id">
 reviewed by {{ candidate.name }}
 </option>
 </select>
 <button type="button" class="link" @click="removeMember(persona.id)">remove</button>
 </li>
 <li v-if="members.length === 0" class="none">Nobody yet.</li>
 </ul>
 </section>

 <!--
 The fleet design: several planners on a team are several planner *personas*, one per
 area, and authoring the second one belongs here. Offered only when the team
 already has a planner to copy, because the copy is the point — a planner
 authored with a narrower envelope than its siblings produces refusals two hops
 from the mistake, and this is the surface where that is visible.
 -->
 <section v-if="plannerTemplate">
 <h3>Another planner</h3>
 <p class="fine">
 One planner per area. This copies
 <strong>{{ plannerTemplate.name }}</strong>'s model, tools and delegation
 envelope, so the new area can do what that one can — edit it afterwards like
 any persona.
 </p>
 <form class="new-planner" @submit.prevent="addPlanner">
 <input
 v-model="plannerName"
 type="text"
 placeholder="e.g. backend-planner"
 aria-label="Name for the new planner"
 />
 <button type="submit":disabled="!plannerName.trim || creatingPlanner">
 {{ creatingPlanner ? 'Creating…': 'Add planner' }}
 </button>
 </form>
 </section>

 <section>
 <h3>Add</h3>
 <ul class="chips">
 <li v-for="persona in available":key="persona.id">
 <span:class="{ planner: persona.harnessPlanner }">{{ persona.name }}</span>
 <button type="button" class="link" @click="addMember(persona.id)">add</button>
 </li>
 <li v-if="available.length === 0" class="none">Every persona is on this team.</li>
 </ul>
 </section>

 <!--
 The panel the roadmap calls this canvas's highest-value job: every reason at once,
 each with what to change, instead of one runtime error at a time.
 -->
 <section v-if="selectedEdge" class="inspector">
 <h3>
 {{ personaById(selectedEdge.source)?.name }} →
 {{ personaById(selectedEdge.target)?.name }}
 </h3>
 <p v-if="selectedEdge.ok" class="ok">
 This planner may delegate to this worker.
 </p>
 <ul v-else class="refusals">
 <li v-for="refusal in selectedEdge.refusals":key="refusal.rule">
 <strong>{{ refusal.rule }}</strong>
 <span>{{ refusal.detail }}</span>
 <em>{{ refusal.fix }}</em>
 </li>
 </ul>
 </section>

 <section v-if="pending" class="pending" role="alert">
 <template v-if="pending.verdict.kind === 'widen'">
 <p>{{ pending.verdict.detail }}</p>
 <p class="fine">
 This edits the planner's own markdown through the same call the persona
 editor uses. It widens what the planner may hand down; it does not change
 what {{ pending.targetName }} is.
 </p>
 <div class="actions">
 <button type="button":disabled="props.busy" @click="applyWidening">
 Widen the envelope
 </button>
 <button type="button" class="link" @click="pending = null">Cancel</button>
 </div>
 </template>
 <template v-else-if="pending.verdict.kind === 'not-a-planner'">
 <p>{{ pending.verdict.detail }}</p>
 <button type="button" class="link" @click="pending = null">Dismiss</button>
 </template>
 <template v-else-if="pending.verdict.kind === 'refused'">
 <p>
 This edge cannot be drawn, because granting it would change what
 {{ pending.targetName }} is rather than what this planner may hand down:
 </p>
 <ul class="refusals">
 <li v-for="refusal in pending.verdict.refusals":key="refusal.rule">
 <strong>{{ refusal.rule }}</strong>
 <span>{{ refusal.detail }}</span>
 <em>{{ refusal.fix }}</em>
 </li>
 </ul>
 <button type="button" class="link" @click="pending = null">Dismiss</button>
 </template>
 <template v-else>
 <p>They are already connected.</p>
 <button type="button" class="link" @click="pending = null">Dismiss</button>
 </template>
 </section>
 </aside>
 </div>
 </div>
 </div>
</template>

<style scoped>
/* Vue Flow's own stylesheet is imported globally in main.ts — see the note there. */
.scrim {
 position: fixed;
 inset: 0;
 z-index: 50;
 display: flex;
 align-items: center;
 justify-content: center;
 padding: 2rem;
 background: rgb(0 0 0 / 45%);
}

.sheet {
 display: flex;
 flex-direction: column;
 width: min(1200px, 100%);
 height: min(800px, 100%);
 border: 1px solid var(--border);
 border-radius: 0.6rem;
 background: var(--bg);
 overflow: hidden;
}

header {
 display: flex;
 align-items: center;
 flex-wrap: wrap;
 gap: 0.5rem 0.75rem;
 padding: 0.6rem 0.8rem;
 border-bottom: 1px solid var(--border);
}

header select {
 /*
 * Bounded on both sides. A bare `<select>` in a flex row sizes from its widest
 * option and does not shrink below it, which squeezed every sibling — the hint
 * wrapped to one word per line and the header grew taller than the canvas.
 */
 flex: 0 1 14rem;
 min-width: 6rem;
 max-width: 14rem;
 font: inherit;
 font-size: 0.8rem;
 padding: 0.25rem 0.4rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text);
}

h2 {
 margin: 0;
 font-size: 0.95rem;
}

h3 {
 margin: 0 0 0.35rem;
 font-size: 0.78rem;
 color: var(--text-muted);
}

.hint {
 /* Basis, not `flex: 1`: with a zero basis it was the first thing to be squeezed. */
 flex: 1 1 14rem;
 min-width: 0;
 font-size: 0.72rem;
 color: var(--text-faint);
}

header h2 {
 flex: 0 0 auto;
 white-space: nowrap;
}

.close {
 flex: 0 0 auto;
 margin-left: auto;
 font-size: 1rem;
 line-height: 1;
 padding: 0.1rem 0.3rem;
}

.close {
 border: 0;
 background: none;
 color: var(--text-muted);
 font: inherit;
 cursor: pointer;
}

.body {
 flex: 1;
 min-height: 0;
 display: grid;
 grid-template-columns: minmax(0, 1fr) 20rem;
}

.canvas {
 min-width: 0;
 min-height: 0;
 border-right: 1px solid var(--border);
 /* A column, so the recursion legend can sit *under* the canvas rather than beside it.
 It was a row — flex's default — which made the legend a sibling column that took
 width from the graph and printed itself across the top of it. */
 display: flex;
 flex-direction: column;
}

.canvas-empty {
 margin: auto;
 max-width: 26rem;
 padding: 1.5rem;
 text-align: center;
 font-size: 0.8rem;
 line-height: 1.6;
 color: var(--text-faint);
}

.canvas-empty strong {
 display: block;
 margin-bottom: 0.35rem;
 color: var(--text-muted);
}

/*
 * Vue Flow measures its own container; without a definite height here the pane
 * computes to zero and nothing renders, however many nodes it was given.
 */
.canvas:deep(.vue-flow) {
 width: 100%;
 /* `flex: 1` rather than `height: 100%`: in a column the graph takes what the legend
 under it does not, and `min-height: 0` is what lets it shrink instead of overflowing. */
 flex: 1 1 auto;
 min-height: 0;
}

/*
 * Vue Flow's default edge label is black on white, which on a refused edge put an
 * unreadable chip in the middle of the one thing the edge is trying to say.
 */
.canvas:deep(.vue-flow__edge-textbg) {
 fill: var(--bg);
}

/*
 * Labels were red because until the canvas design a label only ever appeared on a *refused* edge, so
 * the colour and the meaning happened to coincide. A review edge is labelled always and is
 * not a problem, and painting its label in the danger colour made a healthy expectation
 * read as an error. The refused case keeps red; everything else takes the edge's own
 * colour.
 */
.canvas:deep(.vue-flow__edge-text) {
 fill: var(--text-muted);
 font-size: 10px;
}

.canvas:deep(.delegates.refused.vue-flow__edge-text) {
 fill: var(--danger, #b42318);
}

.canvas:deep(.reviews.vue-flow__edge-text) {
 fill: var(--ok);
}

.canvas:deep(.persona-node) {
 border: 1px solid var(--border);
 border-radius: 0.4rem;
 background: var(--bg-raised, var(--bg));
 color: var(--text);
 font-size: 0.8rem;
 padding: 0.4rem 0.7rem;
}

.canvas:deep(.persona-node.recurses) {
 /* A double border rather than another colour: the node is already coloured by whether
 it is a planner, and recursion is a second, independent fact about it. */
 border-style: double;
 border-width: 3px;
}

.canvas:deep(.persona-node.planner) {
 border-color: var(--accent);
 font-weight: 600;
}

.side {
 overflow-y: auto;
 padding: 0.7rem;
 display: flex;
 flex-direction: column;
 gap: 0.9rem;
}

.chips {
 margin: 0;
 padding: 0;
 list-style: none;
 display: flex;
 flex-direction: column;
 gap: 0.25rem;
}

.chips li {
 display: flex;
 align-items: center;
 justify-content: space-between;
 gap: 0.5rem;
 font-size: 0.8rem;
}

.chips.planner {
 color: var(--accent);
 font-weight: 600;
}

.none {
 color: var(--text-faint);
 font-size: 0.75rem;
}

.new-team {
 display: flex;
 align-items: flex-end;
 flex-wrap: wrap;
 gap: 0.6rem;
 padding: 0.7rem 0.8rem;
 border-bottom: 1px solid var(--border);
}

.new-team label {
 display: flex;
 flex-direction: column;
 gap: 0.2rem;
 font-size: 0.75rem;
 color: var(--text-muted);
}

.new-team input {
 font: inherit;
 font-size: 0.8rem;
 padding: 0.3rem 0.4rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text);
}

.new-team button:not(.link) {
 padding: 0.3rem 0.6rem;
 border: 0;
 border-radius: 0.35rem;
 background: var(--accent);
 color: var(--accent-contrast);
 font: inherit;
 font-weight: 600;
 cursor: pointer;
}

.new-team.fine {
 flex-basis: 100%;
 margin: 0;
}

.refusals {
 margin: 0;
 padding: 0;
 list-style: none;
 display: flex;
 flex-direction: column;
 gap: 0.5rem;
}

.refusals li {
 display: flex;
 flex-direction: column;
 gap: 0.15rem;
 font-size: 0.75rem;
 padding: 0.4rem 0.5rem;
 border: 1px solid var(--border);
 border-radius: 0.35rem;
}

.refusals strong {
 font-family: ui-monospace, monospace;
 font-size: 0.7rem;
 color: var(--danger, #b42318);
}

.refusals em {
 color: var(--text-muted);
 font-style: normal;
}

.ok {
 font-size: 0.78rem;
 color: var(--accent);
}

.pending {
 padding: 0.55rem 0.6rem;
 border: 1px solid var(--accent);
 border-radius: 0.4rem;
 font-size: 0.78rem;
 display: flex;
 flex-direction: column;
 gap: 0.4rem;
}

.fine {
 color: var(--text-faint);
 font-size: 0.72rem;
}

/* Narrow on purpose: it holds at most two digits, and a full-width field beside a name
 reads as the more important of the two. */
.new-planner {
 display: flex;
 gap: 0.4rem;
 margin-top: 0.4rem;
}

.new-planner button {
 flex: 0 0 auto;
 white-space: nowrap;
}

.new-planner input {
 flex: 1 1 auto;
 min-width: 0;
 padding: 0.25rem 0.4rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
 font-size: 0.75rem;
}

.reviewer {
 padding: 0.1rem 0.2rem;
 border: 1px solid var(--border);
 border-radius: 0.25rem;
 background: var(--bg);
 color: var(--text-muted);
 font: inherit;
 font-size: 0.7rem;
 max-width: 9rem;
}

.fleet {
 width: 3.2rem;
 padding: 0.1rem 0.25rem;
 border: 1px solid var(--border);
 border-radius: 0.25rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
 font-size: 0.72rem;
}

/* Under the canvas rather than floating over it: the canvas is the thing being read, and
 a legend that covers a node is worse than one a reader has to glance down for. */
.recursion-note {
 flex: 0 0 auto;
 margin: 0;
 padding: 0.45rem 0.7rem;
 border-top: 1px solid var(--border);
 line-height: 1.5;
}

.actions {
 display: flex;
 align-items: center;
 gap: 0.6rem;
}

.actions button:not(.link) {
 padding: 0.3rem 0.6rem;
 border: 0;
 border-radius: 0.35rem;
 background: var(--accent);
 color: var(--accent-contrast);
 font: inherit;
 font-weight: 600;
 cursor: pointer;
}

.link {
 border: 0;
 padding: 0;
 background: none;
 color: var(--accent);
 font: inherit;
 font-size: 0.78rem;
 cursor: pointer;
}

button:disabled {
 opacity: 0.45;
 cursor: not-allowed;
}
</style>
