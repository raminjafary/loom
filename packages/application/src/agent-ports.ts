import type {
 AgentPersona,
 AgentPersonaId,
 AgentRun,
 AgentRunBranchDisposition,
 AgentRunId,
 AgentRunRelation,
 AgentRunStatus,
 ApprovalRequest,
 ApprovalRequestId,
 ApprovalStatus,
 Capability,
 CapabilityId,
 CapabilityKind,
 McpTransport,
 MergeFailureReason,
 MergeQueueEntry,
 MergeQueueEntryId,
 MergeQueueEntryStatus,
 NoteAuthorKind,
 PersonaCapability,
 PersonaGroup,
 PersonaGroupId,
 PersonaSpec,
 Repository,
 RepositoryId,
 Runner,
 RunnerId,
 ThreadId,
 UserId,
 WorkerNote,
 WorkerNoteKind,
 WorkspaceId,
 WorkspaceRunControl,
} from '@loom/domain'

export interface RunnerRepositoryPort {
 findById(workspaceId: WorkspaceId, id: RunnerId): Promise<Runner | null>
 listByWorkspace(workspaceId: WorkspaceId): Promise<Runner[]>
 createPairing(input: {
 workspaceId: WorkspaceId
 name: string
 }): Promise<{ runnerId: RunnerId; rawToken: string }>
}

export interface RepositoryRepositoryPort {
 create(input: {
 workspaceId: WorkspaceId
 runnerId: RunnerId
 displayName: string
 absolutePath: string
 defaultBranch: string
 }): Promise<Repository>
 findById(workspaceId: WorkspaceId, id: RepositoryId): Promise<Repository | null>
 listByWorkspace(workspaceId: WorkspaceId): Promise<Repository[]>
 /**
 * What the merge queue runs before merging. Its own method
 * rather than a general `update`: it is the only mutable field a bound repository
 * has, and the path and default branch must stay immutable — a repository that
 * could be re-pointed after binding would make every past run's clone provenance
 * a guess.
 */
 setVerifyCommand(
 workspaceId: WorkspaceId,
 id: RepositoryId,
 verifyCommand: string | null,
): Promise<Repository>
 /** What warms this repository's dependency cache. */
 setInstallCommand(
 workspaceId: WorkspaceId,
 id: RepositoryId,
 installCommand: string | null,
): Promise<Repository>
}

/**
 * The serialized merge queue's persistence. Its own port
 * rather than methods on `AgentRunRepositoryPort`: an entry belongs to a
 * repository's queue, and its lifecycle (queued → merging → terminal) is
 * independent of the run whose branch it carries.
 */
export interface MergeQueueRepositoryPort {
 enqueue(input: {
 workspaceId: WorkspaceId
 repositoryId: RepositoryId
 agentRunId: AgentRunId
 branchName: string
 enqueuedByUserId: UserId | null
 }): Promise<MergeQueueEntry>
 findById(workspaceId: WorkspaceId, id: MergeQueueEntryId): Promise<MergeQueueEntry | null>
 /** One repository's queue in `position` order — what a client renders. */
 listByRepository(
 workspaceId: WorkspaceId,
 repositoryId: RepositoryId,
): Promise<MergeQueueEntry[]>
 listByWorkspace(workspaceId: WorkspaceId): Promise<MergeQueueEntry[]>
 /**
 * Every non-terminal entry, workspace-agnostic — the same deliberate exception to
 * this layer's per-workspace convention as `AgentRunRepositoryPort.listAllActive`,
 * for the same reason: it backs an internal sweep that is never reachable through
 * the contract, so there is no caller whose authz boundary it could cross.
 */
 listAllOpen: Promise<MergeQueueEntry[]>
 /**
 * Moves one entry `queued` → `merging`, or returns null.
 *
 * Null is not an error — it is the serialization working. Two servers sweeping
 * concurrently both see the same queued entry; the unique partial index on
 * (repository_id) where status = 'merging' lets exactly one claim succeed, and the
 * loser simply has nothing to do this tick.
 */
 claim(workspaceId: WorkspaceId, id: MergeQueueEntryId): Promise<MergeQueueEntry | null>
 /**
 * Terminal transition. `verified` records whether tests ran and passed, not
 * whether any were configured.
 *
 * Returns null when the entry is *already* terminal, and writes nothing. That
 * case is real: the queue's stuck check can abandon an entry whose Runner then
 * answers late, and letting the late answer win would flip a merge a human was
 * already told had been given up on — with a thread that now says both.
 * First resolution wins.
 */
 finish(
 workspaceId: WorkspaceId,
 id: MergeQueueEntryId,
 patch: {
 status: Extract<MergeQueueEntryStatus, 'merged' | 'failed' | 'cancelled'>
 failureReason?: MergeFailureReason
 detail?: string
 mergedCommitSha?: string
 verified?: boolean
 },
): Promise<MergeQueueEntry | null>
}

/**
 * The worker-notes ledger's persistence.
 *
 * Its own port rather than methods on `AgentRunRepositoryPort`: a note belongs to a
 * *tree*, not to a run — that is the whole point of it, since a run's own context
 * dies with the run's clone — and the kanban reads the same rows.
 *
 * There is no update and no delete. A note is a record of what a run believed at a
 * moment, and an editable ledger would let a later run rewrite what an earlier one
 * reported — the same append-only reasoning as `audit_event`.
 */
export interface WorkerNoteRepositoryPort {
 append(input: {
 workspaceId: WorkspaceId
 treeRunId: AgentRunId
 agentRunId: AgentRunId | null
 authorKind: NoteAuthorKind
 kind: WorkerNoteKind
 title: string
 body: string
 paths: string[]
 }): Promise<WorkerNote>
 /** One tree's ledger in write order — what a starting run's context and the board are built from. */
 listByTree(workspaceId: WorkspaceId, treeRunId: AgentRunId): Promise<WorkerNote[]>
 /**
 * How many notes one run has written. Backs the per-run cap
 * (`MAX_NOTES_PER_RUN`), which is what stops a looping agent turning the ledger
 * into a denial of service against every sibling's context window.
 */
 countByRun(workspaceId: WorkspaceId, agentRunId: AgentRunId): Promise<number>
}

/**
 * Grouped spend, straight from the database.
 *
 * `personaName` and `model` are read out of the run's **persona snapshot**, not out of
 * the live persona: the cost model exists because "Cursor's 8x swing came from worker model choice",
 * and a rollup that read today's persona would attribute last week's Opus spend to
 * whatever the persona was edited to since. The snapshot is what actually ran.
 */
export interface AgentRunCostRollup {
 readonly totals: { readonly runCount: number; readonly totalUsd: number }
 readonly byPersona: {
 readonly personaName: string
 readonly model: string
 readonly runCount: number
 readonly totalUsd: number
 readonly maxUsd: number
 }[]
 readonly byModel: {
 readonly model: string
 readonly runCount: number
 readonly totalUsd: number
 }[]
 readonly byThread: {
 readonly threadId: ThreadId
 readonly channelName: string
 readonly runCount: number
 readonly totalUsd: number
 }[]
 readonly topRuns: {
 readonly agentRunId: AgentRunId
 readonly personaName: string
 readonly model: string
 readonly status: string
 readonly relation: string | null
 readonly totalUsd: number
 readonly createdAt: Date
 }[]
}

export interface AgentRunRepositoryPort {
 create(input: {
 workspaceId: WorkspaceId
 threadId: ThreadId
 repositoryId: RepositoryId
 runnerId: RunnerId
 persona: PersonaSpec
 /** Set for a run another run spawned; absent for a human-started run. */
 parentRunId?: AgentRunId
 relation?: AgentRunRelation
 }): Promise<AgentRun>
 /** Children of one run — the tree view's per-parent lookup. */
 listByParent(workspaceId: WorkspaceId, parentRunId: AgentRunId): Promise<AgentRun[]>
 findById(workspaceId: WorkspaceId, id: AgentRunId): Promise<AgentRun | null>
 updateStatus(
 workspaceId: WorkspaceId,
 id: AgentRunId,
 patch: {
 status: AgentRunStatus
 totalCostUsd?: number
 errorMessage?: string
 completedAt?: Date
 },
): Promise<AgentRun>
 /** Set once the Runner finishes cloning — a distinct event from a status transition. */
 recordWorkspace(
 workspaceId: WorkspaceId,
 id: AgentRunId,
 patch: { clonePath: string; branchName: string },
): Promise<AgentRun>
 /** Single-active-run guard: any non-terminal run in the workspace. */
 findActiveByWorkspace(workspaceId: WorkspaceId): Promise<AgentRun | null>
 /**
 * Every non-terminal run in one workspace. Distinct from
 * `findActiveByWorkspace` on purpose: the kill switch must stop
 * *all* of them, and must not quietly depend on the single-active-run limit
 * still holding — that limit is a Phase 1 scope cut, not an invariant.
 */
 listActiveByWorkspace(workspaceId: WorkspaceId): Promise<AgentRun[]>
 /** A human's end-of-run keep/discard decision on DiffView. */
 setBranchDisposition(
 workspaceId: WorkspaceId,
 id: AgentRunId,
 disposition: AgentRunBranchDisposition,
): Promise<AgentRun>
 /**
 * Authoritative spend, metered at the egress proxy.
 * Separate from `updateStatus` on purpose: cost arrives continuously while a run
 * is mid-flight, and folding it into a status write would mean either inventing
 * a status transition per cost tick or letting cost updates silently rewrite
 * status.
 */
 recordCost(workspaceId: WorkspaceId, id: AgentRunId, totalCostUsd: number): Promise<void>
 /**
 * Spend, grouped, for the cost dashboard.
 *
 * The one read on this port that aggregates in the database rather than returning
 * runs. Every other rollup in this codebase is computed in memory over a bounded set
 * — one tree's cards, one run's children — and that is right for those. A workspace's
 * spend has no such bound: it grows for the life of the workspace, and the panel that
 * shows it refreshes. Fetching every run to sum a column would make the dashboard
 * slower exactly as it became worth looking at.
 *
 * Returns rows, not a summary: what counts as "expensive" is the question, not the
 * database's, and the use case is where that judgement belongs.
 */
 costRollup(
 workspaceId: WorkspaceId,
 input: { since: Date | null },
): Promise<AgentRunCostRollup>
 /** Bumped by the Runner's periodic heartbeat frame. */
 recordHeartbeat(workspaceId: WorkspaceId, id: AgentRunId): Promise<void>
 /** Bumped by any agent_event — distinct signal from a heartbeat: a hung-but-connected run keeps sending heartbeats but stops making progress. */
 recordEventActivity(workspaceId: WorkspaceId, id: AgentRunId): Promise<void>
 /**
 * Every non-terminal run, workspace-agnostic — the one deliberate exception
 * to this port's per-workspace convention. Backs the dead-run reaper, an
 * internal background sweep never exposed through the contract, so there's
 * no authz boundary to enforce here the way there is for every other method.
 */
 listAllActive: Promise<AgentRun[]>
 /**
 * Runs a human hasn't finished with yet: awaiting an approval decision, or terminal with an unreviewed
 * branch (kept/discarded not yet decided). A reaper-failed run naturally
 * falls into the latter — it already got a chat message explaining why.
 */
 listNeedsAttention(workspaceId: WorkspaceId): Promise<AgentRun[]>
}

/**
 * The capability registry's persistence. Attachments live here
 * too rather than on `PersonaRepositoryPort`: the data model models them as a join table
 * precisely because they carry per-attachment scopes, and a persona that owned
 * them would make the scope a property of the persona instead of the pairing.
 */
export interface CapabilityRepositoryPort {
 create(input: {
 workspaceId: WorkspaceId
 kind: CapabilityKind
 name: string
 description: string
 transport: McpTransport | null
 command: string | null
 args: string[]
 url: string | null
 content: string | null
 }): Promise<Capability>
 findById(workspaceId: WorkspaceId, id: CapabilityId): Promise<Capability | null>
 listByWorkspace(workspaceId: WorkspaceId): Promise<Capability[]>
 update(
 workspaceId: WorkspaceId,
 id: CapabilityId,
 patch: {
 description: string
 transport: McpTransport | null
 command: string | null
 args: string[]
 url: string | null
 content: string | null
 /** Cleared on any edit — an edited server has not been reviewed in its new form. */
 toolListHash: string | null
 },
): Promise<Capability>
 /** Records the tool list a human reviewed (the pinned tool-list hash). */
 pinToolListHash(workspaceId: WorkspaceId, id: CapabilityId, toolListHash: string): Promise<void>
 delete(workspaceId: WorkspaceId, id: CapabilityId): Promise<void>
 attach(input: {
 workspaceId: WorkspaceId
 personaId: AgentPersonaId
 capabilityId: CapabilityId
 allowedTools: string[]
 }): Promise<PersonaCapability>
 detach(
 workspaceId: WorkspaceId,
 personaId: AgentPersonaId,
 capabilityId: CapabilityId,
): Promise<void>
 listByPersona(
 workspaceId: WorkspaceId,
 personaId: AgentPersonaId,
): Promise<PersonaCapability[]>
 listAttachments(workspaceId: WorkspaceId): Promise<PersonaCapability[]>
}

export interface PersonaRepositoryPort {
 create(input: {
 workspaceId: WorkspaceId
 name: string
 description: string
 markdownSource: string
 model: string
 tools: string[]
 harnessEffort: string | null
 harnessMaxTurns: number | null
 harnessAutoApprove: boolean
 harnessPlanner: boolean
 harnessDelegates: string[]
 harnessBudgetCapUsd: number | null
 }): Promise<AgentPersona>
 findById(workspaceId: WorkspaceId, id: AgentPersonaId): Promise<AgentPersona | null>
 listByWorkspace(workspaceId: WorkspaceId): Promise<AgentPersona[]>
 update(
 workspaceId: WorkspaceId,
 id: AgentPersonaId,
 patch: {
 description: string
 markdownSource: string
 model: string
 tools: string[]
 harnessEffort: string | null
 harnessMaxTurns: number | null
 harnessAutoApprove: boolean
 harnessPlanner: boolean
 harnessDelegates: string[]
 harnessBudgetCapUsd: number | null
 },
): Promise<AgentPersona>
}

export interface PersonaGroupRepositoryPort {
 create(input: { workspaceId: WorkspaceId; name: string; personaIds: string[] }): Promise<PersonaGroup>
 listByWorkspace(workspaceId: WorkspaceId): Promise<PersonaGroup[]>
 update(
 workspaceId: WorkspaceId,
 id: PersonaGroupId,
 patch: { name: string; personaIds: string[] },
): Promise<PersonaGroup>
 delete(workspaceId: WorkspaceId, id: PersonaGroupId): Promise<void>
}

/**
 * The structured event tier and idempotency ledger.
 */
export interface AgentRunEventRepositoryPort {
 /**
 * Appends one event. Returns `false` when (agentRunId, seq) was already
 * ingested — that is the idempotency check, and the caller must then skip
 * every side effect (message append, status transition) rather than repeat it.
 */
 append(input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 seq: number
 kind: string
 payload: Record<string, unknown>
 }): Promise<boolean>
 /**
 * Highest `seq` ingested for a run, or 0 if none. What a reconnecting Runner
 * needs in order to continue the sequence instead of restarting it at 1 —
 * restarting would make every new event collide with an old one and silently
 * vanish.
 */
 highestSeq(workspaceId: WorkspaceId, agentRunId: AgentRunId): Promise<number>
}

/**
 * The kill switch's persistence. Its own port
 * rather than a method on `AgentRunRepositoryPort`: the state belongs to the
 * workspace, not to any run.
 */
export interface WorkspaceRunControlRepositoryPort {
 get(workspaceId: WorkspaceId): Promise<WorkspaceRunControl>
 set(
 workspaceId: WorkspaceId,
 patch: { paused: boolean; pausedByUserId: string | null },
): Promise<WorkspaceRunControl>
}

export interface ApprovalRepositoryPort {
 create(input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 toolUseId: string
 toolName: string
 input: Record<string, unknown>
 }): Promise<ApprovalRequest>
 findById(workspaceId: WorkspaceId, id: ApprovalRequestId): Promise<ApprovalRequest | null>
 listPendingByRun(workspaceId: WorkspaceId, agentRunId: AgentRunId): Promise<ApprovalRequest[]>
 /**
 * Every pending approval, workspace-agnostic — backs the approval SLA sweep
 *. Same deliberate exception to this port's per-workspace
 * convention, for the same reason, as `AgentRunRepositoryPort.listAllActive`:
 * it's an internal background sweep, never reachable through the contract, so
 * there is no caller whose authz boundary it could cross.
 */
 listAllPending: Promise<ApprovalRequest[]>
 /**
 * `resolvedByUserId: null` marks a resolution no human made — the kill switch
 * denying a dead run's gate, or the approval SLA auto-denying an expired one
 *. That is *not* a hole in identity-bound approval's identity binding: `decideApproval`
 * is the only path a client can reach, and it still requires a `user` actor.
 * These null resolutions are system sweeps that can only ever deny.
 */
 resolve(
 workspaceId: WorkspaceId,
 id: ApprovalRequestId,
 patch: { status: ApprovalStatus; resolvedByUserId: UserId | null },
): Promise<ApprovalRequest>
}

export interface DirectoryEntry {
 readonly name: string
 readonly path: string
 readonly isDirectory: boolean
 readonly isRepository: boolean
}

export type ListDirectoryResult =
 | {
 readonly ok: true
 readonly path: string
 readonly parent: string | null
 readonly entries: DirectoryEntry[]
 readonly truncated: boolean
 }
 | { readonly ok: false; readonly error: string }

export type PathCheckResult =
 | { readonly ok: true; readonly defaultBranch: string }
 | { readonly ok: false; readonly error: string }

/**
 * The driven side of the Runner protocol. Implemented by apps/server/src/runner-gateway.ts,
 * which holds the actual per-Runner WebSocket connections; this port is what
 * lets use-cases send commands to a Runner without knowing sockets exist.
 */
export interface RunDispatchPort {
 /** Validates `path` against the Runner's own allowed roots and confirms it's a git repo. */
 checkPath(input: { runnerId: RunnerId; path: string }): Promise<PathCheckResult>
 /**
 * Scoped directory listing — what backs the directory picker. An
 * empty `path` lists the Runner's allowed roots, so no client needs to know a
 * real filesystem path to start browsing.
 */
 listDirectory(input: { runnerId: RunnerId; path: string }): Promise<ListDirectoryResult>
 /** Creates a new git repository under an allowed root. */
 initRepository(input: {
 runnerId: RunnerId
 parentPath: string
 name: string
 }): Promise<{ ok: true; path: string; defaultBranch: string } | { ok: false; error: string }>
 /**
 * Runs a repository's install command in a sandbox to fill the shared dependency
 * cache. Operator-triggered; no agent is involved, which is what makes
 * the resulting cache safe for runs to inherit.
 */
 warmCache(input: {
 runnerId: RunnerId
 repositoryPath: string
 defaultBranch: string
 installCommand: string
 }): Promise<{ ok: true } | { ok: false; detail: string }>
 /** Fire-and-forget: instructs the connected Runner to start executing. Throws if not connected. */
 startRun(input: {
 runnerId: RunnerId
 runId: AgentRunId
 persona: PersonaSpec
 cwd: string
 defaultBranch: string
 /** What a human asked for via `@mention`; absent for the sidebar-picker path. */
 task?: string
 /**
 * The tree's worker-notes ledger, already rendered and already fenced — absent for the first run in a tree, which has no shared context
 * to be given.
 *
 * Rendered server-side rather than sent as structured notes for the Runner to
 * format: the untrusted-fencing in `renderNotesForPrompt` *is* the mitigation,
 * and a second formatter on the Runner would be a second place to get it wrong.
 */
 contextLedger?: string
 /**
 * Start this run as a reconciler over another run's conflicted branch
 *. Changes how the Runner prepares the workspace — a
 * paused rebase rather than a fresh branch — and how it ends it.
 */
 reconcile?: { parentRunId: AgentRunId; branchName: string }
 }): Promise<void>
 /**
 * Aborts a run mid-flight. Fire-and-forget and
 * deliberately tolerant of a disconnected Runner: the server marks the run
 * `cancelled` either way, since a Runner it cannot reach cannot be the thing
 * that decides whether a stop takes effect.
 */
 cancelRun(input: { runnerId: RunnerId; runId: AgentRunId }): Promise<void>
 /**
 * Relays a human's decision back to the Runner that is blocked awaiting it.
 * Keyed by `toolUseId` (what the SDK's canUseTool callback actually holds),
 * not our internal approval_request id — the Runner doesn't need to know
 * that id exists.
 */
 sendApprovalDecision(input: {
 runnerId: RunnerId
 toolUseId: string
 decision: 'allow' | 'deny'
 }): Promise<void>
 /** Asks the Runner for the run's branch diff on demand. */
 getDiff(input: {
 runnerId: RunnerId
 runId: AgentRunId
 }): Promise<{ ok: true; diff: string } | { ok: false; error: string }>
 /** Instructs the Runner to delete the run's on-disk clone after a human discards the branch. */
 discardRun(input: {
 runnerId: RunnerId
 runId: AgentRunId
 }): Promise<{ ok: true } | { ok: false; error: string }>
 /**
 * Host-side pushes the run's branch to the bound repo's `origin` and
 * best-effort opens a PR/MR. `acknowledgeCiChange`
 * confirms human review of a push the policy would otherwise block for
 * touching CI config.
 */
 pushRun(input: {
 runnerId: RunnerId
 runId: AgentRunId
 acknowledgeCiChange: boolean
 }): Promise<
 | { ok: true; prUrl?: string; compareUrl?: string; warning?: string }
 | { ok: false; error: string }
 >
 /**
 * Rebases one queued branch onto its repository's default branch, verifies it,
 * and fast-forwards. Serialization is the caller's — this
 * port merges exactly the one entry it is given.
 *
 * A far longer timeout than the other dispatch calls: verification is a test
 * suite, not a git command.
 */
 mergeRun(input: {
 runnerId: RunnerId
 runId: AgentRunId
 verifyCommand: string | null
 }): Promise<
 | { ok: true; commitSha: string; verified: boolean; note?: string }
 | { ok: false; reason: MergeFailureReason; detail: string }
 >
}
