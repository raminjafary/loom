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
 budgetCapUsd: z.number.nullable,
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
 * Periodic liveness signal while a run is in flight — deliberately a sibling of `agent_event`, not folded into
 * `AgentEventSchema`: it must never become a chat message, only bump
 * `agent_run.last_heartbeat_at`.
 */
 z.object({ type: z.literal('heartbeat'), runId: z.string }),
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
])

export type RunnerFrame = z.infer<typeof RunnerFrameSchema>
export type ServerFrame = z.infer<typeof ServerFrameSchema>
export type WireAgentEvent = z.infer<typeof AgentEventSchema>
export type WirePersonaSpec = z.infer<typeof PersonaSpecSchema>
