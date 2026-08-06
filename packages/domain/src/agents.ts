import type {
 AgentPersonaId,
 AgentRunId,
 ApprovalRequestId,
 PersonaGroupId,
 RepositoryId,
 RunnerId,
 ThreadId,
 WorkspaceId,
} from './ids.js'

/**
 * A Runner is a paired local daemon — the machine that
 * actually holds a repository and executes sandboxed agent runs. The server
 * never touches a Runner's filesystem directly; every path operation is a
 * capability the Runner exposes, gated by the allowed roots it was started
 * with.
 */
export interface Runner {
 readonly id: RunnerId
 readonly workspaceId: WorkspaceId
 readonly name: string
 readonly allowedRoots: readonly string[]
 readonly connected: boolean
 readonly lastSeenAt: Date | null
 readonly createdAt: Date
}

/**
 * Phase 1 scope cut, deliberate: a repository is bound by absolute path on an
 * already-connected Runner. No directory-picker UI, no `git init` flow yet —
 * both are real follow-up work, not half-built here.
 */
export interface Repository {
 readonly id: RepositoryId
 readonly workspaceId: WorkspaceId
 readonly runnerId: RunnerId
 readonly displayName: string
 readonly absolutePath: string
 readonly defaultBranch: string
 readonly createdAt: Date
}

/**
 * Inline execution spec for Phase 1 — no markdown persona file or git-backed
 * storage yet. This is the
 * minimum needed to actually drive AgentExecutionPort.
 */
export interface PersonaSpec {
 readonly name: string
 readonly systemPrompt: string
 readonly model: string
 // Mutable, not `readonly string[]`: this crosses the wire (Zod's array
 // output type) and into the Runner protocol verbatim — a readonly type
 // here just forces spreads at every boundary for no safety benefit, since
 // nothing in this codebase mutates a persona's tool list in place.
 readonly tools: string[]
 /**
 * Per-persona opt-in (default false): skips the human approval round-trip
 * for risky tools this run hits. The path-scoped write boundary
 * still applies unconditionally — that's a hard boundary, not a judgment
 * call, and autoApprove never touches it.
 */
 readonly autoApprove: boolean
}

/**
 * Stored persona. `markdownSource` is the source
 * of truth; the other fields are its parsed frontmatter, kept denormalized
 * for querying without re-parsing on every list/get.
 */
export interface AgentPersona {
 readonly id: AgentPersonaId
 readonly workspaceId: WorkspaceId
 readonly name: string
 readonly description: string
 readonly markdownSource: string
 readonly model: string
 readonly tools: string[]
 readonly harnessEffort: string | null
 readonly harnessMaxTurns: number | null
 readonly harnessAutoApprove: boolean
 readonly createdAt: Date
 readonly updatedAt: Date
}

/**
 * Organizational grouping of personas. Grouping personas doesn't start anything and does
 * not bind to a channel or a Planner.
 */
export interface PersonaGroup {
 readonly id: PersonaGroupId
 readonly workspaceId: WorkspaceId
 readonly name: string
 readonly personaIds: string[]
 readonly createdAt: Date
 readonly updatedAt: Date
}

export type AgentRunStatus =
 | 'pending'
 | 'running'
 | 'awaiting_approval'
 | 'completed'
 | 'failed'
 | 'cancelled'

export type AgentRunBranchDisposition = 'kept' | 'discarded' | 'pushed'

export interface AgentRun {
 readonly id: AgentRunId
 readonly workspaceId: WorkspaceId
 readonly threadId: ThreadId
 readonly repositoryId: RepositoryId
 readonly runnerId: RunnerId
 readonly persona: PersonaSpec
 readonly status: AgentRunStatus
 readonly totalCostUsd: number | null
 readonly errorMessage: string | null
 // Set once the Runner finishes cloning — null until then.
 readonly clonePath: string | null
 readonly branchName: string | null
 // A human's end-of-run keep/discard decision on DiffView — null until made.
 readonly branchDisposition: AgentRunBranchDisposition | null
 // Dead-run reaper inputs — internal-only, deliberately absent
 // from AgentRunSchema (packages/api-contract) so they never reach the browser.
 readonly lastHeartbeatAt: Date | null
 readonly lastEventAt: Date | null
 readonly createdAt: Date
 readonly completedAt: Date | null
}

/**
 * Structured tier only — token deltas are stream-only and
 * never modeled here; the full raw provider transcript is a separate,
 * not-yet-built blob-storage concern (the tech stack SeaweedFS, deferred past Phase 1).
 */
export type AgentEvent =
 | { readonly kind: 'assistant_text'; readonly text: string }
 | {
 readonly kind: 'tool_call'
 readonly toolUseId: string
 readonly toolName: string
 readonly input: Readonly<Record<string, unknown>>
 }
 | {
 readonly kind: 'tool_result'
 readonly toolUseId: string
 readonly isError: boolean
 readonly summary: string
 }
 | {
 readonly kind: 'run_completed'
 readonly totalCostUsd: number
 readonly result: string
 }
 | { readonly kind: 'run_failed'; readonly message: string }

export type ApprovalStatus = 'pending' | 'approved' | 'denied'

/**
 * Anti-forgery surface, identity-bound approval: `toolName`/`input` are the exact
 * argv the SDK is about to execute, never a model-authored summary, and
 * `resolvedBy` must be a human actor (enforced in the use-case, not here).
 */
export interface ApprovalRequest {
 readonly id: ApprovalRequestId
 readonly workspaceId: WorkspaceId
 readonly agentRunId: AgentRunId
 readonly toolUseId: string
 readonly toolName: string
 readonly input: Readonly<Record<string, unknown>>
 readonly status: ApprovalStatus
 readonly createdAt: Date
 readonly resolvedAt: Date | null
}
