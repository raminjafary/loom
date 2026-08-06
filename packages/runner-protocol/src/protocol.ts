import { z } from 'zod'

/**
 * Wire protocol for /ws/runner — shared between
 * apps/server and apps/runner so there is exactly one source of truth for the
 * frame shapes, the same reasoning as packages/api-contract for the browser
 * boundary. Both directions are versioned together for now since Runner and
 * server ship in lockstep; a real versioning story is a Phase 3+ concern.
 */

export const PersonaSpecSchema = z.object({
 name: z.string,
 systemPrompt: z.string,
 model: z.string,
 tools: z.array(z.string),
 autoApprove: z.boolean,
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
 z.object({ type: z.literal('hello'), token: z.string, allowedRoots: z.array(z.string) }),
 z.object({
 type: z.literal('check_path_result'),
 requestId: z.string,
 ok: z.boolean,
 // Present only when ok is true/false respectively — a plain flat shape
 // is simpler here than nesting a union inside discriminatedUnion.
 defaultBranch: z.string.optional,
 error: z.string.optional,
 }),
 z.object({ type: z.literal('agent_event'), runId: z.string, event: AgentEventSchema }),
 z.object({
 type: z.literal('permission_request'),
 runId: z.string,
 toolUseId: z.string,
 toolName: z.string,
 input: z.record(z.string, z.unknown),
 }),
 /** Sent once the Runner finishes cloning, before the agent starts. */
 z.object({
 type: z.literal('run_workspace_ready'),
 runId: z.string,
 clonePath: z.string,
 branchName: z.string,
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
 * Periodic liveness signal while a run is in flight — deliberately a sibling of `agent_event`, not folded into
 * `AgentEventSchema`: it must never become a chat message, only bump
 * `agent_run.last_heartbeat_at`.
 */
 z.object({ type: z.literal('heartbeat'), runId: z.string }),
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
 /** What a human asked for via `@mention`; absent for the sidebar picker. */
 task: z.string.optional,
 }),
 z.object({
 type: z.literal('permission_response'),
 toolUseId: z.string,
 decision: z.enum(['allow', 'deny']),
 }),
 /**
 * Kill switch. Fire-and-forget with no result frame on purpose:
 * the server has already marked the run `cancelled` by the time this is sent,
 * so there is no decision left for the Runner's answer to influence.
 */
 z.object({ type: z.literal('cancel_run'), runId: z.string }),
 z.object({ type: z.literal('get_diff'), requestId: z.string, runId: z.string }),
 z.object({ type: z.literal('discard_run'), requestId: z.string, runId: z.string }),
 z.object({
 type: z.literal('push_run'),
 requestId: z.string,
 runId: z.string,
 acknowledgeCiChange: z.boolean,
 }),
])

export type RunnerFrame = z.infer<typeof RunnerFrameSchema>
export type ServerFrame = z.infer<typeof ServerFrameSchema>
export type WireAgentEvent = z.infer<typeof AgentEventSchema>
export type WirePersonaSpec = z.infer<typeof PersonaSpecSchema>
