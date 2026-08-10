import { oc } from '@orpc/contract'
import { z } from 'zod'
import {
 ActorSchema,
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
 ThreadSchema,
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

 /**
 * Phase 1 scope cut: bind an existing repo by absolute path on
 * an already-paired Runner. No directory-picker or `git init` flow yet.
 */
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
 * What the merge queue runs against a rebased branch before merging it
 *. Null or empty merges unverified — and says so on the
 * entry, rather than reporting an unverified merge as a verified one.
 */
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
