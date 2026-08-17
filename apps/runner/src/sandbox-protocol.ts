import { AgentEventSchema, PersonaSpecSchema } from '@loom/runner-protocol'
import { z } from 'zod'

/**
 * The stdio protocol between the Runner (host, trusted) and the agent host
 * running inside a sandbox container (untrusted). Distinct from
 * `@loom/runner-protocol`, which is server↔Runner: this crosses the sandbox
 * boundary, and the two must not be conflated even though the payloads overlap.
 *
 * Why a protocol at all: the approval gate is an in-process
 * callback the SDK invokes, so moving the SDK into a container means the
 * callback has to round-trip out to the Runner and back. Losing that would mean
 * losing the gate, which is the single most load-bearing thing Phase 1 built.
 *
 * Every frame is one line of JSON prefixed with SANDBOX_FRAME_PREFIX. The prefix
 * exists because stdout is shared: the SDK, npm, or anything the agent runs may
 * print. Un-prefixed lines are logs, not frames — without that distinction one
 * stray console.log inside the container would desynchronize the stream.
 */

export const SANDBOX_FRAME_PREFIX = 'loom'

/** Host → container. */
export const SandboxCommandSchema = z.discriminatedUnion('t', [
 z.object({
 t: z.literal('start'),
 persona: PersonaSpecSchema,
 task: z.string.optional,
 /**
 * What this persona already knows about the subject,
 * selected, rendered and fenced host-side for the same reason `contextLedger` is.
 */
 mapContext: z.string.optional,
 /**
 * Present when this run's deliverable is a map rather than a diff.
 * Its presence is what gives the agent `record_map` at all — see agent-host.ts.
 */
 mastery: z
.object({
 subjectKind: z.enum(['repository', 'author', 'corpus']),
 subjectRef: z.string,
 revision: z.string,
 /**
 * What this run was asked to look for, rendered server-side.
 *
 * Declared here as well as on the wire and the port because the sandbox boundary
 * is the third place a field of this shape has been dropped: a schema that does
 * not name it strips it, and the container runs a mastery run that was never told
 * what it was for — with no error at either end.
 */
 directive: z.string.optional,
 })
.optional,
 /** The tree's ledger, rendered and fenced server-side. */
 contextLedger: z.string.optional,
 /** Where the run's clone is mounted inside the container, not the host path. */
 cwd: z.string,
 /** Resume an SDK session after a Runner restart. */
 resumeSessionId: z.string.optional,
 /**
 * This run is a re-planning turn, so a
 * Planner's one channel is `submit_plan_delta` rather than `submit_plan`. The
 * same substitution the `start_run` frame carries, for the sandboxed path.
 */
 steering: z.boolean.optional,
 }),
 z.object({
 t: z.literal('permission'),
 toolUseId: z.string,
 decision: z.enum(['allow', 'deny']),
 }),
 /** Context delivered to a run already working, pre-fenced server-side. */
 z.object({ t: z.literal('deliver'), text: z.string }),
 /** The server's verdict on a note the agent wrote. */
 z.object({
 t: z.literal('note_result'),
 requestId: z.string,
 ok: z.boolean,
 reason: z.string.optional,
 }),
 /** The host's verdict on a map fragment. */
 z.object({
 t: z.literal('map_result'),
 requestId: z.string,
 ok: z.boolean,
 reason: z.string.optional,
 nodesWritten: z.number.int.nonnegative.optional,
 edgesWritten: z.number.int.nonnegative.optional,
 superseded: z.number.int.nonnegative.optional,
 }),
 /** The host's verdict on a handover. */
 z.object({
 t: z.literal('handoff_result'),
 requestId: z.string,
 ok: z.boolean,
 reason: z.string.optional,
 }),
 /** The tree's ledger, in answer to the agent's `notes_request`. */
 z.object({
 t: z.literal('notes_result'),
 requestId: z.string,
 ok: z.boolean,
 ledger: z.string.optional,
 error: z.string.optional,
 }),
 /** The atlas's leads, in answer to the agent's `atlas_request`. */
 z.object({
 t: z.literal('atlas_result'),
 requestId: z.string,
 ok: z.boolean,
 leads: z.string.optional,
 error: z.string.optional,
 }),
 /** What became of a proposed cross-project relation. */
 z.object({
 t: z.literal('atlas_link_result'),
 requestId: z.string,
 ok: z.boolean,
 outcome: z.string.optional,
 error: z.string.optional,
 }),
 /** What became of a self-edit. */
 z.object({
 t: z.literal('self_edit_result'),
 requestId: z.string,
 ok: z.boolean,
 outcome: z.string.optional,
 error: z.string.optional,
 }),
 /**
 * A human's reply to `ask_human`. `answer` absent means nobody
 * answered — denied, or the SLA expired — and the tool must still return, or the
 * agent blocks until the reaper takes the run.
 */
 z.object({
 t: z.literal('question_result'),
 requestId: z.string,
 answer: z.string.optional,
 }),
])

/** Container → host. */
export const SandboxEventSchema = z.discriminatedUnion('t', [
 /**
 * Emitted once the agent host is listening on stdin. The host must not send
 * `start` before this: `docker run -i` drops anything written to stdin before the
 * container's process attaches, and the resulting failure is a run that simply
 * hangs until its wall clock with no error anywhere.
 */
 z.object({ t: z.literal('ready') }),
 z.object({ t: z.literal('event'), event: AgentEventSchema }),
 /**
 * One verbatim provider-stream message, as JSON text.
 * Carried as an opaque string rather than a parsed shape on purpose: the point
 * of the raw tier is that it is *not* mapped down to what this platform models,
 * so giving it a schema here would defeat it.
 */
 z.object({ t: z.literal('raw'), line: z.string }),
 /**
 * A Planner's decomposition. The delegation tool is an
 * in-process MCP server, so when the agent runs in a container the tool lives
 * there too and its result has to cross this boundary like everything else.
 */
 z.object({
 t: z.literal('plan'),
 subtasks: z.array(
 z.object({
 title: z.string,
 task: z.string,
 personaName: z.string,
 paths: z.array(z.string).optional,
 }),
),
 }),
 /**
 * A re-planning turn's delta, emitted once
 * after `runAgent` returns exactly like `plan`. The ops are carried unvalidated:
 * the server re-checks them with the domain's parser, and a shape this boundary
 * rejected would be a dropped frame with no reason the model could act on.
 */
 z.object({
 t: z.literal('plan_delta'),
 rationale: z.string,
 ops: z.array(z.record(z.string, z.unknown)),
 }),
 z.object({
 t: z.literal('permission_request'),
 toolUseId: z.string,
 toolName: z.string,
 input: z.record(z.string, z.unknown),
 }),
 /**
 * One note the agent wrote, crossing out as it is written.
 *
 * Unlike `plan`, which is emitted once after `runAgent` returns, this is emitted
 * mid-run — a note collected for the end would be lost by exactly the runs whose
 * context is most worth keeping: killed, reaped, budget-capped, crashed.
 */
 z.object({
 t: z.literal('note'),
 requestId: z.string,
 note: z.object({
 kind: z.string,
 title: z.string,
 body: z.string,
 paths: z.array(z.string).optional,
 }),
 }),
 /** The agent asking for its tree's ledger mid-run, answered by `notes_result`. */
 z.object({ t: z.literal('notes_request'), requestId: z.string }),
 /**
 * What other subjects in this workspace know about a topic.
 * A request rather than something handed over at start, because the atlas is unbounded
 * by construction and a prompt is not — see `atlas-tool.ts`.
 */
 z.object({ t: z.literal('atlas_request'), requestId: z.string, topic: z.string.max(500) }),
 /**
 * A relation the agent wants to propose. Both
 * ends are named in words rather than by id, because no surface a model sees carries
 * one; the host resolves them against what the platform actually holds.
 */
 z.object({
 t: z.literal('atlas_link_request'),
 requestId: z.string,
 mine: z.string.max(200),
 theirs: z.string.max(200),
 theirSubject: z.string.max(200).optional,
 relation: z.string.max(40),
 rationale: z.string.max(600),
 }),
 /**
 * One map fragment the agent wrote, crossing out as it is
 * written for the same reason a note does — and more so, since a mastery run is the
 * longest-lived run in the system and the likeliest to be stopped before it finishes.
 */
 z.object({
 t: z.literal('map'),
 requestId: z.string,
 fragment: z.record(z.string, z.unknown),
 }),
 /**
 * The agent handing its work to a successor.
 *
 * Off the event queue like `map` and `note`: it is not part of the transcript sequence,
 * and the agent's tool call is held open on the answer.
 */
 z.object({
 t: z.literal('handoff'),
 requestId: z.string,
 brief: z.record(z.string, z.unknown),
 }),
 /**
 * The agent rewriting its own persona prompt.
 *
 * Carries no persona id for the same reason the wire frame does not: the host resolves
 * the target from the run, so this can only ever reach the persona the run *is*.
 */
 z.object({
 t: z.literal('self_edit'),
 requestId: z.string,
 body: z.string.max(40_000),
 rationale: z.string.max(600),
 }),
 /** The agent changing its own tool list. */
 z.object({
 t: z.literal('tools_edit'),
 requestId: z.string,
 tools: z.array(z.string.max(80)).max(60),
 rationale: z.string.max(600),
 }),
 /**
 * The agent proposing candidate prompts.
 *
 * Answered on the host like every other write channel, and it has to exist in *both*
 * paths: a self-tool offered outside the container and not inside it is a feature that
 * works until an operator turns the sandbox on.
 */
 z.object({
 t: z.literal('variants_propose'),
 requestId: z.string,
 variants: z
.array(z.object({ body: z.string.max(40_000), rationale: z.string.max(600) }))
.max(8),
 }),
 /** The agent asking a human a question, answered by `question_result`. */
 z.object({ t: z.literal('question_request'), requestId: z.string, question: z.string }),
 /**
 * The SDK's session id, emitted as soon as it is known. The Runner persists it
 * so a run can be resumed rather than restarted after a Runner crash.
 */
 z.object({ t: z.literal('session'), sessionId: z.string }),
 /**
 * Context-window occupancy sampled inside the container. Its own frame
 * rather than a field on an event, for the same reason the heartbeat carries it on the
 * wire above: it is an observation about the run, never something to render in a thread.
 */
 z.object({
 t: z.literal('context_usage'),
 totalTokens: z.number.int.nonnegative,
 maxTokens: z.number.int.positive,
 }),
 z.object({ t: z.literal('done') }),
])

export type SandboxCommand = z.infer<typeof SandboxCommandSchema>
export type SandboxEvent = z.infer<typeof SandboxEventSchema>

export const encodeFrame = (frame: SandboxCommand | SandboxEvent): string =>
 `${SANDBOX_FRAME_PREFIX}${JSON.stringify(frame)}\n`

/**
 * Returns null for any line that is not a frame — ordinary output from whatever
 * the agent is running. Callers log those rather than failing on them.
 */
export const decodeFrameLine = (line: string): unknown | null => {
 if (!line.startsWith(SANDBOX_FRAME_PREFIX)) return null
 try {
 return JSON.parse(line.slice(SANDBOX_FRAME_PREFIX.length))
 } catch {
 return null
 }
}
