import {
 ForbiddenError,
 MAX_NOTES_PER_RUN,
 NotFoundError,
 ValidationError,
 isHuman,
 isTerminalRunStatus,
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
 AgentRunEventRepositoryPort,
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
 /** Only the board reads these, for the live fields — see `getSwarmBoard`. */
 readonly agentRunEvents: AgentRunEventRepositoryPort
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
/**
 * Which runs' notes a given run may be shown: its ancestors, itself, its own
 * descendants, and its immediate siblings — but **not a sibling's subtree**.
 *
 * **This is a context-economy rule before it is a confidentiality one.** A ledger
 * keyed by tree root was right while a tree was one Planner and its workers: "a swarm
 * shares context while two unrelated goals do not pollute each other" holds when the
 * swarm *is* one area. Once a second Planner node exists, one tree stops meaning one
 * area, and a worker under sub-planner A receives everything B's workers wrote —
 * refilling its context with exactly the material that makes a long-running single
 * agent drift. A swarm beats one agent because a worker spends its whole context on
 * one narrow piece of work; a tree-wide ledger spends it on the other subtrees.
 *
 * Each clause earns its place, and dropping any one of them breaks something
 * measured:
 *
 * - **Siblings**, because the parallel-branch measurement measured coordination between peers as the thing that
 * prevents conflicts — the "hands a later run the ledger its siblings
 * already wrote" is the flat fan-out, and it must keep working exactly as it did.
 * In a flat tree this rule admits everything, so Phase 2 behaviour is unchanged.
 * - **Ancestors**, because a decision or a path claim made above has to reach
 * everyone below it, or two subtrees implement the same concept differently.
 * Authority and context flow the same direction — down.
 * - **Descendants**, because a Planner that cannot read its own workers' findings and
 * blockers cannot aggregate or re-plan.
 * - **Not a sibling's subtree**, which is the whole cut: sub-planners A and B see each
 * other as peers and coordinate, while A's workers never see inside B. Siblings
 * coordinate through their common parent, which is what a parent is for.
 *
 * A human's note has `agentRunId: null` — it is about the tree, not any one run — and
 * is always in scope. A person addressing a swarm is addressing all of it.
 */
export const inScopeRunIds = (
 /** Only `id` and `parentRunId` are read — the rest of `AgentRun` is irrelevant to shape. */
 tree: readonly Pick<AgentRun, 'id' | 'parentRunId'>[],
 run: Pick<AgentRun, 'id'>,
): Set<AgentRunId> => {
 const byId = new Map(tree.map((entry) => [entry.id, entry]))
 const scope = new Set<AgentRunId>([run.id])

 const self = byId.get(run.id)
 for (let current = self; current?.parentRunId;) {
 const parent = byId.get(current.parentRunId)
 // A cycle from a bad backfill stops here rather than looping: a run already in
 // scope is never re-entered.
 if (!parent || scope.has(parent.id)) break
 scope.add(parent.id)
 current = parent
 }

 // Immediate siblings only — their descendants stay out, which is the cut.
 if (self?.parentRunId) {
 for (const entry of tree) {
 if (entry.parentRunId === self.parentRunId) scope.add(entry.id)
 }
 }

 /**
 * Descendants, by repeatedly admitting any run whose parent is already a
 * descendant-or-self. Seeded from `run` alone rather than from `scope`, because
 * `scope` already holds ancestors and siblings — growing from it would pull in a
 * sibling's whole subtree and every other branch of the tree with it.
 */
 const below = new Set<AgentRunId>([run.id])
 for (let pass = 0; pass < tree.length; pass += 1) {
 let grew = false
 for (const entry of tree) {
 if (below.has(entry.id) || !entry.parentRunId) continue
 if (below.has(entry.parentRunId)) {
 below.add(entry.id)
 scope.add(entry.id)
 grew = true
 }
 }
 if (!grew) break
 }

 return scope
}

export const buildContextLedger = async (
 deps: NoteDeps,
 input: { workspaceId: WorkspaceId; run: AgentRun; treeRunId?: AgentRunId },
): Promise<string> => {
 const treeRunId = input.treeRunId ?? (await resolveTreeRunId(deps, input.run))
 const everything = await deps.workerNotes.listByTree(input.workspaceId, treeRunId)
 if (everything.length === 0) return ''

 const tree = await deps.agentRuns.listTree(input.workspaceId, treeRunId)
 const scope = inScopeRunIds(tree, input.run)
 const all = everything.filter(
 (note) => note.agentRunId === null || scope.has(note.agentRunId),
)
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
 /** Whether this run decomposes rather than acts. */
 readonly planner: boolean
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

 // --- Live observability. Projections of persisted events and of the
 // run's own snapshot; nothing here asks the agent to cooperate, and nothing here
 // costs a query per card. ---

 /**
 * The tool call in flight and its headline argument — the "which file is it in".
 * Both null for a run that is thinking, finished, or has yet to call anything, which
 * are different things and are told apart by `status` and `lastEventAt`.
 */
 readonly currentToolName: string | null
 readonly currentToolTarget: string | null
 /** Calls open at once, so a parallel fan-out does not read as a single call. */
 readonly openCallCount: number
 /**
 * Last event of any kind. A *timestamp*, not a duration: live swarm observability asks for idle time, and
 * how long ago something happened is a rendering — a payload carrying "4m idle" is
 * wrong the moment anything caches it.
 */
 readonly lastEventAt: Date | null
 /**
 * The cap this run is spending against, from its own frozen `PersonaSpec` snapshot
 * rather than from the persona as configured now — otherwise an edited cap would
 * retroactively rewrite what a finished run was allowed. Null means uncapped.
 */
 readonly budgetCapUsd: number | null
 /**
 * The context pressure: tokens held against the model's window, as the Runner last
 * sampled it from the SDK. Read straight off the run — the heartbeat already wrote it
 * there — so it costs this read nothing.
 *
 * Null before the first sample, which is the honest answer for a run that has not had
 * a turn yet. It is deliberately *not* a sum of per-event token deltas: compaction
 * empties the window while a running total only climbs, so the two would disagree
 * exactly when a human most needs the number.
 */
 readonly contextTokens: number | null
 readonly contextMaxTokens: number | null
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
 /**
 * The whole tree, at any depth. The root is a card too — a Planner's own status is
 * what a human reads first, and a board that showed only workers would go blank
 * while the Planner was thinking — and `listTree` includes it.
 *
 * This was `[root,...listByParent(root)]`, which is the same list only while every
 * one of the root's children is a leaf. A sub-planner's workers were simply absent:
 * no error, a board omitting the runs actually doing the work, and `pathCollisions`
 * blind to every collision involving one of them.
 *
 * The human's view stays tree-wide on purpose. Scoping belongs to what a *model*
 * is handed (see `buildContextLedger`) — a person supervising a swarm needs to see
 * across the subtrees precisely because the agents cannot.
 */
 const runs = await deps.agentRuns.listTree(input.workspaceId, treeRunId)

 /**
 * The live fields, in one statement for the whole tree — the section's cost
 * discipline is that the board stays one fetch on a socket nudge, so this is a third
 * query in the same read and never a query per card.
 */
 const activity = await deps.agentRunEvents.liveActivity(
 input.workspaceId,
 runs.map((entry) => entry.id),
)

 const cards = runs.map((entry) => {
 const live = activity.get(entry.id)
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
 planner: entry.persona.planner === true,
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
 // A terminal run has nothing in flight. Without this a run that died mid-call —
 // reaped, cancelled, out of budget — would keep advertising that call forever,
 // which is the same lie the thread told before pairing was fixed.
 currentToolName: isTerminalRunStatus(entry.status) ? null: live?.currentToolName ?? null,
 currentToolTarget: isTerminalRunStatus(entry.status) ? null: live?.currentToolTarget ?? null,
 openCallCount: isTerminalRunStatus(entry.status) ? 0: live?.openCallCount ?? 0,
 lastEventAt: live?.lastEventAt ?? null,
 budgetCapUsd: entry.persona.budgetCapUsd,
 contextTokens: entry.contextTokens,
 contextMaxTokens: entry.contextMaxTokens,
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
