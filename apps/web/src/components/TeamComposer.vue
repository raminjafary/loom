<script setup lang="ts">
import type { AgentPersona, DelegationEdge, PersonaGroup, Repository } from '@loom/api-contract'
import { MAX_FLEET_SIZE } from '@loom/domain'
import {
 arrangeByTier,
 composerEdges,
 derivedPersonaMarkdown,
 composerNodes,
 connectVerdict,
 layoutForGroup,
 orchestrate,
 removeDelegateVerdict,
 withoutDelegate,
 withWiderEnvelope,
 type ComposerEdge,
 type ConnectVerdict,
 type RemoveEdgeVerdict,
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
 /**
 * The workspace's bound repositories, so a team can say which one its work lands in
 *.
 *
 * The fact the rest of this canvas's policy half was blocked on: verification and
 * reconciliation are fields on a *repository*, so without this the canvas had no way to
 * say whose policy it was drawing. Defaulted empty so a caller that has not read them
 * yet draws a canvas rather than nothing.
 */
 repositories?: Repository[]
 /**
 * What each member is expert in, and what the platform is doing with each map
 *. Keyed by persona id.
 *
 * Portable expertise asks this canvas to show, per member, what it knows — because a roster of
 * names with no expertise on it is what made "two security reviewers, one of which
 * learned this subsystem" impossible to see. Still not filtered to the team's
 * repository, now that a team has one: an expert is a `(persona, subject)` pair and a
 * subject is a repository, an author or a corpus, so filtering to where the work lands
 * would hide most of what portable expertise wants visible.
 */
 expertise?: readonly {
 personaId: string
 subjectRef: string
 subjectKind: string
 retrievalState: 'trial' | 'on' | 'off'
 }[]
 /**
 * How deep delegation may go in this workspace. From the session
 * rather than assumed, because it is server configuration — a canvas that hard-coded
 * it would report depths against a rule the server does not have. Defaulted only so a
 * caller that has not read the session yet draws a canvas rather than nothing.
 */
 maxDelegationDepth?: number | undefined
 busy?: boolean
}>

const maxDepth = computed( => props.maxDelegationDepth ?? 2)

const expertiseFor = (personaId: string) =>
 (props.expertise ?? []).filter((entry) => entry.personaId === personaId)

/** Short marks for the node label: `on` counts, the rest are named in the roster. */
const expertiseMark = (personaId: string): string => {
 const held = expertiseFor(personaId)
 if (held.length === 0) return ''
 const inUse = held.filter((entry) => entry.retrievalState === 'on').length
 return inUse > 0 ? `◆${inUse}`: '◇'
}

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
 /**
 * The chain of command, keyed by **worker** — the opposite key from
 * `reviewers`, because a worker reports to at most one planner. Always sent.
 */
 reportsTo: Record<string, string>
 /** The root, as the canvas's vantage. Always sent, for the same reason. */
 orchestratorId: string | null
 },
 ]
 /**
 * What the merge queue runs before it merges into this team's repository.
 *
 * The same procedure Settings uses, deliberately: the rule for this canvas is that it
 * may only draw what the runtime executes, and `verifyCommand` is a field the merge
 * queue already reads. A second store for the same policy would be a decoration that
 * agreed with the real one until it did not.
 */
 'set-verify-command': [repositoryId: string, verifyCommand: string | null]
 /**
 * Whether a reconciler may attempt a conflicted branch in this team's repository
 *.
 *
 * The third and last of this canvas's policy items, and the one that needed the
 * runtime moved before it could be drawn at all: it was an operator-wide env var, and
 * The rule is that this canvas may not draw what the runtime does not read.
 */
 'set-reconciler-enabled': [repositoryId: string, enabled: boolean]
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
/** The chain of command, keyed by worker. */
const reportsTo = ref<Record<string, string>>({})
/** The root, mirrored likewise. Empty string is "nobody has chosen". */
const orchestratorId = ref('')
/** The team repository, mirrored likewise. Empty string is "nobody has chosen". */
const repositoryId = ref('')

/**
 * The chain of command, computed from the matrix alone.
 *
 * Deliberately built from `composerNodes(members, {}, matrix)` and the delegation edges
 * *without* the review policy, rather than from the rendered `nodes` and `edges`: those
 * depend on `layout` and `reviewers`, which the watch below writes, and the layout is
 * what this decides. One direction only — depth is a fact about the personas, position is
 * a consequence of it.
 */
const orchestration = computed( =>
 orchestrate(
 composerNodes(members.value, {}, props.matrix),
 composerEdges(
 members.value.map((persona) => persona.id),
 props.matrix,
),
 orchestratorId.value,
 maxDepth.value,
),
)

watch(
 [group, members],
 => {
 orchestratorId.value = group.value?.orchestratorId ?? ''
 repositoryId.value = group.value?.repositoryId ?? ''
 // Recomputed only for members with no stored position, so opening a group never
 // rearranges what someone put where they wanted it. The tiers are what an unplaced
 // member falls into — its depth under the orchestrator, rather than a grid slot.
 layout.value = layoutForGroup(
 members.value,
 group.value?.layout ?? {},
 orchestration.value.tiers,
)
 fleet.value = {...(group.value?.fleet ?? {}) }
 reviewers.value = Object.fromEntries(
 Object.entries(group.value?.reviewers ?? {}).map(([id, list]) => [id, [...list]]),
)
 reportsTo.value = {...(group.value?.reportsTo ?? {}) }
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

/**
 * Declared above everything that reads it, not beside the inspector that owns it.
 *
 * A `computed` is lazy so a later `const` would work by accident, and a `watch` in the
 * same position would not — this repository has already lost a whole view to a watcher
 * reading a ref inside its own temporal dead zone, which `vue-tsc` and eslint both
 * accept. Ordering by first use is the cheap way not to have that argument again.
 */
const selectedEdgeId = ref('')

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
 // The seat: the orchestrator, a sub-planner under it, a worker, or a member
 // no chain from the orchestrator reaches.
 `seat-${orchestration.value.seats[node.personaId]?.role ?? 'worker'}`,
 // The two ends of whatever edge is selected. Without this the sidebar talks about
 // "this edge" while the canvas shows fifteen identical lines, which is the state
 // that made a specific message read as a general one.
 selectedEdge.value &&
 (selectedEdge.value.source === node.personaId || selectedEdge.value.target === node.personaId)
 ? 'endpoint'
: '',
 ]
.filter(Boolean)
.join(' '),
 /**
 * The width on the node, because the fleet design says a fleet *is* one node carrying a
 * number — not N copies of a persona, which would be two runs and belongs on the * board. Unsized members show nothing, so a team that never set a width looks exactly
 * as it did before this existed.
 */
 label: [
 node.name,
 fleet.value[node.personaId] ? `×${fleet.value[node.personaId]}`: '',
 // The `↻` is dropped at a depth that has no hop left for it, rather than drawn and
 // then refused — the mark is a claim about what the runtime would do.
 orchestration.value.seats[node.personaId]?.canRecurse ? '↻': '',
 orchestration.value.seats[node.personaId]?.role === 'orchestrator' ? '★ root': '',
 // The badge: a filled mark counts the subjects actually being handed to runs,
 // a hollow one says this member holds maps that nothing is currently reading.
 expertiseMark(node.personaId),
 ]
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

const selectedEdge = computed(
 => edges.value.find((edge) => edge.id === selectedEdgeId.value) ?? null,
)


const recursivePlanners = computed( =>
 // Against the seat rather than the matrix: a planner that may recurse from a root and
 // sits one hop down has no hop left, so the legend would explain a mark nothing carries.
 nodes.value.filter((node) => orchestration.value.seats[node.personaId]?.canRecurse),
)

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

/**
 * Whether anything is selected at all, so the unselected edges can be dimmed only when
 * there is something to dim. Dimming everything by default would make the ordinary
 * canvas quieter than it should be — every edge on it is a fact worth reading.
 */
const hasSelection = computed( => selectedEdge.value !== null)

const flowEdges = computed( =>
 edges.value.map((edge) => {
 const selected = edge.id === selectedEdgeId.value
 /**
 * An edge the pair allows and this arrangement does not. Drawn as its own
 * state rather than as `refused`, because the two are fixed by different things: a
 * refusal is about what these two personas are, and this is about where they sit —
 * the same pair one tier up is a legal edge.
 */
 const outOfDepth = orchestration.value.outOfDepth[edge.id]
 const base =
 edge.kind === 'reviews'
 ? // Dotted and in the "ok" colour, and deliberately not the accent: it is not a
 // permission the platform granted, it is a human's expectation, and nothing
 // refuses a branch for missing it.
 { stroke: 'var(--ok)', strokeWidth: 1.5, strokeDasharray: '2 4' }
: outOfDepth
 ? { stroke: 'var(--text-faint)', strokeWidth: 1.5, strokeDasharray: '1 5' }
: edge.ok
 ? { stroke: 'var(--accent)', strokeWidth: 2 }
: { stroke: 'var(--danger, #b42318)', strokeWidth: 1.5, strokeDasharray: '5 4' }
 return {
 id: edge.id,
 source: edge.source,
 target: edge.target,
 /**
 * A selected edge says who it joins, whatever kind it is. Otherwise a review edge
 * is labelled always and a delegation only when refused: the delegation's label is
 * a *problem*, and the review's is the whole content of the edge.
 */
 label: selected
 ? `${personaById(edge.source)?.name ?? '?'} → ${personaById(edge.target)?.name ?? '?'}`
: edge.kind === 'reviews'
 ? 'reviews'
: outOfDepth
 ? 'too deep here'
: edge.ok
 ? ''
: edge.summary,
 animated: selected,
 class: [
 edge.kind === 'reviews'
 ? 'reviews'
: outOfDepth
 ? 'delegates out-of-depth'
: edge.ok
 ? 'delegates ok'
: 'delegates refused',
 selected ? 'chosen': hasSelection.value ? 'muted': '',
 ]
.filter(Boolean)
.join(' '),
 /**
 * Thicker rather than recoloured. The colour already carries the edge's *kind*,
 * which does not stop being true because someone clicked it — repainting a refused
 * edge in the accent to show selection would trade the one thing the canvas is for
 * against a state that lasts until the next click.
 */
 style: selected
 ? {...base, strokeWidth: 4, strokeDasharray: undefined }
: hasSelection.value
 ? {...base, opacity: 0.25 }
: base,
 }
 }),
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

const personaById = (id: string) => props.personas.find((persona) => persona.id === id) ?? null

/**
 * One save path for the whole team, with only what this gesture changed passed in.
 *
 * It was five copies of the same payload, one per control, and every field added to a
 * team had to be remembered in all five — a save that forgot one would send the *stored*
 * value for it and read as a no-op rather than as a bug. The server treats an absent
 * field as "leave it alone", so the payload here is always complete: what the canvas
 * holds, overridden by what the caller just changed.
 */
const saveGroup = (
 changed: Partial<{
 personaIds: string[]
 layout: Record<string, { x: number; y: number }>
 fleet: Record<string, number>
 reviewers: Record<string, string[]>
 reportsTo: Record<string, string>
 orchestratorId: string | null
 repositoryId: string | null
 }> = {},
) => {
 const current = group.value
 if (!current) return
 emit('save-group', {
 personaGroupId: current.id,
 name: current.name,
 personaIds: current.personaIds,
 layout: layout.value,
 fleet: fleet.value,
 reviewers: reviewers.value,
 reportsTo: reportsTo.value,
 orchestratorId: orchestratorId.value === '' ? null: orchestratorId.value,
 repositoryId: repositoryId.value === '' ? null: repositoryId.value,
...changed,
 })
}

const saveLayout = => saveGroup

/**
 * Puts every member back on the row its depth gives it.
 *
 * Deliberately destructive of the stored arrangement, and offered as a button rather
 * than done on open for exactly that reason. Position is a fact a human recorded and recomputing it on every open would throw that away every time — but a
 * team whose shape has changed since is holding an arrangement that describes a team
 * that no longer exists, and the operator's report is what that looks like: a second
 * planner added to a five-member team, and a canvas with no visible hierarchy at all.
 */
const arrange = => {
 if (members.value.length === 0) return
 layout.value = arrangeByTier(members.value, orchestration.value.tiers)
 saveLayout
 void nextTick.then( => requestAnimationFrame( => fitView(FIT)))
}

/**
 * Names the member the work starts from. Empty un-chooses, which is a real state — the
 * canvas then picks by reach and says that it did, rather than pretending to a choice
 * nobody made.
 */
const setOrchestrator = (personaId: string) => {
 orchestratorId.value = personaId
 saveLayout
}

/**
 * Which repository this team's work lands in.
 *
 * A team fact rather than a member fact, which is why it sits beside the chain of command
 * and not on a node — and the reason the rest of this canvas's policy half was waiting on
 * it: verification and reconciliation belong to a repository, so until a team named one
 * there was no way to say whose policy was being shown.
 *
 * Empty un-chooses, which is a real state and the one every team starts in.
 */
const setRepository = (id: string) => {
 repositoryId.value = id
 saveGroup({ repositoryId: id === '' ? null: id })
}

/**
 * The verify command, edited where the team's repository is chosen.
 *
 * Cost nothing to add, which is why the section orders it after the repository: it is a
 * field the merge queue already reads, so this is a second surface onto one policy rather
 * than a new one. Empty clears it, and a repository with no command merges **unverified**
 * — which the queue's entries say outright rather than reporting as a pass.
 */
const editingVerify = ref(false)
const verifyDraft = ref('')

const startEditingVerify = => {
 verifyDraft.value = chosenRepository.value?.verifyCommand ?? ''
 editingVerify.value = true
}

const saveVerifyCommand = => {
 const repo = chosenRepository.value
 if (!repo) return
 const value = verifyDraft.value.trim
 emit('set-verify-command', repo.id, value.length > 0 ? value: null)
 editingVerify.value = false
}

// A repository swap must not leave the previous one's command in an open editor.
watch(repositoryId, => {
 editingVerify.value = false
})

/**
 * Whether a conflict here is handed to a reconciler before it is handed to a human
 *.
 *
 * On by default, because the parallel-branch measurement measured the cost of not having it: a third of parallel
 * branches needed roughly fifty seconds of human attention each, on conflicts requiring
 * no judgement. The safety case does not rest on the agent being right — the entry has
 * already failed and the branch is already back with its owner before a reconciler starts.
 */
const setReconciler = (enabled: boolean) => {
 const repo = chosenRepository.value
 if (!repo) return
 emit('set-reconciler-enabled', repo.id, enabled)
}

/**
 * Saved on drag *stop* rather than on every frame. A position is a fact worth
 * persisting; sixty of them per second on the way to that position are not.
 */
const onNodeDragStop = (event: NodeDragEvent) => {
 layout.value = {...layout.value, [event.node.id]: {...event.node.position } }
 saveLayout
}

const setMembers = (personaIds: string[]) => saveGroup({ personaIds })

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
 saveGroup({ fleet: next })
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
 saveGroup({ reviewers: next })
}

/**
 * Who may be named a reviewer: anyone on the team. Not filtered to read-only personas —
 * a reviewer's *persona* decides what it can do and the runtime edge gives it no path
 * ownership regardless, so narrowing the list here would be this canvas inventing a rule
 * the runtime does not have.
 */
const reviewCandidates = computed( => members.value)

/**
 * Sets which planner a member reports to.
 *
 * Empty clears it, and clearing is a real state rather than a missing value: an unassigned
 * member is offered to *every* planner's roster, which is what every team does today. So the
 * option says "anyone's" rather than "none" — "none" would read as a member nobody may
 * delegate to, which is the opposite of what it does.
 */
const setReportsTo = (workerId: string, plannerId: string) => {
 const next = {...reportsTo.value }
 if (plannerId === '') delete next[workerId]
 else next[workerId] = plannerId
 reportsTo.value = next
 saveGroup({ reportsTo: next })
}

/**
 * Who may be reported to: a planner on this team, other than the member itself.
 *
 * Narrowed here because the server refuses the rest — only a planner is given a roster, so
 * a line into a worker would be an assignment nothing ever reads. Offering it would be
 * asking for a refusal, which is the same rule the reviewer picker follows.
 */
const reportingCandidates = computed( => plannerMembers.value)

const reportsToOf = (workerId: string): string => reportsTo.value[workerId] ?? ''

const repositories = computed( => props.repositories ?? [])

const chosenRepository = computed(
 => repositories.value.find((repo) => repo.id === repositoryId.value) ?? null,
)

/**
 * Members whose other teams land somewhere else, named rather than left to be discovered.
 *
 * The launcher defaults from a *persona's* teams (`teamRepositoryFor`), because a run
 * carries a persona and not a team — so a persona on two teams that named different
 * repositories gets no default at all. That is the right refusal and an invisible one:
 * the operator sets a repository here and sees the launcher ignore it for some members.
 */
const sharedWithOtherTeams = computed( => {
 if (repositoryId.value === '') return []
 return members.value
.filter((persona) =>
 props.groups.some(
 (other) =>
 other.id !== group.value?.id &&
 other.personaIds.includes(persona.id) &&
 other.repositoryId !== null &&
 other.repositoryId !== repositoryId.value,
),
)
.map((persona) => persona.name)
})

/** Who may be the root: a planner on this team, because the chain starts with a plan. */
const plannerMembers = computed( => members.value.filter((persona) => persona.harnessPlanner))

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
 * The member a new one is modelled on. Defaults to the team's planner when it has one,
 * because a planner is the persona with the most that can be got wrong — its envelope
 * decides what its whole subtree may hold, and one authored narrower than its siblings
 * produces refusals two hops from the mistake.
 */
const deriveFromId = ref('')
const derivedName = ref('')
const derivedModel = ref('')
const creatingPlanner = ref(false)

watch(
 members,
 (list) => {
 if (list.some((persona) => persona.id === deriveFromId.value)) return
 deriveFromId.value = (list.find((persona) => persona.harnessPlanner) ?? list[0])?.id ?? ''
 },
 { immediate: true },
)

const canDerive = computed( => deriveFromId.value !== '' && derivedName.value.trim !== '')

/**
 * Creates the persona and puts it on the team in one gesture. Two steps rather than one
 * contract call because they are two facts — a persona exists in the workspace, and this
 * team uses it — and conflating them would make a persona that could not be authored
 * without joining a team.
 */
const addDerived = => {
 const template = members.value.find((persona) => persona.id === deriveFromId.value)
 const name = derivedName.value.trim
 if (!template || name === '' || creatingPlanner.value) return
 creatingPlanner.value = true
 emit('create-persona', {
 markdownSource: derivedPersonaMarkdown(template, {
 name,
 description: template.harnessPlanner
 ? `Plans and delegates one area, modelled on ${template.name}.`
: `Modelled on ${template.name}, to be given its own expertise.`,
 model: derivedModel.value.trim,
 }),
 done: (personaId) => {
 creatingPlanner.value = false
 if (personaId === null) return
 derivedName.value = ''
 derivedModel.value = ''
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

/**
 * Taking an edge off the canvas (the operator's ask: "you should be able to remove edges
 * in the design graph too").
 *
 * The two kinds are removed by genuinely different acts, because they are stored
 * differently, and pretending otherwise would be the canvas inventing a rule:
 *
 * - A **reviews** edge is stored on the group, so removing it is clearing that entry —
 * exactly what the reviewer picker already does, reached from the edge instead.
 * - A **delegates** edge is *derived* from the planner's envelope against the worker's
 * tools, so there is no row to delete. It goes only by narrowing the envelope, which
 * can take other workers with it — so the removal is proposed with its cost first and
 * never applied silently.
 */
const removal = ref<{
 verdict: RemoveEdgeVerdict
 plannerId: string
 plannerName: string
 targetName: string
} | null>(null)

/**
 * Computes the removal for one edge, optionally narrowing by a tool the human chose
 * from the offered alternatives rather than by the cheapest one.
 *
 * Recomputed from the matrix on every call rather than kept as state, because the
 * personas can change underneath an open panel — a proposal that outlived the envelope
 * it was computed against would apply a narrowing whose cost it no longer describes.
 */
const proposeRemoval = (preferTool?: string) => {
 const edge = selectedEdge.value
 if (!edge || edge.kind === 'reviews') return

 const planner = personaById(edge.source)
 const target = personaById(edge.target)
 if (!planner || !target) return

 /**
 * The other workers this planner currently delegates to — read from the matrix rather
 * than from the team roster, because the matrix is what the runtime would allow and the
 * roster is only who is on the canvas. Narrowing against the roster would report a cost
 * that does not match what actually changes.
 */
 const others = props.matrix
.filter((entry) => entry.plannerId === planner.id && entry.ok && entry.workerId !== target.id)
.flatMap((entry) => {
 const worker = personaById(entry.workerId)
 return worker ? [{ name: worker.name, tools: worker.tools }]: []
 })

 removal.value = {
 verdict: removeDelegateVerdict(
 planner,
 { name: target.name, tools: target.tools },
 others,
 preferTool,
),
 plannerId: planner.id,
 plannerName: planner.name,
 targetName: target.name,
 }
}

const requestRemoveEdge = => {
 const edge = selectedEdge.value
 if (!edge) return

 if (edge.kind === 'reviews') {
 // `source` reviews `target` — clearing is the picker's own empty state.
 setReviewer(edge.target, '')
 selectedEdgeId.value = ''
 return
 }

 proposeRemoval
}

/**
 * The side panel returns to the top when an edge is selected or a proposal opens.
 *
 * Ordering alone does not finish the fix. This column scrolls and it keeps where it was —
 * so a human who had scrolled to the roster clicked an edge and still saw nothing move,
 * which is the report that started this. Moving the panel is the only way a surface says
 * "here" to someone whose eyes are somewhere else.
 *
 * Declared below `removal` and `pending` rather than beside `selectedEdge`, for the reason
 * the inspector's own note gives: a `watch` runs its source immediately, so a `const`
 * declared later is a reference before initialization rather than a lazy read.
 */
const side = ref<HTMLElement | null>(null)
watch([selectedEdgeId, removal, pending], ([edgeId, removalOpen, pendingOpen]) => {
 if (edgeId === '' && removalOpen === null && pendingOpen === null) return
 /**
 * `scrollTop = 0`, not `scrollTo({ behavior: 'smooth' })`. The smooth form did nothing
 * at all in a real browser — checked by hand on this panel — and a fix that silently
 * no-ops is the failure being fixed. Instant is also the right answer: the panel has to
 * be showing this *now*, not arriving shortly.
 */
 void nextTick( => {
 if (side.value) side.value.scrollTop = 0
 })
})

const applyRemoval = => {
 const request = removal.value
 if (!request || request.verdict.kind === 'impossible') return
 const planner = personaById(request.plannerId)
 if (!planner) return
 emit('update-persona', {
 personaId: planner.id,
 markdownSource: withoutDelegate(planner, request.verdict.tools),
 })
 removal.value = null
 selectedEdgeId.value = ''
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
 if (removal.value) removal.value = null
 else if (pending.value) pending.value = null
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
 <!--
 The chain of command, applied to the positions. Destructive of what a
 human dragged, which is why it is a button and not something that happens on
 open — see `arrange`.
 -->
 <button
 v-if="members.length > 0"
 type="button"
 class="link"
 title="Put every member on the row its depth under the root gives it — this replaces the positions you dragged"
 @click="arrange"
 >
 Arrange
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

 <aside ref="side" class="side">
 <!--
 **What the human just acted on comes first.**

 This panel and the two proposals below it used to sit under the roster, the
 derive form and the whole Add list — several screens down a scrolling column.
 Selecting an edge appeared to do nothing, and "Remove this edge" appeared to do
 nothing twice: the proposal it opens rendered below the fold as well. Both were
 working the entire time, which is the point — an operator reported the feature as
 broken and every test passed, the same shape as the Inbox lanes that shipped
 correct and unreadable.

 The rest of this column is standing configuration and can be scrolled to. What a
 human touched a second ago cannot.
 -->
 <!--
 The panel the roadmap calls this canvas's highest-value job: every reason at once,
 each with what to change, instead of one runtime error at a time.
 -->
 <section v-if="selectedEdge" class="inspector">
 <h3>
 <span class="edge-name">
 {{ personaById(selectedEdge.source)?.name }} →
 {{ personaById(selectedEdge.target)?.name }}
 </span>
 <!--
 Which of the two kinds this is, said on the edge's own panel. They are
 stored differently and removed by genuinely different acts, so a human
 reading a message about "this edge" needs to know which one they picked.
 -->
 <em class="edge-kind">{{
 selectedEdge.kind === 'reviews' ? 'review expectation': 'delegation'
 }}</em>
 </h3>
 <p v-if="selectedEdge.kind === 'reviews'" class="ok">
 {{ personaById(selectedEdge.source)?.name }} is expected to review
 {{ personaById(selectedEdge.target)?.name }}'s work. Nothing in the runtime
 gates on it — it is this team's policy, not a permission.
 </p>
 <!--
 An edge the pair allows and the arrangement does not. Said before the
 "may delegate" line, because it is the answer that governs: the permission
 is real and there is nowhere on this team it can be used from.
 -->
 <p v-else-if="orchestration.outOfDepth[selectedEdge.id]" class="warn">
 {{ orchestration.outOfDepth[selectedEdge.id] }}
 These two personas do allow it — what refuses it is where they sit under
 {{ personaById(orchestration.orchestratorId)?.name ?? 'the root' }}. Move the
 root, or shorten the chain.
 </p>
 <p v-else-if="selectedEdge.ok" class="ok">
 This planner may delegate to this worker.
 </p>
 <ul v-else class="refusals">
 <li v-for="refusal in selectedEdge.refusals":key="refusal.rule">
 <strong>{{ refusal.rule }}</strong>
 <span>{{ refusal.detail }}</span>
 <em>{{ refusal.fix }}</em>
 </li>
 </ul>
 <!--
 Offered only for an edge that actually exists. A refused delegation is
 already not there, and "remove" on it would promise to undo something that
 never happened.
 -->
 <button
 v-if="selectedEdge.kind === 'reviews' || selectedEdge.ok"
 type="button"
 class="link danger"
:disabled="props.busy"
 @click="requestRemoveEdge"
 >
 Remove this edge
 </button>
 </section>
 <section v-if="removal" class="pending" role="alert">
 <h3 class="removal-head">
 Remove {{ removal.plannerName }} → {{ removal.targetName }}
 </h3>
 <template v-if="removal.verdict.kind === 'impossible'">
 <p>{{ removal.verdict.reason }}</p>
 <button type="button" class="link" @click="removal = null">Dismiss</button>
 </template>
 <template v-else>
 <p>
 Removing <strong>this one edge</strong> narrows
 {{ removal.plannerName }}'s envelope by
 <strong>{{ removal.verdict.tools.join(', ') }}</strong
 >, which is the only way to stop it delegating to
 {{ removal.targetName }} — a delegation edge is derived from the envelope,
 not stored as a pair.
 </p>
 <p v-if="removal.verdict.kind === 'clean'" class="fine">
 No other delegate needs that tool, so every other edge on this canvas stays
 exactly as it is.
 </p>
 <template v-else>
 <p class="fine">
 It also stops {{ removal.plannerName }} delegating to
 <strong>{{ removal.verdict.alsoLoses.join(', ') }}</strong
 >, which need the same tool. Said before it happens rather than discovered
 afterwards.
 </p>
 <!--
 The alternatives, because the automatic choice is a minimum and not the
 answer. Without them a panel naming three collateral workers reads as
 "everyone loses something", when the truth is that *this* narrowing does
 and another may not.
 -->
 <p v-if="removal.verdict.everyOptionCosts" class="fine">
 Every tool that would remove this edge is shared with someone, so there is
 no narrowing that costs nothing. The choice below is which cost to pay.
 </p>
 <ul v-if="removal.verdict.options.length > 1" class="options">
 <li v-for="option in removal.verdict.options":key="option.tool">
 <button
 type="button"
 class="link"
:disabled="removal.verdict.tools.includes(option.tool)"
 @click="proposeRemoval(option.tool)"
 >
 drop {{ option.tool }}
 </button>
 <span class="fine">{{
 option.alsoLoses.length === 0
 ? 'nothing else changes'
: `also loses ${option.alsoLoses.join(', ')}`
 }}</span>
 </li>
 </ul>
 </template>
 <div class="actions">
 <button type="button":disabled="props.busy" @click="applyRemoval">
 Narrow by {{ removal.verdict.tools.join(', ') }}
 </button>
 <button type="button" class="link" @click="removal = null">Cancel</button>
 </div>
 </template>
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
 <!--
 The design-canvas policy, and the item the other two were blocked on.
 Leads with the answer — where this team's work lands — because the sentence is
 what an operator came to read, and the picker is only how they change it.
 -->
 <section class="lands">
 <h3>Where the work lands</h3>
 <p v-if="repositoryId === ''" class="fine">
 <strong>No repository chosen.</strong> Every start from the launcher picks one
 by hand.
 </p>
 <p v-else class="fine">
 Runs of these personas start against
 <strong>{{ chosenRepository?.displayName ?? 'a repository that is gone' }}</strong
 >, on
 <code>{{ chosenRepository?.defaultBranch ?? '—' }}</code
 >. The launcher fills it in; a human can still start one somewhere else.
 </p>
 <select
 class="repo-picker"
:value="repositoryId"
 aria-label="Which repository this team's work lands in"
 @change="setRepository(($event.target as HTMLSelectElement).value)"
 >
 <option value="">no repository</option>
 <option v-for="repo in repositories":key="repo.id":value="repo.id">
 {{ repo.displayName }}
 </option>
 </select>
 <!--
 The limitation stated where the choice is made, not discovered later: a run
 carries a persona, not a team, so the launcher can only default from a
 persona's teams — and teams that disagree default to nothing.
 -->
 <p v-if="sharedWithOtherTeams.length > 0" class="fine warn shared">
 {{ sharedWithOtherTeams.join(', ') }} also sit(s) on a team that lands
 somewhere else, so the launcher fills in nothing for them.
 </p>

 <!--
 The second policy item, and the one that cost nothing once the first
 existed: `verifyCommand` is a field the merge queue already reads. Leads with
 what happens at a merge rather than with the control.
 -->
 <template v-if="chosenRepository">
 <p v-if="chosenRepository.verifyCommand === null" class="fine warn">
 Nothing is run before a merge, so branches land <strong>unverified</strong>.
 </p>
 <p v-else class="fine">
 Before a branch merges, the queue runs
 <code>{{ chosenRepository.verifyCommand }}</code> in the sandbox — and hands
 the branch back to its run if it fails.
 </p>
 <form
 v-if="editingVerify"
 class="verify-form"
 @submit.prevent="saveVerifyCommand"
 >
 <input
 v-model="verifyDraft"
 placeholder="pnpm -r test"
 aria-label="Verification command"
 />
 <button type="submit">Save</button>
 <button type="button" class="link" @click="editingVerify = false">Cancel</button>
 </form>
 <button v-else type="button" class="link" @click="startEditingVerify">
 {{ chosenRepository.verifyCommand === null ? 'Set a verify command': 'Change it' }}
 </button>
 <!--
 Verification runs with `--network none`, so on any repository whose tests
 need an install step the command can only succeed against a warmed cache
. Setting one without the other is the configuration that looks right
 and merges unverified anyway.
 -->
 <p
 v-if="chosenRepository.verifyCommand !== null && chosenRepository.installCommand === null"
 class="fine warn"
 >
 No install command, and verification runs with the network closed — if
 those tests need dependencies, warm the cache in Settings first.
 </p>

 <!--
 The third policy item. It needed the runtime moved first: this was
 an operator-wide env var, and a canvas may not draw what the runtime does
 not read. The env var is still the machine-level switch, and off there is
 off everywhere — which is why this says "may" rather than "will".
 -->
 <label class="reconciler">
 <input
 type="checkbox"
:checked="chosenRepository.reconcilerEnabled"
 @change="setReconciler(($event.target as HTMLInputElement).checked)"
 />
 <span>Let a reconciler try a conflict first</span>
 </label>
 <p class="fine">
 <template v-if="chosenRepository.reconcilerEnabled">
 A conflicted branch goes back to its run <em>and then</em> an agent
 attempts it — the merge queue still rebases and verifies whatever comes
 back.
 </template>
 <template v-else>
 A conflicted branch goes back to its run and waits for a human.
 </template>
 </p>
 </template>
 </section>

 <!--
 The chain of command. The picker is here rather than on a node because
 it is a fact about the *team* — which member the work starts from — and the
 canvas is where its consequence is read: every tier below it, and the edges
 that stop being usable at the depth they end up.
 -->
 <section v-if="plannerMembers.length > 0" class="chain">
 <h3>Chain of command</h3>
 <select
 class="root-picker"
:value="orchestration.orchestratorId"
 aria-label="Which member the work starts from"
 @change="setOrchestrator(($event.target as HTMLSelectElement).value)"
 >
 <option value="">pick by reach</option>
 <option v-for="planner in plannerMembers":key="planner.id":value="planner.id">
 {{ planner.name }} is the root
 </option>
 </select>
 <p class="fine">
 <template v-if="orchestratorId === '' && orchestration.orchestratorId !== ''">
 Nobody has chosen, so this canvas is measuring from
 <strong>{{ personaById(orchestration.orchestratorId)?.name }}</strong
 >, the planner that reaches the most members.
 </template>
 <template v-else>
 Depth is measured from here. Delegation goes
 <strong>{{ maxDepth }}</strong> level(s) deep in this workspace, so the
 root's own children are level 1 and theirs are level {{ maxDepth }}.
 </template>
 </p>
 <!--
 The claim this canvas was making falsely before there was a vantage: the
 matrix is computed from a root for *every* pair, so two planner personas
 each admit the other and both appear to own every worker.
 -->
 <p v-if="Object.keys(orchestration.outOfDepth).length > 0" class="fine warn">
 {{ Object.keys(orchestration.outOfDepth).length }} drawn edge(s) are allowed
 between those two personas and unusable where they sit — dotted and faint on
 the canvas. Click one to see why.
 </p>
 <p v-if="orchestration.unreachable.length > 0" class="fine warn">
 No chain from the root reaches
 <strong>{{
 orchestration.unreachable.map((id) => personaById(id)?.name ?? id).join(', ')
 }}</strong
 >. They are on the team and nothing the root plans can start them.
 </p>
 </section>

 <section>
 <h3>On this team</h3>
 <ul class="chips">
 <template v-for="persona in members":key="persona.id">
 <li>
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
 <!--
 The chain of command: which planner this member reports to. Offered
 on every member including a planner — a sub-planner reporting to a root is
 the shape the corporation describes and the reason this field exists at all.

 "Anyone's" rather than "none" for the empty state, because an unassigned
 member appears in *every* planner's roster. "None" would read as nobody may
 delegate to it, which is the opposite of what it does.
 -->
 <select
 v-if="reportingCandidates.filter((c) => c.id !== persona.id).length > 0"
 class="reports-to"
:value="reportsToOf(persona.id)"
:aria-label="`Which planner ${persona.name} reports to`"
 @change="setReportsTo(persona.id, ($event.target as HTMLSelectElement).value)"
 >
 <option value="">anyone's to assign</option>
 <option
 v-for="candidate in reportingCandidates.filter((c) => c.id !== persona.id)"
:key="`reports-${candidate.id}`"
:value="candidate.id"
 >
 reports to {{ candidate.name }}
 </option>
 </select>
 <button type="button" class="link" @click="removeMember(persona.id)">remove</button>
 </li>
 <!--
 What this member knows. Its own row rather than a tooltip: it is
 the difference between two members that otherwise look identical, which is
 exactly the case the operator described.
 -->
 <li
 v-for="subject in expertiseFor(persona.id)"
:key="`${persona.id}:${subject.subjectRef}`"
 class="knows"
 >
 <span class="subject">{{ subject.subjectRef }}</span>
 <span:class="['retrieval', subject.retrievalState]">{{
 subject.retrievalState === 'on'
 ? 'in use'
: subject.retrievalState === 'trial'
 ? 'on trial'
: 'withheld'
 }}</span>
 </li>
 </template>
 <li v-if="members.length === 0" class="none">Nobody yet.</li>
 </ul>
 </section>

 <!--
 The fleet design for planners, portable expertise for everyone else: a second expert in one role is
 a second *persona*, because expertise attaches to an identity and not to a slot
 on a team. Authoring it belongs here, from a member already on the roster — the
 copy inherits the tools, the envelope and the approval mode this team was
 designed against, so the only difference between the two is the one a human
 meant to introduce.
 -->
 <section v-if="members.length > 0">
 <h3>Another like one of these</h3>
 <p class="fine">
 Copies a member's model, tools and delegation envelope under a new name. Point
 it at a different subject afterwards and you have two of the same role that
 know different things — which is the only way to have that, since a map hangs
 off a persona and travels with it onto every team.
 </p>
 <form class="new-planner" @submit.prevent="addDerived">
 <select v-model="deriveFromId" aria-label="Member to copy">
 <option value="" disabled>copy…</option>
 <option v-for="persona in members":key="persona.id":value="persona.id">
 {{ persona.name }}
 </option>
 </select>
 <input
 v-model="derivedName"
 type="text"
 placeholder="e.g. security-reviewer-payments"
 aria-label="Name for the new agent"
 />
 <!--
 The other axis a human varies between two otherwise identical experts (the cost model:
 worker model choice is the cost lever). Empty keeps the template's.
 -->
 <input
 v-model="derivedModel"
 type="text"
 placeholder="model (optional)"
 aria-label="Model for the new agent"
 />
 <button type="submit":disabled="!canDerive || creatingPlanner">
 {{ creatingPlanner ? 'Creating…': 'Add' }}
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

 </aside>
 </div>
 </div>
 </div>
</template>

<style scoped>
/* The one destructive control on this canvas. Every other action here adds — a member, a
 planner, an edge, a width — and this one takes away, so it must not look like them. */
.link.danger {
 color: var(--danger);
}

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

/* The root, marked on the node that holds it. A left bar rather than another
 border colour: the border already says planner, and being the root is a second and
 independent fact about a planner. */
.canvas:deep(.persona-node.seat-orchestrator) {
 border-left: 4px solid var(--accent);
}

/* A member no chain from the root reaches. Faded rather than hidden — it is really on
 the team, and that is the problem worth seeing. */
.canvas:deep(.persona-node.seat-unreachable) {
 opacity: 0.55;
 border-style: dashed;
}

.canvas:deep(.delegates.out-of-depth.vue-flow__edge-text) {
 fill: var(--text-faint);
}

.verify-form {
 display: flex;
 gap: 0.25rem;
}

.reconciler {
 display: flex;
 align-items: center;
 gap: 0.35rem;
 font-size: 0.75rem;
}

.verify-form input {
 flex: 1;
 min-width: 0;
 padding: 0.2rem 0.3rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
 font-size: 0.75rem;
}

.root-picker,
.repo-picker {
 width: 100%;
 padding: 0.2rem 0.3rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
 font-size: 0.75rem;
}

.warn {
 color: var(--danger, #b42318);
}

.fine.warn {
 color: var(--danger, #b42318);
 opacity: 0.85;
}

.chain,
.lands {
 display: flex;
 flex-direction: column;
 gap: 0.3rem;
}

/* The two ends of the selected edge, so "this edge" on the right has a referent on the
 left. An outline rather than a border change: the border already says planner. */
.canvas:deep(.persona-node.endpoint) {
 outline: 2px solid var(--text-muted);
 outline-offset: 2px;
}

/* A selected edge's own label stays readable while the rest fade — the label is the
 name of the thing the sidebar is talking about. */
.canvas:deep(.chosen.vue-flow__edge-text) {
 fill: var(--text);
 font-weight: 600;
}

.canvas:deep(.muted.vue-flow__edge-text) {
 opacity: 0.25;
}

.edge-name {
 color: var(--text);
}

.edge-kind {
 margin-left: 0.4rem;
 font-style: normal;
 font-size: 0.68rem;
 color: var(--text-faint);
}

.removal-head {
 margin: 0;
 color: var(--text);
}

.options {
 margin: 0;
 padding: 0;
 list-style: none;
 display: flex;
 flex-direction: column;
 gap: 0.2rem;
}

.options li {
 display: flex;
 align-items: baseline;
 gap: 0.4rem;
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

/* What a member knows, indented under it: it is a fact about that row, not a
 sibling of it. */
.chips li.knows {
 padding-left: 0.9rem;
 font-size: 0.7rem;
 color: var(--text-faint);
 justify-content: flex-start;
 gap: 0.4rem;
}

.chips li.knows.retrieval {
 padding: 0 0.25rem;
 border: 1px solid currentcolor;
 border-radius: 0.7rem;
 font-size: 0.6rem;
 text-transform: uppercase;
}

.chips li.knows.retrieval.on {
 color: var(--ok);
}

.chips li.knows.retrieval.off {
 color: var(--text-faint);
}

.new-planner select {
 flex: 0 1 8rem;
 min-width: 0;
 padding: 0.25rem 0.3rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
 font-size: 0.72rem;
}

.new-planner {
 flex-wrap: wrap;
}
</style>