import { z } from 'zod'

/**
 * The wire shapes. No persistence type may cross this boundary —
 * these Zod schemas are the single source of truth for every client, and the
 * OpenAPI document generated from them is what lets non-TypeScript clients
 * exist later without a second contract.
 */

/**
 * A timestamp that survives both transports.
 *
 * The RPC path hands a client real `Date` objects — oRPC serializes them and revives
 * them for us. The realtime path does not: `apps/server/src/events.ts` publishes a
 * frame with `JSON.stringify`, the gateway forwards the bytes verbatim, and every
 * `Date` arrives as an ISO string. A plain `z.date` rejects that, and because
 * `connectRealtime` deliberately ignores frames the contract does not recognise, the
 * rejection is silent: the socket stays "Live" and nothing it delivers is ever seen.
 *
 * That is not hypothetical — it is how the thread came to look realtime while being
 * driven entirely by the 10s safety-net poll. Anything reachable from
 * `ServerEventSchema` must therefore accept the string form as well as the object.
 */
const wireDate = z.coerce.date

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
 /**
 * The SDK's own correlation id for a tool call and the result it produced, carried
 * so a client never has to guess which result belongs to which call. A model issues
 * tool calls in parallel and their results come back in whatever order they finish,
 * so position and authorship are both wrong answers. Null for everything that is
 * not one of those two events, and for history written before it was recorded.
 */
 toolUseId: z.string.nullable,
 createdAt: wireDate,
 editedAt: wireDate.nullable,
})

export const ChannelSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 name: z.string,
 topic: z.string.nullable,
 isPrivate: z.boolean,
 createdAt: wireDate,
})

export const ThreadSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 channelId: z.string,
 parentMessageId: z.string.nullable,
 isRoot: z.boolean,
 createdAt: wireDate,
})

/**
 * How much prose a run should produce.
 *
 * Duplicated from `@loom/domain`'s `RESPONSE_STYLES` rather than imported: this
 * package deliberately depends on nothing, so the wire contract can be published
 * without dragging the domain along. The two are kept honest by a test in
 * apps/server, which is the first place both are in scope.
 */
export const ResponseStyleSchema = z.enum(['default', 'concise', 'explanatory', 'caveman'])

/**
 * How much a run may do without asking, narrowest first.
 *
 * The order is the security property — a child may never hold a wider mode than its
 * parent — and it is enforced in `@loom/domain`, never here. Duplicated for the same
 * reason `ResponseStyleSchema` is, and kept honest by a test in apps/server, which is
 * the first place both are in scope.
 */
export const ApprovalModeSchema = z.enum(['ask', 'accept-edits', 'auto'])

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
 /**
 * A run's structure or activity changed.
 *
 * **The frame the graph never had.** Every other run-state surface in this client
 * re-reads `workerNote.board` on a socket nudge plus a 10s safety net, which is why
 * the canvas renders live *facts* but never shows anything *happening*: by the time
 * a refetch lands, the tool call that prompted it has usually finished. This carries
 * the change itself, so an edge can light up when work crosses it and a node can
 * show the call in flight.
 *
 * Deliberately **not** a replacement for the board fetch. It is a nudge with enough
 * payload to animate, not a second source of truth about what a swarm is doing —
 * The worker-notes design refuses that, and a client that rebuilt its tree from a stream would
 * disagree with the board the moment one frame was dropped. Everything here is
 * either an id or a short label; nothing is authoritative.
 */
 z.object({
 type: z.literal('run.activity'),
 /** The tree this run belongs to, so a client can ignore trees it is not watching. */
 treeRunId: z.string,
 agentRunId: z.string,
 /** The run that caused this, when it is not `agentRunId` — a parent starting a child. */
 parentRunId: z.string.nullable,
 /**
 * What happened, as a closed set. A closed set because a client *animates* on it:
 * free text would mean a new server-side string silently renders as nothing.
 */
 kind: z.enum([
 'started',
 'tool_call',
 'tool_result',
 'delegated',
 'note_written',
 'awaiting_human',
 'finished',
 ]),
 /** The tool being called, for `tool_call`/`tool_result`. Never its arguments. */
 label: z.string.nullable,
 status: z.string,
 at: wireDate,
 }),
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
 /**
 * What warms this repository's dependency cache.
 *
 * On the wire because a client has to be able to *show* it: verification runs with
 * `--network none`, so on any repository whose tests need an install step the verify
 * command only works against a warmed cache. A UI that could set this but never read
 * it back could not tell a human whether the thing their merge depends on was
 * configured.
 */
 installCommand: z.string.nullable,
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
 /**
 * Whether this card decomposes rather than acts.
 *
 * `relation` says what a node is to its *parent*; this says what it is in itself, and
 * with sub-planners the two stop coinciding — every node in a three-level tree is a
 * `delegation` child, and half of them are planners. Without it the graph draws a
 * middle node identically whether it decomposes or writes code.
 */
 planner: z.boolean,
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

 /**
 * Live observability. Every field is projected from events the platform
 * already persists, in the same read as the rest of the board — live swarm observability forbids a
 * per-tick query, and these add none.
 *
 * These map onto the OpenTelemetry GenAI semantic conventions, which live swarm observability asks be
 * adopted by name because it "costs nothing now and buys export later":
 * `currentToolName` is `gen_ai.tool.name`, `currentToolTarget` is the call's primary
 * argument, and a card is `gen_ai.agent.name` at `gen_ai.agent.id`. The names are
 * kept in this shape on the wire because a UI payload reads better for it; the
 * mapping is recorded here so an exporter does not have to guess it.
 */
 currentToolName: z.string.nullable,
 currentToolTarget: z.string.nullable,
 openCallCount: z.number.int,
 /** A timestamp, never a duration — "idle for 4m" would be stale the moment it is cached. */
 lastEventAt: wireDate.nullable,
 /**
 * From the run's frozen persona snapshot, so an edited cap cannot retroactively
 * change what a finished run was allowed to spend. Null means uncapped.
 */
 budgetCapUsd: z.number.nullable,
 /**
 * The context pressure, sampled by the Runner from the SDK's own
 * `getContextUsage` — a platform fact counting system prompt, tools and messages
 * against the model's real window, never a model's self-report. Null before the first
 * sample. Maps to OTel GenAI's `gen_ai.usage.input_tokens` family, though the window
 * ceiling has no standard attribute yet.
 */
 contextTokens: z.number.int.nullable,
 contextMaxTokens: z.number.int.nullable,
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
 /**
 * How much this run may do without asking. Duplicated from
 * `@loom/domain`'s `APPROVAL_MODES` for the reason the response-style enum is —
 * this package depends on nothing — and kept honest by a test in apps/server.
 */
 approvalMode: ApprovalModeSchema,
 budgetCapUsd: z.number.nullable,
 /**
 * Whether this run decomposes rather than acts.
 *
 * Absent until now, which was harmless while a tree had exactly one planner at its
 * root: `parentRunId === null` answered it. With sub-planners it does not — a client
 * looking at a middle node cannot tell a planner from a worker, and `tools: []` is
 * not a proxy either, since a persona may legitimately hold no tools without being
 * one. The graph needs it to shape a node, and the board needs it to say what a
 * quiet run is quiet *about*.
 *
 * Optional because runs that predate the field have stored persona JSON without it,
 * and a missing flag must read as "not a planner" rather than failing the whole row.
 */
 planner: z.boolean.optional,
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
 harnessApprovalMode: ApprovalModeSchema,
 harnessPlanner: z.boolean,
 harnessDelegates: z.array(z.string),
 harnessBudgetCapUsd: z.number.nullable,
 /**
 * Where this persona stands relative to the version this build ships,
 * or null when it is not a built-in.
 *
 * Derived rather than stored, and on the wire because it is the only way a client
 * can offer the one action that resolves it: `'stale'` means the markdown differs
 * from the shipped version and the recorded seed does not explain why — so either a
 * human edited it, or it predates the recording. `seedBuiltinPersonas` deliberately
 * leaves those alone; a human choosing is the honest resolution.
 */
 builtinStatus: z.enum(['current', 'stale']).nullable,
 createdAt: z.date,
 updatedAt: z.date,
})

/**
 * What the authoritative parser made of a candidate persona markdown, without
 * saving it.
 *
 * This procedure exists so that **no client ever parses the persona format.** The
 * form is populated from the same `parsePersonaMarkdown` the write path uses, so a
 * human toggling between the form and the raw text cannot be shown fields that
 * disagree with what a save would store. `models.ts` states the same rule for the
 * model list and resolves it by duplication; a parser is too large a thing to
 * duplicate, so it is reached through the contract instead.
 *
 * `problems` carries the refusals a save would raise — a missing required key, a
 * planner holding an acting tool — as text rather than as a thrown error, because
 * the point is to show them while the human is still typing.
 */
export const PersonaDraftSchema = z.object({
 ok: z.boolean,
 problems: z.array(z.string),
 /** Null exactly when the frontmatter could not be parsed at all. */
 parsed: z
.object({
 name: z.string,
 description: z.string,
 model: z.string,
 tools: z.array(z.string),
 systemPrompt: z.string,
 harnessEffort: z.string.nullable,
 harnessMaxTurns: z.number.nullable,
 harnessApprovalMode: ApprovalModeSchema,
 harnessPlanner: z.boolean,
 harnessDelegates: z.array(z.string),
 harnessBudgetCapUsd: z.number.nullable,
 })
.nullable,
})

/** The persona model — organizational grouping of personas, not a Team/roster. */
export const PersonaGroupSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 name: z.string,
 personaIds: z.array(z.string),
 /**
 * Where each member sits on the composition canvas. Persisted because on an
 * authoring canvas position is a fact a human recorded, not a layout to recompute —
 * the line Phase 2 draws between this canvas and the observability graph.
 */
 layout: z.record(z.string, z.object({ x: z.number, y: z.number })),
 /**
 * How many of each member this team runs at once — the fleet, keyed by persona
 * id. A member with no entry is unsized, meaning the Planner decides.
 *
 * Unlike `layout`, the runtime reads it: the roster a Planner is given, the concurrency
 * check at child start, and the plan-time warning.
 */
 fleet: z.record(z.string, z.number),
 createdAt: z.date,
 updatedAt: z.date,
})

/**
 * Why one persona cannot delegate to another, at design time.
 *
 * Computed server-side with the same rules the child-start gate applies, for the
 * reason `persona.parse` exists: a client that decided this for itself would show a
 * human a team the runtime then refuses, one error at a time.
 */
export const DelegationRefusalSchema = z.object({
 rule: z.enum(['tools', 'delegates', 'autoApprove', 'budget', 'model', 'capabilities', 'depth']),
 detail: z.string,
 fix: z.string,
 /**
 * Tools that, added to the planner's envelope, would satisfy this refusal — the one
 * repair a composer may offer, since widening an envelope is what drawing an edge
 * asked for. Absent on every other rule, which would change what a *worker* is.
 */
 widenEnvelopeWith: z.array(z.string).optional,
})

export const DelegationEdgeSchema = z.object({
 plannerId: z.string,
 workerId: z.string,
 ok: z.boolean,
 refusals: z.array(DelegationRefusalSchema),
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
export const AgentRunRelationSchema = z.enum(['delegation', 'review', 'reconcile', 'steer'])

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
 /**
 * Set when this gate is a clarifying question rather than a tool call.
 *
 * **Model-authored, so untrusted**: a client must render it inside
 * the untrusted fence, exactly like agent prose in the thread. An agent that could
 * ask "paste your token here" in a box wearing the platform's chrome is the risk
 * in a different shape.
 */
 question: z.string.nullable,
 /** The human's reply. Trusted — a person is not the threat model here. */
 answer: z.string.nullable,
 createdAt: z.date,
 resolvedAt: z.date.nullable,
})

export type Actor = z.infer<typeof ActorSchema>
export type Message = z.infer<typeof MessageSchema>
export type Channel = z.infer<typeof ChannelSchema>
export type Thread = z.infer<typeof ThreadSchema>
export type MessagePage = z.infer<typeof MessagePageSchema>
export type ResponseStyle = z.infer<typeof ResponseStyleSchema>
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
export type PersonaDraft = z.infer<typeof PersonaDraftSchema>
export type PersonaGroup = z.infer<typeof PersonaGroupSchema>
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>
export type DelegationEdge = z.infer<typeof DelegationEdgeSchema>

/** What a planner could delegate to under a launcher's overrides. */
export interface DelegationPreview {
 readonly planner: boolean
 readonly delegatable: ReadonlyArray<{ readonly id: string; readonly name: string }>
 readonly refused: ReadonlyArray<{
 readonly id: string
 readonly name: string
 readonly refusals: ReadonlyArray<z.infer<typeof DelegationRefusalSchema>>
 }>
}
export type DelegationRefusal = z.infer<typeof DelegationRefusalSchema>
export type AgentRun = z.infer<typeof AgentRunSchema>
export type RunControl = z.infer<typeof RunControlSchema>
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>
export type NotificationTransport = z.infer<typeof NotificationTransportSchema>
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>
export type NotificationTarget = z.infer<typeof NotificationTargetSchema>
