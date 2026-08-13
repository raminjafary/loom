import type { MergeQueueEntry, SwarmBoard } from '@loom/api-contract'
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

export type SwarmEdgeKind =
 | 'delegation'
 | 'review'
 | 'reconcile'
 | 'steer'
 | 'collision'
 /**
 * One run was shown another's notes.
 *
 * The only edge here that points *backwards* in the flow of work: delegation runs
 * parent→child and a collision is mutual, but a reader learns from someone who wrote
 * earlier. Drawn reader→author, so the arrow reads "got this from".
 */
 | 'note_read'
 /**
 * A run is working with expertise its persona holds.
 *
 * The edge that joins the two surfaces live swarm observability left separate: the swarm graph is
 * run-level and a map is persona-level, so without this a human watching a swarm
 * cannot tell which of these workers actually knows the codebase.
 */
 | 'knows'
 /**
 * A run that was **deliberately denied** a map its persona holds.
 *
 * Its own kind rather than a missing edge, because the absence is the measurement. A
 * withheld run is one arm of the trial that decides whether the map is worth handing to
 * anyone, and drawing nothing there would make the platform look like it sometimes
 * forgets to fire — which is exactly how "unmeasured" reads to someone watching.
 */
 | 'withheld'
 /**
 * A run authored a decision or a blocker.
 *
 * Points run→note, which is the direction it was written in. A decision *governs* runs
 * that come after it and drawing that would be a second, guessed edge — scope is
 * The and it is not a property of the note.
 */
 | 'wrote'
 /** A run's branch to the merge-queue entry holding it. */
 | 'queue'
 /** That entry to its verification. */
 | 'verify'

/**
 * What verification did to one entry — derived from `verified` and `failureReason`,
 * because the canvas design asks for verification as "a node on that edge, not a boolean on the
 * entry".
 *
 * Every value comes from a persisted field. `skipped` and `passed` are the two halves of
 * a `merged` entry's `verified` flag, and the distinction is the one the flag exists to
 * make: "no tests vouched for this" is not "tests passed".
 */
export type SwarmVerificationState =
 /** The entry has not been attempted yet, so nothing is known. */
 | 'pending'
 | 'passed'
 /** Merged with no verification command configured for the repository. */
 | 'skipped'
 | 'failed'
 /** Would have run agent-authored code on the host with no sandbox. */
 | 'refused'

/**
 * A merge-queue entry as a node on the live graph.
 *
 * The reason for wanting this drawn rather than listed: the merge queue "is the one
 * part of the platform where *order* is the whole semantics — a list renders order badly
 * and a graph renders it naturally".
 *
 * **The stage is the persisted status and nothing more.** the canvas design describes the machine
 * as `queued → rebasing → verifying → merged`, and only two of those four are real: the
 * row carries `queued | merging | merged | failed | cancelled`, with rebase and
 * verification both happening inside `merging`. Splitting `merging` into two drawn stages
 * would be the graph asserting a transition nobody recorded — so the node shows what is
 * true and the verification node beside it carries what is known about the rest.
 */
export interface SwarmQueueNode {
 /**
 * `entry` is the queue position itself; `verification` is the command that ran against
 * the rebased branch.
 *
 * Two nodes rather than one with a flag, because the canvas design asks for exactly that:
 * "**Verification** is a node on that edge, not a boolean on the entry... its failure
 * output is the most useful thing on the screen when it fails." A boolean has nowhere
 * to put that output, which is the argument.
 */
 readonly kind: 'entry' | 'verification'
 /** Namespaced so an edge endpoint can never collide with a run id. */
 readonly id: string
 readonly entryId: string
 /** The run whose branch this holds — the other end of its `queue` edge. */
 readonly agentRunId: string
 readonly branchName: string
 readonly status: 'queued' | 'merging' | 'merged' | 'failed'
 /**
 * Place in line among the entries still waiting for this repository, 1-based, or null
 * once it is no longer waiting.
 *
 * Not `MergeQueueEntry.position`, which is a database sequence: it is the right key to
 * order by and a meaningless thing to show a human, who wants "2nd of 4" rather than
 * "4173". Computed per repository, because the queue is per repository.
 */
 readonly place: number | null
 readonly verification: SwarmVerificationState
 /**
 * The failure's own words, for a title — never re-derived prose.
 *
 * **Split between the two nodes by what caused it**, which is the whole reason there
 * are two: a conflict, a dirty target or a moved target belong to the `entry` (and to
 * the edge back to the run that must fix them), while a verification failure's output
 * belongs to the `verification` node. Putting both on one node would make "the tests
 * said this" and "git said this" the same field.
 */
 readonly detail: string | null
 readonly depth: number
 readonly order: number
}

export interface SwarmGraphNode {
 readonly card: BoardCard
 readonly activity: CardActivity
 /** Layer index: 0 is the tree root, 1 its children, and so on. */
 readonly depth: number
 /** Position within its layer, left to right. */
 readonly order: number
 /**
 * What this node *is*, as opposed to what it is to its parent.
 *
 * Depth used to answer this — layer 0 planned, everything below worked — and with
 * sub-planners it does not: a three-level tree has planners on two layers and every
 * one of them is an ordinary `delegation` child, so neither `depth` nor `relation`
 * separates them. Drawn the same, a corporation reads as a wide fan-out with extra
 * rows, which is the one thing the graph exists to make legible.
 */
 readonly role: 'planner' | 'worker'
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

/**
 * A map a run's persona holds for the repository that run is against.
 *
 * Its own array rather than a `SwarmGraphNode`, for the same reason the queue band is:
 * a map is not a run — it has no status, no cost, no activity and no context pressure —
 * and a union would make every reader narrow before it could draw.
 */
export interface SwarmKnowledgeNode {
 readonly mapId: string
 readonly subjectRef: string
 readonly subjectKind: string
 readonly personaName: string
 /** Runs on this board carrying it, so a renderer can place it near them. */
 readonly runIds: string[]
 /**
 * What the platform is doing with this map. A band that said
 * "expertise in play" while the map was being withheld would be the graph claiming an
 * expertise nobody is carrying.
 */
 readonly retrievalState: 'trial' | 'on' | 'off'
 /** Runs here that were actually handed it — the strong reading of "adopted". */
 readonly readByRunIds: string[]
 readonly order: number
}

/**
 * A decision or a blocker, as a node.
 *
 * Live swarm observability names this gap outright, and the reason it is worth closing is the * split-brain: "decisions are a standing record, not a note among notes". A count on a
 * card says a swarm has been writing; a node says *what was decided*, beside the run that
 * decided it, at a glance.
 *
 * `title` is model-authored in the general case. It is text and must be rendered as text.
 */
export interface SwarmNoteNode {
 readonly noteId: string
 readonly agentRunId: string
 readonly kind: 'decision' | 'blocker'
 readonly title: string
 readonly authorKind: string
 readonly order: number
}

export interface SwarmGraph {
 readonly nodes: SwarmGraphNode[]
 /**
 * The merge-queue band, in its own array rather than mixed into
 * `nodes`.
 *
 * A queue entry is not a run: it has no persona, no cost, no context pressure and no
 * activity, and half of `BoardCard` would be null on it. A union type would make every
 * reader narrow before it could draw, to describe two things that are laid out in
 * separate bands anyway.
 */
 readonly queue: SwarmQueueNode[]
 /** Expertise in play on this tree — empty when nothing has been mastered. */
 readonly knowledge: SwarmKnowledgeNode[]
 /** Decisions and blockers, in their own band like the queue's. */
 readonly notes: SwarmNoteNode[]
 /** How many exist beyond the ones drawn, so a truncated set never reads as the whole. */
 readonly elidedNotes: number
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
 * `relation` describes what a child *is* to its parent, and the four are genuinely
 * different edges: a reconciler is not a worker the planner asked for, a
 * reviewer's finding can gate a branch, and a steering run is a human's
 * re-planning turn hanging off the Planner it re-enters rather than work that
 * Planner handed down. Drawing them identically would hide the only structural
 * distinction the data carries.
 */
const edgeKindOf = (card: BoardCard): Exclude<SwarmEdgeKind, 'collision'> => {
 if (card.relation === 'review') return 'review'
 if (card.relation === 'reconcile') return 'reconcile'
 if (card.relation === 'steer') return 'steer'
 return 'delegation'
}

/**
 * What verification is known to have done, from the entry's own persisted fields.
 *
 * `merging` is deliberately `pending` rather than `passed`: the rebase and the
 * verification both happen inside that status, so an entry that is merging has not
 * finished being verified — claiming otherwise would put a green node beside a command
 * that may still fail.
 */
const verificationOf = (entry: MergeQueueEntry): SwarmVerificationState => {
 if (entry.status === 'merged') return entry.verified ? 'passed': 'skipped'
 if (entry.status === 'failed') {
 if (entry.failureReason === 'verification_failed') return 'failed'
 if (entry.failureReason === 'verification_refused') return 'refused'
 // A conflict, a dirty target or a stale target all failed *before* verification
 // could say anything. Drawing those as a verification failure would send someone to
 // read test output that does not exist.
 return 'pending'
 }
 return 'pending'
}

export const buildSwarmGraph = (
 board: SwarmBoard | null,
 /**
 * The workspace's merge queue. Entries belonging to other trees are filtered out here
 * rather than by the caller: the graph knows which runs are on it, and a caller that
 * had to pre-filter would be a second place that decides what is in this tree.
 *
 * Required rather than defaulted, deliberately. A default of `[]` would let a caller
 * that forgot it render a graph that silently omits the whole queue — which is exactly
 * how the board came to omit every run under a sub-planner.
 */
 mergeQueue: readonly MergeQueueEntry[],
 /**
 * Maps held for the repository this tree is against, already joined to persona names
 * by the caller.
 *
 * Fetched once when the graph opens rather than carried on the board, because the
 * board is polled and expertise does not change between polls — the rule that
 * watching a swarm must not add a per-tick query.
 */
 expertise: readonly {
 mapId: string
 subjectRef: string
 subjectKind: string
 personaName: string
 retrievalState: 'trial' | 'on' | 'off'
 }[] = [],
 now: Date = new Date,
 /**
 * Which runs on this board actually read which map, and which were denied it.
 *
 * Distinct from `expertise`, which is per *persona*: holding a map and having been given
 * one are different facts, and only the second is a claim about the work in front of
 * you. Fetched in the same round as the band, so watching still costs no per-tick query.
 */
 uses: readonly { agentRunId: string; mapId: string; arm: 'retrieved' | 'withheld' }[] = [],
): SwarmGraph => {
 const cards = board?.cards ?? []
 const byId = new Map(cards.map((card) => [card.runId, card]))
 const boardNotes = board?.notes ?? []

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
 return {
 card,
 activity: describeCardActivity(card, now),
 depth,
 order,
 role: card.planner ? ('planner' as const): ('worker' as const),
 }
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

 /**
 * Note-read edges. The board reports them by run id, which is already
 * what a graph needs — unlike collisions, which arrive as titles and have to be
 * resolved back.
 *
 * An edge whose reader or author is not on this board is skipped rather than drawn to
 * a node that is not there. That happens legitimately: a run's row can be cascaded
 * away while its edges survive on a tree that is still being watched.
 */
 for (const read of board?.noteReads ?? []) {
 if (!byId.has(read.readerRunId) || !byId.has(read.authorRunId)) continue
 edges.push({
 from: read.readerRunId,
 to: read.authorRunId,
 kind: 'note_read',
 detail:
 read.readCount === 1
 ? 'read their notes'
: `read their notes ${read.readCount} times`,
 })
 }

 /**
 * The merge-queue band, one layer below the deepest run.
 *
 * Laid out left to right in queue order, which is the point of drawing it at all: work
 * flows *down* into the queue and the queue's own order runs *across*, so "this branch
 * is third in line behind that one" is a shape rather than a number in a column.
 *
 * **Cancelled entries are dropped.** A human withdrew that one, and the graph's job is
 * what is happening to these branches now; a merged entry stays, because "this landed"
 * is the outcome the whole pipeline exists to reach.
 */
 const relevant = mergeQueue
.filter((entry) => byId.has(entry.agentRunId) && entry.status !== 'cancelled')
.slice
.sort((a, b) => (a.position < b.position ? -1: a.position > b.position ? 1: 0))

 /**
 * Place in line, per repository and among the still-queued only. Computed over the
 * *whole* workspace queue rather than over `relevant`, because a branch from another
 * tree ahead of this one really is ahead of it — a "1st in line" that ignored other
 * trees would be wrong in the one case a human is waiting on.
 */
 const places = new Map<string, number>
 const seenPerRepository = new Map<string, number>
 for (const entry of mergeQueue
.filter((entry) => entry.status === 'queued')
.slice
.sort((a, b) => (a.position < b.position ? -1: a.position > b.position ? 1: 0))) {
 const place = (seenPerRepository.get(entry.repositoryId) ?? 0) + 1
 seenPerRepository.set(entry.repositoryId, place)
 places.set(entry.id, place)
 }

 const queueDepth = perLayer.size
 const queue: SwarmQueueNode[] = []

 for (const [order, entry] of relevant.entries) {
 const verification = verificationOf(entry)
 const verificationFailed = verification === 'failed' || verification === 'refused'
 const status = entry.status as SwarmQueueNode['status']
 const place = places.get(entry.id) ?? null

 queue.push({
 kind: 'entry',
 id: `merge:${entry.id}`,
 entryId: entry.id,
 agentRunId: entry.agentRunId,
 branchName: entry.branchName,
 status,
 place,
 verification,
 // Git's reasons, not the tests' — see `detail`.
 detail: verificationFailed ? null: entry.detail,
 depth: queueDepth,
 order,
 })

 /**
 * From the run to its entry, and **the conflict rides this edge** — the canvas design: the
 * conflicted paths "belong on the edge between the entry that failed and the run that
 * owns the branch", because a conflict is a fact about the pair and the run is the
 * end that has to fix it.
 */
 edges.push({
 from: entry.agentRunId,
 to: `merge:${entry.id}`,
 kind: 'queue',
 detail:
 status === 'failed' && !verificationFailed && entry.detail !== null
 ? entry.detail
: place !== null
 ? `${place} in line`
: status,
 })

 /**
 * The verification node exists only once the entry has left `queued`. Before that
 * nothing is known about it, and a row of "pending" boxes under a long queue is noise
 * standing exactly where information should be.
 */
 if (status === 'queued') continue

 queue.push({
 kind: 'verification',
 id: `verify:${entry.id}`,
 entryId: entry.id,
 agentRunId: entry.agentRunId,
 branchName: entry.branchName,
 status,
 place,
 verification,
 // The command's own output, and only when the command is what failed.
 detail: verificationFailed ? entry.detail: null,
 depth: queueDepth + 1,
 order,
 })
 edges.push({
 from: `merge:${entry.id}`,
 to: `verify:${entry.id}`,
 kind: 'verify',
 detail: verification,
 })
 }

 /**
 * Expertise in play.
 *
 * Joined by **persona name**, because a run carries a persona *snapshot* and not a
 * persona id — the same fact the fleet design records about teams. A name is the address this
 * platform already resolves everything by (`@mention`, the delegation roster, the merge
 * queue), and renaming a persona is refused outright for exactly that reason, so the
 * join is as sound here as it is there.
 *
 * A map with no run on this board is dropped rather than drawn floating: this band
 * answers "which of these workers knows the codebase", and a map nobody here holds is
 * not an answer to it.
 */
 const knowledge: SwarmKnowledgeNode[] = []
 const runsByPersona = new Map<string, string[]>
 for (const card of cards) {
 runsByPersona.set(card.personaName, [...(runsByPersona.get(card.personaName) ?? []), card.runId])
 }
 /**
 * What each run was actually given, keyed by run and map. A run with no row was never a
 * candidate — its persona holds the map but the run predates the trial, or the map was
 * off — and it gets the weaker "holds" edge rather than a claim either way.
 */
 const armByRunAndMap = new Map(uses.map((use) => [`${use.agentRunId}:${use.mapId}`, use.arm]))

 let knowledgeOrder = 0
 for (const map of expertise) {
 const runIds = runsByPersona.get(map.personaName) ?? []
 if (runIds.length === 0) continue
 const readByRunIds = runIds.filter(
 (runId) => armByRunAndMap.get(`${runId}:${map.mapId}`) === 'retrieved',
)
 knowledge.push({
 mapId: map.mapId,
 subjectRef: map.subjectRef,
 subjectKind: map.subjectKind,
 personaName: map.personaName,
 runIds,
 retrievalState: map.retrievalState,
 readByRunIds,
 order: knowledgeOrder,
 })
 knowledgeOrder += 1
 for (const runId of runIds) {
 const arm = armByRunAndMap.get(`${runId}:${map.mapId}`)
 edges.push({
 from: runId,
 to: `map:${map.mapId}`,
 kind: arm === 'withheld' ? 'withheld': 'knows',
 detail:
 arm === 'retrieved'
 ? `read ${map.subjectRef}`
: arm === 'withheld'
 ? `denied ${map.subjectRef} — this run is the baseline the map is measured against`
: `knows ${map.subjectRef}`,
 })
 }
 }

 /**
 * Decisions and blockers.
 *
 * A note whose run is not on this board is dropped rather than drawn floating, for the
 * same reason a map with nobody holding it is: this band answers "what has this swarm
 * decided", and a note nobody here wrote is not an answer to it.
 */
 const noteNodes: SwarmNoteNode[] = []
 for (const note of boardNotes) {
 if (!byId.has(note.agentRunId)) continue
 noteNodes.push({
 noteId: note.noteId,
 agentRunId: note.agentRunId,
 kind: note.kind,
 title: note.title,
 authorKind: note.authorKind,
 order: noteNodes.length,
 })
 edges.push({
 from: note.agentRunId,
 to: `note:${note.noteId}`,
 kind: 'wrote',
 detail: `${note.kind}: ${note.title}`,
 })
 }

 const queueWidth = new Set(queue.map((node) => node.order)).size
 const queueLayers = new Set(queue.map((node) => node.depth)).size

 return {
 nodes,
 queue,
 knowledge,
 notes: noteNodes,
 elidedNotes: board?.elidedNotes ?? 0,
 edges,
 width: Math.max(...[...perLayer.values], queueWidth, noteNodes.length, 0),
 depth: perLayer.size + queueLayers,
 }
}
