<script setup lang="ts">
import type { AgentPersona, DelegationEdge, PersonaGroup } from '@loom/api-contract'
import {
 composerEdges,
 connectVerdict,
 layoutForGroup,
 withWiderEnvelope,
 type ComposerEdge,
 type ConnectVerdict,
} from '@loom/client-core'
import { VueFlow, type Connection, type NodeDragEvent } from '@vue-flow/core'
import { computed, ref, watch } from 'vue'

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
 'save-group': [input: { personaGroupId: string; name: string; personaIds: string[]; layout: Record<string, { x: number; y: number }> }]
 'update-persona': [input: { personaId: string; markdownSource: string }]
}>

const selectedGroupId = ref(props.groups[0]?.id ?? '')
const creating = ref(false)
const draftName = ref('')

const createTeam = => {
 if (!draftName.value.trim) return
 emit('create-group', { name: draftName.value.trim, personaIds: [] })
 draftName.value = ''
 creating.value = false
}

/**
 * Selects a team as soon as one exists, and after one is created from here — without
 * it, creating the first team leaves the canvas looking exactly as empty as before.
 */
watch(
 => props.groups,
 (groups) => {
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

watch(
 [group, members],
 => {
 // Recomputed only for members with no stored position, so opening a group never
 // rearranges what someone put where they wanted it.
 layout.value = layoutForGroup(members.value, group.value?.layout ?? {})
 },
 { immediate: true },
)

const flowNodes = computed( =>
 members.value.map((persona) => ({
 id: persona.id,
 type: 'default' as const,
 position: layout.value[persona.id] ?? { x: 0, y: 0 },
 data: { persona },
 class: persona.harnessPlanner ? 'persona-node planner': 'persona-node',
 label: persona.name,
 })),
)

const edges = computed<ComposerEdge[]>( =>
 composerEdges(
 members.value.map((persona) => persona.id),
 props.matrix,
),
)

const flowEdges = computed( =>
 edges.value.map((edge) => ({
 id: edge.id,
 source: edge.source,
 target: edge.target,
 label: edge.ok ? '': edge.summary,
 animated: false,
 class: edge.ok ? 'delegates ok': 'delegates refused',
 style: edge.ok
 ? { stroke: 'var(--accent)', strokeWidth: 2 }
: { stroke: 'var(--danger, #b42318)', strokeWidth: 1.5, strokeDasharray: '5 4' },
 })),
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
 })
}

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
 <VueFlow
:nodes="flowNodes"
:edges="flowEdges"
:nodes-draggable="true"
:edges-updatable="false"
:fit-view-on-init="true"
:default-viewport="{ zoom: 0.9, x: 0, y: 0 }"
 @node-drag-stop="onNodeDragStop"
 @connect="onConnect"
 @edge-click="(event) => (selectedEdgeId = event.edge.id)"
 />
 </div>

 <aside class="side">
 <section>
 <h3>On this team</h3>
 <ul class="chips">
 <li v-for="persona in members":key="persona.id">
 <span:class="{ planner: persona.harnessPlanner }">{{ persona.name }}</span>
 <button type="button" class="link" @click="removeMember(persona.id)">remove</button>
 </li>
 <li v-if="members.length === 0" class="none">Nobody yet.</li>
 </ul>
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
@import '@vue-flow/core/dist/style.css';
@import '@vue-flow/core/dist/theme-default.css';

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
 gap: 0.75rem;
 padding: 0.6rem 0.8rem;
 border-bottom: 1px solid var(--border);
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
 flex: 1;
 min-width: 0;
 font-size: 0.72rem;
 color: var(--text-faint);
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
 grid-template-columns: 1fr 20rem;
}

.canvas {
 min-width: 0;
 border-right: 1px solid var(--border);
}

.canvas:deep(.persona-node) {
 border: 1px solid var(--border);
 border-radius: 0.4rem;
 background: var(--bg-raised, var(--bg));
 color: var(--text);
 font-size: 0.8rem;
 padding: 0.4rem 0.7rem;
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
