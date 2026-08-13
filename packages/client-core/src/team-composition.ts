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
 /**
 * `delegates` is the matrix's answer about what the runtime would allow; `reviews` is a
 * human's standing expectation from the team's policy. Nothing gates
 * on the second, so drawing them alike would have the canvas claim a rule that does not
 * exist.
 */
 readonly kind: 'delegates' | 'reviews'
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
 *
 * `tiers` is the chain of command when the canvas has one (see `orchestrate`):
 * a member's row is then the depth its runs would actually sit at, which is the
 * arrangement the tangle in a two-planner team is asking for. Without it this falls
 * back to the two-row split, which is all that can be said when nobody has picked a
 * vantage to measure depth from.
 */
export const layoutForGroup = (
 personas: readonly AgentPersona[],
 stored: Readonly<Record<string, { x: number; y: number }>>,
 tiers?: Readonly<Record<string, number>>,
): Record<string, { x: number; y: number }> => {
 const layout: Record<string, { x: number; y: number }> = {}

 if (tiers) {
 const arranged = arrangeByTier(personas, tiers)
 for (const persona of personas) {
 layout[persona.id] = stored[persona.id] ?? arranged[persona.id]!
 }
 return layout
 }

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

/**
 * Every member placed on the row its depth puts it on, centred, ignoring what is stored.
 *
 * The counterpart to dragging rather than a replacement for it: a human arranges a team
 * and that arrangement is a fact worth keeping, but a team whose shape has
 * changed — a second planner added, an envelope widened — has an arrangement describing a
 * team that no longer exists. So this is what "Arrange" applies, deliberately overwriting,
 * and everything after it is dragging again.
 */
export const arrangeByTier = (
 personas: readonly AgentPersona[],
 tiers: Readonly<Record<string, number>>,
): Record<string, { x: number; y: number }> => {
 const rows = new Map<number, AgentPersona[]>
 for (const persona of personas) {
 const tier = tiers[persona.id] ?? UNREACHABLE_TIER
 rows.set(tier, [...(rows.get(tier) ?? []), persona])
 }

 const layout: Record<string, { x: number; y: number }> = {}
 for (const [tier, members] of [...rows.entries].sort((a, b) => a[0] - b[0])) {
 members.forEach((persona, index) => {
 layout[persona.id] = {
 // Centred on the row rather than left-aligned: a root with three workers under it
 // reads as a hierarchy only if the parent sits over the middle of its children.
 x: (index - (members.length - 1) / 2) * COLUMN,
 y: tier * ROW,
 }
 })
 }
 return layout
}

/**
 * The chain of command, as the canvas can know it.
 *
 * **The problem this solves is that the matrix has no vantage point.** Every edge on
 * this canvas is `delegationMatrixForWorkspace`'s answer, and that answer is computed
 * "from a root" — the most permissive real position — because a workspace-wide matrix
 * has nowhere else to stand. That is right for a pair and wrong for an arrangement: two
 * planner personas each admit the other, so the canvas draws a line both ways and a team
 * of two planners and three workers becomes the tangle in the operator's screenshot, in
 * which nothing says which planner is the root and both appear to own every worker.
 *
 * The runtime has no such ambiguity. A run tree has a root, a child of a run at depth `d`
 * is at `d + 1` and is refused past `maxDelegationDepth`, and a planner is only *offered*
 * as a delegate while a hop remains below it — so the same pair of personas is a legal
 * edge in one arrangement and an edge no plan can use in another.
 *
 * So the canvas needs the one thing the matrix cannot supply: **which member the work
 * starts from.** Given that, every other depth follows, and the edges the runtime would
 * refuse *in that arrangement* become sayable. This is not the canvas inventing a rule —
 * it is the canvas stopping short of a claim it was making falsely, which is the caution
 * about this surface read in the only direction that matters.
 */
export type OrchestrationRole = 'orchestrator' | 'sub-planner' | 'worker' | 'unreachable'

/** The row a member with no depth is drawn on — below everything that has one. */
export const UNREACHABLE_TIER = 9

export interface OrchestrationSeat {
 /** How deep this member's runs would sit under the orchestrator; null when unreachable. */
 readonly depth: number | null
 readonly role: OrchestrationRole
 /**
 * Whether the `↻` still holds at this depth. The matrix answers it from a root,
 * and a sub-planner one hop down has no hop left to recurse into — a mark that survives
 * a move down the chain would be the node claiming a shape the runtime refuses.
 */
 readonly canRecurse: boolean
}

export interface Orchestration {
 readonly orchestratorId: string
 readonly seats: Record<string, OrchestrationSeat>
 /** Tier per persona id, for `arrangeByTier` and `layoutForGroup`. */
 readonly tiers: Record<string, number>
 /**
 * Edges the matrix allows but this arrangement does not, with the reason. Keyed by
 * `ComposerEdge.id`. An empty record is the ordinary case, and a non-empty one is the
 * canvas telling a human something they would otherwise learn from a refused subtask.
 */
 readonly outOfDepth: Record<string, string>
 /** Members no chain from the orchestrator reaches — on the team, and unusable from it. */
 readonly unreachable: string[]
}

/**
 * Which member the chain starts from, when a human has not said.
 *
 * The stored choice wins whenever it is still a planner on this team; a team whose
 * orchestrator was removed or demoted falls back rather than rendering an empty tier.
 * The fallback is **reach** — the planner from which the most members are reachable —
 * because that is what a root is for, and ties break on the name so a canvas does not
 * rearrange itself between two equally good answers.
 */
export const chooseOrchestrator = (
 nodes: readonly ComposerNode[],
 edges: readonly ComposerEdge[],
 stored: string,
 maxDepth: number,
): string => {
 const planners = nodes.filter((node) => node.planner)
 if (planners.some((node) => node.personaId === stored)) return stored
 if (planners.length === 0) return ''

 const scored = planners
.map((node) => ({
 id: node.personaId,
 name: node.name,
 reach: Object.keys(reachFrom(nodes, edges, node.personaId, maxDepth).seats).length,
 }))
.sort((a, b) => b.reach - a.reach || (a.name < b.name ? -1: 1))
 return scored[0]!.id
}

/** BFS over the ok delegation edges, applying the runtime's own two depth rules. */
const reachFrom = (
 nodes: readonly ComposerNode[],
 edges: readonly ComposerEdge[],
 orchestratorId: string,
 maxDepth: number,
): { seats: Record<string, number>; outOfDepth: Record<string, string> } => {
 const byId = new Map(nodes.map((node) => [node.personaId, node]))
 const seats: Record<string, number> = {}
 const outOfDepth: Record<string, string> = {}
 if (!byId.has(orchestratorId)) return { seats, outOfDepth }

 const delegations = edges.filter((edge) => edge.kind === 'delegates' && edge.ok)
 seats[orchestratorId] = 0
 const queue = [orchestratorId]
 while (queue.length > 0) {
 const currentId = queue.shift!
 const depth = seats[currentId]!
 for (const edge of delegations) {
 if (edge.source !== currentId) continue
 const target = byId.get(edge.target)
 if (!target) continue

 /**
 * The child-start gate: a run at `depth` starts children at `depth + 1`, refused
 * past the limit. Copied in its own terms rather than approximated — the whole
 * value of saying this on the canvas is that it is the same arithmetic.
 */
 if (depth + 1 > maxDepth) {
 outOfDepth[edge.id] =
 `${target.name} would be level ${depth + 1}, and delegation is ${maxDepth} level(s) deep at most here.`
 continue
 }
 /**
 * And the roster's: a planner is only offered while a hop remains *below* it,
 * because a sub-planner with nothing under it can only produce subtasks that are
 * refused. This is the rule that makes a two-planner team's second edge unusable
 * rather than merely deep, and it is invisible on a canvas without a vantage.
 */
 if (target.planner && maxDepth - depth - 1 < 1) {
 outOfDepth[edge.id] =
 `${target.name} is a planner, and at level ${depth + 1} nothing below it could run — ` +
 'so it is not offered in this planner\'s roster.'
 continue
 }
 // Cycles end here: a node already seated keeps its shallowest depth, which is the
 // one the runtime would give it, and is not queued twice.
 if (seats[edge.target] !== undefined) continue
 seats[edge.target] = depth + 1
 queue.push(edge.target)
 }
 }
 return { seats, outOfDepth }
}

export const orchestrate = (
 nodes: readonly ComposerNode[],
 edges: readonly ComposerEdge[],
 stored: string,
 maxDepth: number,
): Orchestration => {
 const orchestratorId = chooseOrchestrator(nodes, edges, stored, maxDepth)
 const { seats: depths, outOfDepth } = reachFrom(nodes, edges, orchestratorId, maxDepth)

 const seats: Record<string, OrchestrationSeat> = {}
 const tiers: Record<string, number> = {}
 const unreachable: string[] = []
 for (const node of nodes) {
 const depth = depths[node.personaId]
 if (depth === undefined) {
 seats[node.personaId] = { depth: null, role: 'unreachable', canRecurse: false }
 tiers[node.personaId] = UNREACHABLE_TIER
 unreachable.push(node.personaId)
 continue
 }
 const role: OrchestrationRole =
 node.personaId === orchestratorId ? 'orchestrator': node.planner ? 'sub-planner': 'worker'
 seats[node.personaId] = {
 depth,
 role,
 // Same rule as the roster's, applied to the self-edge: recursing costs a hop.
 canRecurse: node.recurses && maxDepth - depth - 1 >= 1,
 }
 tiers[node.personaId] = depth
 }

 return { orchestratorId, seats, tiers, outOfDepth, unreachable }
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
 /**
 * The team's review policy, keyed by reviewer.
 *
 * Drawn as its own edge kind rather than mixed in with delegation, because the two say
 * different things and one of them is not about permission at all: a delegation edge is
 * the matrix's answer about what the runtime *would allow*, while a review edge is a
 * human's standing expectation about what should happen. Drawn alike, a canvas would
 * claim the platform refuses an unreviewed branch, which it does not.
 */
 reviewers: Readonly<Record<string, readonly string[]>> = {},
): ComposerEdge[] => {
 const members = new Set(personaIds)
 const reviewEdges: ComposerEdge[] = []
 for (const [reviewerId, reviewedIds] of Object.entries(reviewers)) {
 if (!members.has(reviewerId)) continue
 for (const reviewedId of reviewedIds) {
 if (!members.has(reviewedId)) continue
 reviewEdges.push({
 id: `reviews:${reviewerId}->${reviewedId}`,
 source: reviewerId,
 target: reviewedId,
 kind: 'reviews',
 // Always `ok`: a review expectation cannot be refused by the runtime — nothing
 // gates on it — so drawing it as refusable would be the canvas inventing a rule.
 ok: true,
 refusals: [],
 summary: 'reviews this persona\'s work',
 })
 }
 }
 return reviewEdges.concat(
 matrix
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
 kind: 'delegates' as const,
 ok: edge.ok,
 refusals: edge.refusals,
 summary: summarizeRefusals(edge.refusals),
 })),
)
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
 * Additive only. Removing is `withoutDelegate` below, and it is deliberately a
 * different function rather than this one in reverse — see its own comment for why the
 * two are not symmetric.
 */
export const withWiderEnvelope = (planner: AgentPersona, tools: readonly string[]): string => {
 const form = personaFormFromPersona(planner)
 const delegates = [...new Set([...form.delegates,...tools])]
 return personaFormToMarkdown({...form, delegates })
}

/**
 * What removing one delegation edge would cost, and whether it can be done at all.
 *
 * **A delegation edge is not a stored pair**, and that is the whole difficulty. The
 * matrix is computed from the planner's `harness.delegates` envelope against each
 * worker's tools (the attenuation), so there is no row to delete: the only way to stop a
 * planner delegating to one worker is to narrow the envelope until that worker no longer
 * fits. Which means removing an edge can remove *others*, and a canvas that silently did
 * that would be the design surface lying about what it changed — the one thing the roadmap says it
 * must never do.
 *
 * So this computes the tools that only the removed worker needs, and reports what else
 * would go with them. Three outcomes, all of which a human should see before agreeing:
 *
 * - `clean` — those tools serve no other current delegate, so the edge goes and nothing
 * else moves.
 * - `collateral` — narrowing also drops the named workers, because they need the same
 * tools. Offered, with the list, because it is sometimes exactly what is wanted.
 * - `impossible` — the worker needs no tool the others do not also need, so no envelope
 * excludes it while including them. There is nothing to narrow, and saying "removed"
 * would be a lie the next plan would expose.
 */
/**
 * One way to narrow the envelope, and what that particular way costs.
 *
 * Every option removes the edge; they differ only in who else goes. The list is
 * returned rather than only the winner because the automatic choice is a *minimum*,
 * not the answer — a human may prefer to drop a tool that costs two teammates they
 * were going to remove anyway over one that costs one they were not. Reporting only
 * the winner also produced the complaint this list answers: a panel that names three
 * collateral workers with no way to see the alternatives reads as "everyone loses
 * something", when the truth is "this narrowing does, and there are two others".
 */
export interface RemoveEdgeOption {
 readonly tool: string
 readonly alsoLoses: string[]
}

export type RemoveEdgeVerdict =
 | { readonly kind: 'clean'; readonly tools: string[]; readonly options: RemoveEdgeOption[] }
 | {
 readonly kind: 'collateral'
 readonly tools: string[]
 readonly alsoLoses: string[]
 readonly options: RemoveEdgeOption[]
 /**
 * Whether *no* narrowing spares anyone — the case that reads as "all the workers
 * lose something", and the only case where saying so is true. Distinguished from
 * ordinary collateral because the two call for different decisions: one is a
 * trade between options, the other is a choice between this edge and the team.
 */
 readonly everyOptionCosts: boolean
 }
 | { readonly kind: 'impossible'; readonly reason: string }

export const removeDelegateVerdict = (
 planner: AgentPersona,
 remove: { name: string; tools: readonly string[] },
 /** The other workers this planner currently delegates to, with their tools. */
 others: readonly { name: string; tools: readonly string[] }[],
 /**
 * Which tool to narrow by, when a human picked one from `options` rather than taking
 * the cheapest. Ignored when the envelope does not grant it — an option that is not on
 * the list cannot become the answer by being asked for.
 */
 preferTool?: string,
): RemoveEdgeVerdict => {
 const envelope = new Set(personaFormFromPersona(planner).delegates)
 // Only tools the envelope actually grants are candidates: narrowing cannot remove
 // what was never there, and listing them would overstate what the change does.
 const needed = [...new Set(remove.tools)].filter((tool) => envelope.has(tool))
 if (needed.length === 0) {
 return {
 kind: 'impossible',
 reason: `${remove.name} needs no tool this planner's envelope grants, so narrowing it changes nothing.`,
 }
 }

 /**
 * **One tool at a time, choosing the least damaging.**
 *
 * The first version of this compared the removed worker's tools against the union of
 * every other worker's, and concluded "impossible" whenever no tool was exclusive to
 * it — which is wrong, and a test caught it. Dropping *any* one tool the worker needs
 * removes it; the question is only which tool costs the least, since each one also
 * takes every other worker that needs it. So the choice is a minimum, not an
 * intersection, and "impossible" survives only for the case where there is nothing to
 * drop at all.
 */
 const options: RemoveEdgeOption[] = needed
.map((tool) => ({
 tool,
 alsoLoses: others.filter((worker) => worker.tools.includes(tool)).map((w) => w.name),
 }))
.sort((a, b) => a.alsoLoses.length - b.alsoLoses.length || (a.tool < b.tool ? -1: 1))

 const chosen = options.find((option) => option.tool === preferTool) ?? options[0]!
 return chosen.alsoLoses.length === 0
 ? { kind: 'clean', tools: [chosen.tool], options }
: {
 kind: 'collateral',
 tools: [chosen.tool],
 alsoLoses: chosen.alsoLoses,
 options,
 everyOptionCosts: options.every((option) => option.alsoLoses.length > 0),
 }
}

/** The planner's markdown with those tools removed from `harness.delegates`. */
export const withoutDelegate = (planner: AgentPersona, tools: readonly string[]): string => {
 const form = personaFormFromPersona(planner)
 const drop = new Set(tools)
 return personaFormToMarkdown({
...form,
 delegates: form.delegates.filter((tool) => !drop.has(tool)),
 })
}

/**
 * A second planner persona, authored from the canvas.
 *
 * The fleet design is explicit that "the answer to 'how do I put several planners on a team' is
 * not a fleet count — it is several planner **personas**, one per area", and that "the
 * canvas should make authoring the second one a first-class act rather than a trip to
 * Settings."
 *
 * **Modelled on an existing planner rather than on a blank form**, and that is the whole
 * value of doing it here: a planner is the persona with the most that can be got wrong —
 * the envelope decides what its whole subtree may hold, and a planner authored with a
 * narrower one than its siblings produces refusals two hops away from the mistake. Copying
 * the team's existing planner means the second area starts able to do what the first can.
 *
 * The name is the only thing a human must supply, because it is the only thing that must
 * be unique and the only thing the model will be told to use. Everything else is a copy,
 * and every part of it stays editable through the ordinary persona form afterwards — this
 * writes markdown through the same serializer that form does, so there is one write path
 * (the product shape: "through the same contract calls a markdown edit uses").
 */
export const plannerLikeMarkdown = (
 template: AgentPersona,
 input: { name: string; description: string },
): string => derivedPersonaMarkdown(template, {...input, planner: true })

/**
 * A second persona derived from any member of the team — the generalization of the
 * planner case above, and the operator's ask: *"two security reviewers, one of which
 * adopted the expertise of a specific report or concept."*
 *
 * **The answer to "one role, two experts" is two personas, and that is not a workaround.**
 * Portable expertise is explicit that expertise attaches to the *persona*, and that the instinct to
 * add a `team_expertise` join table is the bug — it would make the same expert on two
 * teams two different experts, the second starting from zero. The same reasoning applies
 * one level down: expertise scoped to a *slot on a team* rather than to an identity would
 * mean the security reviewer that learned the payments subsystem forgets it the moment
 * someone puts it on another team. So the second expert is a second persona that carries
 * its own maps everywhere it goes, exactly as the answer to "several planners" is
 * several planner personas.
 *
 * What makes that cheap enough to be the answer is doing it *here*, on the canvas, from a
 * member already on the team: the copy inherits the tools, the envelope and the approval
 * mode that the rest of the team was designed against, so the only difference between the
 * two experts is the one a human meant to introduce — what each of them knows, and
 * optionally what it costs to run.
 *
 * `model` is offered because it is the other axis a human wants to vary between two
 * otherwise identical experts (the cost model: worker model choice is the 8x cost lever), and because
 * a derived reviewer on a cheaper tier is the ordinary case rather than an exotic one.
 * Everything else stays editable through the persona form afterwards — this writes
 * markdown through the same serializer that form does, so there is one write path.
 */
export const derivedPersonaMarkdown = (
 template: AgentPersona,
 input: {
 name: string
 description: string
 /** Overridden only when asked; otherwise the copy runs on what the template runs on. */
 model?: string
 /**
 * Forced only by the planner case, which offers this beside a planner. Left alone
 * otherwise: a copy of a worker is a worker, and a copy that claimed to be a planner
 * would be refused by the server for holding acting tools — a confusing way to
 * learn the template was wrong.
 */
 planner?: boolean
 },
): string => {
 const form = personaFormFromPersona(template)
 return personaFormToMarkdown({
...form,
 name: input.name,
 description: input.description,
...(input.model === undefined || input.model === '' ? {}: { model: input.model }),
...(input.planner === undefined ? {}: { planner: input.planner }),
 })
}
