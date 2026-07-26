import type {
 AgentRun,
 AgentRunId,
 AgentRunStatus,
 ApprovalRequest,
 ApprovalRequestId,
 ApprovalStatus,
 PersonaSpec,
 Repository,
 RepositoryId,
 Runner,
 RunnerId,
 ThreadId,
 UserId,
 WorkspaceId,
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
 }): Promise<AgentRun>
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
 resolve(
 workspaceId: WorkspaceId,
 id: ApprovalRequestId,
 patch: { status: ApprovalStatus; resolvedByUserId: UserId },
): Promise<ApprovalRequest>
}

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
 /** Fire-and-forget: instructs the connected Runner to start executing. Throws if not connected. */
 startRun(input: {
 runnerId: RunnerId
 runId: AgentRunId
 persona: PersonaSpec
 cwd: string
 defaultBranch: string
 }): Promise<void>
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
}
