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
 * The SDK's session id, emitted as soon as it is known. The Runner persists it
 * so a run can be resumed rather than restarted after a Runner crash.
 */
 z.object({ t: z.literal('session'), sessionId: z.string }),
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
