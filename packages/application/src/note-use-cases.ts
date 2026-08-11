import {
 ForbiddenError,
 MAX_NOTES_PER_RUN,
 NotFoundError,
 ValidationError,
 isHuman,
 parseNoteInput,
 pathsOverlap,
 renderNotesForPrompt,
 selectNotesForContext,
 summarizeElidedNotes,
 type Actor,
 type AgentRun,
 type AgentRunId,
 type PlatformNoteKind,
 type WorkerNote,
 type WorkspaceId,
} from '@loom/domain'
import type {
 AgentRunCostRollup,
 AgentRunRepositoryPort,
 WorkerNoteRepositoryPort,
} from './agent-ports.js'

/**
 * The worker-notes ledger's use cases — and, since "the ledger
 * and the kanban are one object", the board's read model too.
 *
 * Split out of agent-use-cases.ts rather than added to it because these are the
 * *only* callers that may write a note, and keeping the write paths in one small
 * file is what makes "agent-authored notes are data, never instructions" auditable:
 * `recordAgentNote` is the one function that accepts model-authored text, and
 * everything else here is either a platform fact or a human's.
 */

export interface NoteDeps {
 readonly workerNotes: WorkerNoteRepositoryPort
 readonly agentRuns: AgentRunRepositoryPort
}

/**
 * How deep a parent chain this will walk looking for a tree root.
 *
 * The data model lets a run spawn children of itself, so a chain is possible in principle even
 * though the Planner produces exactly two levels today. A bound rather than a
 * `while (true)`: this runs on every note write and every run start, and a cycle
 * introduced by a future migration or a bad backfill would otherwise hang the
 * request rather than degrade it.
 */
const MAX_TREE_DEPTH = 16

/**
 * The root of the tree a run belongs to — a Planner, or a parentless run being its
 * own root.
 *
 * This is what notes are keyed by (the worker-notes design: "keyed by **tree** … so a swarm
 * shares context while two unrelated goals do not pollute each other"), so getting
 * it wrong does not fail loudly — it silently either splits one swarm's ledger or
 * merges two goals'. Hence walking to the actual root rather than using
 * `parentRunId ?? id`, which would be correct only while trees are exactly two
 * levels deep.
 */
export const resolveTreeRunId = async (
 deps: NoteDeps,
 run: AgentRun,
): Promise<AgentRunId> => {
 let current = run
 for (let depth = 0; depth < MAX_TREE_DEPTH; depth += 1) {
 if (!current.parentRunId) return current.id
 const parent = await deps.agentRuns.findById(current.workspaceId, current.parentRunId)
 // A missing parent means the row was cascaded away underneath us. The deepest
 // ancestor still readable is the best available root, and it is stable — every
 // sibling resolves to the same one.
 if (!parent) return current.id
 current = parent
 }
 return current.id
}

/**
 * Records a note an agent run wrote, called by
 * runner-gateway.ts on each `note_written` frame — one frame per note, as the run
 * writes it.
 *
 * **Incremental by construction, and that is the requirement.** the worker-notes design: "A run
 * that is killed, reaped, budget-capped or crashed never reaches a stop handler.
 * This codebase has already paid for that lesson twice." So there is deliberately no
 * batch variant of this function and no flush-at-stop path — a note that reached
 * here is durable, and a run that dies loses only the note it was mid-way through
 * writing.
 *
 * The text is a model's, so nothing here treats it as an instruction: it is stored
 * as data, rendered inside `renderNotesForPrompt`'s untrusted fence, and shown to a
 * human as agent-authored. This function's own validation is about *shape and
 * volume*, never about content — see `parseNoteInput`.
 */
export const recordAgentNote = async (
 deps: NoteDeps,
 input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 note: unknown
 },
): Promise<{ ok: true; note: WorkerNote } | { ok: false; reason: string }> => {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')

 const verdict = parseNoteInput(input.note)
 // Returned rather than thrown: the Runner relays this back to the model as the
 // tool's result, so a malformed note is a retry the writer can see and fix —
 // the same reasoning as the Planner's decomposition tool.
 if (!verdict.ok) return { ok: false, reason: verdict.reason }

 // The per-run cap. Enforced
 // here rather than only at render time because the unbounded thing to protect is
 // the *table* — a looping agent that writes forever costs every sibling's context
 // window and every reader's query, not just its own prompt.
 const written = await deps.workerNotes.countByRun(input.workspaceId, input.agentRunId)
 if (written >= MAX_NOTES_PER_RUN) {
 return {
 ok: false,
 reason: `This run has already written its maximum of ${MAX_NOTES_PER_RUN} notes. Summarize what matters into the notes you have already written instead.`,
 }
 }

 const note = await deps.workerNotes.append({
 workspaceId: input.workspaceId,
 treeRunId: await resolveTreeRunId(deps, run),
 agentRunId: run.id,
 authorKind: 'agent_run',
 kind: verdict.kind,
 title: verdict.title,
 body: verdict.body,
 paths: verdict.paths,
 })

 return { ok: true, note }
}

/**
 * A structural fact the platform observed first-hand.
 *
 * These are the trusted half of the ledger, and they are trusted for exactly one
 * reason: no model produced them. Callers must keep it that way — passing a model's
 * text through here would launder untrusted prose into the trusted section, which is
 * the one way to defeat `renderNotesForPrompt`.
 */
export const recordPlatformNote = async (
 deps: NoteDeps,
 input: {
 run: AgentRun
 kind: PlatformNoteKind
 title: string
 body: string
 paths?: readonly string[]
 /** Overrides the tree root when the caller already knows it — saves a walk per sibling. */
 treeRunId?: AgentRunId
 },
): Promise<void> => {
 await deps.workerNotes.append({
 workspaceId: input.run.workspaceId,
 treeRunId: input.treeRunId ?? (await resolveTreeRunId(deps, input.run)),
 agentRunId: input.run.id,
 authorKind: 'platform',
 kind: input.kind,
 title: input.title,
 body: input.body,
 paths: [...(input.paths ?? [])],
 })
}

/**
 * A human's note on a tree — the authoritative kind.
 *
 * The worker-notes design makes "the persona and the human-visible plan stay authoritative over
 * what a worker does" a property of the rendering; this is how a human adds to that
 * mid-swarm without editing a persona or restarting anything. Rendered outside the
 * untrusted fence, because a human is not the threat model this fence exists for.
 */
export const writeHumanNote = async (
 deps: NoteDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 agentRunId: AgentRunId
 note: unknown
 },
): Promise<WorkerNote> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may write a human note — agents use their own tool')
 }
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')

 const verdict = parseNoteInput(input.note)
 // Thrown, not returned: this path's caller is a human at a client, and the
 // contract's error channel is what they see.
 if (!verdict.ok) throw new ValidationError(verdict.reason)

 return deps.workerNotes.append({
 workspaceId: input.workspaceId,
 treeRunId: await resolveTreeRunId(deps, run),
 // Null: a human's note is about the tree, not about any one run.
 agentRunId: null,
 authorKind: 'human',
 kind: verdict.kind,
 title: verdict.title,
 body: verdict.body,
 paths: verdict.paths,
 })
}

/** One tree's whole ledger, oldest first — what a client renders and the board groups. */
export const listTreeNotes = async (
 deps: NoteDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId },
): Promise<WorkerNote[]> => {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')
 return deps.workerNotes.listByTree(input.workspaceId, await resolveTreeRunId(deps, run))
}

/**
 * The shared context a run is handed when it starts, or asks for mid-run.
 *
 * Returns `''` for a tree with nothing in it yet, so the caller adds nothing to the
 * prompt at all rather than a header with no content under it — the first worker in
 * a swarm should not be told "here is what others did" followed by silence.
 *
 * The bounding and the untrusted-fencing both happen inside the domain
 * (`selectNotesForContext`, `renderNotesForPrompt`); this function's only job is to
 * fetch, and to append the mechanical summary of whatever the cap dropped so that
 * elided notes are accounted for rather than merely counted.
 */
export const buildContextLedger = async (
 deps: NoteDeps,
 input: { workspaceId: WorkspaceId; run: AgentRun; treeRunId?: AgentRunId },
): Promise<string> => {
 const treeRunId = input.treeRunId ?? (await resolveTreeRunId(deps, input.run))
 const all = await deps.workerNotes.listByTree(input.workspaceId, treeRunId)
 if (all.length === 0) return ''

 const { selected, elided } = selectNotesForContext(all)
 const rendered = renderNotesForPrompt(selected, elided)
 if (elided === 0) return rendered

 const selectedIds = new Set(selected.map((note) => note.id))
 const dropped = all.filter((note) => !selectedIds.has(note.id))
 return `${rendered}\n\n${summarizeElidedNotes(dropped)}`
}

/**
 * `buildContextLedger` for a caller that has a run id rather than a run — the
 * `read_notes` tool's server side.
 *
 * A missing run throws rather than returning empty: an agent asking for the ledger of
 * a run that does not exist is a bug or a forged id, and answering it with "no notes
 * yet" would hide both.
 */
export const readContextLedger = async (
 deps: NoteDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId },
): Promise<string> => {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')
 return buildContextLedger(deps, { workspaceId: input.workspaceId, run })
}

/**
 * The kanban, as a read model over the ledger and the run tree.
 *
 * **Derived, never stored** — the worker-notes design: "The ledger and the kanban are one object.
 * The Phase 2 kanban is this same data with a board rendering; building them
 * separately would produce two sources of truth for what a swarm is doing." So there
 * is no `task` table: a card *is* a run, its column is that run's status, and its
 * detail is the notes keyed to the tree.
 *
 * `ownedPaths` comes from the platform's own `path_ownership` note rather than from
 * the persona or the task text, because that note is what the Planner's
 * decomposition actually claimed — the thing a human needs to see next to "this
 * branch conflicts".
 */
export interface SwarmBoardCard {
 readonly runId: AgentRunId
 /**
 * Null for the tree's root. Present so the same payload renders as a *tree*
 * and not only as a flat board — the hierarchy is already
 * in the data, and a second endpoint to re-fetch it would be two sources of truth
 * for what a swarm's shape is, which is exactly what the worker-notes design refuses.
 */
 readonly parentRunId: AgentRunId | null
 readonly personaName: string
 readonly title: string
 readonly status: string
 readonly relation: string | null
 readonly branchName: string | null
 readonly branchDisposition: string | null
 readonly totalCostUsd: number | null
 readonly ownedPaths: string[]
 readonly noteCount: number
 /** The most recent agent- or human-authored note, for the card's subtitle. Untrusted text. */
 readonly latestNoteTitle: string | null
 readonly blockerCount: number
}

export interface SwarmBoard {
 readonly treeRunId: AgentRunId
 readonly cards: SwarmBoardCard[]
 /** Pairs of cards whose owned paths collide — the merge conflicts to expect. */
 readonly pathCollisions: { readonly titles: [string, string]; readonly paths: string[] }[]
}

export const getSwarmBoard = async (
 deps: NoteDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId },
): Promise<SwarmBoard> => {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')

 const treeRunId = await resolveTreeRunId(deps, run)
 const root = treeRunId === run.id ? run: await deps.agentRuns.findById(input.workspaceId, treeRunId)
 if (!root) throw new NotFoundError('AgentRun')

 const notes = await deps.workerNotes.listByTree(input.workspaceId, treeRunId)
 const children = await deps.agentRuns.listByParent(input.workspaceId, treeRunId)
 // The root is a card too: a Planner's own status is what a human reads first, and
 // a board that showed only workers would go blank while the Planner was thinking.
 const runs = [root,...children]

 const cards = runs.map((entry) => {
 const own = notes.filter((note) => note.agentRunId === entry.id)
 const authored = own.filter((note) => note.authorKind !== 'platform')
 /**
 * A card's claim comes from the run's *own* `run_started` note, never from the
 * `path_ownership` notes.
 *
 * Those two carry the same paths but answer different questions, and conflating
 * them was a real bug a test caught. `path_ownership` notes are written by the
 * Planner before any child exists — that ordering is the point, since it is what
 * puts every sibling's claim in the first child's context — so they are all keyed
 * to the *Planner's* run. Read here, they would give the Planner a card owning
 * every path and the workers cards owning none, and `pathCollisions` would then
 * find nothing at all.
 */
 const ownership = own.filter((note) => note.kind === 'run_started')
 return {
 runId: entry.id,
 parentRunId: entry.parentRunId,
 personaName: entry.persona.name,
 title: own.find((note) => note.kind === 'run_started')?.title ?? entry.persona.name,
 status: entry.status,
 relation: entry.relation,
 branchName: entry.branchName,
 branchDisposition: entry.branchDisposition,
 totalCostUsd: entry.totalCostUsd,
 ownedPaths: [...new Set(ownership.flatMap((note) => note.paths))],
 noteCount: own.length,
 latestNoteTitle: authored.at(-1)?.title ?? null,
 blockerCount: authored.filter((note) => note.kind === 'blocker').length,
 }
 })

 return { treeRunId, cards, pathCollisions: collidingCards(cards) }
}

/**
 * Workspace spend, grouped.
 *
 * Deliberately *not* built on the board. `getSwarmBoard` rolls up one tree by loading
 * its cards; the cost model asks for the workspace, which has no bound and grows for the workspace's
 * life. The rollup is therefore a database aggregate (`costRollup`), and this use case's
 * only job is turning the "per thread/team/workspace" window into a `since` and
 * refusing to invent one.
 *
 * Nothing here re-prices anything. Every figure is what the egress proxy metered
 * — a dashboard that recomputed spend from a price table would be a second, quietly
 * disagreeing answer to the question the proxy already answered authoritatively.
 */
export const getWorkspaceCostSummary = async (
 deps: NoteDeps,
 input: { workspaceId: WorkspaceId; windowHours: number | null; now?: Date },
): Promise<CostSummary> => {
 const now = input.now ?? new Date
 const since =
 input.windowHours === null ? null: new Date(now.getTime - input.windowHours * 3_600_000)
 const rollup = await deps.agentRuns.costRollup(input.workspaceId, { since })
 return { windowHours: input.windowHours,...rollup }
}

export interface CostSummary extends AgentRunCostRollup {
 /** Null means all time. Echoed back so a client cannot mislabel the figures it renders. */
 readonly windowHours: number | null
}

/**
 * Path collisions between cards, using the *recorded* ownership rather than the
 * decomposition — so the board keeps warning after the plan is gone, and covers a
 * run a human started by hand alongside a swarm.
 *
 * Kept here rather than in the domain's `detectPathOverlaps` because that one
 * operates on a decomposition being validated; this operates on runs that already
 * exist. Both use `pathsOverlap` so a directory claim still contains a file claim.
 */
const collidingCards = (
 cards: readonly SwarmBoardCard[],
): { titles: [string, string]; paths: string[] }[] => {
 const collisions: { titles: [string, string]; paths: string[] }[] = []
 for (let i = 0; i < cards.length; i += 1) {
 for (let j = i + 1; j < cards.length; j += 1) {
 const first = cards[i]
 const second = cards[j]
 if (!first || !second) continue
 const paths = [
...new Set([
...first.ownedPaths.filter((path) =>
 second.ownedPaths.some((other) => pathsOverlap(path, other)),
),
...second.ownedPaths.filter((path) =>
 first.ownedPaths.some((other) => pathsOverlap(path, other)),
),
 ]),
 ].sort
 if (paths.length > 0) collisions.push({ titles: [first.title, second.title], paths })
 }
 }
 return collisions
}
