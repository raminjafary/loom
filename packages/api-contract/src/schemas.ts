import { z } from 'zod'

/**
 * The wire shapes. No persistence type may cross this boundary —
 * these Zod schemas are the single source of truth for every client, and the
 * OpenAPI document generated from them is what lets non-TypeScript clients
 * exist later without a second contract.
 */

export const ActorSchema = z.discriminatedUnion('kind', [
 z.object({ kind: z.literal('user'), userId: z.string }),
 z.object({ kind: z.literal('agent_run'), agentRunId: z.string }),
 z.object({ kind: z.literal('system') }),
])

export const MessageBodySchema = z.discriminatedUnion('kind', [
 z.object({ kind: z.literal('text'), text: z.string }),
 z.object({ kind: z.literal('system'), text: z.string }),
])

export const MessageSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 threadId: z.string,
 author: ActorSchema,
 body: MessageBodySchema,
 createdAt: z.date,
 editedAt: z.date.nullable,
})

export const ChannelSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 name: z.string,
 topic: z.string.nullable,
 isPrivate: z.boolean,
 createdAt: z.date,
})

export const ThreadSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 channelId: z.string,
 parentMessageId: z.string.nullable,
 isRoot: z.boolean,
 createdAt: z.date,
})

export const MessagePageSchema = z.object({
 messages: z.array(MessageSchema),
 nextCursor: z.string.nullable,
})

/** Realtime frames. Deliberately small: structure and status, never token deltas. */
export const ServerEventSchema = z.discriminatedUnion('type', [
 z.object({
 type: z.literal('message.created'),
 threadId: z.string,
 message: MessageSchema,
 }),
 z.object({ type: z.literal('channel.created'), channel: ChannelSchema }),
 z.object({ type: z.literal('thread.created'), thread: ThreadSchema }),
])

export const RunnerSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 name: z.string,
 allowedRoots: z.array(z.string),
 connected: z.boolean,
 lastSeenAt: z.date.nullable,
 createdAt: z.date,
})

export const RepositorySchema = z.object({
 id: z.string,
 workspaceId: z.string,
 runnerId: z.string,
 displayName: z.string,
 absolutePath: z.string,
 defaultBranch: z.string,
 /** What the merge queue runs before merging; null merges unverified. */
 verifyCommand: z.string.nullable,
 createdAt: z.date,
})

/** A registry capability. MCP `command`/`url` are operator-authored config. */
export const CapabilitySchema = z.object({
 id: z.string,
 workspaceId: z.string,
 kind: z.enum(['mcp', 'skill']),
 name: z.string,
 description: z.string,
 transport: z.enum(['stdio', 'sse', 'http']).nullable,
 command: z.string.nullable,
 args: z.array(z.string),
 url: z.string.nullable,
 /** The pinned tool-list hash; null until first observed. */
 toolListHash: z.string.nullable,
 content: z.string.nullable,
 createdAt: z.date,
 updatedAt: z.date,
})

export const PersonaCapabilitySchema = z.object({
 id: z.string,
 workspaceId: z.string,
 personaId: z.string,
 capabilityId: z.string,
 /** Empty means everything the capability offers — the opposite of "no tools". */
 allowedTools: z.array(z.string),
})

/** One entry from a Runner's scoped directory listing. */
export const DirectoryEntrySchema = z.object({
 name: z.string,
 path: z.string,
 isDirectory: z.boolean,
 isRepository: z.boolean,
})

export const DirectoryListingSchema = z.object({
 path: z.string,
 /** Null when stepping up would leave the Runner's allowed roots. */
 parent: z.string.nullable,
 entries: z.array(DirectoryEntrySchema),
 /** The listing hit the Runner's cap; the picker must say so rather than imply a short directory. */
 truncated: z.boolean,
})

/**
 * One branch waiting in, or resolved by, the serialized merge queue.
 *
 * `position` crosses the wire as a string: it is a Postgres bigserial, and JSON
 * numbers cannot carry one faithfully. Clients only ever compare and display it.
 */
/**
 * One entry in a tree's worker-notes ledger.
 *
 * `authorKind` is on the wire because the UI is *required* to render agent-authored
 * prose as distinct from platform-recorded fact — the worker-notes design makes that a
 * requirement, not a style preference, since a note by worker A read by worker B (or
 * trusted by a human) is a persistence layer for prompt injection. A client that
 * cannot tell them apart cannot meet it.
 */
export const WorkerNoteSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 treeRunId: z.string,
 /** Null for a human's note, which is about the tree rather than any one run. */
 agentRunId: z.string.nullable,
 authorKind: z.enum(['platform', 'human', 'agent_run']),
 kind: z.enum([
 'run_started',
 'branch_ready',
 'run_finished',
 'merge_result',
 'path_ownership',
 'summary',
 'finding',
 'decision',
 'blocker',
 ]),
 title: z.string,
 body: z.string,
 paths: z.array(z.string),
 createdAt: z.date,
})

/** One card on the kanban — a *run*, since the board and the ledger are one object. */
export const SwarmBoardCardSchema = z.object({
 runId: z.string,
 /** Null for the tree's root — what makes the board renderable as a tree. */
 parentRunId: z.string.nullable,
 personaName: z.string,
 title: z.string,
 status: z.string,
 relation: z.string.nullable,
 branchName: z.string.nullable,
 branchDisposition: z.string.nullable,
 totalCostUsd: z.number.nullable,
 ownedPaths: z.array(z.string),
 noteCount: z.number.int,
 /** Agent- or human-authored, so untrusted text — render it as such. */
 latestNoteTitle: z.string.nullable,
 blockerCount: z.number.int,
})

export const SwarmBoardSchema = z.object({
 treeRunId: z.string,
 cards: z.array(SwarmBoardCardSchema),
 /** Pairs of cards whose owned paths collide — the merge conflicts to expect. */
 pathCollisions: z.array(
 z.object({ titles: z.tuple([z.string, z.string]), paths: z.array(z.string) }),
),
})

/**
 * The cost dashboard.
 *
 * The cost model asks for spend "rolled up per thread/team/workspace", metered at the egress proxy,
 * with model choice **visible** rather than buried in config — the reason given is that
 * Cursor's 8x cost swing came from worker model choice. So the groupings here are not
 * decoration: `byModel` and `byPersona` are the specific question the cost model says a human must
 * be able to answer, and both read the persona *snapshot* the run carried, not the
 * persona as it is configured today.
 *
 * Every figure is proxy-metered spend, never a model's self-report.
 */
export const SpendGroupSchema = z.object({
 runCount: z.number.int,
 totalUsd: z.number,
})

export const CostSummarySchema = z.object({
 /** Null means all time; otherwise the window these figures cover. */
 windowHours: z.number.int.nullable,
 totals: SpendGroupSchema,
 byPersona: z.array(
 SpendGroupSchema.extend({
 personaName: z.string,
 model: z.string,
 /** The single most expensive run in this group — a mean hides the run that hurt. */
 maxUsd: z.number,
 }),
),
 byModel: z.array(SpendGroupSchema.extend({ model: z.string })),
 byThread: z.array(
 SpendGroupSchema.extend({ threadId: z.string, channelName: z.string }),
),
 topRuns: z.array(
 z.object({
 agentRunId: z.string,
 personaName: z.string,
 model: z.string,
 status: z.string,
 relation: z.string.nullable,
 totalUsd: z.number,
 createdAt: z.date,
 }),
),
})

export const MergeQueueEntrySchema = z.object({
 id: z.string,
 workspaceId: z.string,
 repositoryId: z.string,
 agentRunId: z.string,
 branchName: z.string,
 status: z.enum(['queued', 'merging', 'merged', 'failed', 'cancelled']),
 position: z.string,
 failureReason: z
.enum([
 'conflict',
 'verification_failed',
 'verification_refused',
 'dirty_target',
 'stale_target',
 'runner_error',
 ])
.nullable,
 detail: z.string.nullable,
 mergedCommitSha: z.string.nullable,
 /** Whether tests actually ran and passed — not whether any were configured. */
 verified: z.boolean,
 createdAt: z.date,
 startedAt: z.date.nullable,
 finishedAt: z.date.nullable,
})

/** Inline for Phase 1 — no markdown/git-backed persona storage yet. */
export const PersonaSpecSchema = z.object({
 name: z.string.min(1).max(100),
 systemPrompt: z.string.min(1).max(20_000),
 model: z.string.min(1),
 tools: z.array(z.string),
 autoApprove: z.boolean,
 budgetCapUsd: z.number.nullable,
})

/** Phase 1 subset — read/CRUD only, no git-backed versioning yet. */
export const AgentPersonaSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 name: z.string,
 description: z.string,
 markdownSource: z.string,
 model: z.string,
 tools: z.array(z.string),
 harnessEffort: z.string.nullable,
 harnessMaxTurns: z.number.nullable,
 harnessAutoApprove: z.boolean,
 harnessPlanner: z.boolean,
 harnessDelegates: z.array(z.string),
 harnessBudgetCapUsd: z.number.nullable,
 createdAt: z.date,
 updatedAt: z.date,
})

/** The persona model — organizational grouping of personas, not a Team/roster. */
export const PersonaGroupSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 name: z.string,
 personaIds: z.array(z.string),
 createdAt: z.date,
 updatedAt: z.date,
})

export const AgentRunStatusSchema = z.enum([
 'pending',
 'running',
 'awaiting_approval',
 'completed',
 'failed',
 'cancelled',
])

/** `merged` is set by the merge queue on success, never by a direct human action. */
export const AgentRunBranchDispositionSchema = z.enum(['kept', 'discarded', 'pushed', 'merged'])

/** How a child run attaches to its parent — see AgentRunRelation. */
export const AgentRunRelationSchema = z.enum(['delegation', 'review', 'reconcile'])

export const AgentRunSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 threadId: z.string,
 repositoryId: z.string,
 runnerId: z.string,
 persona: PersonaSpecSchema,
 // Swarm structure — null for a run a human started.
 parentRunId: z.string.nullable,
 relation: AgentRunRelationSchema.nullable,
 status: AgentRunStatusSchema,
 totalCostUsd: z.number.nullable,
 errorMessage: z.string.nullable,
 clonePath: z.string.nullable,
 branchName: z.string.nullable,
 branchDisposition: AgentRunBranchDispositionSchema.nullable,
 createdAt: z.date,
 completedAt: z.date.nullable,
})

/** Global kill switch state. */
export const RunControlSchema = z.object({
 workspaceId: z.string,
 paused: z.boolean,
 pausedAt: z.date.nullable,
 pausedByUserId: z.string.nullable,
})

/**
 * The product shape/the replaceability contract notifications. `transport: null` means this deployment has no
 * notification adapter configured — a client must be able to tell that apart
 * from "configured, but you have not subscribed", so it can say so instead of
 * offering a button that cannot work.
 */
export const NotificationTransportSchema = z.enum(['web_push'])

export const NotificationConfigSchema = z.object({
 transport: NotificationTransportSchema.nullable,
 publicKey: z.string.nullable,
})

/**
 * A registered destination. `credentials` is transport-specific — for web push,
 * the subscription's `p256dh` and `auth` keys. Deliberately not echoed back in
 * any output shape: it is write-only from the client's side, and the browser
 * already holds its own copy.
 */
export const NotificationTargetSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 transport: NotificationTransportSchema,
 endpoint: z.string,
 createdAt: z.date,
})

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied'])

export const ApprovalRequestSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 agentRunId: z.string,
 toolUseId: z.string,
 toolName: z.string,
 input: z.record(z.string, z.unknown),
 status: ApprovalStatusSchema,
 createdAt: z.date,
 resolvedAt: z.date.nullable,
})

export type Actor = z.infer<typeof ActorSchema>
export type Message = z.infer<typeof MessageSchema>
export type Channel = z.infer<typeof ChannelSchema>
export type Thread = z.infer<typeof ThreadSchema>
export type MessagePage = z.infer<typeof MessagePageSchema>
export type ServerEvent = z.infer<typeof ServerEventSchema>
export type Runner = z.infer<typeof RunnerSchema>
export type Repository = z.infer<typeof RepositorySchema>
export type MergeQueueEntry = z.infer<typeof MergeQueueEntrySchema>
export type WorkerNote = z.infer<typeof WorkerNoteSchema>
export type SwarmBoardCard = z.infer<typeof SwarmBoardCardSchema>
export type SwarmBoard = z.infer<typeof SwarmBoardSchema>
export type CostSummary = z.infer<typeof CostSummarySchema>
export type SpendGroup = z.infer<typeof SpendGroupSchema>
export type Capability = z.infer<typeof CapabilitySchema>
export type PersonaCapability = z.infer<typeof PersonaCapabilitySchema>
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>
export type PersonaSpec = z.infer<typeof PersonaSpecSchema>
export type AgentPersona = z.infer<typeof AgentPersonaSchema>
export type PersonaGroup = z.infer<typeof PersonaGroupSchema>
export type AgentRun = z.infer<typeof AgentRunSchema>
export type RunControl = z.infer<typeof RunControlSchema>
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>
export type NotificationTransport = z.infer<typeof NotificationTransportSchema>
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>
export type NotificationTarget = z.infer<typeof NotificationTargetSchema>
