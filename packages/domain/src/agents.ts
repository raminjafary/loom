import type { ApprovalMode } from './approval-modes.js'
import type { CapabilitySpec } from './capabilities.js'
import type { ResponseStyle } from './response-styles.js'
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
 /**
 * What the merge queue runs against a rebased branch before merging it. Null merges unverified — see `planMergeVerification`
 * for why this executes in the sandbox rather than on the Runner host.
 */
 readonly verifyCommand: string | null
 /**
 * What the platform runs to warm this repository's dependency cache.
 * Operator-authored, run with no agent in the loop — which is the whole reason a
 * warmed cache can be shared with runs at all.
 */
 readonly installCommand: string | null
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
 * How much this run may do without asking.
 *
 * The path-scoped write boundary and the denied Bash effects apply
 * unconditionally in every mode — those are boundaries, not judgment calls, and
 * no mode touches them.
 */
 readonly approvalMode: ApprovalMode
 /**
 * Enforced spend ceiling in USD, or null for uncapped. Snapshotted onto the run like the rest of this
 * spec, so editing the persona mid-run cannot raise the ceiling of a run already
 * in flight.
 */
 readonly budgetCapUsd: number | null
 /**
 * Registry capabilities attached to this persona, resolved and
 * snapshotted at run start like everything else here — so revoking a capability
 * does not change what a run already in flight is using, and attaching one does
 * not silently widen it.
 *
 * Optional in the type because runs that predate the registry have stored
 * persona JSON without it; the mapper defaults it rather than failing to read a
 * completed run's row.
 */
 readonly capabilities?: CapabilitySpec[]
 /**
 * Marks this persona as a Planner. A Planner gets one
 * extra channel — the delegation tool it submits a decomposition through — and
 * is required to declare `tools: []`, which is what makes the "no filesystem,
 * no shell" trust boundary a boundary rather than a description.
 *
 * Optional for the same reason `capabilities` is: runs that predate it have
 * stored persona JSON without it.
 */
 readonly planner?: boolean
 /**
 * The **envelope** a Planner's children are attenuated against.
 *
 * This exists because the roadmap and the data model contradict each other as written. The roadmap says a
 * Planner declares `tools: []`; the data model says "a child run can never request tools …
 * exceeding its parent's". Taken together a Planner can only delegate to
 * workers that also have no tools, which makes it useless — the boundary would
 * be real and the feature would not exist.
 *
 * The resolution is to separate two things the data model conflates: what a run may do
 * *itself*, and what it may hand down. A Planner still has `tools: []`, so it
 * cannot read, write or execute anything; `delegates` is the separate,
 * human-set ceiling on what its children may hold. A Planner can never widen
 * it, and everything else — budget, model tier, capabilities — still attenuates
 * against the parent's own values.
 *
 * Only meaningful on a planner; enforced at authoring time.
 */
 readonly delegates?: string[]
 /**
 * The response style this run was launched with.
 *
 * Recorded on the snapshot rather than only folded into `systemPrompt` for two
 * reasons: a UI has to be able to say which style a finished run used, and a
 * delegated child has to be able to inherit its parent's so one swarm speaks in
 * one voice. Optional for the same reason `capabilities` is — runs that predate
 * it have stored persona JSON without it.
 */
 readonly responseStyle?: ResponseStyle
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
 readonly harnessApprovalMode: ApprovalMode
 /** Phase 2 — see PersonaSpec.planner. */
 readonly harnessPlanner: boolean
 readonly harnessDelegates: string[]
 readonly harnessBudgetCapUsd: number | null
 /**
 * The markdown the platform seeded, for a built-in, or null for a
 * hand-authored persona and for a built-in seeded before this was recorded.
 *
 * It exists so "the human edited this" and "the platform shipped a new one" stop
 * being the same observation — see `seedBuiltinPersonas` for what that cost.
 */
 readonly builtinSource: string | null
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
 /**
 * Where each member sits on the composition canvas, keyed by persona id.
 *
 * Persisted because on an authoring canvas **position is a fact** a human recorded
 * — which is the line between this canvas and the
 * observability graph, whose positions are computed and worth nothing.
 */
 readonly layout: Record<string, { x: number; y: number }>
 readonly createdAt: Date
 readonly updatedAt: Date
}

/**
 * The global kill switch. Workspace-scoped rather than process-global: a pause must survive a
 * server restart, so it lives in the database, not in memory.
 *
 * Pausing is deliberately asymmetric with resuming. Pausing cancels every
 * in-flight run; resuming only lifts the block on *starting* new ones and never
 * restarts anything — an operator who hit the switch wants the work stopped,
 * and silently reviving killed runs would be the opposite of that.
 */
export interface WorkspaceRunControl {
 readonly workspaceId: WorkspaceId
 readonly paused: boolean
 readonly pausedAt: Date | null
 readonly pausedByUserId: string | null
}

export type AgentRunStatus =
 | 'pending'
 | 'running'
 | 'awaiting_approval'
 | 'completed'
 | 'failed'
 | 'cancelled'

/**
 * `merged` is set by the merge queue on success, never by a
 * human directly — queueing is the human action, and until the queue reaches the
 * entry the branch is still undecided. A failed merge leaves the disposition unset
 * on purpose: the "hand the branch back to its owning run" means it is actionable
 * again, not that it has been dealt with.
 */
export type AgentRunBranchDisposition = 'kept' | 'discarded' | 'pushed' | 'merged'

/**
 * How a child run hangs off its parent. Kept distinct from plain
 * `parent_run_id` presence because the data model is explicit that "reviewer and reconciler
 * runs attach via a distinct relation field rather than pretending to be
 * delegation children" — the tree view renders delegation, while a review or a
 * reconcile is something done *to* a run's output, not work handed down.
 *
 * `steer` is the same distinction for a re-planning turn: the run hangs off the Planner it re-enters, because that is what it is
 * *about*, but it is not work that Planner delegated and it must not be summed into
 * the aggregation, counted as delegation depth, or drawn as another worker.
 */
export type AgentRunRelation = 'delegation' | 'review' | 'reconcile' | 'steer'

export interface AgentRun {
 readonly id: AgentRunId
 readonly workspaceId: WorkspaceId
 readonly threadId: ThreadId
 readonly repositoryId: RepositoryId
 readonly runnerId: RunnerId
 readonly persona: PersonaSpec
 /**
 * The run that spawned this one — null for a run a human started.
 * Renders the swarm tree, and carries the capability attenuation rule: see
 * `attenuateChildPersona`.
 */
 readonly parentRunId: AgentRunId | null
 /** Null exactly when `parentRunId` is null. */
 readonly relation: AgentRunRelation | null
 /**
 * What this run was asked to do — a human's `@mention`, or the subtask text its
 * Planner wrote. Null for a run started from the sidebar picker with no task.
 *
 * Recorded because a re-planning turn needs
 * "its original goal, its current plan" and neither existed anywhere queryable: the
 * task was dispatched to the Runner and never persisted, so the closest thing on
 * record was a `run_started` note title truncated to 120 characters.
 *
 * **Internal-only, and absent from `AgentRunSchema` by the same rule as the reaper's
 * timestamps.** For a delegated child this string is model-authored, so exposing it
 * through the contract would put untrusted prose into a client that has no fence
 * around it. The steering brief is assembled server-side, which is where it
 * needs to be read.
 */
 readonly task: string | null
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
 /**
 * How full this run's context window was when the Runner last sampled it.
 * Both null until a sample arrives — and they move together, since a token count with
 * no window to measure against is not a ratio.
 */
 readonly contextTokens: number | null
 readonly contextMaxTokens: number | null
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

/**
 * A run in a terminal status will never emit another event, which is what makes it safe
 * to stop attributing live activity to it. Here rather than in a use case because three
 * layers ask the question and a fourth copy of the list would eventually disagree.
 */
export const TERMINAL_RUN_STATUSES: readonly AgentRunStatus[] = ['completed', 'failed', 'cancelled']

export const isTerminalRunStatus = (status: string): boolean =>
 (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)

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
 /**
 * A clarifying question this gate is carrying,
 * or null when it is an ordinary tool gate.
 *
 * **Model-authored, therefore untrusted**: a question is composed
 * by an agent, so it renders inside the untrusted fence like any other agent prose.
 * An agent that could ask "paste your token here" in a box that looks like the
 * platform's own is the risk wearing a different hat.
 */
 readonly question: string | null
 /** The human's reply. Trusted input — a person is not the threat model here. */
 readonly answer: string | null
 readonly createdAt: Date
 readonly resolvedAt: Date | null
}

/** A gate carrying a question rather than a tool call, and what to do with it. */
export const isClarifyingQuestion = (request: {
 readonly question: string | null
}): boolean => request.question !== null

/**
 * Tried in order; the first string field present is a call's headline argument.
 *
 * One definition, because two consumers need the same answer: the thread's activity
 * line (`eventToMessageText`) and the board, which shows the call in flight and the
 * file it is in. Two orderings would mean the board and the thread disagreed about what
 * a worker was doing, which is the kind of small inconsistency that makes a human stop
 * trusting both.
 *
 * Full arguments are never hidden by this — an approval card renders them verbatim
 *. This is only what makes a one-line summary scannable.
 */
export const PRIMARY_ARG_FIELDS = [
 'command',
 'file_path',
 'notebook_path',
 'pattern',
 'path',
 'url',
 'query',
] as const

export const primaryToolArgument = (
 input: Readonly<Record<string, unknown>> | null | undefined,
): string | null => {
 if (!input) return null
 for (const field of PRIMARY_ARG_FIELDS) {
 const value = input[field]
 if (typeof value === 'string') return value
 }
 return null
}
