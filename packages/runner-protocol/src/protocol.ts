import { z } from 'zod'

/**
 * Wire protocol for /ws/runner — shared between
 * apps/server and apps/runner so there is exactly one source of truth for the
 * frame shapes, the same reasoning as packages/api-contract for the browser
 * boundary. Both directions are versioned together for now since Runner and
 * server ship in lockstep; a real versioning story is a Phase 3+ concern.
 */

/**
 * A registry capability, resolved and snapshotted onto the run.
 *
 * A skill carries its `content` rather than a path, because with
 * `settingSources: []` a skill living in the run's clone would be content the
 * agent itself can write — the registry provisions it instead.
 */
export const CapabilitySpecSchema = z.discriminatedUnion('kind', [
 z.object({
 kind: z.literal('mcp'),
 name: z.string,
 transport: z.enum(['stdio', 'sse', 'http']),
 command: z.string.nullable,
 args: z.array(z.string),
 url: z.string.nullable,
 /** The pinned tool-list hash; null until a first observation is recorded. */
 toolListHash: z.string.nullable,
 allowedTools: z.array(z.string),
 /**
 * Hosts this grant opens through the egress proxy.
 *
 * Declared here as well as on the domain type and the port, because this schema is
 * the frame — and this repository has three times shipped a field that existed
 * everywhere except the place the value actually crosses. Defaulted rather than
 * required so a Runner resuming from a state file written before this existed does
 * not fail to parse its own run; the default is the closed one.
 */
 egressHosts: z.array(z.string).default([]),
 }),
 z.object({
 kind: z.literal('skill'),
 name: z.string,
 content: z.string,
 egressHosts: z.array(z.string).default([]),
 }),
])

export const PersonaSpecSchema = z.object({
 name: z.string,
 systemPrompt: z.string,
 model: z.string,
 tools: z.array(z.string),
 approvalMode: z.enum(['ask', 'accept-edits', 'auto']),
 budgetCapUsd: z.number.nullable,
 // Optional on the wire: a Runner resumed from a state file written before the
 // registry existed has no capabilities recorded, and refusing to parse that
 // would turn an upgrade into a lost run.
 capabilities: z.array(CapabilitySpecSchema).optional,
 /** Planner — gets the delegation tool, must declare `tools: []`. */
 planner: z.boolean.optional,
 /** A planner's delegation envelope; empty for every other persona. */
 delegates: z.array(z.string).optional,
 /**
 * The self-modification ceiling, carried so the Runner's own copy of the
 * snapshot is the same snapshot the server holds.
 *
 * Declared here for the reason this file's `egressHosts` comment gives, which has now
 * cost this repository four fields: **a Zod schema strips what it does not name.** A
 * field that exists on the domain type and not on the frame is one that crosses the wire
 * as `undefined`, and nothing anywhere fails. The Runner does not enforce the envelope —
 * nothing self-modifies yet — but a resumed run rebuilds its persona from a state file
 * validated by this schema, so an unnamed field would be dropped on every restart.
 */
 envelope: z
.object({
 tools: z.array(z.string),
 model: z.string.nullable,
 budgetCapUsd: z.number.nullable,
 capabilities: z.array(z.string),
 subagentDepth: z.number.int.nullable,
 approvalMode: z.enum(['ask', 'accept-edits', 'auto']).nullable,
 })
.nullish,
})

/**
 * One subtask of a Planner's decomposition.
 */
export const PlanSubtaskSchema = z.object({
 title: z.string,
 task: z.string,
 personaName: z.string,
 /**
 * Repository-relative paths this subtask owns. Optional on the wire: a Runner
 * resumed from a state file written before this field existed has none, and
 * refusing to parse that would turn an upgrade into a lost run.
 */
 paths: z.array(z.string).optional,
 /**
 * Which other subtasks in this plan must finish first, by index.
 * Optional on the wire for the same reason `paths` is: a Runner resumed from a
 * state file written before this field existed has none, and refusing to parse
 * that would turn an upgrade into a lost run.
 */
 dependsOn: z.array(z.number).optional,
 /**
 * Which sibling subtask this one reviews, by index. Optional
 * on the wire for the same reason the two fields above are.
 *
 * Nullable as well as optional: the SDK renders an optional number as a field a
 * model may send as `null` to mean "not reviewing anything", and a Zod failure here
 * is a dropped plan frame with no reason the model could act on.
 */
 reviews: z.number.nullish,
 /**
 * Which repository this subtask lands in, by **name**. Absent or null means the planner's own, which is every subtask
 * a single-repository team writes.
 *
 * Declared here rather than left to ride the payload, for the reason this file's
 * `egressHosts` comment gives and this repository has now paid for five times: a Zod schema
 * **strips what it does not name**. A subtask's repository dropped at the frame is a plan
 * that silently lands every branch in the planner's own repository, with nothing anywhere
 * saying so.
 */
 repository: z.string.max(200).nullish,
})

/**
 * One note a run wrote to the shared ledger.
 *
 * The `kind` is validated again in the domain rather than constrained to an enum
 * here, for the same reason `plan_submitted` is re-validated: the Runner relays, it
 * does not decide. What arrives here is a model's output.
 */
export const WorkerNoteInputSchema = z.object({
 kind: z.string,
 title: z.string,
 body: z.string,
 paths: z.array(z.string).optional,
})

export const AgentEventSchema = z.discriminatedUnion('kind', [
 z.object({ kind: z.literal('assistant_text'), text: z.string }),
 z.object({
 kind: z.literal('tool_call'),
 toolUseId: z.string,
 toolName: z.string,
 input: z.record(z.string, z.unknown),
 }),
 z.object({
 kind: z.literal('tool_result'),
 toolUseId: z.string,
 isError: z.boolean,
 summary: z.string,
 }),
 z.object({ kind: z.literal('run_completed'), totalCostUsd: z.number, result: z.string }),
 z.object({ kind: z.literal('run_failed'), message: z.string }),
])

// Runner -> Server
export const RunnerFrameSchema = z.discriminatedUnion('type', [
 /**
 * `resumableRunIds` are runs this Runner still holds on-disk state for. Sent on every connect, including the first, where it is empty.
 *
 * The server needs it to tell two cases apart that look identical from its side: a
 * run whose Runner restarted but can continue, and a run whose Runner came back with
 * nothing and can only be failed. Without it the only outcome is waiting for the
 * dead-run reaper, which is correct but discards work still sitting on disk.
 */
 z.object({
 type: z.literal('hello'),
 token: z.string,
 allowedRoots: z.array(z.string),
 resumableRunIds: z.array(z.string).optional,
 }),
 z.object({
 type: z.literal('check_path_result'),
 requestId: z.string,
 ok: z.boolean,
 // Present only when ok is true/false respectively — a plain flat shape
 // is simpler here than nesting a union inside discriminatedUnion.
 defaultBranch: z.string.optional,
 error: z.string.optional,
 }),
 /**
 * `seq` is a per-run counter the Runner assigns, and the server's idempotency
 * key: a retransmitted event
 * carries the same seq and is dropped rather than appended twice. Required,
 * not optional — an event without one cannot be deduplicated, and Runner and
 * server ship in lockstep (see this file's header).
 */
 z.object({
 type: z.literal('agent_event'),
 runId: z.string,
 seq: z.number.int.positive,
 event: AgentEventSchema,
 }),
 z.object({
 type: z.literal('permission_request'),
 runId: z.string,
 toolUseId: z.string,
 toolName: z.string,
 input: z.record(z.string, z.unknown),
 }),
 /**
 * An agent asking a human a question and blocking on the answer.
 *
 * Shaped like `permission_request` because it *is* one: the "a clarifying question
 * is that same gate carrying a prompt and returning a string. Reuse it rather than
 * build a second blocking channel." `toolUseId` is the correlation id the answer
 * comes back on, exactly as for a tool gate, so the SLA, the notification and the
 * identity binding are all inherited rather than rebuilt.
 *
 * `question` is composed by a model and is therefore untrusted text.
 */
 z.object({
 type: z.literal('question_asked'),
 runId: z.string,
 toolUseId: z.string,
 question: z.string.min(1).max(2_000),
 }),
 /** Sent once the Runner finishes cloning, before the agent starts. */
 z.object({
 type: z.literal('run_workspace_ready'),
 runId: z.string,
 clonePath: z.string,
 branchName: z.string,
 /**
 * The commit the clone opened at.
 *
 * The server cannot know this: the repository lives on the Runner's machine and
 * nothing in the contract resolves a ref. So a mastery run's map is opened at
 * dispatch with its revision *pending* and given the real one here — which is also
 * the first moment it exists, since the clone is what fixes it.
 */
 headSha: z.string.optional,
 }),
 z.object({
 type: z.literal('diff_result'),
 requestId: z.string,
 ok: z.boolean,
 diff: z.string.optional,
 error: z.string.optional,
 }),
 z.object({
 type: z.literal('discard_result'),
 requestId: z.string,
 ok: z.boolean,
 error: z.string.optional,
 }),
 /** Result of a host-side push + best-effort PR/MR open. */
 z.object({
 type: z.literal('push_result'),
 requestId: z.string,
 ok: z.boolean,
 prUrl: z.string.optional,
 compareUrl: z.string.optional,
 warning: z.string.optional,
 error: z.string.optional,
 }),
 /**
 * A batch of verbatim provider-stream lines. Batched
 * rather than per-event because the raw stream is an order of magnitude chattier
 * than the structured tier, and a frame per event would spend the socket's
 * capacity on the tier nobody is watching live.
 *
 * `chunkIndex` is assigned by the Runner and is the blob's identity, so a
 * retransmitted chunk overwrites rather than duplicating — the same idempotency
 * reasoning as `agent_event.seq`, with the blob key playing the role of the
 * unique index.
 */
 /**
 * A Planner's decomposition, relayed after it submitted one. The server validates it again with the domain schema before acting: the
 * Runner is trusted to relay, not to decide what a valid plan is, and the
 * subtasks become *runs* — the most expensive thing a bad payload could cause.
 */
 z.object({
 type: z.literal('plan_submitted'),
 runId: z.string,
 subtasks: z.array(PlanSubtaskSchema),
 }),
 /**
 * A re-planning turn's delta, relayed on the
 * same terms as `plan_submitted`: once, at the end, and re-validated server-side
 * with `parsePlanDelta` before anything is cancelled or started.
 *
 * `ops` is deliberately loose here — an array of records. The wire's job is to
 * carry the shape a model produced without a second opinion about it: a delta that
 * fails the domain's validation should be reported to the model with a reason it
 * can act on, and a Zod failure at this layer is a dropped frame with no such
 * reason. `plan_submitted` gets a typed schema because its shape predates this and
 * is stable; a delta's ops are three variants that will grow.
 */
 z.object({
 type: z.literal('plan_delta_submitted'),
 runId: z.string,
 rationale: z.string,
 ops: z.array(z.record(z.string, z.unknown)),
 }),
 /**
 * One note a run wrote to its tree's ledger, sent **as it is
 * written** rather than collected for the end of the run.
 *
 * That is the requirement, not an implementation detail: "A run that is killed,
 * reaped, budget-capped or crashed never reaches a stop handler. This codebase has
 * already paid for that lesson twice." Contrast `plan_submitted`, which is
 * deliberately sent once at the end — a plan is only actionable whole, whereas a
 * note is worth exactly what it is worth the moment it exists.
 *
 * `requestId` carries the tool call, so the server's verdict (accepted, or refused
 * with a reason the model can act on) can be relayed back into the tool result.
 */
 z.object({
 type: z.literal('note_written'),
 runId: z.string,
 requestId: z.string,
 note: WorkerNoteInputSchema,
 }),
 /**
 * A run asking for its tree's ledger mid-flight.
 *
 * Needed in addition to the ledger carried in `start_run`, because siblings write
 * while this run is working — and "two workers independently deciding to touch the
 * same file" is a thing that happens *during* the runs, not before them.
 */
 z.object({
 type: z.literal('notes_requested'),
 runId: z.string,
 requestId: z.string,
 }),
 /**
 * A run asking the **atlas** what other subjects in this workspace know about a topic
 *.
 *
 * A request rather than a payload on `start_run`, and that is the design rather than an
 * implementation detail: a map is injected because it is bounded to one repository, and
 * the atlas spans every subject in the workspace — injecting it would fill a window with
 * structure about code this run cannot see. It costs one line of tool description until
 * a run actually reaches for it.
 */
 z.object({
 type: z.literal('atlas_requested'),
 runId: z.string,
 requestId: z.string,
 topic: z.string.max(500),
 }),
 /**
 * A run proposing a relation between its own subject and another's.
 *
 * Unvalidated beyond lengths on purpose, exactly as `map_written` is: the labels are
 * resolved against what the platform actually holds and the pair is checked by the
 * domain's `proposeAtlasEdge`, which is the one place that knows a concept may not be
 * related to structure and that a relation must cross a subject boundary. A second
 * validator here would be a second place for that rule to drift.
 */
 z.object({
 type: z.literal('atlas_link_proposed'),
 runId: z.string,
 requestId: z.string,
 mine: z.string.max(200),
 theirs: z.string.max(200),
 theirSubject: z.string.max(200).optional,
 relation: z.string.max(40),
 rationale: z.string.max(600),
 }),
 /**
 * A run rewriting the prompt of the persona it is.
 *
 * **No persona id, and that absence is the security property.** The server resolves the
 * target from the run's own snapshot, so a run can only ever edit the persona it *is* —
 * The delta tool takes the same shape for the same reason, since an id in a tool call
 * is model output and there is no meaningful way to attenuate "edit somebody else".
 *
 * The body is length-bounded here as a transport sanity check only; the rule that
 * decides whether this edit may happen at all — the envelope, the round trip, the
 * per-run cap — is `revisePromptBody`, server-side, where the stored markdown is.
 */
 z.object({
 type: z.literal('persona_prompt_revised'),
 runId: z.string,
 requestId: z.string,
 body: z.string.max(40_000),
 rationale: z.string.max(600),
 }),
 /**
 * One fragment of a map a mastery run wrote, sent **as it is written**.
 *
 * Same requirement and same reasoning as `note_written`, and it bites harder here: a
 * mastery run is the longest-lived run in the system and therefore the likeliest to be
 * killed, reaped or capped before any stop handler could fire. Writing incrementally is
 * also what makes the partial map readable *during* the run, which is what makes
 * stopping it early a real option rather than a loss.
 *
 * `fragment` is unvalidated here on purpose — the domain's `parseMapFragment` is the
 * one validator, and it is the only place that knows a model may not claim `extracted`
 * provenance. A second schema on the wire would be a second answer to that question.
 */
 z.object({
 type: z.literal('map_written'),
 runId: z.string,
 requestId: z.string,
 fragment: z.record(z.string, z.unknown),
 }),
 /**
 * A mastery run's measured progress.
 *
 * `filesRead` is a count of distinct files the Runner observed the agent open, not a
 * figure the agent reported: an agent's own estimate of its progress is model output
 * and may be a remark, never the number.
 */
 z.object({
 type: z.literal('mastery_progress'),
 runId: z.string,
 filesRead: z.number.int.nonnegative,
 filesInScope: z.number.int.nonnegative,
 }),
 /**
 * A run handing its work to a successor.
 *
 * `brief` is unvalidated here on purpose, exactly like `map_written`'s fragment: the
 * domain's `parseBrief` is the one validator, and it is the only place that knows a
 * brief without a next step is a summary. A second schema on the wire would be a second
 * answer to that question.
 */
 z.object({
 type: z.literal('handoff_requested'),
 runId: z.string,
 requestId: z.string,
 brief: z.record(z.string, z.unknown),
 }),
 z.object({
 type: z.literal('raw_transcript_chunk'),
 runId: z.string,
 chunkIndex: z.number.int.nonnegative,
 lines: z.array(z.string),
 }),
 /**
 * Scoped directory listing, backing the web picker and the TUI equivalent alike
 *. `parent` is null when stepping up would leave the Runner's
 * allowed roots, so a client cannot render a door out of the boundary.
 */
 z.object({
 type: z.literal('list_directory_result'),
 requestId: z.string,
 ok: z.boolean,
 path: z.string.optional,
 parent: z.string.nullable.optional,
 entries: z
.array(
 z.object({
 name: z.string,
 path: z.string,
 isDirectory: z.boolean,
 isRepository: z.boolean,
 }),
)
.optional,
 truncated: z.boolean.optional,
 error: z.string.optional,
 }),
 z.object({
 type: z.literal('init_repository_result'),
 requestId: z.string,
 ok: z.boolean,
 path: z.string.optional,
 defaultBranch: z.string.optional,
 error: z.string.optional,
 }),
 /**
 * Result of one serialized merge-queue entry: rebase, run
 * tests, fast-forward the repository's default branch.
 *
 * `reason` is the closed set from the domain's `MergeFailureReason` rather than a
 * free-text error, because what a human should do next differs per reason — a
 * conflict is the run's to fix, a dirty target is theirs. `verified` reports
 * whether tests actually ran and passed, not whether any were configured.
 */
 z.object({
 type: z.literal('merge_result'),
 requestId: z.string,
 ok: z.boolean,
 commitSha: z.string.optional,
 verified: z.boolean.optional,
 /**
 * What the merge actually changed, from `git diff --name-only`.
 */
 changedPaths: z.array(z.string).optional,
 /** Why verification did not run, when it did not. */
 note: z.string.optional,
 reason: z
.enum([
 'conflict',
 'verification_failed',
 'verification_refused',
 'dirty_target',
 'stale_target',
 'runner_error',
 ])
.optional,
 detail: z.string.optional,
 }),
 /**
 * The outcome of a reconciler run's paused rebase.
 *
 * Separate from `run_completed`, because the run completing and the conflict being
 * resolved are genuinely different facts: a reconciler that reads the conflict, judges
 * it a real disagreement and declines is a *successful* run that resolved nothing.
 * Collapsing the two would make refusal — which the persona is explicitly told is a
 * correct outcome — indistinguishable from a crash.
 *
 * Unsolicited rather than a reply to a request, unlike `merge_result`: the server
 * started the run and then let go, so there is no in-flight call to answer.
 */
 z.object({
 type: z.literal('warm_cache_result'),
 requestId: z.string,
 ok: z.boolean,
 /** Tail of the install output — the useful part when it failed. */
 detail: z.string.optional,
 }),
 z.object({
 type: z.literal('reconcile_result'),
 runId: z.string,
 /** The run whose branch was being reconciled. */
 parentRunId: z.string,
 ok: z.boolean,
 commitSha: z.string.optional,
 /** Why it was not resolved — including the legitimate case of a refusal. */
 reason: z.string.optional,
 }),
 /**
 * Periodic liveness signal while a run is in flight — deliberately a sibling of `agent_event`, not folded into
 * `AgentEventSchema`: it must never become a chat message, only bump
 * `agent_run.last_heartbeat_at`.
 */
 z.object({
 type: z.literal('heartbeat'),
 runId: z.string,
 /**
 * How full the run's context window is.
 *
 * Read from the SDK's `getContextUsage`, which is a **platform fact**: it counts
 * the system prompt, tools, MCP surface and messages against the model's real
 * window. The event-tiering design models no token usage on `AgentEvent` and says token deltas are
 * stream-only, so this is the only honest source — and it is better than a sum of
 * deltas anyway, because compaction resets occupancy while a running total only
 * ever climbs.
 *
 * Carried on the heartbeat rather than as its own frame: the heartbeat already
 * fires on an interval for exactly as long as a run is live, so this adds no frame
 * type and no second timer. Optional, because a Runner that has not yet sampled —
 * or one built before this existed — must still produce a valid heartbeat, and
 * because the answer is unavailable before the first turn.
 */
 contextTokens: z.number.int.nonnegative.optional,
 contextMaxTokens: z.number.int.positive.optional,
 }),
 /**
 * Authoritative spend, metered at the egress proxy and relayed by the Runner
 *. Deliberately not derived from the SDK's self-reported
 * `total_cost_usd`: the credential broker's point is that the number a run reports about itself is
 * not the number to bill or to enforce a cap against.
 *
 * Relayed over this socket rather than posted by the proxy directly, so metered
 * cost reaches the database through a path that is already authenticated and
 * already trusted with run state.
 */
 z.object({
 type: z.literal('cost_report'),
 runId: z.string,
 spentUsd: z.number.nonnegative,
 capUsd: z.number.nonnegative.nullable,
 exhausted: z.boolean,
 }),
])

// Server -> Runner
export const ServerFrameSchema = z.discriminatedUnion('type', [
 z.object({ type: z.literal('hello_ack'), runnerId: z.string }),
 z.object({ type: z.literal('error'), message: z.string }),
 z.object({ type: z.literal('check_path'), requestId: z.string, path: z.string }),
 z.object({
 type: z.literal('start_run'),
 runId: z.string,
 persona: PersonaSpecSchema,
 // Source repo path to clone from, not the run's own cwd — the Runner
 // clones this into a scratch workspace per run.
 cwd: z.string,
 defaultBranch: z.string,
 /**
 * Which repository this run is against, so the Runner can hand it that
 * repository's prepared dependency tree.
 * Optional because a Runner that predates the field still starts runs; it simply
 * installs for itself, which is what every run did before.
 */
 repositoryId: z.string.optional,
 /** What a human asked for via `@mention`; absent for the sidebar picker. */
 task: z.string.optional,
 /**
 * The tree's worker-notes ledger, already rendered and
 * already fenced by the server. Absent for the first run in a tree.
 *
 * Pre-rendered rather than structured: the untrusted-block framing in
 * `renderNotesForPrompt` is the mitigation for notes being a persistence layer
 * for prompt injection, and a second formatter on the Runner would be a second
 * place to get it wrong.
 */
 contextLedger: z.string.optional,
 /**
 * What this persona already knows about the subject it is working on, already selected, rendered and fenced by the server.
 *
 * Pre-rendered for exactly the reason `contextLedger` is: the trusted/untrusted
 * split in `renderMapForPrompt` is the mitigation, and a second formatter on the
 * Runner would be a second place to get it wrong.
 */
 mapContext: z.string.optional,
 /**
 * Start this run as a **mastery run**: its deliverable is a map, not a diff.
 *
 * Carries the subject so the Runner can frame the task, and `filesInScope` so the
 * platform's coverage denominator is fixed at dispatch rather than recomputed per
 * checkpoint against a tree the run may itself have changed.
 */
 mastery: z
.object({
 subjectKind: z.enum(['repository', 'author', 'corpus']),
 subjectRef: z.string,
 /**
 * What the run was asked to look for, already rendered by the server.
 *
 * Pre-rendered for the same reason `mapContext` is: the wording is what makes a
 * focus produce a concept instead of a directory listing, and a second formatter
 * on the Runner would be a second place for it to drift. The Runner's job is to
 * put it in the opening, not to decide what it says.
 */
 directive: z.string.optional,
 })
.optional,
 /**
 * Start this run as a **reconciler** over another run's conflicted branch
 *.
 *
 * Present, the Runner prepares the workspace differently: it clones the named
 * run's clone, checks out its branch, and rebases onto the merge target *without
 * aborting* — so the agent opens onto real conflict markers. On termination the
 * paused rebase is completed rather than a plain commit taken.
 *
 * `parentRunId` rather than a path: the branch lives only in that run's clone
 * until it merges, and the Runner is the only thing that knows where that is.
 * A Runner that no longer holds it fails the reconcile with a clear reason, the
 * same limitation `getDiff`, `push` and the merge itself already carry.
 */
 reconcile: z
.object({ parentRunId: z.string, branchName: z.string })
.optional,
 /**
 * Start this run as a **reviewer** of another run's branch.
 *
 * Present, the Runner clones the reviewed run's clone and checks that branch out
 * before cutting this run's own branch from it — so the reviewer opens on the real
 * tree it is reviewing and can grep it, read it and run it, rather than being
 * handed a diff in its prompt. The words are "read access to the reviewed
 * branch"; a diff in a prompt is not read access, it is a quotation.
 *
 * `targetRunId` rather than `parentRunId`, and that difference is the point: a
 * reconciler's parent *is* the run whose branch it fixes, while a reviewer's parent
 * is the planner and the branch belongs to a **sibling**. Reusing `reconcile`'s
 * field would have made the reviewed run the reviewer's parent, which would put a
 * worker in the delegation chain above another worker and measure the attenuation
 * against the wrong run.
 *
 * The same Runner-holds-the-clone limitation as `reconcile`, `getDiff`, `push` and
 * the merge itself: the branch exists only in that run's clone until it merges.
 */
 review: z.object({ targetRunId: z.string, branchName: z.string }).optional,
 /**
 * Start this run as a **re-planning turn**.
 *
 * The Runner's only decision from this flag is which channel to give a Planner:
 * `submit_plan_delta` instead of `submit_plan`. Instead, not as well — a run that
 * could still submit a whole decomposition could answer a steering message by
 * starting a second fan-out beside the one already running, which is the failure
 * The whole "a delta, emphatically" is written to prevent.
 *
 * The target it is steering is not sent, because the Runner has no use for it: the
 * server resolves it from the run's own parent, so a delta cannot name a tree it
 * was not started against.
 */
 steering: z.boolean.optional,
 }),
 /**
 * Warm this repository's dependency cache. Operator-triggered, and
 * the command is the operator's — no agent is involved, which is the whole reason
 * the resulting cache can be handed to runs.
 */
 z.object({
 type: z.literal('warm_cache'),
 requestId: z.string,
 /**
 * Which repository this warms, so the prepared tree it captures can be handed to
 * that repository's runs. Keyed by id rather
 * than by path: two `repository` rows can legitimately point at one directory on
 * different Runners, and a path is not a stable name for a cache entry.
 */
 repositoryId: z.string,
 repositoryPath: z.string,
 defaultBranch: z.string,
 installCommand: z.string,
 }),
 z.object({
 type: z.literal('permission_response'),
 toolUseId: z.string,
 decision: z.enum(['allow', 'deny']),
 }),
 /**
 * The human's reply to a `question_asked`. `answer` is null when the
 * gate was denied or auto-denied by the SLA — a run blocked forever on a question
 * nobody saw is worse than a run that guessed and said so, so the tool returns and
 * tells the model it got no answer.
 */
 z.object({
 type: z.literal('question_answered'),
 toolUseId: z.string,
 answer: z.string.nullable,
 }),
 /**
 * Context delivered to a run that is **already working**.
 *
 * Pre-rendered and pre-fenced by the server, exactly like `start_run`'s
 * `contextLedger` and for the same reason: the untrusted-block framing in
 * `renderNotesForPrompt` is the mitigation, and a second formatter on the Runner
 * would be a second place to get it wrong.
 *
 * Fire-and-forget. A run that has finished between the decision to deliver and the
 * frame arriving has nothing to receive it, and that is not a failure — the note is
 * on the ledger either way, which is where a later run reads it.
 */
 z.object({ type: z.literal('deliver_context'), runId: z.string, text: z.string }),
 /**
 * Kill switch. Fire-and-forget with no result frame on purpose:
 * the server has already marked the run `cancelled` by the time this is sent,
 * so there is no decision left for the Runner's answer to influence.
 */
 z.object({ type: z.literal('cancel_run'), runId: z.string }),
 /**
 * Continue a run the Runner already holds state for. Carries no
 * persona or task: the Runner's own state file has them, and re-sending them from the
 * server would let a persona edited mid-run change what a resumed run is doing.
 *
 * `fromEventSeq` is the server's highest ingested `seq`, so the Runner continues the
 * sequence instead of restarting it at 1 and having every new event dropped as a
 * duplicate.
 */
 z.object({
 type: z.literal('resume_run'),
 runId: z.string,
 fromEventSeq: z.number.int.nonnegative,
 }),
 z.object({ type: z.literal('get_diff'), requestId: z.string, runId: z.string }),
 z.object({ type: z.literal('discard_run'), requestId: z.string, runId: z.string }),
 z.object({
 type: z.literal('push_run'),
 requestId: z.string,
 runId: z.string,
 acknowledgeCiChange: z.boolean,
 }),
 /**
 * Merge one queued branch into its repository's default branch. Sent by the server's queue sweep, one at a time per repository — the
 * serialization is the server's, so the Runner does exactly what it is told and
 * holds no queue of its own.
 *
 * `verifyCommand` travels with the request rather than being read from the
 * Runner's environment: it is repository configuration, and the server is where
 * repository configuration lives. Whether it may *run* is still the Runner's
 * decision, since only the Runner knows if it has a sandbox.
 */
 /** An empty `path` lists the allowed roots themselves, so a client never has to guess one. */
 z.object({ type: z.literal('list_directory'), requestId: z.string, path: z.string }),
 z.object({
 type: z.literal('init_repository'),
 requestId: z.string,
 parentPath: z.string,
 name: z.string,
 }),
 z.object({
 type: z.literal('merge_run'),
 requestId: z.string,
 runId: z.string,
 verifyCommand: z.string.nullable,
 }),
 /**
 * The server's verdict on a note a run wrote. `ok: false`
 * carries a reason written *for the model* — a malformed or over-cap note becomes a
 * tool result it can act on, rather than a silent drop it will repeat.
 */
 z.object({
 type: z.literal('note_result'),
 requestId: z.string,
 ok: z.boolean,
 reason: z.string.optional,
 }),
 /**
 * The server's verdict on a handover. Same shape and same reason as
 * `note_result` — and it matters more here, because the refusals are things the model
 * can fix: a brief with no next step, or a tree that has already handed off twice.
 */
 z.object({
 type: z.literal('handoff_result'),
 requestId: z.string,
 ok: z.boolean,
 reason: z.string.optional,
 }),
 /**
 * The server's verdict on a map fragment. Same shape and same reason as
 * `note_result`: a refusal a model cannot see is a refusal it earns again next call.
 *
 * `written` and `superseded` come back because they are the only honest feedback a
 * mapping agent gets — "3 nodes recorded, 1 replaced what you said earlier" tells it
 * whether it is adding to the map or arguing with itself.
 */
 z.object({
 type: z.literal('map_result'),
 requestId: z.string,
 ok: z.boolean,
 reason: z.string.optional,
 nodesWritten: z.number.int.nonnegative.optional,
 edgesWritten: z.number.int.nonnegative.optional,
 superseded: z.number.int.nonnegative.optional,
 }),
 /**
 * A tree's ledger, rendered, in answer to `notes_requested`. `ledger` is empty when
 * the tree has nothing in it — the Runner then tells the model so explicitly, since
 * an empty tool result reads as a failure.
 */
 z.object({
 type: z.literal('notes_result'),
 requestId: z.string,
 ok: z.boolean,
 ledger: z.string.optional,
 error: z.string.optional,
 }),
 /**
 * The atlas's answer — leads, already ranked, capped and fenced by the server.
 *
 * Rendered server-side for the same reason the ledger is: the fence, the cap and the
 * "these are leads, not facts" framing are security properties, and a Runner that
 * assembled its own would be a second place they could drift.
 */
 z.object({
 type: z.literal('atlas_result'),
 requestId: z.string,
 ok: z.boolean,
 leads: z.string.optional,
 error: z.string.optional,
 }),
 /**
 * What became of a proposal — the sentence the agent is shown, assembled server-side.
 *
 * `outcome` carries a refusal as readily as an acceptance, because "that is not a
 * concept" is an answer the model can act on rather than a fault in the channel. `error`
 * is kept for the case where the platform could not decide at all.
 */
 z.object({
 type: z.literal('atlas_link_result'),
 requestId: z.string,
 ok: z.boolean,
 outcome: z.string.optional,
 error: z.string.optional,
 }),
 /**
 * What became of a self-edit, assembled server-side.
 *
 * `outcome` carries the refusal as well as the acceptance, for the reason
 * `atlas_link_result` does and one more that is specific to this tier: continuity mode requires a
 * refused self-modification to reach the agent as a request a human could grant, so the
 * wording *is* the feature and a Runner writing its own would be a second place for it
 * to drift. `error` stays for the case where the platform could not decide at all.
 */
 z.object({
 type: z.literal('persona_prompt_result'),
 requestId: z.string,
 ok: z.boolean,
 outcome: z.string.optional,
 error: z.string.optional,
 }),
])

export type RunnerFrame = z.infer<typeof RunnerFrameSchema>
export type ServerFrame = z.infer<typeof ServerFrameSchema>
export type WireAgentEvent = z.infer<typeof AgentEventSchema>
export type WirePersonaSpec = z.infer<typeof PersonaSpecSchema>
export type WireCapabilitySpec = z.infer<typeof CapabilitySpecSchema>
export type WirePlanSubtask = z.infer<typeof PlanSubtaskSchema>
export type WireWorkerNoteInput = z.infer<typeof WorkerNoteInputSchema>
