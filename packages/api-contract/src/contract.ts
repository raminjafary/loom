import { oc } from '@orpc/contract'
import { z } from 'zod'
import {
 ActorSchema,
 CapabilitySchema,
 DirectoryListingSchema,
 PersonaCapabilitySchema,
 AgentPersonaSchema,
 AgentRunSchema,
 ApprovalRequestSchema,
 ChannelSchema,
 MergeQueueEntrySchema,
 MessagePageSchema,
 MessageSchema,
 NotificationConfigSchema,
 NotificationTargetSchema,
 NotificationTransportSchema,
 PersonaGroupSchema,
 RepositorySchema,
 RunControlSchema,
 RunnerSchema,
 CostSummarySchema,
 SwarmBoardSchema,
 ThreadSchema,
 WorkerNoteSchema,
} from './schemas.js'

/**
 * Every use-case a client may invoke. The hard rule from the contract-first rule: if it is
 * not declared here, no client can do it — including the browser. That forces
 * this contract to be complete rather than letting the web app grow a private
 * side channel, which is what makes a terminal client reach parity for free.
 */

export const contract = {
 health: oc.output(z.object({ status: z.literal('ok'), time: z.date })),

 /**
 * Who am I, and which workspace am I in. Clients must learn identity from the
 * session rather than from build-time config — otherwise the workspace id
 * becomes a client-supplied value, which is exactly the forgery surface
 * Identity-bound approval closes.
 */
 session: {
 me: oc.output(z.object({ actor: ActorSchema, workspaceId: z.string })),
 },

 channel: {
 list: oc.output(z.array(ChannelSchema)),

 create: oc
.input(
 z.object({
 name: z.string.min(2).max(64),
 topic: z.string.max(500).nullish,
 isPrivate: z.boolean.optional,
 }),
)
.output(z.object({ channel: ChannelSchema, rootThread: ThreadSchema })),

 rootThread: oc
.input(z.object({ channelId: z.string }))
.output(ThreadSchema),
 },

 message: {
 list: oc
.input(
 z.object({
 threadId: z.string,
 limit: z.number.int.min(1).max(100).optional,
 cursor: z.string.optional,
 }),
)
.output(MessagePageSchema),

 post: oc
.input(z.object({ threadId: z.string, text: z.string.min(1).max(16_000) }))
.output(MessageSchema),

 /** Reconnect path — replay what the client missed while its socket was down. */
 backfill: oc
.input(
 z.object({
 threadId: z.string,
 afterMessageId: z.string,
 limit: z.number.int.min(1).max(100).optional,
 }),
)
.output(z.array(MessageSchema)),
 },

 runner: {
 list: oc.output(z.array(RunnerSchema)),

 createPairingToken: oc
.input(z.object({ name: z.string.min(1).max(100) }))
.output(z.object({ runnerId: z.string, rawToken: z.string })),
 },

 /** Repository binding: browse a Runner's allowed roots, bind an existing repo, or create one. */
 repository: {
 list: oc.output(z.array(RepositorySchema)),

 bindExisting: oc
.input(
 z.object({
 runnerId: z.string,
 path: z.string.min(1),
 displayName: z.string.min(1).max(100),
 }),
)
.output(RepositorySchema),

 /**
 * Scoped directory listing for the picker. An empty `path` lists the Runner's
 * allowed roots, so a client never needs to know a filesystem path to begin —
 * the first thing it can name is something the Runner already permitted.
 */
 listDirectory: oc
.input(z.object({ runnerId: z.string, path: z.string }))
.output(DirectoryListingSchema),

 /** Creates a repository on the Runner (`git init` + an initial commit) and binds it. */
 createNew: oc
.input(
 z.object({
 runnerId: z.string,
 parentPath: z.string.min(1),
 // A single directory name, never a path — enforced again on the Runner,
 // where the allowed-root boundary actually lives.
 name: z.string.min(1).max(100),
 displayName: z.string.min(1).max(100),
 }),
)
.output(RepositorySchema),

 /**
 * What the merge queue runs against a rebased branch before merging it
 *. Null or empty merges unverified — and says so on the
 * entry, rather than reporting an unverified merge as a verified one.
 */
 /**
 * What the platform runs to warm this repository's dependency cache.
 * Operator-authored and executed with no agent in the loop — that is precisely what
 * makes the resulting cache safe to hand to runs.
 */
 setInstallCommand: oc
.input(
 z.object({
 repositoryId: z.string,
 installCommand: z.string.max(2_000).nullable,
 }),
)
.output(RepositorySchema),

 /** Runs the install command to fill the shared cache. */
 warmCache: oc
.input(z.object({ repositoryId: z.string }))
.output(z.object({ ok: z.boolean, detail: z.string.nullable })),

 setVerifyCommand: oc
.input(
 z.object({
 repositoryId: z.string,
 verifyCommand: z.string.max(2_000).nullable,
 }),
)
.output(RepositorySchema),
 },

 /**
 * The serialized merge queue.
 *
 * There is no "merge now" call, deliberately. Queueing is the only human action;
 * the queue itself rebases in order, one repository-entry at a time, in a server
 * sweep. A synchronous merge endpoint would be the race this replaces.
 */
 mergeQueue: {
 list: oc.output(z.array(MergeQueueEntrySchema)),

 /** Queues a finished run's branch. The run's own `agentRun.merge` is the same action from the diff view. */
 enqueue: oc.input(z.object({ agentRunId: z.string })).output(MergeQueueEntrySchema),

 /** Only while still `queued` — a merge already running cannot be called back. */
 cancel: oc.input(z.object({ entryId: z.string })).output(MergeQueueEntrySchema),
 },

 /**
 * The worker-notes ledger and the kanban — one
 * namespace, because they are one object: "building them separately would produce
 * two sources of truth for what a swarm is doing."
 *
 * There is deliberately no way for a client to write an *agent-authored* note. The
 * `authorKind` on a note is a fact about provenance, and a client that could set it
 * would be able to launder its own text into the trusted section of every later
 * worker's prompt. Agents write through their own tool, over the Runner socket.
 */
 workerNote: {
 /** One tree's whole ledger, oldest first. Any run in the tree resolves to the same ledger. */
 listByTree: oc
.input(z.object({ agentRunId: z.string }))
.output(z.array(WorkerNoteSchema)),

 /**
 * A human's note on a tree — authoritative, and rendered to workers outside the
 * untrusted fence. How a person steers a swarm mid-flight without editing a
 * persona or restarting anything.
 */
 write: oc
.input(
 z.object({
 agentRunId: z.string,
 kind: z.enum(['finding', 'decision', 'blocker']),
 title: z.string.min(1).max(200),
 body: z.string.min(1).max(4_000),
 paths: z.array(z.string.max(500)).max(50).optional,
 }),
)
.output(WorkerNoteSchema),

 /** The board: a card per run in the tree, plus the path collisions to expect. */
 board: oc.input(z.object({ agentRunId: z.string })).output(SwarmBoardSchema),
 },

 /**
 * Workspace spend. Distinct from `agentRun.board`, which
 * rolls up **one tree**: this is the whole workspace, which is the rollup the cost model asks for
 * and the one no in-memory pass over a tree can produce.
 */
 cost: {
 summary: oc
.input(z.object({ windowHours: z.number.int.min(1).max(8_760).nullable.optional }))
.output(CostSummarySchema),
 },

 /** Phase 1 subset — markdown+frontmatter, read/CRUD only. */
 persona: {
 list: oc.output(z.array(AgentPersonaSchema)),

 get: oc.input(z.object({ personaId: z.string })).output(AgentPersonaSchema),

 create: oc
.input(z.object({ markdownSource: z.string.min(1).max(40_000) }))
.output(AgentPersonaSchema),

 update: oc
.input(z.object({ personaId: z.string, markdownSource: z.string.min(1).max(40_000) }))
.output(AgentPersonaSchema),
 },

 /**
 * The capability registry — MCP servers and skills,
 * attached per persona with per-attachment scopes.
 *
 * Human-only throughout, and that is the security property rather than a
 * convenience: a capability is something an operator registered deliberately,
 * never something a repository under review can introduce. Skills live here
 * rather than in a run's clone for the same reason `settingSources: []` exists.
 */
 capability: {
 list: oc.output(z.array(CapabilitySchema)),

 /** Lists attachments workspace-wide, so a client can render them per persona without N calls. */
 listAttachments: oc.output(z.array(PersonaCapabilitySchema)),

 register: oc
.input(
 z.object({
 kind: z.enum(['mcp', 'skill']),
 name: z.string.min(1).max(100),
 description: z.string.max(1_000).default(''),
 transport: z.enum(['stdio', 'sse', 'http']).nullish,
 command: z.string.max(2_000).nullish,
 args: z.array(z.string.max(500)).max(50).optional,
 url: z.string.max(2_000).nullish,
 content: z.string.max(100_000).nullish,
 }),
)
.output(CapabilitySchema),

 remove: oc.input(z.object({ capabilityId: z.string })).output(z.object({ ok: z.literal(true) })),

 /** `allowedTools` narrows an MCP server; empty means everything it offers. */
 attach: oc
.input(
 z.object({
 personaId: z.string,
 capabilityId: z.string,
 allowedTools: z.array(z.string.max(200)).max(200).optional,
 }),
)
.output(PersonaCapabilitySchema),

 detach: oc
.input(z.object({ personaId: z.string, capabilityId: z.string }))
.output(z.object({ ok: z.literal(true) })),
 },

 /** The persona model — organizational only; does not start anything, does not bind a channel/Planner. */
 personaGroup: {
 list: oc.output(z.array(PersonaGroupSchema)),

 create: oc
.input(z.object({ name: z.string.min(1).max(100), personaIds: z.array(z.string) }))
.output(PersonaGroupSchema),

 update: oc
.input(
 z.object({
 personaGroupId: z.string,
 name: z.string.min(1).max(100),
 personaIds: z.array(z.string),
 }),
)
.output(PersonaGroupSchema),

 delete: oc.input(z.object({ personaGroupId: z.string })).output(z.object({ ok: z.literal(true) })),
 },

 agentRun: {
 start: oc
.input(
 z.object({
 threadId: z.string,
 repositoryId: z.string,
 personaId: z.string,
 /** What a human asked for via `@mention`; absent for the sidebar picker. */
 task: z.string.min(1).max(4_000).optional,
 }),
)
.output(AgentRunSchema),

 get: oc.input(z.object({ agentRunId: z.string })).output(AgentRunSchema),

 /** Lets a client resume watching an already-active run after a reload. */
 getActive: oc.output(AgentRunSchema.nullable),

 /**
 * Every run currently executing. Distinct from `listNeedsAttention`: that answers "what is blocked on
 * me", this answers "what is running", and with concurrency those diverge.
 */
 listActive: oc.output(z.array(AgentRunSchema)),

 /** One run's children — what the tree view is drawn from. */
 listChildren: oc
.input(z.object({ agentRunId: z.string }))
.output(z.array(AgentRunSchema)),

 /** On-demand branch diff for end-of-run review. */
 getDiff: oc
.input(z.object({ agentRunId: z.string }))
.output(z.object({ diff: z.string })),

 /**
 * The raw transcript tier's "expand raw" fetch — the
 * verbatim provider stream, redacted at write.
 *
 * Explicitly on demand and never folded into a list or a subscription: the event-tiering design — event persistence tiering
 * says a late-joining client backfills from the structured tier and fetches
 * this only when asked, which is what keeps the run-tree payload light.
 */
 getRawTranscript: oc
.input(z.object({ agentRunId: z.string }))
.output(z.object({ lines: z.array(z.string), chunks: z.number.int })),

 /** Keeps a finished run's branch as-is — no push, no host action. */
 keep: oc.input(z.object({ agentRunId: z.string })).output(AgentRunSchema),

 /** Discards a finished run's branch: the Runner deletes the on-disk clone. */
 discard: oc.input(z.object({ agentRunId: z.string })).output(AgentRunSchema),

 /**
 * Host-side pushes the run's branch to the bound repo's `origin` and
 * best-effort opens a PR/MR — the agent never holds git
 * credentials or pushes. `acknowledgeCiChange` re-submits a push the
 * policy blocked for touching CI config, confirming human review.
 */
 push: oc
.input(z.object({ agentRunId: z.string, acknowledgeCiChange: z.boolean.optional }))
.output(AgentRunSchema),

 /** Runs needing a human decision — the inbox's data source. */
 listNeedsAttention: oc.output(z.array(AgentRunSchema)),
 },

 /**
 * The global kill switch. `pauseAll` blocks new runs *and* cancels every in-flight one;
 * `resume` only lifts the block — it never restarts what the pause killed.
 */
 runControl: {
 get: oc.output(RunControlSchema),

 pauseAll: oc.output(
 z.object({ control: RunControlSchema, cancelledRunIds: z.array(z.string) }),
),

 resume: oc.output(RunControlSchema),
 },

 /**
 * The other half — what tells a human a run needs them instead of
 * making them go and look. In the contract rather than a private endpoint of
 * apps/web for the contract-first rule reason: a terminal client must be able to register a
 * desktop-notification target through the same calls.
 */
 notification: {
 /** VAPID public key and transport, or `transport: null` when unconfigured. */
 config: oc.output(NotificationConfigSchema),

 /** Upserts by endpoint — a browser re-subscribing refreshes, never duplicates. */
 subscribe: oc
.input(
 z.object({
 transport: NotificationTransportSchema,
 endpoint: z.string.url.max(2_000),
 // Write-only: the keys the transport needs to encrypt to this target
 // (web push: `p256dh` and `auth`). Never echoed back in any output.
 credentials: z.record(z.string, z.string),
 }),
)
.output(NotificationTargetSchema),

 unsubscribe: oc
.input(z.object({ endpoint: z.string.max(2_000) }))
.output(z.object({ ok: z.literal(true) })),
 },

 /**
 * Human-only resolution of a pending risky-tool gate — the
 * use-case enforces this is a `user` actor, not this schema, since that's a
 * server-side identity check no client input can carry.
 */
 approval: {
 listPending: oc
.input(z.object({ agentRunId: z.string }))
.output(z.array(ApprovalRequestSchema)),

 decide: oc
.input(
 z.object({
 approvalRequestId: z.string,
 decision: z.enum(['approve', 'deny']),
 }),
)
.output(ApprovalRequestSchema),
 },
} as const

export type Contract = typeof contract
