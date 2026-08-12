import type { AgentPersona, DelegationEdge, DelegationRefusal } from '@loom/api-contract'
import { personaFormFromPersona, personaFormToMarkdown } from './persona-form.js'

/**
 * The canvas-based team composition. The parts that are decisions rather than rendering live here, so a
 * TUI could compose a team without reimplementing what an edge means.
 *
 * **Two canvases, not one.** The observability graph draws runs, and its positions are
 * computed from a tree's depth ordering — facts, worth nothing to persist. This one
 * draws *personas*, and its positions are choices a human made about how their team is
 * arranged, which is why `persona_group.layout` exists.
 *
 * **An edge is a fact about two personas, not a line someone drew.** the first
 * caution — "it must not be able to draw what the runtime cannot execute" — is kept
 * literally: every edge on the canvas is `personaGroup.delegationMatrix`'s answer,
 * computed by the same rules that refuse a child start. Connecting two nodes does not
 * create an edge; it asks for one, and the only request the composer can grant is
 * widening the planner's own envelope, which is what drawing a planner→worker line
 * means. Everything else is refused *with its reason*, which is the second caution:
 * "three separate correct refusals currently combine to make the shipped personas
 * undelegatable, and a human discovers that one runtime error at a time."
 */

export interface ComposerNode {
 readonly personaId: string
 readonly name: string
 readonly model: string
 readonly tools: readonly string[]
 readonly planner: boolean
 readonly position: { x: number; y: number }
 /**
 * Whether this persona may delegate to **another run of itself** — the * recursion, and the only way depth happens.
 *
 * It lives on the node rather than as a drawn edge, and that is a rendering choice
 * about one fact rather than two facts: a self-loop between one node's own handles is
 * a line hidden behind the box it starts and ends on, so drawing it as an edge is
 * indistinguishable from dropping it. The complaint is not that a curve is
 * missing, it is that "hiding it makes the own shape invisible on the surface
 * built to show shape" — a mark on the planner answers that, and the edge list cannot.
 */
 readonly recurses: boolean
 /** Why it may not, when it may not — the same refusal text an ordinary edge carries. */
 readonly recursionSummary: string
}

export interface ComposerEdge {
 readonly id: string
 readonly source: string
 readonly target: string
 readonly ok: boolean
 readonly refusals: readonly DelegationRefusal[]
 /** The one-line reason, for a label — the full list is the inspector's job. */
 readonly summary: string
}

const COLUMN = 260
const ROW = 150
const PER_ROW = 4

/**
 * Where a member with no stored position goes.
 *
 * Planners first and on their own row, because the thing a human is looking for on
 * this canvas is which workers hang off which planner — a grid that interleaves them
 * makes the one relationship it exists to show the hardest to see.
 */
export const layoutForGroup = (
 personas: readonly AgentPersona[],
 stored: Readonly<Record<string, { x: number; y: number }>>,
): Record<string, { x: number; y: number }> => {
 const layout: Record<string, { x: number; y: number }> = {}
 const planners = personas.filter((persona) => persona.harnessPlanner)
 const workers = personas.filter((persona) => !persona.harnessPlanner)

 const place = (list: readonly AgentPersona[], rowOffset: number) => {
 list.forEach((persona, index) => {
 const existing = stored[persona.id]
 layout[persona.id] = existing ?? {
 x: (index % PER_ROW) * COLUMN,
 y: (rowOffset + Math.floor(index / PER_ROW)) * ROW,
 }
 })
 }
 place(planners, 0)
 place(workers, Math.ceil(planners.length / PER_ROW) + 1)
 return layout
}

export const composerNodes = (
 personas: readonly AgentPersona[],
 layout: Readonly<Record<string, { x: number; y: number }>>,
 /**
 * The delegation matrix, for the self-edge each planner has in it. Optional so a
 * caller that has not got the matrix yet renders nodes rather than nothing — a node
 * without its recursion mark is incomplete, and a canvas without nodes is empty.
 */
 matrix: readonly DelegationEdge[] = [],
): ComposerNode[] =>
 personas.map((persona) => {
 const self = matrix.find(
 (edge) => edge.plannerId === persona.id && edge.workerId === persona.id,
)
 return {
 personaId: persona.id,
 name: persona.name,
 model: persona.model,
 tools: persona.tools,
 planner: persona.harnessPlanner,
 position: layout[persona.id] ?? { x: 0, y: 0 },
 // Only a planner can recurse at all, and the matrix says whether this one may:
 // its own envelope has to admit its own tools, which a narrowed envelope can fail.
 recurses: persona.harnessPlanner && self?.ok === true,
 recursionSummary:
 persona.harnessPlanner && self && !self.ok ? summarizeRefusals(self.refusals): '',
 }
 })

/** One line for an edge label; the inspector shows every refusal in full. */
export const summarizeRefusals = (refusals: readonly DelegationRefusal[]): string => {
 if (refusals.length === 0) return 'may delegate'
 if (refusals.length === 1) return refusals[0]?.rule ?? ''
 return `${refusals.length} refusals: ${refusals.map((refusal) => refusal.rule).join(', ')}`
}

/**
 * Edges between the group's own members.
 *
 * Scoped to the group deliberately. The matrix is workspace-wide because the rules
 * are, but a canvas showing every pair in the workspace would draw lines to personas
 * that are not on it.
 */
export const composerEdges = (
 personaIds: readonly string[],
 matrix: readonly DelegationEdge[],
): ComposerEdge[] => {
 const members = new Set(personaIds)
 return matrix
.filter((edge) => members.has(edge.plannerId) && members.has(edge.workerId))
 /**
 * A self-edge is not dropped as noise any more — it is **moved to the node**, as
 * `ComposerNode.recurses`. Drawn between one node's own handles it
 * would be a line behind the box, which is indistinguishable from hiding it; on the
 * node it is a mark a human can see and act on. It is still excluded here, because
 * the edge list is what the canvas draws *between* nodes.
 */
.filter((edge) => edge.plannerId !== edge.workerId)
.map((edge) => ({
 id: `${edge.plannerId}->${edge.workerId}`,
 source: edge.plannerId,
 target: edge.workerId,
 ok: edge.ok,
 refusals: edge.refusals,
 summary: summarizeRefusals(edge.refusals),
 }))
}

export type ConnectVerdict =
 | { readonly kind: 'already' }
 | { readonly kind: 'not-a-planner'; readonly detail: string }
 /** Every refusal can be fixed by widening the source planner's envelope. */
 | { readonly kind: 'widen'; readonly tools: string[]; readonly detail: string }
 /** At least one refusal is about what the *worker* is, which an edge cannot decide. */
 | { readonly kind: 'refused'; readonly refusals: readonly DelegationRefusal[] }

/**
 * What connecting two nodes can mean.
 *
 * The important case is `refused`. A composer that quietly edited a worker's model
 * tier or turned off its auto-approve because someone drew a line would be changing
 * what that worker *is* — a persona other teams also use — to satisfy a gesture. So
 * the only edit a connection may cause is widening the planner's own envelope, and
 * everything else is reported for a human to decide.
 */
export const connectVerdict = (
 source: { personaId: string; name: string; planner: boolean },
 target: { name: string },
 edge: DelegationEdge | undefined,
): ConnectVerdict => {
 if (!source.planner) {
 return {
 kind: 'not-a-planner',
 detail: `${source.name} is not a planner, so it cannot delegate. Mark it a planner and give it a delegation envelope.`,
 }
 }
 if (!edge || edge.ok) return { kind: 'already' }

 const widenable = edge.refusals.filter((refusal) => refusal.widenEnvelopeWith !== undefined)
 if (widenable.length !== edge.refusals.length) {
 return { kind: 'refused', refusals: edge.refusals }
 }

 const tools = [
...new Set(widenable.flatMap((refusal) => refusal.widenEnvelopeWith ?? [])),
 ].sort
 return {
 kind: 'widen',
 tools,
 detail: `Add ${tools.join(', ')} to ${source.name}'s delegation envelope so it may delegate to ${target.name}.`,
 }
}

/**
 * The planner's markdown with those tools added to `harness.delegates`.
 *
 * Goes through the same serializer the persona form uses, and is saved through
 * `persona.update` — the "through the same contract calls a markdown edit uses",
 * which is what keeps the canvas from being a second write path with its own rules.
 * Additive only: a connection asks for a permission and never removes one, so
 * disconnecting a line is not the same gesture in reverse and is not offered.
 */
export const withWiderEnvelope = (planner: AgentPersona, tools: readonly string[]): string => {
 const form = personaFormFromPersona(planner)
 const delegates = [...new Set([...form.delegates,...tools])]
 return personaFormToMarkdown({...form, delegates })
}
