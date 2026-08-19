import {
  ForbiddenError,
  MAX_NOTES_PER_RUN,
  NotFoundError,
  ValidationError,
  isHuman,
  isTerminalRunStatus,
  parseNoteInput,
  pathsOverlap,
  renderDeliveredNote,
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
  NoteReadRepositoryPort,
  RunDispatchPort,
  RunnerRepositoryPort,
  WorkerNoteRepositoryPort,
} from './agent-ports.js'
import type { ChannelRepositoryPort, ThreadRepositoryPort } from './ports.js'

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
  /**
   * Delivers a note into runs already working.
   *
   * Optional, and the one dependency here that reaches outside the database: a note is
   * recorded whether or not it can be delivered, so a caller that has no dispatch
   * (a test, a read-only context) writes notes exactly as before.
   */
  readonly dispatch?: RunDispatchPort
  /**
   * Who read whose notes.
   *
   * Optional for the same reason `dispatch` is: a ledger is assembled whether or not the
   * edge can be recorded, and a caller without this (a test, a read-only context) builds
   * context exactly as before. Bookkeeping about a read must never be able to fail the
   * read.
   */
  readonly noteReads?: NoteReadRepositoryPort
}

/**
 * What the board needs on top of a ledger — where each card is
 * *running*: the runner's machine and the channel the work is watched in.
 *
 * Its own type rather than three more fields on `NoteDeps`, and not only to avoid a clash
 * with `Deps`: nothing else in this file reads a runner or a channel, and a note has no
 * business knowing about either. Optional, like `dispatch` and `noteReads` — a board
 * assembles with or without them and a caller that has neither gets the board it got
 * before, with both names empty. A name nobody could resolve must never fail the read a
 * human is waiting on.
 *
 * Two workspace-wide lists plus one lookup per *thread* rather than per card: a workspace
 * holds a handful of runners and channels, a tree lives in one thread, and the cost
 * discipline is that the board stays one fetch on a socket nudge rather than a query per
 * row.
 */
export interface BoardDeps extends NoteDeps {
  readonly runners?: RunnerRepositoryPort
  readonly channels?: ChannelRepositoryPort
  readonly threads?: ThreadRepositoryPort
}

/**
 * How deep a parent chain this will walk looking for a tree root.
 *
 * The data model lets a run spawn children of itself, so a chain is possible in principle
 * even though the Planner produces exactly two levels today. A bound rather than a `while
 * (true)`: this runs on every note write and every run start, and a cycle introduced by a
 * future migration or a bad backfill would otherwise hang the request rather than degrade
 * it.
 */
const MAX_TREE_DEPTH = 16

/**
 * Records that a run was shown notes written by others.
 *
 * Only `agent_run` authors, and never the reader itself. A platform note has no author
 * run to draw an edge to, a human's note is about the tree rather than any one run, and a
 * run reading its own note back is not an interaction between two runs — drawing any of
 * those would fill the graph with edges that say nothing about who learned from whom.
 *
 * Every failure is swallowed. An edge that could not be recorded costs a line on a graph;
 * a read that failed because of it would cost the run its context.
 */
const recordNoteReads = async (
  deps: NoteDeps,
  input: {
    workspaceId: WorkspaceId
    treeRunId: AgentRunId
    readerRunId: AgentRunId
    notes: readonly WorkerNote[]
  },
): Promise<void> => {
  if (!deps.noteReads) return
  const authorRunIds = [
    ...new Set(
      input.notes
        .filter((note) => note.authorKind === 'agent_run' && note.agentRunId !== null)
        .map((note) => note.agentRunId!)
        .filter((authorRunId) => authorRunId !== input.readerRunId),
    ),
  ]
  if (authorRunIds.length === 0) return
  try {
    await deps.noteReads.recordReads({
      workspaceId: input.workspaceId,
      treeRunId: input.treeRunId,
      readerRunId: input.readerRunId,
      authorRunIds,
    })
  } catch {
    // Deliberately swallowed — see above.
  }
}

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
 * **Incremental by construction, and that is the requirement.** The worker-notes design: "A
 * run that is killed, reaped, budget-capped or crashed never reaches a stop handler. This
 * codebase has already paid for that lesson twice." So there is deliberately no batch
 * variant of this function and no flush-at-stop path — a note that reached here is durable,
 * and a run that dies loses only the note it was mid-way through writing.
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

  const treeRunId = await resolveTreeRunId(deps, run)
  const note = await deps.workerNotes.append({
    workspaceId: input.workspaceId,
    treeRunId,
    agentRunId: run.id,
    authorKind: 'agent_run',
    kind: verdict.kind,
    title: verdict.title,
    body: verdict.body,
    paths: verdict.paths,
  })

  /**
   * Only a `decision` propagates to runs already in flight, and the restraint is the
   * design. A decision is the one authored kind that is a *standing* fact governing
   * everyone who comes after (see `MAX_DECISIONS_IN_CONTEXT`); a finding is one
   * worker's observation and a blocker is one worker's reason for stopping, and
   * pushing either into every sibling's context mid-turn would spend the attention
   * this feature exists to protect. Findings still reach the ledger, and the ledger is
   * still read.
   */
  if (verdict.kind === 'decision') {
    await deliverNoteToActiveRuns(deps, { workspaceId: input.workspaceId, treeRunId, note })
  }

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
 * The worker-notes design makes "the persona and the human-visible plan stay authoritative
 * over what a worker does" a property of the rendering; this is how a human adds to that
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

  const treeRunId = await resolveTreeRunId(deps, run)
  const note = await deps.workerNotes.append({
    workspaceId: input.workspaceId,
    treeRunId,
    // Null: a human's note is about the tree, not about any one run.
    agentRunId: null,
    authorKind: 'human',
    kind: verdict.kind,
    title: verdict.title,
    body: verdict.body,
    paths: verdict.paths,
  })

  /**
   * Every kind, unlike an agent's — and this is the asymmetry that makes the feature
   * worth having. The account of what a human can do today is "leave a
   * message for the swarm and hope"; a person who writes a blocker while three
   * workers are running means it for those three workers, now. A human's note is also
   * always in scope (`agentRunId: null`), so it reaches every active run in the tree.
   */
  await deliverNoteToActiveRuns(deps, { workspaceId: input.workspaceId, treeRunId, note })
  return note
}

/**
 * Delivers a note into the runs that are working **right now**.
 *
 * The gap this closes: a note reaches a run that starts after it, or one that happens
 * to call `read_notes` again. A worker mid-turn learns nothing — so a decision made
 * one minute after a worker began was, until now, a decision that worker would never
 * see, and two subtrees implementing the same concept differently is the failure that
 * produces most reliably.
 *
 * Three bounds, and each is load-bearing:
 *
 * - **Scope.** Only runs `inScopeRunIds` admits — ancestors, self, descendants and
 *   immediate siblings. The same rule as the opening ledger, for the same
 *   context-economy reason: delivering one area's chatter into another's workers is
 *   exactly the context pollution a swarm exists to avoid.
 * - **Active only.** A terminal run has no loop to deliver into.
 * - **Never the author.** A run does not need its own note read back to it, and
 *   delivering it would be the one case where a model's own output re-enters its
 *   context wearing the platform's framing.
 *
 * Every failure here is swallowed. Delivery makes runs *better informed*; a note that
 * could not be delivered is still on the ledger, and letting that fail the write would
 * trade the thing that matters for the thing that helps.
 */
export const deliverNoteToActiveRuns = async (
  deps: NoteDeps,
  input: { workspaceId: WorkspaceId; treeRunId: AgentRunId; note: WorkerNote },
): Promise<{ delivered: AgentRunId[] }> => {
  if (!deps.dispatch) return { delivered: [] }

  const delivered: AgentRunId[] = []
  try {
    const tree = await deps.agentRuns.listTree(input.workspaceId, input.treeRunId)
    const active = tree.filter(
      (run) => !isTerminalRunStatus(run.status) && run.id !== input.note.agentRunId,
    )
    if (active.length === 0) return { delivered: [] }

    const text = renderDeliveredNote(input.note)
    for (const run of active) {
      // Scope is computed per recipient, because it is a question about *that* run's
      // position in the tree — a sibling of the author is in scope, a sibling's worker
      // is not, and only the recipient's own view can tell those apart.
      if (input.note.agentRunId && !inScopeRunIds(tree, run).has(input.note.agentRunId)) {
        continue
      }
      try {
        await deps.dispatch.deliverToRun({ runnerId: run.runnerId, runId: run.id, text })
        delivered.push(run.id)
      } catch {
        // Deliberately swallowed — see above.
      }
    }
  } catch {
    // Deliberately swallowed — see above.
  }
  return { delivered }
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
 * - **Siblings**, because the parallel-branch measurement measured coordination between
 *   peers as the thing that prevents conflicts — the "hands a later run the ledger its
 *   siblings already wrote" is the flat fan-out, and it must keep working exactly as it
 *   did. In a flat tree this rule admits everything, so Phase 2 behaviour is unchanged.
 * - **Ancestors**, because a decision or a path claim made above has to reach
 *   everyone below it, or two subtrees implement the same concept differently.
 *   Authority and context flow the same direction — down.
 * - **Descendants**, because a Planner that cannot read its own workers' findings and
 *   blockers cannot aggregate or re-plan.
 * - **Not a sibling's subtree**, which is the whole cut: sub-planners A and B see each
 *   other as peers and coordinate, while A's workers never see inside B. Siblings
 *   coordinate through their common parent, which is what a parent is for.
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
  for (let current = self; current?.parentRunId; ) {
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

  /**
   * The edge is recorded from what was *selected*, not from what the tree holds.
   *
   * Those differ, and the difference is the whole point: `selectNotesForContext` elides
   * under the per-tree cap, so a note that was dropped was never shown to this run and an
   * edge claiming otherwise would be a false record of what it knew. This is also the one
   * funnel every read passes through — the ledger handed over at start and every
   * mid-flight `read_notes` — so recording here covers both without a second call site.
   */
  await recordNoteReads(deps, {
    workspaceId: input.workspaceId,
    treeRunId,
    readerRunId: input.run.id,
    notes: selected,
  })

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
 * **Derived, never stored** — the worker-notes design: "The ledger and the kanban are one
 * object. The Phase 2 kanban is this same data with a board rendering; building them
 * separately would produce two sources of truth for what a swarm is doing." So there is no
 * `task` table: a card *is* a run, its column is that run's status, and its detail is the
 * notes keyed to the tree.
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
  /**
   * Where this card is *running* — the runner's machine and the
   * channel the work is watched in.
   *
   * On the card rather than folded up to the board, which is forward-looking rather than
   * pessimistic: every run in a tree shares its parent's repository today, so both names
   * are constant across a board — and the cross-repository fleet is exactly the arrangement
   * where they stop being. A board that had folded them to the top would then be quietly
   * wrong rather than merely repetitive.
   *
   * Empty rather than the id when unresolvable: "which machine" is how a human decides
   * whether a stuck run is stuck on *this* box, and a uuid answers that worse than a blank.
   */
  readonly runnerName: string
  readonly channelName: string

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
   * Last event of any kind. A *timestamp*, not a duration: live swarm observability asks
   * for idle time, and how long ago something happened is a rendering — a payload carrying
   * "4m idle" is wrong the moment anything caches it.
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
  /**
   * When the platform told this run its window was filling, or null.
   *
   * Carried so a card can say the nudge *fired* rather than only how full the window is.
   * Those are different facts and the second does not imply the first: an operator may
   * have raised the threshold, the tree may have spent its handoffs, or the run may have
   * been told and decided it was still doing fine — which is exactly the decision mastery
   * leaves to the agent.
   */
  readonly handoffSuggestedAt: Date | null
}

export interface SwarmBoard {
  readonly treeRunId: AgentRunId
  readonly cards: SwarmBoardCard[]
  /** Pairs of cards whose owned paths collide — the merge conflicts to expect. */
  readonly pathCollisions: { readonly titles: [string, string]; readonly paths: string[] }[]
  /**
   * Who read whose notes.
   *
   * On the board's payload rather than a second endpoint, because it is the same
   * question the board already answers — what is this swarm doing — and a separate fetch
   * would be a second source of truth for one tree's shape.
   */
  readonly noteReads: {
    readonly readerRunId: AgentRunId
    readonly authorRunId: AgentRunId
    readonly readCount: number
  }[]
  /**
   * Notes as objects rather than as a count on a card.
   *
   * **Bounded to decisions and blockers, and the bound is the design.** the worker-notes
   * design makes a `decision` the only authored kind that governs everyone after it, and a
   * `blocker` the one that is asking for help — both are things a human watching a swarm
   * should see without opening a panel. A `finding` is one run's experience of its own
   * work: a busy swarm writes dozens, they are what the ledger is *for*, and drawing them
   * would bury the tree they hang off. The own phrasing is that the canvas must stay
   * readable while a swarm is moving, which is precisely when it is being watched.
   *
   * Every title here is model-authored in the general case, so it is untrusted text and
   * must be rendered as such.
   */
  readonly notes: {
    readonly noteId: string
    readonly agentRunId: AgentRunId
    readonly kind: 'decision' | 'blocker'
    readonly title: string
    /** Human-authored notes exist and are not the same claim as an agent's. */
    readonly authorKind: string
    readonly createdAt: Date
  }[]
  /** How many decisions and blockers exist beyond the ones drawn — never silently dropped. */
  readonly elidedNotes: number
}

/**
 * How many note nodes one canvas draws.
 *
 * The same argument as `MAX_NODES_IN_CONTEXT` with a different reader: a graph that draws
 * every decision a long swarm made stops being a picture of the swarm. Newest first,
 * because a decision of record is most useful while it is still governing work in flight
 * — and the count dropped is reported rather than swallowed, for the reason
 * `selectNotesForContext` reports its own: a viewer shown a silently truncated set
 * believes it has the whole picture.
 */
export const MAX_NOTE_NODES = 24

export const getSwarmBoard = async (
  deps: BoardDeps,
  input: { workspaceId: WorkspaceId; agentRunId: AgentRunId },
): Promise<SwarmBoard> => {
  const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
  if (!run) throw new NotFoundError('AgentRun')

  const treeRunId = await resolveTreeRunId(deps, run)
  const root = treeRunId === run.id ? run : await deps.agentRuns.findById(input.workspaceId, treeRunId)
  if (!root) throw new NotFoundError('AgentRun')

  const notes = await deps.workerNotes.listByTree(input.workspaceId, treeRunId)
  /**
   * The whole tree, at any depth. The root is a card too — a Planner's own status is
   * what a human reads first, and a board that showed only workers would go blank
   * while the Planner was thinking — and `listTree` includes it.
   *
   * This was `[root, ...listByParent(root)]`, which is the same list only while every
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

  /**
   * Where each card is running — the runner's name and the
   * channel the thread belongs to.
   *
   * Per *card* rather than per board, and that is a forward-looking choice rather than a
   * pessimistic one: every run in a tree shares its parent's repository today, so the two
   * names are constant across a board — but the cross-repository fleet is
   * exactly the arrangement where they stop being, and a board that had folded them up to
   * the top would then be quietly wrong instead of merely repetitive.
   *
   * Resolved from workspace-wide lists, all in this one read: a workspace holds a handful
   * of runners, channels and threads, and live swarm observability forbids a query per row.
   */
  const distinctThreadIds = [...new Set(runs.map((entry) => entry.threadId))]
  const [runnerRows, channelRows, threadRows] = await Promise.all([
    deps.runners?.listByWorkspace(input.workspaceId) ?? Promise.resolve([]),
    deps.channels?.listByWorkspace(input.workspaceId) ?? Promise.resolve([]),
    /**
     * By distinct **thread**, not by card. `ThreadRepositoryPort` has no workspace-wide
     * list and does not need one for this: a tree lives in the thread its root was started
     * in, so this is one lookup in practice and is bounded by the number of threads a tree
     * touches rather than by the number of runs in it.
     */
    Promise.all(
      distinctThreadIds.map((threadId) =>
        deps.threads?.findById(input.workspaceId, threadId) ?? Promise.resolve(null),
      ),
    ),
  ])
  const runnerNameById = new Map(runnerRows.map((runner) => [runner.id as string, runner.name]))
  const channelNameById = new Map(
    channelRows.map((channel) => [channel.id as string, channel.name]),
  )
  const channelIdByThread = new Map(
    threadRows.flatMap((thread) =>
      thread === null ? [] : [[thread.id as string, thread.channelId as string]],
    ),
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
      /**
       * Empty rather than null when unresolvable, and rather than the id. The reason for
       * the field is that "which machine" is how a human decides whether a stuck run is
       * stuck on *this* box — and a uuid answers that question worse than a blank does,
       * because it looks like an answer.
       */
      runnerName: runnerNameById.get(entry.runnerId as string) ?? '',
      channelName:
        channelNameById.get(channelIdByThread.get(entry.threadId as string) ?? '') ?? '',
      // A terminal run has nothing in flight. Without this a run that died mid-call —
      // reaped, cancelled, out of budget — would keep advertising that call forever,
      // which is the same lie the thread told before pairing was fixed.
      currentToolName: isTerminalRunStatus(entry.status) ? null : live?.currentToolName ?? null,
      currentToolTarget: isTerminalRunStatus(entry.status) ? null : live?.currentToolTarget ?? null,
      openCallCount: isTerminalRunStatus(entry.status) ? 0 : live?.openCallCount ?? 0,
      lastEventAt: live?.lastEventAt ?? null,
      budgetCapUsd: entry.persona.budgetCapUsd,
      contextTokens: entry.contextTokens,
      contextMaxTokens: entry.contextMaxTokens,
      handoffSuggestedAt: entry.handoffSuggestedAt,
    }
  })

  /**
   * Swallowed, and last: a board that failed to load because an interaction edge could
   * not be read would trade the surface a human is watching for a line on it.
   */
  let noteReads: SwarmBoard['noteReads'] = []
  try {
    noteReads = (await deps.noteReads?.listByTree(input.workspaceId, treeRunId))?.map((edge) => ({
      readerRunId: edge.readerRunId,
      authorRunId: edge.authorRunId,
      readCount: edge.readCount,
    })) ?? []
  } catch {
    // Deliberately swallowed — see above.
  }

  /**
   * Live swarm observability gap 3. Read from the notes already fetched for the cards, so
   * this costs no query.
   */
  const governing = notes.filter(
    (note): note is typeof note & { kind: 'decision' | 'blocker'; agentRunId: AgentRunId } =>
      (note.kind === 'decision' || note.kind === 'blocker') && note.agentRunId !== null,
  )
  const drawnNotes = governing.slice(-MAX_NOTE_NODES).map((note) => ({
    noteId: note.id as string,
    agentRunId: note.agentRunId,
    kind: note.kind,
    title: note.title,
    authorKind: note.authorKind,
    createdAt: note.createdAt,
  }))

  return {
    treeRunId,
    cards,
    pathCollisions: collidingCards(cards),
    noteReads,
    notes: drawnNotes,
    elidedNotes: governing.length - drawnNotes.length,
  }
}

/**
 * Workspace spend, grouped.
 *
 * Deliberately *not* built on the board. `getSwarmBoard` rolls up one tree by loading its
 * cards; the cost model asks for the workspace, which has no bound and grows for the
 * workspace's life. The rollup is therefore a database aggregate (`costRollup`), and this
 * use case's only job is turning the "per thread/team/workspace" window into a `since` and
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
  const now = input.now ?? new Date()
  const since =
    input.windowHours === null ? null : new Date(now.getTime() - input.windowHours * 3_600_000)
  const rollup = await deps.agentRuns.costRollup(input.workspaceId, { since })
  return { windowHours: input.windowHours, ...rollup }
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
      ].sort()
      if (paths.length > 0) collisions.push({ titles: [first.title, second.title], paths })
    }
  }
  return collisions
}
