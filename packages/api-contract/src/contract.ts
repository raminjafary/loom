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
 ResponseStyleSchema,
 MessageSchema,
 NotificationConfigSchema,
 NotificationTargetSchema,
 NotificationTransportSchema,
 DelegationEdgeSchema,
 DelegationRefusalSchema,
 PersonaDraftSchema,
 PersonaGroupSchema,
 RepositorySchema,
 RunControlSchema,
 RunnerSchema,
 CostSummarySchema,
 SwarmBoardSchema,
 ThreadSchema,
 ColosseumClaimSchema,
 ColosseumSessionSchema,
 ColosseumViewSchema,
 MasteryViewSchema,
 SubjectMapListingSchema,
 SubjectMapSchema,
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
 me: oc.output(
 z.object({
 actor: ActorSchema,
 workspaceId: z.string,
 /**
 * Workspace limits, sent with identity for the same reason identity is sent at
 * all: they are server configuration, and a client that assumed a value would be
 * drawing a surface against a rule the server does not have. The depth is
 * the one the composition canvas needs — it decides which drawn edges a plan
 * could use.
 */
 limits: z.object({
 maxDelegationDepth: z.number.int.positive,
 maxConcurrentRunsPerWorkspace: z.number.int.positive,
 }),
 }),
),
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

 /**
 * Every thread in a channel, root and replies.
 *
 * Reply threads have existed in the data model and the use cases since Phase 0 and
 * were never reachable from here, because nothing created one: a channel had a root
 * thread and that was the whole conversation. A sub-planner now gets its own, so
 * the client needs to know which messages have one hanging off them — which is what
 * `parentMessageId` answers, in one call rather than per message.
 */
 threads: oc
.input(z.object({ channelId: z.string }))
.output(z.array(ThreadSchema)),

 /**
 * Removes a channel and everything said in it. The heaviest cascade there is —
 * threads, messages, and every run started in them with its recorded spend — so
 * the server refuses while work is live and refuses again unless the caller has
 * acknowledged the count it was told.
 */
 delete: oc
.input(
 z.object({
 channelId: z.string,
 acknowledgeRunHistoryLoss: z.boolean.optional,
 }),
)
.output(z.object({ ok: z.literal(true) })),
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

 /** Forgets a Runner. Refused while any repository is still bound to it. */
 remove: oc
.input(z.object({ runnerId: z.string }))
.output(z.object({ ok: z.literal(true) })),
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

 /**
 * Unbinds a repository. Its runs and their recorded spend go with it, so this is
 * refused while any is live and refused again unless the loss is acknowledged.
 */
 unbind: oc
.input(
 z.object({
 repositoryId: z.string,
 acknowledgeRunHistoryLoss: z.boolean.optional,
 }),
)
.output(z.object({ ok: z.literal(true) })),
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

 /**
 * Queues a finished run's branch. The run's own `agentRun.merge` is the same action
 * from the diff view.
 *
 * `overrideBlockers` answers a reviewer's `blocker` note — the
 * one place the notes ledger gates an action rather than informing one. Without it a
 * blocked branch is refused and the refusal names the objections; with it the merge
 * is queued and the override is audited. It is a separate flag rather than a
 * silent retry for the same reason `acknowledgeRunHistoryLoss` and
 * `acknowledgeCiChange` are: the second call has to be a different statement from
 * the first, or the refusal is decoration.
 */
 enqueue: oc
.input(z.object({ agentRunId: z.string, overrideBlockers: z.boolean.optional }))
.output(MergeQueueEntrySchema),

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
 * A persona's expertise.
 *
 * There is deliberately no client path that writes a node or an edge. A map is what
 * later runs are handed as context, so a client able to write one could put text of
 * its choosing into every future run's prompt — the same reasoning that keeps
 * `workerNote.write` to human-authored notes only. Agents write through `record_map`
 * over the Runner socket, where the domain refuses them `extracted` provenance.
 */
 mastery: {
 /** Every subject this persona has a map of — what makes an expert legible before it is used. */
 listForPersona: oc
.input(z.object({ personaId: z.string }))
.output(z.array(SubjectMapListingSchema)),

 /** One map whole: nodes, edges, measured progress, and the computed hubs. */
 get: oc.input(z.object({ mapId: z.string })).output(MasteryViewSchema),

 /**
 * Every persona's map of one repository.
 *
 * Its own procedure rather than a field on the board, and the reason is the cost
 * discipline: the board is polled, and expertise does not change between polls. The
 * graph fetches this once when it opens and joins it against the cards it already
 * has, so watching a swarm costs exactly what it did before.
 */
 listForRepository: oc
.input(z.object({ repositoryId: z.string }))
.output(z.array(SubjectMapListingSchema)),

 /**
 * Every map in the workspace.
 *
 * For the design canvas, which draws personas and has no repository to filter by —
 * and which portable expertise asks to show, per member, what that member is expert in. A
 * roster of names with no expertise on it is the surface that made "two security
 * reviewers, one of which learned this subsystem" impossible to see.
 */
 listAll: oc.output(z.array(SubjectMapListingSchema)),

 /**
 * One curation pass over one map.
 *
 * Offered to a human as well as run on the idle sweep, because a pass is cheap,
 * computed rather than asked of a model, and the report is exactly what someone
 * looking at a map wants: what was re-checked, what was kept, what was retired, and
 * what has been *proposed* for retirement next time.
 */
 curate: oc
.input(z.object({ mapId: z.string }))
.output(
 z.object({
 checked: z.number.int,
 kept: z.number.int,
 retired: z.number.int,
 proposed: z.number.int,
 withdrawn: z.number.int,
 }),
),

 /**
 * Which maps one run was handed, and which it was deliberately denied.
 *
 * The stronger half of the operator's "which agents adopted which expertise": a
 * persona's map list says what it *holds*, and only this says what a particular piece
 * of work actually read. A run on the withheld arm is reported too, because a badge
 * that showed only retrievals would make the baseline invisible and the measurement
 * look like a feature that sometimes forgets to fire.
 */
 usedByRuns: oc
.input(z.object({ agentRunIds: z.array(z.string).max(500) }))
.output(
 z.array(
 z.object({
 agentRunId: z.string,
 map: SubjectMapSchema,
 arm: z.enum(['retrieved', 'withheld']),
 nodesShown: z.number.int,
 edgesShown: z.number.int,
 }),
),
),

 /**
 * A human's standing answer about whether a map is used.
 *
 * Promotion is a human act, and so is demotion — an operator watching a map produce
 * bad advice should not have to wait for five more runs to agree with them. `null`
 * hands the decision back to the measurement, which is a third act.
 */
 setRetrieval: oc
.input(
 z.object({
 mapId: z.string,
 override: z.enum(['on', 'off']).nullable,
 }),
)
.output(SubjectMapSchema),

 /**
 * Start a mastery run.
 *
 * Takes a repository rather than a free-text subject: the revision has to be
 * checkable, and the platform can only check one it can resolve. An author or corpus
 * subject needs a different extractor before it can be started this way, and
 * offering the field before that exists would be a control the runtime ignores.
 */
 start: oc
.input(
 z.object({
 threadId: z.string,
 personaId: z.string,
 repositoryId: z.string,
 task: z.string.max(4_000).optional,
 /**
 * What is being mastered. `repository` is the tree; `author` is one
 * person's record *within* that repository's history, which is why a repository
 * is required either way — an author subject with no corpus to read is a map
 * with nothing behind it.
 *
 * `corpus` is deliberately absent: the bar for a new subject kind is an
 * extractor plus something checkable to serve as the revision, and prose has
 * neither here yet. Offering it would be a control the runtime ignores.
 */
 subjectKind: z.enum(['repository', 'author']).optional,
 /** Who, for an author subject — the name or email git history records. */
 subjectRef: z.string.max(200).optional,
 /**
 * What kind of expertise to grasp.
 *
 * A closed vocabulary rather than free text alone, because free text does not
 * fix the failure mastery names: a model told to "learn this repository" and then
 * "focus on payments" produces the same directory listing about payments. Each
 * focus carries what *earns a node* for the thing being asked.
 */
 focus: z.array(z.string).max(8).optional,
 /** The human's own words, for what a closed vocabulary cannot express. */
 guidance: z.string.max(2_000).optional,
 }),
)
.output(AgentRunSchema),
 },

 /**
 * The Colosseum — a bounded, budgeted, recorded session with a fixed
 * roster and a verdict.
 *
 * There is deliberately no procedure that merges a session's conclusions into a map.
 * Mastery: "a session's output is a set of claims with verdicts, never a merged map;
 * nothing a session says is written into a trusted layer by the session itself."
 */
 colosseum: {
 list: oc.output(z.array(ColosseumSessionSchema)),

 get: oc.input(z.object({ sessionId: z.string })).output(ColosseumViewSchema),

 /**
 * Convenes one. The roster is fixed here and never added to — the "no agent pulls
 * in another mid-session" is enforced by there being no way to.
 */
 convene: oc
.input(
 z.object({
 threadId: z.string,
 repositoryId: z.string.nullable,
 purpose: z.enum(['consultation', 'contention', 'crunching', 'warm_up']),
 subject: z.string.min(1).max(200),
 question: z.string.min(1).max(2_000),
 personaIds: z.array(z.string).min(2).max(5),
 turnCap: z.number.int.min(1).max(12).optional,
 spendCapUsd: z.number.nonnegative.nullable.optional,
 }),
)
.output(ColosseumSessionSchema),

 /** A claim held *before* the first exchange. Refused once the session has started. */
 recordClaim: oc
.input(
 z.object({
 sessionId: z.string,
 personaId: z.string,
 statement: z.string.min(1).max(2_000),
 }),
)
.output(ColosseumClaimSchema),

 /**
 * Settles a claim with the check that settled it. A verdict with no citation is
 * refused — the arbiter is the repository, and nothing is settled by vote.
 */
 settleClaim: oc
.input(
 z.object({
 claimId: z.string,
 verdict: z.enum(['upheld', 'refuted']),
 citation: z.string.min(1).max(1_000),
 }),
)
.output(ColosseumClaimSchema),

 /**
 * Takes one turn — one agent run, against the cap and the spend ceiling.
 *
 * `personaId` omitted means whoever has gone longest without speaking, so a session
 * driven by clicking one button still gives every participant the floor. The output
 * says what happened rather than throwing, because every refusal here — the floor is
 * taken, the cap is reached, the ceiling is spent — is a fact about the session that
 * a human should read, not an error.
 */
 takeTurn: oc
.input(z.object({ sessionId: z.string, personaId: z.string.optional }))
.output(
 z.object({
 ok: z.boolean,
 reason: z.string,
 agentRunId: z.string.nullable,
 speakerPersonaName: z.string.nullable,
 }),
),

 conclude: oc.input(z.object({ sessionId: z.string })).output(ColosseumViewSchema),
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

 /**
 * Who this persona could delegate to **if launched with these overrides**
 *.
 *
 * Separate from `personaGroup.delegationMatrix`, which answers the same question
 * for personas as they are stored. A run launcher lets a human override the model
 * and the cap for one run, and those are exactly the two fields that silently
 * empty a roster: a planner moved to a cheaper model cannot start a worker on a
 * higher tier, so a correct configuration produces a planner with nobody to
 * delegate to. Measured once by paying for a live run that planned nothing and
 * replied that "the only available persona is sweep-probe".
 */
 delegationPreview: oc
.input(
 z.object({
 personaId: z.string,
 model: z.string.optional,
 budgetCapUsd: z.number.nullable.optional,
 }),
)
.output(
 z.object({
 planner: z.boolean,
 delegatable: z.array(z.object({ id: z.string, name: z.string })),
 refused: z.array(
 z.object({
 id: z.string,
 name: z.string,
 refusals: z.array(DelegationRefusalSchema),
 }),
),
 }),
),

 /**
 * Parses a candidate markdown without saving it, so the persona form and its
 * raw-markdown toggle can show the *same* reading of a draft that a save would
 * store. Read-only and workspace-free — it touches nothing.
 */
 parse: oc
.input(z.object({ markdownSource: z.string.max(40_000) }))
.output(PersonaDraftSchema),

 create: oc
.input(z.object({ markdownSource: z.string.min(1).max(40_000) }))
.output(AgentPersonaSchema),

 update: oc
.input(z.object({ personaId: z.string, markdownSource: z.string.min(1).max(40_000) }))
.output(AgentPersonaSchema),

 /**
 * Removes a persona. No history is lost — a run snapshots its whole persona spec
 * at start — so this only refuses while a run of that persona is in flight.
 */
 delete: oc
.input(z.object({ personaId: z.string }))
.output(z.object({ ok: z.literal(true) })),

 /**
 * Replaces a built-in's markdown with the version this build ships.
 *
 * The resolution for a `'stale'` built-in, and human-only for the reason every
 * other persona write is: it discards whatever the row said. Refused on a persona
 * that is not a built-in — there would be nothing to reset it to.
 */
 resetToBuiltin: oc
.input(z.object({ personaId: z.string }))
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
 /**
 * Optional so every other caller of this procedure — the chip list, a TUI —
 * keeps working without inventing coordinates. Omitting it leaves the stored
 * layout alone rather than clearing it, which is what a client that does not
 * draw a canvas means by not sending one.
 */
 layout: z
.record(z.string, z.object({ x: z.number, y: z.number }))
.optional,
 /**
 * How many of each member this team runs at once. Optional on
 * the same terms as `layout` — omitted leaves the stored widths alone.
 *
 * Unlike `layout`, the server *validates* this rather than storing what it is
 * given: the runtime reads it, so a width of 0 or one past the ceiling is a
 * refusal with a reason, not a stored number that later refuses every run of
 * that persona.
 */
 fleet: z.record(z.string, z.number).optional,
 /**
 * Who reviews whom on this team, keyed by
 * reviewer persona id. Optional on the same terms as `layout` and `fleet`.
 *
 * Validated server-side, not stored as given: the roster tells a Planner to act
 * on it, so a policy asking for a self-review or for a *planner* to be reviewed
 * would be an instruction the Planner cannot follow.
 */
 reviewers: z.record(z.string, z.array(z.string)).optional,
 /**
 * The root orchestrator — the member the work starts from, and the
 * vantage the canvas measures depth from.
 *
 * Nullable *and* optional, and the two mean different things: omitted leaves
 * the stored root alone (a TUI that draws no canvas is not un-choosing one),
 * `null` clears it back to picked-by-reach. Validated server-side like `fleet`
 * and `reviewers` — a root that is not a planner on this team would make every
 * depth the canvas reports wrong.
 */
 orchestratorId: z.string.nullable.optional,
 }),
)
.output(PersonaGroupSchema),

 delete: oc.input(z.object({ personaGroupId: z.string })).output(z.object({ ok: z.literal(true) })),

 /**
 * Every planner-to-persona pair in this workspace, and why each refused one is
 * refused.
 *
 * Workspace-wide rather than per group, because the rules are properties of the
 * personas rather than of a grouping — and because the same answer belongs under
 * the run launcher's model select, where choosing a cheap planner silently empties
 * its roster.
 */
 delegationMatrix: oc.output(z.array(DelegationEdgeSchema)),
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
 /**
 * How much prose this run should produce.
 * Per run rather than per persona: the same persona is wanted terse on the fifth
 * run of the afternoon and explanatory when someone is reading along.
 */
 responseStyle: ResponseStyleSchema.optional,
 /**
 * Overrides the persona's model for this run only.
 * The cost model names model choice as the cost swing factor and requires it be visible
 * rather than buried in config; the server refuses a model it cannot price,
 * because an unmeterable run is one whose budget cap cannot be enforced.
 */
 model: z.string.min(1).max(100).optional,
 /**
 * Overrides the persona's spend ceiling for this run only.
 * Null means uncapped, and is a deliberate human choice rather than an
 * omission — omitting the field entirely keeps the persona's own cap.
 */
 budgetCapUsd: z.number.positive.max(1_000).nullable.optional,
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

 /**
 * Re-enters a Planner with a human's message and lets it change its own plan
 *.
 *
 * Explicit rather than implied by posting in the thread: every call is a frontier
 * model run, and putting one behind every message would spend exactly the
 * attention and money the riskiest assumption measures as the cost this feature exists to reduce. The
 * message is posted to the thread and written to the ledger as a human note before
 * any model is paid, so the instruction lands even if the re-planning turn does not.
 *
 * Returns the steering run, so a client can watch it like any other.
 */
 steer: oc
.input(z.object({ agentRunId: z.string, message: z.string.min(1).max(4_000) }))
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
 /**
 * The reply, when this gate carries a clarifying question.
 *
 * Approving a question with no answer is treated as a denial by the server:
 * resuming the run having told the model nothing, while implying it was
 * answered, is worse than a clean refusal — the model reads silence as assent.
 */
 answer: z.string.min(1).max(4_000).optional,
 }),
)
.output(ApprovalRequestSchema),
 },
} as const

export type Contract = typeof contract
