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
 /** The tree's ledger, rendered and fenced server-side. */
 contextLedger: z.string.optional,
 /** Where the run's clone is mounted inside the container, not the host path. */
 cwd: z.string,
 /** Resume an SDK session after a Runner restart. */
 resumeSessionId: z.string.optional,
 }),
 z.object({
 t: z.literal('permission'),
 toolUseId: z.string,
 decision: z.enum(['allow', 'deny']),
 }),
 /** The server's verdict on a note the agent wrote. */
 z.object({
 t: z.literal('note_result'),
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
 z.object({ title: z.string, task: z.string, personaName: z.string }),
),
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
