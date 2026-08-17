import type {
 AtlasEdgeStatus,
 AtlasRelation,
 ColosseumClaim,
 ColosseumSession,
 Envelope,
 ColosseumParticipant,
 ColosseumPurpose,
 ColosseumStatus,
 ExpertiseArm,
 MasteryDirective,
 RosterDiversity,
 ExpertiseArmTally,
 RetrievalOverride,
 ApprovalMode,
 ChannelId,
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
 RunVerification,
 RunVerificationId,
 VerificationCheck,
 VerificationCheckResult,
 VerificationStatus,
 PersonaCapability,
 PersonaGroup,
 PersonaGroupId,
 PersonaRevision,
 PersonaRevisionAuthorKind,
 PersonaRevisionId,
 PromptArm,
 PromptArmTally,
 PersonaVariant,
 PersonaVariantSet,
 PersonaVariantId,
 PersonaVariantSetId,
 VariantArmTally,
 PersonaSpec,
 Repository,
 RepositoryId,
 Runner,
 RunnerId,
 ThreadId,
 UserId,
 WorkerNote,
 WorkerNoteKind,
 MapEdge,
 MapFragmentEdge,
 MapFragmentNode,
 MapNode,
 MapNodeKind,
 MapSubjectKind,
 MasteryCheckpoint,
 SubjectMap,
 SubjectMapId,
 SubjectMapStatus,
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
 /**
 * Forgets a Runner and its pairing credential.
 *
 * Callers must have checked that nothing is bound to it — the schema cascades
 * runner → repository → agent_run, so an unchecked delete here would take a
 * workspace's run history and its recorded spend with it.
 */
 delete(workspaceId: WorkspaceId, id: RunnerId): Promise<void>
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
 /** Unbinds a repository. Cascades to its runs — see `unbindRepository` for the gate. */
 delete(workspaceId: WorkspaceId, id: RepositoryId): Promise<void>
 countByRunner(workspaceId: WorkspaceId, runnerId: RunnerId): Promise<number>
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
 /**
 * This repository's definition of done. Replaces the list
 * wholesale rather than patching one check: the order is a dependency order, so an
 * edit that could only append would make "run the build first" unreachable.
 */
 setVerificationChecks(
 workspaceId: WorkspaceId,
 id: RepositoryId,
 checks: readonly VerificationCheck[],
): Promise<Repository>
 /** What warms this repository's dependency cache. */
 setInstallCommand(
 workspaceId: WorkspaceId,
 id: RepositoryId,
 installCommand: string | null,
): Promise<Repository>
 /**
 * Whether a reconciler may attempt a conflicted branch here — the per-repository half of what `LOOM_RECONCILER_ENABLED` used to decide
 * for a whole process.
 */
 setReconcilerEnabled(
 workspaceId: WorkspaceId,
 id: RepositoryId,
 enabled: boolean,
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
 * The verification harness's persistence.
 *
 * Shaped like `MergeQueueRepositoryPort` on purpose, and the resemblance is the design
 * rather than a copy: verification is a queue with the same two properties — a job that
 * runs a test suite, and at most one of them per repository at a time — so it needs the
 * same claim-or-lose-the-race primitive, backed by the same kind of unique partial index
 * rather than by anything the sweep believes.
 *
 * `enqueue` is an upsert on the run, because the row is one per run: a re-verification
 * is the same question asked again, not a second record whose reader has to work out
 * which of two verdicts is current.
 */
export interface RunVerificationRepositoryPort {
 enqueue(input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 repositoryId: RepositoryId
 branchName: string
 }): Promise<RunVerification>
 findByRun(workspaceId: WorkspaceId, agentRunId: AgentRunId): Promise<RunVerification | null>
 listByRuns(workspaceId: WorkspaceId, agentRunIds: readonly AgentRunId[]): Promise<RunVerification[]>
 /**
 * Every unstarted verification, workspace-agnostic — the same deliberate exception to
 * this layer's per-workspace convention as `listAllOpen`, and for the same reason: it
 * backs an internal sweep with no caller whose authz boundary it could cross.
 */
 listAllPending: Promise<RunVerification[]>
 /**
 * Marks one row as being worked on, or returns null.
 *
 * Null is the serialization working, not an error — exactly as it is for the merge
 * queue. Two servers sweeping concurrently both see the same pending row; the unique
 * partial index lets one start it and the other has nothing to do this tick.
 */
 claim(workspaceId: WorkspaceId, id: RunVerificationId): Promise<RunVerification | null>
 /**
 * Terminal transition. Returns null when the row is already terminal, and writes
 * nothing: a Runner answering after the sweep abandoned its verification must not
 * overwrite the record a human has already read.
 */
 finish(
 workspaceId: WorkspaceId,
 id: RunVerificationId,
 patch: {
 status: Exclude<VerificationStatus, 'pending'>
 commitSha?: string | null
 checks?: readonly VerificationCheckResult[]
 reason?: string | null
 },
): Promise<RunVerification | null>
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
 * A subtask waiting on another.
 *
 * See `plan_subtask` in the schema for why a waiting subtask is not modelled as an
 * `agent_run` in a new status. Briefly: a run row is what the concurrency limit
 * counts, the reaper sweeps, the kill switch cancels and a Runner declares resumable,
 * and a row that is none of those while looking like all of them would need every one
 * of those invariants amended.
 */
export interface PlanSubtaskRecord {
 readonly id: string
 readonly workspaceId: WorkspaceId
 readonly plannerRunId: AgentRunId
 readonly position: number
 readonly title: string
 readonly task: string
 readonly personaName: string
 readonly paths: string[]
 readonly dependsOn: number[]
 /** Which sibling `position` this subtask reviews, or null. */
 readonly reviews: number | null
 /**
 * Which repository this subtask lands in, by name, or null for the planner's own
 *. A name, not an id — see the column's own comment: the
 * check against the team runs when the run starts, not when the plan was submitted.
 */
 readonly repository: string | null
 readonly status: 'waiting' | 'started' | 'skipped' | 'refused'
 readonly agentRunId: AgentRunId | null
 readonly detail: string | null
}

export interface PlanSubtaskRepositoryPort {
 /**
 * Records a whole decomposition at once. All-or-nothing on purpose: a half-written
 * pipeline is a plan whose later stages can never be released, and there is no
 * repair path for one — the planner has already stopped.
 */
 recordPlan(input: {
 workspaceId: WorkspaceId
 plannerRunId: AgentRunId
 subtasks: readonly {
 position: number
 title: string
 task: string
 repository?: string | null
 personaName: string
 paths: string[]
 dependsOn: number[]
 reviews: number | null
 status: 'waiting' | 'started' | 'skipped' | 'refused'
 agentRunId: AgentRunId | null
 detail: string | null
 }[]
 }): Promise<PlanSubtaskRecord[]>
 listByPlanner(workspaceId: WorkspaceId, plannerRunId: AgentRunId): Promise<PlanSubtaskRecord[]>
 /**
 * Finds the plan a started child belongs to, so a child reaching a terminal state
 * can release or skip whatever was waiting on it. Null for a child that was not
 * started from a recorded plan — every run that predates the collaboration topology, and every run started
 * by a human.
 */
 findByAgentRun(workspaceId: WorkspaceId, agentRunId: AgentRunId): Promise<PlanSubtaskRecord | null>
 /**
 * Moves one subtask out of `waiting`, and **only** out of `waiting`.
 *
 * The conditional is the concurrency control, not a sanity check: two siblings
 * finishing at the same moment both evaluate the same dependency set and both try
 * to release the same successor. Whoever loses gets null and starts nothing, which
 * is the same shape as `claimAggregation`'s fix for the duplicated plan summary.
 */
 claimWaiting(input: {
 workspaceId: WorkspaceId
 id: string
 status: 'started' | 'skipped' | 'refused'
 agentRunId: AgentRunId | null
 detail: string | null
 }): Promise<PlanSubtaskRecord | null>
 /**
 * Writes what became of a row this caller already claimed as `started`.
 *
 * Needed because `claimWaiting` — correctly — only ever matches a `waiting` row, and
 * the release has to claim *before* it starts a run or two siblings finishing at once
 * would start the same subtask twice. That leaves the run id to be written afterwards,
 * and `claimWaiting` cannot do it.
 *
 * **The missing half of that was a real bug, not a tidiness issue.** A released
 * subtask whose row never recorded its run id is a subtask `findByAgentRun` cannot
 * find, so when that run finished nothing released *its* dependents: every plan of
 * three or more stages stopped after the second, with the rest sitting in `waiting`
 * forever and no error anywhere. Every test of the feature had been two stages.
 *
 * Safe without a claim of its own: the caller holds this row by having won
 * `claimWaiting`. The `started` predicate is belt and braces — it guarantees this can
 * never resurrect a `skipped` row or overwrite a `waiting` one another caller is
 * about to claim.
 */
 settleClaimed(input: {
 workspaceId: WorkspaceId
 id: string
 status: 'started' | 'refused'
 agentRunId: AgentRunId | null
 detail: string | null
 }): Promise<PlanSubtaskRecord | null>
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
 /** What this run was asked to do — see `AgentRun.task`. */
 task?: string
 }): Promise<AgentRun>
 /** Children of one run — the tree view's per-parent lookup. */
 listByParent(workspaceId: WorkspaceId, parentRunId: AgentRunId): Promise<AgentRun[]>
 /**
 * Claims the right to report this run's plan.
 * Returns true exactly once per run, for the caller that won.
 *
 * A claim rather than a check, and it is the whole fix: "only the last sibling
 * reports" was a read-then-write, so two children reaching a terminal status
 * concurrently both saw "all terminal" and both posted a summary. Byte-identical
 * duplicates, observed in a real workspace. Implementations must make this one
 * conditional write, not a read followed by a write.
 */
 claimAggregation(workspaceId: WorkspaceId, id: AgentRunId): Promise<boolean>
 /**
 * Every run at or below `rootRunId`, in creation order — the whole tree, not one
 * generation of it.
 *
 * Separate from `listByParent` because the two answer different questions and the
 * difference is invisible until a tree is three levels deep: the board built itself
 * from `[root,...listByParent(root)]` and was correct only while a Planner's
 * children were all leaves. A sub-planner's workers would simply not appear —
 * no error, a board that quietly omits the runs doing the work.
 *
 * Depth-bounded in the adapter rather than trusted to terminate: a cycle from a bad
 * backfill must degrade the answer, not spin the query.
 */
 listTree(workspaceId: WorkspaceId, rootRunId: AgentRunId): Promise<AgentRun[]>
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
 /**
 * How many runs reference a repository, and how many of those are still live.
 *
 * Deletion asks both: cascading a repository away destroys its run history and the
 * spend recorded against it, so the count is what turns a refusal into an
 * explanation, and the live count is what makes the refusal unconditional.
 */
 countByRepository(
 workspaceId: WorkspaceId,
 repositoryId: RepositoryId,
): Promise<{ total: number; active: number }>
 /** The same question for a channel, whose threads own the runs started in them. */
 countByChannel(
 workspaceId: WorkspaceId,
 channelId: ChannelId,
): Promise<{ total: number; active: number }>
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
 /**
 * Liveness, and — when the Runner sampled it — how full the run's context window is
 *. One write for both, because they arrive on one frame; passing no
 * context leaves the stored figure untouched rather than nulling it.
 */
 recordHeartbeat(
 workspaceId: WorkspaceId,
 id: AgentRunId,
 context?: { tokens: number; maxTokens: number } | undefined,
): Promise<void>
 /**
 * Stamps that the platform has told this run its window is filling, and
 * says whether *this* call was the one that stamped it.
 *
 * Conditional on the stamp being absent, in the update itself: heartbeats arrive every
 * few seconds and a read-then-write would nudge the same run on every one of them from
 * the moment it crosses the threshold. A nudge repeated is a nudge ignored, and this is
 * a run that by hypothesis has no room to spare.
 */
 markHandoffSuggested(workspaceId: WorkspaceId, id: AgentRunId): Promise<boolean>
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
 /**
 * Runs a human has already decided about, newest first.
 *
 * The other half of the Inbox. `listNeedsAttention` answers "what is waiting on me",
 * which is the question that gets you through a day; this answers "what came out",
 * which is the one you cannot answer at all today without opening runs one at a time.
 *
 * Windowed by count rather than by age, because a workspace that has been quiet for a
 * week should still show its last outcomes rather than an empty board — "nothing
 * happened recently" and "nothing has ever happened" send a reader to different places.
 */
 listSettled(workspaceId: WorkspaceId, limit: number): Promise<AgentRun[]>
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
 /** Hosts this grant opens through the egress proxy, already validated. */
 egressHosts: string[]
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
 harnessApprovalMode: ApprovalMode
 harnessPlanner: boolean
 harnessDelegates: string[]
 harnessBudgetCapUsd: number | null
 /**
 * The self-modification ceiling. Null means this persona may not
 * rewrite itself — see `maySelfModify` for why absence is a refusal rather than a
 * blank cheque.
 */
 envelope: Envelope | null
 /** The markdown the platform seeded, for a built-in — see `seedBuiltinPersonas`. */
 builtinSource?: string
 }): Promise<AgentPersona>
 findById(workspaceId: WorkspaceId, id: AgentPersonaId): Promise<AgentPersona | null>
 listByWorkspace(workspaceId: WorkspaceId): Promise<AgentPersona[]>
 /**
 * Removes a persona. Safe for history: a run snapshots the whole `PersonaSpec` at
 * start, so past runs keep their persona, their model and their cost.
 */
 delete(workspaceId: WorkspaceId, id: AgentPersonaId): Promise<void>
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
 harnessApprovalMode: ApprovalMode
 harnessPlanner: boolean
 harnessDelegates: string[]
 harnessBudgetCapUsd: number | null
 /** The ceiling. Sent on every save, because a removed `envelope:` block is a change. */
 envelope: Envelope | null
 /**
 * Only `seedBuiltinPersonas` sends this, when it brings an untouched built-in
 * forward. A human's edit deliberately leaves it alone: the recorded seed is
 * what makes "untouched" answerable at all, and rewriting it on every save
 * would make every persona look untouched forever.
 */
 builtinSource?: string
 },
 /**
 * What this save replaces, recorded in the same transaction.
 *
 * A third argument rather than a field on the patch, because it is not part of the
 * new state: it is the old one. And in the same transaction rather than a second
 * call, because the two orders fail differently and both failures are bad — record
 * then update leaves a history entry for an edit that never happened, update then
 * record loses the only copy of the superseded prompt.
 *
 * Optional so that a caller with no revision to record — seeding a built-in, say —
 * is not made to invent one.
 */
 revision?: {
 /** The markdown being replaced. The caller has it; the port does not re-read it. */
 markdownSource: string
 replacedByKind: PersonaRevisionAuthorKind
 replacedByRunId?: AgentRunId | null
 replacedByUserId?: UserId | null
 rationale?: string
 },
): Promise<AgentPersona>
 /** Newest first — the top of the list is the version immediately before the live one. */
 listRevisions(
 workspaceId: WorkspaceId,
 personaId: AgentPersonaId,
 limit?: number,
): Promise<PersonaRevision[]>
 /**
 * Every persona's, newest first — one query rather than one per persona, which is what
 * lets a list of personas say which of them an agent has rewritten.
 */
 listRevisionsByWorkspace(workspaceId: WorkspaceId, limit?: number): Promise<PersonaRevision[]>
 findRevision(
 workspaceId: WorkspaceId,
 revisionId: PersonaRevisionId,
): Promise<PersonaRevision | null>
 /** Backs the per-run self-edit cap — the same shape `worker_note` uses for its own. */
 countRevisionsByRun(workspaceId: WorkspaceId, agentRunId: AgentRunId): Promise<number>

 /**
 * The agent-authored revision currently being measured, or null.
 *
 * Newest first and undecided: an edit a human has ruled on is settled, and only the
 * most recent one is on trial — two live trials on one persona would be two
 * counterfactuals with no way to tell which prompt produced which outcome.
 */
 findRevisionOnTrial(
 workspaceId: WorkspaceId,
 personaId: AgentPersonaId,
): Promise<PersonaRevision | null>
 /** Ends the trial. Called by a human keeping the edit, and by a revert discarding it. */
 decideTrial(workspaceId: WorkspaceId, revisionId: PersonaRevisionId): Promise<void>
 /** Which prompt this run was given while a revision is on trial. */
 recordTrialUse(input: {
 workspaceId: WorkspaceId
 personaId: AgentPersonaId
 revisionId: PersonaRevisionId
 agentRunId: AgentRunId
 arm: PromptArm
 }): Promise<void>
 /**
 * How many runs each arm has been *assigned*, in flight included.
 *
 * Distinct from the tally below, which counts only decided runs: alternation has to
 * balance what has been handed out, or a burst of concurrent starts all land on the
 * same side while none of them has finished.
 */
 countTrialArms(
 workspaceId: WorkspaceId,
 revisionId: PersonaRevisionId,
): Promise<{ revised: number; previous: number }>
 /**
 * Outcomes per arm, joined from the runs and their verifications — never copied onto the
 * use row.
 *
 * "Decided" is a disposition, a failed run, **or a branch that failed its repository's
 * definition of done**. The last one is what makes this a fitness rather
 * than a record of what reviewers had time for, and it must match
 * `tallyExpertiseOutcomes` exactly: the two are one query written twice.
 */
 tallyTrialOutcomes(
 workspaceId: WorkspaceId,
 revisionId: PersonaRevisionId,
): Promise<PromptArmTally[]>
}

/**
 * The searching half of the self-improvement loop — candidates, the
 * arms they are measured on, and the human's settlement.
 *
 * Nothing here decides anything: the rules are `prompt-variants.ts`, the fitness is
 * `summarizeVariantSearch`, and the two human acts are use cases. This is storage.
 */
export interface PersonaVariantRepositoryPort {
 /**
 * Opens a search with its candidates, in one transaction.
 *
 * Rejects — by unique index, not by check — when this persona already has an open one.
 * Two searches on one persona would split a workspace's runs across more arms than it
 * can fill, so the second proposer loses the race and is told so.
 */
 openSet(input: {
 workspaceId: WorkspaceId
 personaId: AgentPersonaId
 proposedByRunId?: AgentRunId
 candidates: readonly { markdownSource: string; rationale: string }[]
 }): Promise<{ set: PersonaVariantSet; variants: PersonaVariant[] }>

 /** The measurement in progress for this persona, if there is one. Read at every start. */
 findOpenSet(
 workspaceId: WorkspaceId,
 personaId: AgentPersonaId,
): Promise<{ set: PersonaVariantSet; variants: PersonaVariant[] } | null>

 findSet(
 workspaceId: WorkspaceId,
 setId: PersonaVariantSetId,
): Promise<{ set: PersonaVariantSet; variants: PersonaVariant[] } | null>

 /**
 * Every open search in the workspace, with its candidates. Usually none.
 *
 * One query rather than one per persona: a client refreshing a settings panel must not
 * pay a round trip per persona for a state almost none of them is ever in.
 */
 listOpenSets(
 workspaceId: WorkspaceId,
): Promise<{ set: PersonaVariantSet; variants: PersonaVariant[] }[]>

 /** Which arm a run went on. `variantId` absent is the incumbent — the prompt in use. */
 recordVariantUse(input: {
 workspaceId: WorkspaceId
 setId: PersonaVariantSetId
 variantId?: PersonaVariantId | null
 agentRunId: AgentRunId
 }): Promise<void>

 /** Assigned runs per arm, in flight included — what `nextVariantArm` balances. */
 countVariantArms(
 workspaceId: WorkspaceId,
 setId: PersonaVariantSetId,
): Promise<{ variantId: PersonaVariantId | null; count: number }[]>

 /**
 * Outcomes per arm, joined from the runs and their verifications.
 *
 * Must use the same definition of "decided" as `tallyTrialOutcomes` and
 * `tallyExpertiseOutcomes` — a disposition, a failed run, or a branch that failed its
 * repository's definition of done. Three tallies with three definitions would make the
 * three panels incomparable.
 */
 tallyVariantOutcomes(
 workspaceId: WorkspaceId,
 setId: PersonaVariantSetId,
): Promise<VariantArmTally[]>

 /**
 * Ends the search — a promotion names the winner, a discard names nobody.
 *
 * Returns null when the set was not open, which is how a double settle stays a no-op
 * instead of recording the second click.
 */
 settleSet(
 workspaceId: WorkspaceId,
 setId: PersonaVariantSetId,
 input: { promotedVariantId?: PersonaVariantId | null; settledByUserId?: UserId | null },
): Promise<PersonaVariantSet | null>
}

export interface PersonaGroupRepositoryPort {
 create(input: { workspaceId: WorkspaceId; name: string; personaIds: string[] }): Promise<PersonaGroup>
 listByWorkspace(workspaceId: WorkspaceId): Promise<PersonaGroup[]>
 update(
 workspaceId: WorkspaceId,
 id: PersonaGroupId,
 /**
 * `layout` absent leaves the stored positions alone, and `fleet` absent leaves the stored widths alone — a client
 * that draws neither means "do not touch them", not "clear them".
 */
 patch: {
 name: string
 /**
 * What this team is for. Absent leaves the stored line alone, like
 * `layout` — a client that does not offer the field is not saying to clear it.
 */
 description?: string
 personaIds: string[]
 layout?: Record<string, { x: number; y: number }>
 fleet?: Record<string, number>
 reviewers?: Record<string, string[]>
 /**
 * The chain of command, keyed by worker. Absent leaves it alone like the
 * three above; an empty object clears it, which is a team saying it has no chain of
 * command rather than a client that did not draw one.
 */
 reportsTo?: Record<string, string>
 /** The root, as the canvas's vantage. Null clears it; absent leaves it. */
 orchestratorId?: string | null
 /** The team repository. Null clears it; absent leaves it, likewise. */
 repositoryId?: string | null
 /**
 * The other repositories this team's subtasks may name. Absent
 * leaves them alone; `[]` clears them, which is a team saying it works in one place.
 */
 extraRepositoryIds?: string[]
 },
): Promise<PersonaGroup>
 delete(workspaceId: WorkspaceId, id: PersonaGroupId): Promise<void>
 /**
 * Drops a persona from every group that lists it, and answers how many changed.
 *
 * Membership is a plain id array with no foreign key, so nothing in the database
 * removes a deleted persona from the groups holding it — the entry survives as a
 * chip with no name behind it. `deletePersona` used to do this itself, reading every
 * group and writing back the ones that matched. That works and is the wrong place
 * for it: a use case cannot know what else references a group, and the next
 * reference added would have to remember to repeat the chore. Behind the port, the
 * adapter that owns the storage owns the integrity, and can do it in one statement.
 */
 prunePersona(workspaceId: WorkspaceId, personaId: string): Promise<number>
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
 /**
 * What each of these runs is doing right now, as a projection of events already persisted.
 *
 * Batched over the whole tree in one statement, because the cost discipline is
 * explicit: "None of this may add a per-tick query. The board is already one fetch on
 * a socket nudge." One query for N runs meets that; one per card would not.
 */
 liveActivity(
 workspaceId: WorkspaceId,
 agentRunIds: readonly AgentRunId[],
): Promise<Map<string, RunLiveActivity>>
 /**
 * Repository-relative paths this run was **observed** writing.
 *
 * From the persisted `tool_call` events rather than from anything the run said, which
 * is the whole point: the brief is written by a model that is by hypothesis running low
 * on room, and the check is only worth having if its other side is independent of it.
 */
 writtenPaths(workspaceId: WorkspaceId, agentRunId: AgentRunId): Promise<string[]>
}

/**
 * A run's observable present tense. Timestamps rather than durations: how long ago
 * something happened is a rendering, and a payload that carried "4m idle" would be
 * wrong the moment it was cached.
 */
export interface RunLiveActivity {
 /**
 * The call in flight: the newest `tool_call` whose `toolUseId` has no matching
 * `tool_result`. Correlating on the id rather than on position matters here for the
 * same reason it does in the thread — a model issues calls in parallel, and "the last
 * call with no result after it" names the wrong one whenever more than one is open.
 */
 readonly currentToolName: string | null
 /** The call's primary argument — the "which file is it in" answer. */
 readonly currentToolTarget: string | null
 /** How many calls are open at once, so a fan-out reads as one rather than as none. */
 readonly openCallCount: number
 /** Last event of any kind. Null for a run that has emitted nothing yet. */
 readonly lastEventAt: Date | null
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
 /**
 * When the platform suggests a handoff, and how many a tree may make.
 *
 * A separate method from `set` rather than an optional field on it, because the two are
 * different acts: one is the kill switch, which an operator hits in an emergency, and
 * the other is policy they edit deliberately. A patch that could do both would let a
 * pause quietly rewrite a threshold.
 */
 setHandoffPolicy(
 workspaceId: WorkspaceId,
 patch: { threshold: number | null; capPerTree: number | null },
): Promise<WorkspaceRunControl>
 /**
 * Whether a decomposition waits for a human.
 *
 * Its own method for the reason `setHandoffPolicy` is: this is policy an operator edits
 * deliberately, and folding it into `set` would let hitting the kill switch quietly turn
 * a review gate off.
 */
 setPlanReviewRequired(
 workspaceId: WorkspaceId,
 required: boolean,
): Promise<WorkspaceRunControl>
}

export interface ApprovalRepositoryPort {
 create(input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 toolUseId: string
 toolName: string
 input: Record<string, unknown>
 /**
 * Set when this gate carries a clarifying question rather than a tool call
 *. Model-authored, so untrusted — see `ApprovalRequest.question`.
 */
 question?: string
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
 patch: { status: ApprovalStatus; resolvedByUserId: UserId | null; answer?: string },
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
 /**
 * Which repository is being warmed, so the Runner can key the prepared dependency
 * tree it captures to the repository rather
 * than to a path two Runners could both hold.
 */
 repositoryId: RepositoryId
 repositoryPath: string
 defaultBranch: string
 installCommand: string
 /**
 * `detail` is present on success too: the base-image half means a warm can
 * succeed and still have nothing to hand a run, and "warmed" alone cannot say
 * which happened.
 */
 }): Promise<{ ok: true; detail?: string } | { ok: false; detail: string }>
 /** Fire-and-forget: instructs the connected Runner to start executing. Throws if not connected. */
 startRun(input: {
 runnerId: RunnerId
 runId: AgentRunId
 persona: PersonaSpec
 cwd: string
 defaultBranch: string
 /** Which repository this run is against, so the Runner can hand it that repository's prepared tree. */
 repositoryId?: RepositoryId
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
 * What this persona already knows about the subject it is working on, selected, rendered and fenced server-side for the same reason
 * `contextLedger` is.
 */
 mapContext?: string
 /**
 * Start this run as a mastery run: its deliverable is a map, and its
 * presence is what gives the run `record_map` at all.
 *
 * **Declared here, and the omission was a real bug.** Without it this field was an
 * excess property on a spread — which TypeScript deliberately does not check — so
 * the server built a frame carrying `mastery`, the type said nothing, and the field
 * never reached the Runner. Every unit test passed, the map row was created, the
 * revision resolved, and the model was simply never offered the tool. A live run
 * scored 0 nodes; nothing else noticed.
 */
 mastery?: {
 subjectKind: MapSubjectKind
 subjectRef: string
 /**
 * What this run was asked to look for. Declared here as well as on
 * the frame, because this port is exactly where the last such field was dropped
 * without a type error: a spread against a port that never declared it compiles,
 * and the tool the model never got cost a run and produced nothing.
 */
 directive?: MasteryDirective
 }
 /**
 * Start this run as a reconciler over another run's conflicted branch
 *. Changes how the Runner prepares the workspace — a
 * paused rebase rather than a fresh branch — and how it ends it.
 */
 reconcile?: { parentRunId: AgentRunId; branchName: string }
 /**
 * Start this run as a **reviewer** of a sibling's branch.
 * Changes how the Runner prepares the workspace: the reviewed run's clone with
 * that branch checked out, then this run's own branch cut from its tip.
 *
 * `targetRunId`, not `parentRunId` — a reviewer's parent is the planner, and the
 * branch belongs to a sibling.
 */
 review?: { targetRunId: AgentRunId; branchName: string }
 /**
 * Start this run as a **re-planning turn**.
 * The Runner's only decision from it is which channel a Planner gets:
 * `submit_plan_delta` instead of `submit_plan`.
 */
 steering?: boolean
 }): Promise<void>
 /**
 * Aborts a run mid-flight. Fire-and-forget and
 * deliberately tolerant of a disconnected Runner: the server marks the run
 * `cancelled` either way, since a Runner it cannot reach cannot be the thing
 * that decides whether a stop takes effect.
 */
 cancelRun(input: { runnerId: RunnerId; runId: AgentRunId }): Promise<void>
 /**
 * Delivers pre-rendered context into a run that is already working.
 *
 * Fire-and-forget and deliberately tolerant, like `cancelRun`: a run that finished
 * between the decision to deliver and the frame arriving has nothing to receive it,
 * and that is not a failure — the note is on the ledger, which is where the next
 * run reads it.
 */
 deliverToRun(input: { runnerId: RunnerId; runId: AgentRunId; text: string }): Promise<void>
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
 /**
 * The human's reply to a clarifying question.
 *
 * A separate method rather than an optional field on the one above, because the two
 * carry different frames and a caller must not be able to send a decision where an
 * answer is expected: the Runner is holding a tool call open on exactly one of them,
 * and the wrong frame leaves the run blocked until the reaper takes it.
 *
 * `answer: null` is a refusal — denied, or auto-denied by the SLA. Mid-flight steering: "a run
 * blocked forever on a question nobody saw is worse than a run that guessed and
 * said so", so the tool returns either way.
 */
 sendQuestionAnswer(input: {
 runnerId: RunnerId
 toolUseId: string
 answer: string | null
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
 checks: readonly VerificationCheck[]
 }): Promise<
 | { ok: true; commitSha: string; verified: boolean; changedPaths: string[]; note?: string }
 | { ok: false; reason: MergeFailureReason; detail: string }
 >
 /**
 * Runs a repository's definition of done against one finished run's own branch, in
 * its own clone.
 *
 * Returns what each check did and never a verdict: `summarizeVerification` decides
 * that, so a Runner cannot report a pass with a failing check in the list.
 *
 * Shares `mergeRun`'s long timeout for the same reason — this is a test suite, not a
 * git command.
 */
 verifyRun(input: {
 runnerId: RunnerId
 runId: AgentRunId
 checks: readonly VerificationCheck[]
 }): Promise<
 | { status: 'ran'; commitSha: string; checks: VerificationCheckResult[] }
 | { status: 'skipped' | 'refused' | 'error'; reason: string }
 >
}

/**
 * A persona's expertise in a subject.
 *
 * Its own port rather than methods on `PersonaRepositoryPort` for the same reason the
 * notes ledger has one: a map outlives the runs that wrote it and is read by runs that
 * did not, so it is not part of any one run's or persona edit's lifecycle.
 *
 * There is no `deleteNode`. Invalidation is a write — `invalidateNodes` stamps a
 * row rather than removing it, which is what lets a curation pass tell a claim it
 * already retired from one it never had, and what makes "this was true until commit
 * `abc`" sayable at all. Dropping a whole map is a persona-level act and cascades from
 * the persona or the repository.
 */
export interface SubjectMapRepositoryPort {
 /**
 * Creates the map or moves an existing one to a new revision.
 *
 * Upsert rather than insert, because mastering the same subject again must *update*
 * the map: a new map per run would leave retrieval guessing which of five is current,
 * which is the failure mastery means by "a map with no commit is a rumour" wearing a
 * different hat.
 */
 upsertMap(input: {
 workspaceId: WorkspaceId
 personaId: AgentPersonaId
 subjectKind: MapSubjectKind
 repositoryId: RepositoryId | null
 subjectRef: string
 revision: string
 status: SubjectMapStatus
 masteryRunId: AgentRunId | null
 }): Promise<SubjectMap>
 setStatus(
 workspaceId: WorkspaceId,
 mapId: SubjectMapId,
 status: SubjectMapStatus,
): Promise<SubjectMap | null>
 getMap(workspaceId: WorkspaceId, mapId: SubjectMapId): Promise<SubjectMap | null>
 findMapByRun(workspaceId: WorkspaceId, masteryRunId: AgentRunId): Promise<SubjectMap | null>
 listMapsForPersona(workspaceId: WorkspaceId, personaId: AgentPersonaId): Promise<SubjectMap[]>
 listMapsForRepository(workspaceId: WorkspaceId, repositoryId: RepositoryId): Promise<SubjectMap[]>
 /**
 * Every map in the workspace.
 *
 * For the design canvas, which draws personas rather than runs and therefore has no
 * repository to filter by — the "a team has no repository" is still true. Cheap
 * because a workspace holds one map per (persona, subject), which is tens of rows, not
 * thousands.
 */
 listAllMaps(workspaceId: WorkspaceId): Promise<SubjectMap[]>
 /**
 * Workspaces holding at least one map worth curating.
 *
 * The idle sweep is process-wide and has no workspace registry to walk — the reaper
 * gets away with `listAllActive` because a run carries its workspace, and a curation
 * pass is per map. One `distinct` beats inventing a second way to enumerate tenants.
 */
 listWorkspacesWithMaps: Promise<WorkspaceId[]>
 /**
 * Writes one fragment, bi-temporally.
 *
 * A live node whose content is unchanged is *re-confirmed* at the new revision rather
 * than superseded — otherwise every re-mastering would invalidate the entire map and
 * write it again, and the invalidation history would record churn instead of change.
 */
 writeFragment(input: {
 workspaceId: WorkspaceId
 mapId: SubjectMapId
 revision: string
 nodes: readonly MapFragmentNode[]
 edges: readonly MapFragmentEdge[]
 }): Promise<{ nodesWritten: number; edgesWritten: number; superseded: number }>
 listNodes(workspaceId: WorkspaceId, mapId: SubjectMapId): Promise<MapNode[]>
 /**
 * Every live `concept` node in the workspace, with the subject and persona it came from
 * — the atlas's read side.
 *
 * One statement rather than a map list followed by a node read per map, because the
 * number of maps grows with the number of projects and this is called from a *tool* a
 * run may reach for at any moment. A per-map loop would put an unbounded number of
 * round-trips behind one model call.
 *
 * Concepts only, and that is the boundary rather than an optimisation: "extracted
 * structure never crosses a subject boundary", so a file or a symbol from another
 * repository has no business being offered here at all. What crosses is a concept, which
 * is `inferred` by construction.
 *
 * `excludeRepositoryId` drops the run's own subject, which it has already been handed.
 */
 listConceptsAcrossSubjects(
 workspaceId: WorkspaceId,
 options: { excludeRepositoryId?: RepositoryId; limit: number },
): Promise<
 {
 nodeId: string
 mapId: SubjectMapId
 label: string
 summary: string
 subjectRef: string
 personaName: string
 createdAt: Date
 }[]
 >
 /**
 * Live concepts in this workspace carrying a given label — how a proposal names its two
 * ends.
 *
 * **By label, and that is forced rather than chosen.** Neither surface a model sees
 * carries a node id: `renderMapForPrompt` renders a claim as a sentence, and an atlas
 * lead is one line by design. Putting an identifier on either would spend context on
 * plumbing in the one place this platform is most careful about it. So the model names
 * the two concepts in the words it was shown, and the platform resolves — and a label
 * that resolves to nothing is a real answer, because it means the model is relating
 * something it was never told about.
 *
 * Case-insensitive, and every candidate is returned rather than one: two subjects
 * holding the same label is exactly the interesting case, and picking one here would
 * decide the proposal instead of resolving it.
 */
 findConceptsByLabel(
 workspaceId: WorkspaceId,
 input: { label: string; repositoryId?: RepositoryId; subjectRef?: string },
): Promise<
 {
 nodeId: string
 mapId: SubjectMapId
 kind: MapNodeKind
 label: string
 summary: string
 subjectRef: string
 repositoryId: RepositoryId | null
 personaId: AgentPersonaId
 personaName: string
 }[]
 >
 listEdges(workspaceId: WorkspaceId, mapId: SubjectMapId): Promise<MapEdge[]>
 /** Live counts, which is what `MAX_NODES_PER_MAP` bounds. */
 countLive(
 workspaceId: WorkspaceId,
 mapId: SubjectMapId,
): Promise<{ nodes: number; edges: number }>
 invalidateNodes(
 workspaceId: WorkspaceId,
 nodeIds: readonly string[],
 reason: string,
): Promise<number>
 /**
 * Writes down what a curation pass intends to retire.
 *
 * `reason` null withdraws the proposal, which is a distinct act and the half that makes
 * the window real: a proposal that stopped being true is taken back rather than carried
 * out.
 */
 proposeRetirement(
 workspaceId: WorkspaceId,
 nodeIds: readonly string[],
 reason: string | null,
): Promise<number>
 appendCheckpoint(input: {
 workspaceId: WorkspaceId
 mapId: SubjectMapId
 agentRunId: AgentRunId | null
 filesRead: number
 filesInScope: number
 nodeCount: number
 edgeCount: number
 spendUsd: number
 }): Promise<MasteryCheckpoint>
 listCheckpoints(workspaceId: WorkspaceId, mapId: SubjectMapId): Promise<MasteryCheckpoint[]>

 /**
 * A human's standing answer about whether a map is used. Null hands
 * the decision back to the measurement, which is a third state and not the same as
 * `'off'` — one says "I have decided", the other says "keep measuring".
 */
 setRetrievalOverride(
 workspaceId: WorkspaceId,
 mapId: SubjectMapId,
 override: RetrievalOverride,
): Promise<SubjectMap | null>

 /**
 * Records which side of the trial one run was on.
 *
 * Idempotent per (run, map): a run is on one arm, and a second row would count it twice
 * in whichever arm it landed in — which is exactly the way an A/B measurement quietly
 * stops being one.
 */
 recordExpertiseUse(input: {
 workspaceId: WorkspaceId
 mapId: SubjectMapId
 agentRunId: AgentRunId
 arm: ExpertiseArm
 nodesShown: number
 edgesShown: number
 /**
 * **Which** claims were put in front of this run.
 *
 * Written by the same call as the count rather than by a second one, because the two
 * are one fact: a count that disagrees with the list is a measurement nobody can
 * trust, and mastery has already paid twice for a field that had to be written in two
 * places to arrive. Empty on the withheld arm — that run was shown nothing, which is
 * the whole point of it.
 */
 nodeIds: readonly string[]
 }): Promise<void>

 /**
 * What became of the runs each claim was shown to.
 *
 * Domain expertise asks for claims "ranked by the dispositions of runs that cited them", and this is
 * that join: per node, how many of the runs it was rendered into merged, were discarded,
 * or failed. Undecided runs are excluded for the reason `tallyExpertiseOutcomes` gives —
 * a run still in flight is not evidence either way.
 *
 * One query per map rather than per node: this is read on the dispatch path, where the
 * selection has to be ordered before a run can start.
 */
 tallyNodeOutcomes(
 workspaceId: WorkspaceId,
 mapId: SubjectMapId,
): Promise<Record<string, { decided: number; merged: number; discarded: number; failed: number }>>

 /**
 * How many runs are on each arm of a map's trial so far, including undecided ones.
 *
 * Separate from `tallyExpertiseOutcomes` because the two answer different questions at
 * different moments: this one decides where the *next* run goes and must count runs
 * that have not finished, while the tally judges the map and must count only runs that
 * have reached a disposition. Folding them together would let a burst of in-flight runs
 * all land on the same arm.
 */
 countExpertiseUses(
 workspaceId: WorkspaceId,
 mapId: SubjectMapId,
): Promise<{ retrieved: number; withheld: number }>

 /**
 * Each arm's outcomes, joined against the runs and their verifications at read time.
 *
 * One query for many maps, because the list surfaces need the effective retrieval state
 * per map and a query per map would make opening a persona's expertise list cost a
 * round trip per subject.
 *
 * "Decided" includes a branch that failed its repository's definition of done, which is the same definition `tallyTrialOutcomes` uses. Keeping them identical is
 * deliberate: the map trial and the prompt trial share their thresholds, so their arm
 * counts have to mean the same thing.
 */
 tallyExpertiseOutcomes(
 workspaceId: WorkspaceId,
 mapIds: readonly SubjectMapId[],
): Promise<Record<string, ExpertiseArmTally[]>>

 /**
 * Which maps these runs were handed, and which they were deliberately denied.
 *
 * Takes a list rather than one run because both callers want a set: the swarm graph
 * draws a whole tree's expertise in one fetch when it opens, and the cost rule is
 * that watching a swarm must not add a query per node.
 */
 listExpertiseUsesForRuns(
 workspaceId: WorkspaceId,
 agentRunIds: readonly AgentRunId[],
): Promise<
 {
 agentRunId: string
 mapId: string
 arm: ExpertiseArm
 nodesShown: number
 edgesShown: number
 }[]
 >
}

/**
 * The Colosseum's four properties, stored: a fixed roster, a spend
 * ceiling, a transcript and a verdict.
 *
 * Its own port because a session is not a run and not a map: it has participants, turns
 * and claims, and folding it into either would make half the fields on that port null for
 * everything else that uses it.
 */
export interface ColosseumRepositoryPort {
 convene(input: {
 workspaceId: WorkspaceId
 threadId: ThreadId
 repositoryId: RepositoryId | null
 purpose: ColosseumPurpose
 subject: string
 question: string
 turnCap: number
 spendCapUsd: number | null
 diversity: RosterDiversity
 participants: readonly ColosseumParticipant[]
 }): Promise<ColosseumSession>
 getSession(workspaceId: WorkspaceId, sessionId: string): Promise<ColosseumSession | null>
 listSessions(workspaceId: WorkspaceId): Promise<ColosseumSession[]>
 listParticipants(workspaceId: WorkspaceId, sessionId: string): Promise<ColosseumParticipant[]>
 setStatus(
 workspaceId: WorkspaceId,
 sessionId: string,
 status: ColosseumStatus,
): Promise<ColosseumSession | null>

 /**
 * Claims the floor for one run — false when somebody already has it.
 *
 * The check and the write are one statement, deliberately: two turn requests racing
 * would both read an empty floor and both start a run, and the loser's answer would
 * land in a transcript that had moved on without it. A session speaks one voice at a
 * time or its transcript is a set of overlapping monologues.
 */
 claimFloor(
 workspaceId: WorkspaceId,
 sessionId: string,
 input: { agentRunId: AgentRunId; personaId: AgentPersonaId },
): Promise<boolean>
 releaseFloor(workspaceId: WorkspaceId, sessionId: string): Promise<void>
 /** How a completing run finds the session it was speaking in, on the completion path. */
 findSessionSpeakingFor(
 workspaceId: WorkspaceId,
 agentRunId: AgentRunId,
): Promise<ColosseumSession | null>

 /** An opening claim, recorded before the first exchange. */
 recordClaim(input: {
 workspaceId: WorkspaceId
 sessionId: string
 statement: string
 originalHolderPersonaId: AgentPersonaId
 }): Promise<ColosseumClaim>
 listClaims(workspaceId: WorkspaceId, sessionId: string): Promise<ColosseumClaim[]>
 settleClaim(input: {
 workspaceId: WorkspaceId
 claimId: string
 verdict: 'upheld' | 'refuted'
 citation: string
 }): Promise<ColosseumClaim | null>
 dropClaim(workspaceId: WorkspaceId, claimId: string): Promise<ColosseumClaim | null>

 appendTurn(input: {
 workspaceId: WorkspaceId
 sessionId: string
 personaId: AgentPersonaId | null
 personaName: string
 agentRunId: AgentRunId | null
 text: string
 }): Promise<{ seq: number }>
 listTurns(
 workspaceId: WorkspaceId,
 sessionId: string,
): Promise<
 {
 seq: number
 personaName: string
 agentRunId: string | null
 text: string
 createdAt: Date
 }[]
 >
 countTurns(workspaceId: WorkspaceId, sessionId: string): Promise<number>
}

/**
 * Who read whose notes.
 *
 * Its own port rather than methods on `WorkerNoteRepositoryPort` because it records a
 * *relationship between runs*, not a note: nothing here reads or writes note content,
 * and the board draws it beside the collision edges rather than in the ledger.
 */
export interface NoteReadRepositoryPort {
 /**
 * Records that one run read notes authored by others. Idempotent per pair — a repeat
 * increments the count rather than adding a row, because the graph wants the
 * relationship and the count is the only part of the volume worth keeping.
 */
 recordReads(input: {
 workspaceId: WorkspaceId
 treeRunId: AgentRunId
 readerRunId: AgentRunId
 authorRunIds: readonly AgentRunId[]
 }): Promise<void>
 listByTree(workspaceId: WorkspaceId, treeRunId: AgentRunId): Promise<NoteReadEdge[]>
}

export interface NoteReadEdge {
 readonly readerRunId: AgentRunId
 readonly authorRunId: AgentRunId
 readonly readCount: number
 readonly lastReadAt: Date
}

/**
 * One end of a stored atlas relation, as read back with everything needed to render it.
 *
 * Denormalized on read rather than at write time, and that is the choice worth naming: a
 * label copied into the edge row would be the label as it was when somebody proposed the
 * relation, and a curation pass that rewords a concept would leave the atlas quoting a
 * sentence its own map no longer contains. The join costs one statement and always tells
 * the truth.
 */
export interface AtlasEdgeEnd {
 readonly nodeId: string
 readonly mapId: SubjectMapId
 readonly label: string
 readonly summary: string
 readonly subjectRef: string
 readonly personaName: string
 /** Whether the map still holds this claim — an endpoint can be superseded under the edge. */
 readonly live: boolean
}

export interface AtlasEdge {
 readonly id: string
 readonly relation: AtlasRelation
 readonly rationale: string
 readonly status: AtlasEdgeStatus
 readonly from: AtlasEdgeEnd
 readonly to: AtlasEdgeEnd
 readonly proposedByPersonaName: string
 readonly proposedByRunId: string | null
 readonly sessionId: string | null
 readonly decidedByName: string
 readonly decidedAt: Date | null
 readonly decisionNote: string
 readonly createdAt: Date
}

/**
 * The atlas's write side.
 *
 * Its own port rather than methods on `SubjectMapRepositoryPort`, for the reason
 * `NoteReadRepositoryPort` is separate: nothing here reads or writes a *map*. An atlas
 * edge is a relation between two maps that belongs to neither, and putting it on the map
 * port would suggest a map owns its half of one — which is exactly the mistake that would
 * make a re-mastering delete somebody's confirmed relation.
 */
export interface AtlasRepositoryPort {
 /**
 * Stores a proposal, or returns the existing row for that pair.
 *
 * Idempotent rather than erroring, because the caller is a model and a model that gets
 * an error for "this already exists" will rephrase and try again. Returning the row it
 * would have created lets the tool say *this was already proposed, here is where it
 * got to*, which is the answer a run actually needs.
 */
 propose(input: {
 workspaceId: WorkspaceId
 fromNodeId: string
 toNodeId: string
 relation: AtlasRelation
 rationale: string
 proposedByPersonaId: AgentPersonaId | null
 proposedByRunId: AgentRunId | null
 }): Promise<{ edge: AtlasEdge; created: boolean }>
 get(workspaceId: WorkspaceId, edgeId: string): Promise<AtlasEdge | null>
 /** The queue a human works through, and the list the canvas draws. */
 list(
 workspaceId: WorkspaceId,
 options?: { statuses?: readonly AtlasEdgeStatus[] },
): Promise<AtlasEdge[]>
 countByStatus(
 workspaceId: WorkspaceId,
 statuses: readonly AtlasEdgeStatus[],
): Promise<number>
 /**
 * The confirmed relations touching a set of concepts — the read side's half of this
 * table (mastery: "a confirmed edge stops being a lead and starts being ranked above
 * leads").
 *
 * Keyed by node id rather than by topic because matching stays lexical and stays in the
 * domain: this returns what is confirmed *about these concepts*, and the caller has
 * already decided which concepts the topic matched.
 */
 listPromotedTouching(
 workspaceId: WorkspaceId,
 nodeIds: readonly string[],
): Promise<AtlasEdge[]>
 attachSession(workspaceId: WorkspaceId, edgeId: string, sessionId: string): Promise<AtlasEdge | null>
 decide(input: {
 workspaceId: WorkspaceId
 edgeId: string
 status: Extract<AtlasEdgeStatus, 'promoted' | 'rejected'>
 decidedByUserId: UserId
 decidedByName: string
 note: string
 }): Promise<AtlasEdge | null>
}
