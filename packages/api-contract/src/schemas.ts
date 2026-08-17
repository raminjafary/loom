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

/**
 * One step of a repository's definition of done. Named, because
 * "verification failed" sends a human to open a log and "the build check failed" sends
 * them to the build.
 */
export const VerificationCheckSchema = z.object({
 name: z.string.min(1).max(40),
 command: z.string.min(1).max(2_000),
})

/**
 * What a repository's definition of done said about one run's branch.
 *
 * `skipped` and `refused` are on the wire as themselves rather than folded into
 * `failed`: neither says anything about the branch — one is a repository with no
 * definition of done, the other the platform declining to run agent code unsandboxed —
 * and a client that could not tell them apart would show broken work where there is
 * none.
 */
export const RunVerificationSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 agentRunId: z.string,
 repositoryId: z.string,
 branchName: z.string,
 status: z.enum(['pending', 'passed', 'failed', 'skipped', 'refused', 'error']),
 commitSha: z.string.nullable,
 checks: z.array(
 z.object({
 name: z.string,
 status: z.enum(['passed', 'failed', 'not_run']),
 detail: z.string.nullable,
 durationMs: z.number.nullable,
 }),
),
 reason: z.string.nullable,
 createdAt: z.date,
 startedAt: z.date.nullable,
 finishedAt: z.date.nullable,
})

export const RepositorySchema = z.object({
 id: z.string,
 workspaceId: z.string,
 runnerId: z.string,
 displayName: z.string,
 absolutePath: z.string,
 defaultBranch: z.string,
 /**
 * What the merge queue ran before the harness existed.
 * Superseded by `verificationChecks` and still read: an empty list falls back to this
 * as a single check named `tests`.
 */
 verifyCommand: z.string.nullable,
 /**
 * This repository's definition of done: named checks, in dependency order, stopped at the first failure. Run
 * against a finished run's own branch and again against a rebased one in the merge
 * queue — the same list both times.
 */
 verificationChecks: z.array(VerificationCheckSchema),
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
 /**
 * Whether a reconciler may attempt a conflicted branch here. On by default.
 *
 * On the wire because it moved from `LOOM_RECONCILER_ENABLED` — an operator-wide env
 * var no client could read — precisely so a team's canvas could show it. The rule for
 * that canvas is that it may only draw what the runtime executes, so the drawing and
 * the field the runtime consults have to be the same thing.
 */
 reconcilerEnabled: z.boolean,
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
 /**
 * Hosts a persona holding this may reach through the egress proxy.
 *
 * The grant is the capability, not the tool — a persona reaches the open web because
 * an operator attached something that says so, never because its tool list happens to
 * contain `WebFetch`. On the wire so a surface can *show* which agents have web reach.
 */
 egressHosts: z.array(z.string),
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
 'verification_result',
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

/**
 * A persona's expertise in one subject.
 *
 * `createdAt` is a `Date` rather than a string for the same reason every other schema
 * here uses one, and the reason is a bug this repository shipped: the socket path is
 * `JSON.stringify` → Valkey → a gateway forwarding bytes, so a `z.date` on a frame
 * arrives as an ISO string and silently fails validation. These procedures are HTTP
 * only, where the oRPC codec preserves the type.
 */
export const SubjectMapSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 personaId: z.string,
 subjectKind: z.enum(['repository', 'author', 'corpus']),
 repositoryId: z.string.nullable,
 subjectRef: z.string,
 /** Mastery: "a map with no commit is a rumour." */
 revision: z.string,
 status: z.enum(['mastering', 'ready', 'failed']),
 /**
 * A human's standing answer about whether this map is used. Null hands the
 * decision back to the measurement, which is a third state and not the same as 'off'.
 */
 retrievalOverride: z.enum(['on', 'off']).nullable,
 masteryRunId: z.string.nullable,
 createdAt: z.date,
 updatedAt: z.date,
})

/**
 * One arm of an expertise trial. The `withheld` arm is the baseline —
 * runs deliberately denied a map they were eligible for — and it is the half that makes
 * "does this help" answerable at all.
 */
export const ExpertiseArmSummarySchema = z.object({
 arm: z.enum(['retrieved', 'withheld']),
 decided: z.number.int,
 merged: z.number.int,
 discarded: z.number.int,
 failed: z.number.int,
 costUsdTotal: z.number,
 successRate: z.number,
 meanCostUsd: z.number,
})

export const ExpertiseEffectSchema = z.object({
 retrieved: ExpertiseArmSummarySchema,
 withheld: ExpertiseArmSummarySchema,
 verdict: z.enum(['undecided', 'helps', 'no-better']),
 /** One sentence naming the numbers the verdict rests on, for a human to disagree with. */
 detail: z.string,
})

/**
 * A map as a list shows it: what it is, and what the platform is *doing* with it.
 *
 * The state travels with the list because that is what makes an expertise legible before
 * it is used. A badge reading "expert in this repository" while the platform is
 * quietly withholding the map would be the surface lying — the same class of dishonesty
 * as a canvas drawing an edge the runtime refuses.
 */
export const SubjectMapListingSchema = z.object({
 map: SubjectMapSchema,
 retrievalState: z.enum(['trial', 'on', 'off']),
 decided: z.object({ retrieved: z.number.int, withheld: z.number.int }),
})

export const MapNodeSchema = z.object({
 id: z.string,
 key: z.string,
 kind: z.enum([
 'module',
 'file',
 'symbol',
 'test',
 'entry_point',
 'migration',
 'config',
 'concept',
 'convention',
 'constraint',
 'hazard',
 'person',
 ]),
 label: z.string,
 summary: z.string,
 /**
 * The trust boundary, carried to the client so the UI can render it. Mastery: an inferred
 * edge must not look like a parsed one, and a client that could not tell them apart
 * would be the place the distinction quietly stopped mattering.
 */
 provenance: z.enum(['extracted', 'inferred', 'ambiguous']),
 paths: z.array(z.string),
 observationCount: z.number,
 derivedAtRevision: z.string,
 createdAt: z.date,
 /** Set rather than deleted when superseded — history, not absence. */
 invalidatedAt: z.date.nullable,
 invalidatedReason: z.string.nullable,
 /**
 * A curation pass intends to retire this claim on its next run.
 *
 * On the wire because that is the whole point of proposing first: deleting memory is
 * the one self-modification with no diff to review, and a proposal nobody can see is
 * the same as no proposal at all.
 */
 retirementProposedAt: z.date.nullable,
 retirementReason: z.string.nullable,
})

export const MapEdgeSchema = z.object({
 id: z.string,
 fromKey: z.string,
 toKey: z.string,
 kind: z.enum([
 'imports',
 'calls',
 'tested_by',
 'implements',
 'configures',
 'supersedes',
 'contradicts',
 'owned_by',
 'documented_in',
 ]),
 provenance: z.enum(['extracted', 'inferred', 'ambiguous']),
 derivedAtRevision: z.string,
 createdAt: z.date,
 invalidatedAt: z.date.nullable,
 invalidatedReason: z.string.nullable,
})

/**
 * The measured progress. Every figure is one the platform computed; an agent's own
 * estimate of its progress is model output and is deliberately not in this payload at
 * all, so no client can accidentally render it as the number.
 */
export const MasteryProgressSchema = z.object({
 coverage: z.number,
 /** The two numbers the ratio is of — a 0% that cannot be read is not an answer. */
 filesRead: z.number.int,
 filesInScope: z.number.int,
 nodeCount: z.number,
 edgeCount: z.number,
 yield: z.number,
 /** Coverage still climbing while yield has stopped — "reading without learning". */
 yieldFlat: z.boolean,
 spendUsd: z.number,
})

export const MasteryViewSchema = z.object({
 map: SubjectMapSchema,
 nodes: z.array(MapNodeSchema),
 edges: z.array(MapEdgeSchema),
 progress: MasteryProgressSchema.nullable,
 hubs: z.array(z.object({ key: z.string, degree: z.number })),
 /** Whether reading this map has been shown to help, and what is being done about it. */
 effect: ExpertiseEffectSchema,
 retrievalState: z.enum(['trial', 'on', 'off']),
 /**
 * What became of the runs each claim was shown to, keyed by node id. Counts rather than a score, because "outranked" is a
 * conclusion and the human should be able to check it against the runs it came from.
 */
 claimOutcomes: z.record(
 z.string,
 z.object({
 decided: z.number.int,
 merged: z.number.int,
 discarded: z.number.int,
 failed: z.number.int,
 }),
),
})

/**
 * A convened session.
 *
 * The four properties mastery says make it a venue rather than a feature are all here: the
 * roster (its own array), the spend ceiling, the transcript, and the verdicts.
 */
export const ColosseumSessionSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 threadId: z.string,
 repositoryId: z.string.nullable,
 purpose: z.enum(['consultation', 'contention', 'crunching', 'warm_up']),
 subject: z.string,
 question: z.string,
 status: z.enum(['convened', 'running', 'concluded', 'abandoned']),
 turnCap: z.number.int,
 spendCapUsd: z.number.nullable,
 /** Roster diversity as convened — correlated errors are the mechanism, so this is data. */
 distinctSubjects: z.number.int,
 distinctModels: z.number.int,
 /** Who has the floor. A session speaks one voice at a time, and this is that voice. */
 speakingRunId: z.string.nullable,
 speakingPersonaId: z.string.nullable,
 createdAt: z.date,
 concludedAt: z.date.nullable,
})

export const ColosseumClaimSchema = z.object({
 id: z.string,
 statement: z.string,
 /** Recorded before the first exchange — what makes attrition measurable. */
 originalHolderPersonaId: z.string,
 verdict: z.enum(['unsettled', 'upheld', 'refuted']),
 /** What settled it. Empty on an unsettled claim, and required to leave that state. */
 citation: z.string,
 droppedAt: z.date.nullable,
})

/**
 * A cross-project relation, in whichever of its three states it has reached.
 *
 * Both ends carry their subject and the persona that learned them, because a relation
 * without those names nothing a human can check: "these two concepts are the same" is a
 * claim about two codebases, and the reviewer has to know which two.
 */
export const AtlasEdgeEndSchema = z.object({
 nodeId: z.string,
 mapId: z.string,
 label: z.string,
 summary: z.string,
 subjectRef: z.string,
 personaName: z.string,
 /** Whether the map still holds this claim — an endpoint can be retired under the edge. */
 live: z.boolean,
})

export const AtlasEdgeSchema = z.object({
 id: z.string,
 relation: z.enum(['same_concept', 'analogous_to', 'contradicts']),
 /** The agent's argument. Model-authored — untrusted text, rendered as data. */
 rationale: z.string,
 status: z.enum(['proposed', 'contended', 'promoted', 'rejected']),
 from: AtlasEdgeEndSchema,
 to: AtlasEdgeEndSchema,
 proposedByPersonaName: z.string,
 proposedByRunId: z.string.nullable,
 /** The session that argued over it, when one has — where the transcript is. */
 sessionId: z.string.nullable,
 /** The human who decided, by name. Empty until somebody has. */
 decidedByName: z.string,
 decidedAt: z.date.nullable,
 decisionNote: z.string,
 createdAt: z.date,
})

export const ColosseumViewSchema = z.object({
 session: ColosseumSessionSchema,
 participants: z.array(
 z.object({
 personaId: z.string,
 personaName: z.string,
 mapId: z.string.nullable,
 model: z.string,
 subjectRef: z.string,
 }),
),
 claims: z.array(ColosseumClaimSchema),
 /** The transcript. Model-authored throughout — untrusted text. */
 turns: z.array(
 z.object({
 seq: z.number.int,
 personaName: z.string,
 agentRunId: z.string.nullable,
 text: z.string,
 createdAt: z.date,
 }),
),
 outcome: z.object({
 upheld: z.number.int,
 refuted: z.number.int,
 /** Not a failure count: an unsettled disagreement is a successful outcome. */
 unsettled: z.number.int,
 dropped: z.number.int,
 lostGround: z.boolean,
 }),
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
 * Where this card is running — the runner's name and the channel the
 * work is watched in. The inbox has both; the board and the active-runs panel did not, and
 * those are the surfaces a human uses while arbitrating several agents.
 *
 * Empty rather than the id when unresolvable: "which machine" is how somebody decides
 * whether a stuck run is stuck on *this* box, and a uuid answers that worse than a blank,
 * because it looks like an answer.
 */
 runnerName: z.string,
 channelName: z.string,

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
 /**
 * When the platform told this run its window was filling, or null.
 *
 * Distinct from the ratio beside it: a full window does not imply the run was told,
 * and a run that was told may have decided it is still doing fine — which is the
 * decision mastery deliberately leaves to the agent rather than to a number.
 */
 handoffSuggestedAt: wireDate.nullable,
})

/**
 * One run having been shown another's notes.
 *
 * The complaint is that the tree renders parentage but not *interaction*. Collisions
 * became edges; this is who learned from whom.
 */
export const NoteReadEdgeSchema = z.object({
 readerRunId: z.string,
 authorRunId: z.string,
 /** Reads behind the edge — "read it once" and "kept coming back" are different facts. */
 readCount: z.number,
})

export const SwarmBoardSchema = z.object({
 treeRunId: z.string,
 cards: z.array(SwarmBoardCardSchema),
 /** Pairs of cards whose owned paths collide — the merge conflicts to expect. */
 pathCollisions: z.array(
 z.object({ titles: z.tuple([z.string, z.string]), paths: z.array(z.string) }),
),
 noteReads: z.array(NoteReadEdgeSchema),
 /**
 * Notes as objects on the canvas, bounded to decisions and
 * blockers: a decision governs everyone after it and a blocker is asking for help,
 * while a finding is one run's experience of its own work and a busy swarm writes
 * dozens. Titles are model-authored in the general case — untrusted text.
 */
 notes: z.array(
 z.object({
 noteId: z.string,
 agentRunId: z.string,
 kind: z.enum(['decision', 'blocker']),
 title: z.string,
 authorKind: z.string,
 createdAt: z.date,
 }),
),
 /** Decisions and blockers beyond the ones drawn — reported, never silently dropped. */
 elidedNotes: z.number.int,
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

/**
 * A self-modification envelope — a human-set ceiling on what a persona may
 * become, distinct from `harnessDelegates`, which bounds what it may hand *down*.
 *
 * Nullable wherever it appears, and null means **no permission** rather than no ceiling:
 * a persona with no envelope may not rewrite itself at all. Every reader goes through the
 * domain's `maySelfModify`, so this schema deliberately does not encode a default.
 *
 * No `pathScope`, though continuity mode lists one. Every run writes only inside its own clone,
 * enforced in the container, and a narrower scope needs an enforcer that does not
 * exist — putting the field on the wire would be a control the runtime ignores.
 */
export const EnvelopeSchema = z.object({
 tools: z.array(z.string),
 /** A model *id* whose tier is the ceiling — never a tier name, which would be a second vocabulary. */
 model: z.string.nullable,
 budgetCapUsd: z.number.nullable,
 /** Capability names, because an envelope is written by a human and a uuid is unreviewable. */
 capabilities: z.array(z.string),
 subagentDepth: z.number.int.nullable,
 approvalMode: ApprovalModeSchema.nullable,
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
 * The self-modification ceiling this run was launched with.
 *
 * On the wire because a Zod schema **strips what it does not name**, and this
 * repository has already lost a field to exactly that: a value present on the domain
 * type and absent from the frame arrives nowhere and nothing fails. The snapshot is
 * what `attenuateEnvelope` reads at a child start, so a stripped envelope is a ceiling
 * that silently stops applying one delegation hop down.
 *
 * Optional and nullable for the same reason `planner` is optional: a run that predates
 * the field has stored persona JSON without it, and absence means no permission.
 */
 envelope: EnvelopeSchema.nullish,
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
/**
 * A prompt a persona used to have.
 *
 * `markdownSource` is the **superseded** document: the persona row is always the live
 * version, so the history holds what was replaced rather than a second copy of what is
 * already there. Newest first, so the head of the list is the version immediately before
 * the current one — which is also the one a revert restores.
 */
export const PersonaRevisionSchema = z.object({
 id: z.string,
 personaId: z.string,
 markdownSource: z.string,
 replacedByKind: z.enum(['human', 'agent_run', 'platform']),
 replacedByRunId: z.string.nullable,
 /** What the author said they were doing. Empty for a human's edit, which has a diff. */
 rationale: z.string,
 createdAt: z.string,
})

/**
 * What the runs so far say about an agent's edit.
 *
 * `verdict` is `undecided` until both arms have enough finished runs, and that is the
 * common state rather than an error one: an edit is live and unproven for as long as it
 * takes a workspace to run the persona ten times.
 */
export const PromptTrialSchema = z.object({
 revisionId: z.string,
 verdict: z.enum(['undecided', 'better', 'worse', 'no-better']),
 /** One sentence a human reads instead of doing the arithmetic. */
 detail: z.string,
 arms: z.array(
 z.object({
 arm: z.enum(['revised', 'previous']),
 decided: z.number.int,
 merged: z.number.int,
 failed: z.number.int,
 meanCostUsd: z.number,
 }),
),
})

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
 /** The ceiling. Null means this persona may not rewrite itself — not that it may do anything. */
 envelope: EnvelopeSchema.nullable,
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
 envelope: EnvelopeSchema.nullable,
 })
.nullable,
})

/** The persona model — organizational grouping of personas, not a Team/roster. */
/**
 * A plan a human is being asked to approve.
 *
 * The stored decomposition, field for field — what is reviewed has to be exactly what would
 * run, and a second projection of "the plan" is a second thing that can be wrong.
 */
export const PlanReviewSubtaskSchema = z.object({
 id: z.string,
 position: z.number.int,
 title: z.string,
 /** The whole instruction the worker will get. Model-authored — untrusted text. */
 task: z.string,
 personaName: z.string,
 paths: z.array(z.string),
 /** Which sibling positions must finish first — the DAG a reviewer reads as the shape. */
 dependsOn: z.array(z.number.int),
 /** Which sibling `position` this one reviews, or null. */
 reviews: z.number.int.nullable,
 /**
 * Which repository this subtask lands in, by name, or null for the planner's own
 * — the field a cross-repository team's plan actually uses, and the
 * one a reviewer most needs to see before accepting.
 */
 repository: z.string.nullable,
 status: z.enum(['waiting', 'started', 'skipped', 'refused']),
 agentRunId: z.string.nullable,
 detail: z.string.nullable,
})

export const PlanReviewSchema = z.object({
 plannerRunId: z.string,
 plannerName: z.string,
 /**
 * True exactly when nothing has started and something is waiting. Derived rather than
 * stored: a plan mid-flight also has waiting rows, so a stored flag would need clearing at
 * a moment nobody owns.
 */
 awaitingReview: z.boolean,
 subtasks: z.array(PlanReviewSubtaskSchema),
})

export const PersonaGroupSchema = z.object({
 id: z.string,
 workspaceId: z.string,
 name: z.string,
 /** What this team is for, in one line. Empty means undescribed. */
 description: z.string,
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
 /**
 * Who reviews whom on this team, keyed by reviewer
 * persona id. Read by the runtime: a clause in the Planner's roster, and a plan-time
 * warning when work the team expects reviewed is not.
 */
 reviewers: z.record(z.string, z.array(z.string)),
 /**
 * Who reports to whom — the chain of command, keyed by the **worker**
 * and holding the planner it reports to.
 *
 * Keyed the opposite way from `reviewers`, because a worker reports to at most one
 * planner and one value per key is what enforces it. Read by the runtime: it narrows the
 * roster a planner is given, and it can only narrow — attenuation still decides what a
 * child may hold. Empty means no narrowing, not nobody.
 */
 reportsTo: z.record(z.string, z.string),
 /**
 * The other repositories this team's subtasks may name. `repositoryId`
 * is where a run defaults; this is which repositories a *subtask* may land in.
 */
 extraRepositoryIds: z.array(z.string),
 /**
 * Which member the work starts from — the root orchestrator, as the canvas's
 * vantage point (see `orchestrate` in client-core).
 *
 * Stored because depth is only answerable from somewhere. The delegation matrix is
 * computed from a root because a workspace-wide matrix has nowhere else to stand, so
 * two planner personas each admit the other and the canvas draws a chain that no run
 * tree can have. Given the root, every other depth follows and the edges the runtime
 * would refuse *in this arrangement* become sayable.
 *
 * Null means nobody has chosen and the canvas picks by reach. This is deliberately
 * not a claim that the runtime reads it: it selects which of two runtime behaviours
 * the drawing describes, which is the opposite of a control the runtime ignores.
 */
 orchestratorId: z.string.nullable,
 /**
 * Which repository this team's work lands in.
 *
 * The fact the other two policy items on that canvas were blocked on: verification and
 * reconciliation are fields on a *repository*, so without this a team's canvas had no
 * way to say whose policy it was drawing. Read by the run launcher, which defaults to
 * it — the rule for this canvas is that it may only draw what the runtime executes.
 *
 * Null means nobody has chosen, and a repository that is deleted leaves the teams that
 * named it in exactly that state.
 */
 repositoryId: z.string.nullable,
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
/**
 * `handoff` is the warm successor — a new run in the same tree, on the same branch,
 * against the same ledger. On the wire because mastery requires the swap to be *visible*: a
 * silent identity change mid-task is what destroys trust in a system otherwise doing the
 * right thing.
 */
export const AgentRunRelationSchema = z.enum([
 'delegation',
 'review',
 'reconcile',
 'steer',
 'handoff',
])

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
 /**
 * When the platform *suggests* a handoff, and how many one tree may make.
 *
 * Neither swaps an agent. The threshold decides when a filling run is told its own
 * number; the cap is the one bound the platform enforces on its own. Null means the
 * platform's default, which a surface must render as "not set" rather than as the
 * number it currently resolves to.
 */
 handoff: z.object({
 threshold: z.number.nullable,
 capPerTree: z.number.int.nullable,
 }),
 /**
 * Whether a Planner's decomposition waits for a human before anything starts
 *.
 *
 * The pair to autonomous teams: with the tool gates off, the human's job is to review the
 * plan and to merge, and a plan was the one expensive decision with no gate at all — N
 * runs spawn the moment a model submits, and the steering only reaches them afterwards.
 */
 planReviewRequired: z.boolean,
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
export type SubjectMap = z.infer<typeof SubjectMapSchema>
export type Envelope = z.infer<typeof EnvelopeSchema>
export type AtlasEdge = z.infer<typeof AtlasEdgeSchema>
export type PlanReview = z.infer<typeof PlanReviewSchema>
export type AtlasEdgeEnd = z.infer<typeof AtlasEdgeEndSchema>
export type ColosseumSession = z.infer<typeof ColosseumSessionSchema>
export type ColosseumView = z.infer<typeof ColosseumViewSchema>
export type SubjectMapListing = z.infer<typeof SubjectMapListingSchema>
export type ExpertiseEffect = z.infer<typeof ExpertiseEffectSchema>
export type MapNode = z.infer<typeof MapNodeSchema>
export type MapEdge = z.infer<typeof MapEdgeSchema>
export type MasteryView = z.infer<typeof MasteryViewSchema>
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
export type PersonaRevision = z.infer<typeof PersonaRevisionSchema>
export type PromptTrial = z.infer<typeof PromptTrialSchema>
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
