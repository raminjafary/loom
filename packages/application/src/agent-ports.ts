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
  PersonaGroup,
  PersonaGroupId,
  PersonaSpec,
  Repository,
  RepositoryId,
  Runner,
  RunnerId,
  ThreadId,
  UserId,
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
}

export interface AgentRunRepositoryPort {
  create(input: {
    workspaceId: WorkspaceId
    threadId: ThreadId
    repositoryId: RepositoryId
    runnerId: RunnerId
    persona: PersonaSpec
    /** Set for a run another run spawned (PLAN.md §5); absent for a human-started run. */
    parentRunId?: AgentRunId
    relation?: AgentRunRelation
  }): Promise<AgentRun>
  /** Children of one run — the tree view's per-parent lookup (PLAN.md §3 Views). */
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
  /** Set once the Runner finishes cloning (PLAN.md §5a) — a distinct event from a status transition. */
  recordWorkspace(
    workspaceId: WorkspaceId,
    id: AgentRunId,
    patch: { clonePath: string; branchName: string },
  ): Promise<AgentRun>
  /** Single-active-run guard (PLAN.md §3a non-scope): any non-terminal run in the workspace. */
  findActiveByWorkspace(workspaceId: WorkspaceId): Promise<AgentRun | null>
  /**
   * Every non-terminal run in one workspace. Distinct from
   * `findActiveByWorkspace` on purpose: the kill switch (PLAN.md §6) must stop
   * *all* of them, and must not quietly depend on the single-active-run limit
   * still holding — that limit is a Phase 1 scope cut, not an invariant.
   */
  listActiveByWorkspace(workspaceId: WorkspaceId): Promise<AgentRun[]>
  /** A human's end-of-run keep/discard decision on DiffView (PLAN.md §7 ship criterion). */
  setBranchDisposition(
    workspaceId: WorkspaceId,
    id: AgentRunId,
    disposition: AgentRunBranchDisposition,
  ): Promise<AgentRun>
  /**
   * Authoritative spend, metered at the egress proxy (PLAN.md §6 A6, §9).
   * Separate from `updateStatus` on purpose: cost arrives continuously while a run
   * is mid-flight, and folding it into a status write would mean either inventing
   * a status transition per cost tick or letting cost updates silently rewrite
   * status.
   */
  recordCost(workspaceId: WorkspaceId, id: AgentRunId, totalCostUsd: number): Promise<void>
  /** Bumped by the Runner's periodic heartbeat frame (PLAN.md §6 dead-run reaper). */
  recordHeartbeat(workspaceId: WorkspaceId, id: AgentRunId): Promise<void>
  /** Bumped by any agent_event — distinct signal from a heartbeat (§6): a hung-but-connected run keeps sending heartbeats but stops making progress. */
  recordEventActivity(workspaceId: WorkspaceId, id: AgentRunId): Promise<void>
  /**
   * Every non-terminal run, workspace-agnostic — the one deliberate exception
   * to this port's per-workspace convention. Backs the dead-run reaper, an
   * internal background sweep never exposed through the contract, so there's
   * no authz boundary to enforce here the way there is for every other method.
   */
  listAllActive(): Promise<AgentRun[]>
  /**
   * Runs a human hasn't finished with yet (PLAN.md §3's inbox/retention
   * hook): awaiting an approval decision, or terminal with an unreviewed
   * branch (kept/discarded not yet decided). A reaper-failed run naturally
   * falls into the latter — it already got a chat message explaining why.
   */
  listNeedsAttention(workspaceId: WorkspaceId): Promise<AgentRun[]>
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
 * The structured event tier and idempotency ledger (PLAN.md §4d-bis, §6
 * "idempotency keys on run steps").
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
 * The kill switch's persistence (PLAN.md §6 runtime safety). Its own port
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
   * (PLAN.md §6). Same deliberate exception to this port's per-workspace
   * convention, for the same reason, as `AgentRunRepositoryPort.listAllActive`:
   * it's an internal background sweep, never reachable through the contract, so
   * there is no caller whose authz boundary it could cross.
   */
  listAllPending(): Promise<ApprovalRequest[]>
  /**
   * `resolvedByUserId: null` marks a resolution no human made — the kill switch
   * denying a dead run's gate, or the approval SLA auto-denying an expired one
   * (PLAN.md §6). That is *not* a hole in A1's identity binding: `decideApproval`
   * is the only path a client can reach, and it still requires a `user` actor.
   * These null resolutions are system sweeps that can only ever deny.
   */
  resolve(
    workspaceId: WorkspaceId,
    id: ApprovalRequestId,
    patch: { status: ApprovalStatus; resolvedByUserId: UserId | null },
  ): Promise<ApprovalRequest>
}

export type PathCheckResult =
  | { readonly ok: true; readonly defaultBranch: string }
  | { readonly ok: false; readonly error: string }

/**
 * The driven side of the Runner protocol (PLAN.md §4a/§4b — corrected
 * placement, see §4c note). Implemented by apps/server/src/runner-gateway.ts,
 * which holds the actual per-Runner WebSocket connections; this port is what
 * lets use-cases send commands to a Runner without knowing sockets exist.
 */
export interface RunDispatchPort {
  /** Validates `path` against the Runner's own allowed roots and confirms it's a git repo. */
  checkPath(input: { runnerId: RunnerId; path: string }): Promise<PathCheckResult>
  /** Fire-and-forget: instructs the connected Runner to start executing. Throws if not connected. */
  startRun(input: {
    runnerId: RunnerId
    runId: AgentRunId
    persona: PersonaSpec
    cwd: string
    defaultBranch: string
    /** What a human asked for via `@mention` (PLAN.md §3a); absent for the sidebar-picker path. */
    task?: string
  }): Promise<void>
  /**
   * Aborts a run mid-flight (PLAN.md §6 kill switch). Fire-and-forget and
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
  /** Asks the Runner for the run's branch diff on demand (PLAN.md §5a diff-review handoff). */
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
   * best-effort opens a PR/MR (PLAN.md §6 A2). `acknowledgeCiChange`
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
}
