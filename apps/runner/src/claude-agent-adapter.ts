import {
 query,
 type CanUseTool,
 type McpSdkServerConfigWithInstance,
 type McpServerConfig,
 type PermissionResult,
 type SDKMessage,
 type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { WireAgentEvent, WirePersonaSpec } from '@loom/runner-protocol'
import { allowedMcpToolNames, toMcpServers } from './capabilities.js'
import { NOTES_SERVER_NAME, NOTES_TOOL_NAMES } from './notes-tool.js'
import { ASK_HUMAN_TOOL_NAME, QUESTION_SERVER_NAME } from './question-tool.js'
import { PLANNER_SERVER_NAME } from './planner-tool.js'

/**
 * `AgentExecutionPort` implementation for the Claude Agent SDK —
 * imported as a library, not shelled out to as a subprocess, per the
 * corrected design in the architecture/the driven side — driven side.
 *
 * Branding note: must be called "Claude Agent" in any user-facing text,
 * never "Claude Code" — a license condition of the SDK, not a style choice.
 */

interface ContentBlockLike {
 readonly type?: string
 readonly text?: string
 readonly id?: string
 readonly name?: string
 readonly input?: Record<string, unknown>
 readonly tool_use_id?: string
 readonly is_error?: boolean
 readonly content?: unknown
}

const asBlocks = (content: unknown): ContentBlockLike[] =>
 Array.isArray(content) ? (content as ContentBlockLike[]): []

const summarizeToolResultContent = (content: unknown): string => {
 if (typeof content === 'string') return content.slice(0, 2000)
 if (Array.isArray(content)) {
 return content
.map((block: unknown) => {
 const b = block as ContentBlockLike
 return typeof b.text === 'string' ? b.text: JSON.stringify(b)
 })
.join('\n')
.slice(0, 2000)
 }
 return JSON.stringify(content).slice(0, 2000)
}

/**
 * Maps the SDK's ~40-variant message union down to the structured tier this
 * platform actually renders — everything else (thinking
 * tokens, hook lifecycle, session-state changes,...) is deliberately not
 * modeled here; it's not part of Phase 1's condensed rendering.
 */
export const toWireEvents = (message: SDKMessage): WireAgentEvent[] => {
 switch (message.type) {
 case 'assistant': {
 const blocks = asBlocks((message.message as { content?: unknown }).content)
 const events: WireAgentEvent[] = []
 for (const block of blocks) {
 if (block.type === 'text' && typeof block.text === 'string') {
 events.push({ kind: 'assistant_text', text: block.text })
 } else if (block.type === 'tool_use' && block.id && block.name) {
 events.push({
 kind: 'tool_call',
 toolUseId: block.id,
 toolName: block.name,
 input: block.input ?? {},
 })
 }
 }
 return events
 }

 case 'user': {
 const blocks = asBlocks((message.message as { content?: unknown }).content)
 const events: WireAgentEvent[] = []
 for (const block of blocks) {
 if (block.type === 'tool_result' && block.tool_use_id) {
 events.push({
 kind: 'tool_result',
 toolUseId: block.tool_use_id,
 isError: block.is_error ?? false,
 summary: summarizeToolResultContent(block.content),
 })
 }
 }
 return events
 }

 case 'result':
 if (message.subtype === 'success') {
 return [
 {
 kind: 'run_completed',
 totalCostUsd: message.total_cost_usd,
 result: message.result,
 },
 ]
 }
 return [
 {
 kind: 'run_failed',
 message: `Run ended without success (${message.subtype}, stop_reason: ${message.stop_reason ?? 'unknown'})`,
 },
 ]

 default:
 return []
 }
}

/**
 * How often the context window is sampled. Long enough that a fast burst of messages
 * costs one control request rather than dozens; short enough that a human watching the
 * board sees pressure build within a turn or two.
 */
const CONTEXT_SAMPLE_INTERVAL_MS = 5_000

export interface RunAgentOptions {
 readonly persona: WirePersonaSpec
 readonly cwd: string
 /** What a human asked for via `@mention`; absent for the sidebar-picker path. */
 readonly task?: string
 /**
 * Reports how full the model's context window is, sampled from the SDK.
 * Absent for callers that do not care; the sampling is skipped entirely then.
 */
 readonly onContextUsage?: (usage: { totalTokens: number; maxTokens: number }) => void
 /**
 * May return a promise, and the stream loop awaits it — that await is how the
 * Runner applies backpressure: while it is unresolved the
 * SDK's iterator is not pulled, so the agent loop itself slows rather than the
 * Runner buffering without limit.
 */
 readonly onEvent: (event: WireAgentEvent) => void | Promise<void>
 /**
 * The verbatim SDK message, before `toWireEvents` maps it down. Optional: an unsandboxed debugging run has no reason to persist one,
 * and a caller that does not want the tier should not pay to serialize it.
 */
 readonly onRawMessage?: (line: string) => void | Promise<void>
 /**
 * The Planner's in-process delegation server. Absent for
 * every ordinary run — a worker has no business submitting plans.
 *
 * The tool's *name* travels with the server rather than being derived here,
 * because there are now two of them: an ordinary Planner gets `submit_plan`, and a
 * re-planning turn gets `submit_plan_delta` instead. Deriving it would leave a second place that has to agree about which
 * one is mounted, and a disagreement there is the silent failure this codebase has
 * already shipped twice — a tool the model is never offered, with nothing to notice
 * it but a live run.
 */
 readonly plannerTool?: { server: McpSdkServerConfigWithInstance; toolName: string }
 /**
 * The worker-notes server — `write_note` and `read_notes`.
 * Present for every run that has a ledger to share, which is every run the
 * platform starts; absent only where no note channel exists (a bare adapter test).
 */
 readonly notesTool?: McpSdkServerConfigWithInstance
 /**
 * `ask_human`. Present for every run the
 * platform starts, including a Planner: asking is not a capability, and a
 * `tools: []` Planner still holds no filesystem and no shell.
 */
 readonly questionTool?: McpSdkServerConfigWithInstance
 /**
 * The tree's ledger, rendered and fenced by the *server*.
 *
 * Appended to the prompt rather than to the persona's system prompt: the persona is
 * the operator's instruction source and must stay authoritative, and mixing
 * agent-authored text into it would make one compromised worker's note read as
 * part of every later worker's own instructions.
 */
 readonly contextLedger?: string
 /**
 * Hands the caller the run's delivery channel.
 *
 * Called once, synchronously, before the agent loop starts. What comes through it
 * is text the *server* has already rendered and fenced — the Runner never composes
 * what a model reads, for the same reason `contextLedger` arrives pre-rendered.
 */
 readonly onInputChannel?: (channel: { deliver: (text: string) => void }) => void
 /**
 * Aborts the SDK's agent loop mid-flight. Owned by
 * the caller so a `cancel_run` frame arriving on the socket can reach a run
 * that is already streaming.
 */
 readonly abortController?: AbortController
 /**
 * The SDK's session id, reported as soon as the session announces itself.
 * Persisting it is what makes a run resumable rather than restartable after a
 * Runner crash.
 */
 readonly onSessionId?: (sessionId: string) => void
 /** An SDK session id to continue instead of starting fresh. */
 readonly resumeSessionId?: string
 /** Resolves once a human (relayed via the server) has decided. */
 readonly onPermissionRequest: (
 toolUseId: string,
 toolName: string,
 input: Record<string, unknown>,
) => Promise<'allow' | 'deny'>
 readonly isRiskyTool: (toolName: string) => boolean
 /** Path-scoped write check — see packages/domain/src/risky-tools.ts. */
 readonly classifyEffect: (
 toolName: string,
 input: Record<string, unknown>,
) => Promise<
 | { readonly ok: true; readonly requiresApproval: boolean; readonly effects?: string }
 | { readonly ok: false; readonly reason: string }
 >
}

/**
 * Which filesystem settings the SDK may load (`~/.claude/settings.json`,
 * `<cwd>/.claude/settings.json`, `.claude/settings.local.json`).
 *
 * **`[]` — none — is the default, deliberately.** `cwd` is the run's clone of a
 * repository: content the agent can write to and, in the general case, content
 * nobody on this workspace authored. Loading settings from there would let the
 * material under review influence how the run is permitted to behave — and
 * Claude Code's own precedence puts `permissions.allow` rules ahead of a prompt,
 * so an allow-rule shipped in a repo is at minimum a plausible way to skip the
 * `canUseTool` gate that identity-bound approval make the whole point. Loom does not
 * need those files: the persona is the instruction source and the approval gate
 * is the permission source.
 *
 * `LOOM_SDK_SETTING_SOURCES` re-enables them for an operator who wants
 * repo-provided settings and accepts what that means — comma-separated, e.g.
 * `project` or `user,project`. Anything unrecognized is ignored rather than
 * guessed at.
 */
const SETTING_SOURCE_NAMES = ['user', 'project', 'local'] as const
type SettingSourceName = (typeof SETTING_SOURCE_NAMES)[number]

export const settingSourcesFromEnv = (
 raw = process.env.LOOM_SDK_SETTING_SOURCES,
): SettingSourceName[] =>
 (raw ?? '')
.split(',')
.map((part) => part.trim)
.filter((part): part is SettingSourceName =>
 (SETTING_SOURCE_NAMES as readonly string[]).includes(part),
)

/**
 * The SDK options a run executes under, minus the two things that cannot be
 * compared in a test (the `canUseTool` closure and the abort controller).
 *
 * Extracted so those options can be asserted directly — same reasoning as
 * sandbox.test.ts asserting container flags: a weakened boundary should fail a
 * test that names the requirement, not go unnoticed because it lives inside a
 * call expression.
 */
export const buildQueryOptions = (
 options: Pick<
 RunAgentOptions,
 'persona' | 'cwd' | 'resumeSessionId' | 'plannerTool' | 'notesTool' | 'questionTool'
 >,
 settingSources: SettingSourceName[] = settingSourcesFromEnv,
) => {
 const capabilities = options.persona.capabilities ?? []
 const mcpServers: Record<string, McpServerConfig> = toMcpServers(capabilities)
 // The Planner's one channel. Registered as an in-process
 // MCP server so the decomposition schema is enforced by the tool call, not by
 // parsing prose after the fact.
 if (options.plannerTool) mcpServers[PLANNER_SERVER_NAME] = options.plannerTool.server
 // The shared-context channel, in-process for the same reason.
 if (options.notesTool) mcpServers[NOTES_SERVER_NAME] = options.notesTool
 if (options.questionTool) mcpServers[QUESTION_SERVER_NAME] = options.questionTool
 const skills = capabilities
.filter((capability) => capability.kind === 'skill')
.map((capability) => capability.name)
 const scopedMcpTools = allowedMcpToolNames(capabilities)

 /**
 * The platform's own in-process tools, which must be added to the agent's tool
 * list explicitly.
 *
 * **This is load-bearing and was found only by a live run.** The SDK documents
 * `AgentDefinition.tools` as "Array of allowed tool names. If omitted, inherits all
 * tools from parent" — so a persona declaring `tools: [Read, Edit]` gets an
 * *exhaustive* allowlist, and an MCP tool absent from it is never offered to the
 * model. Registering the server is not enough.
 *
 * The consequence for a Planner is worse than for notes, and is why this comment is
 * long: a Planner declares `tools: []`, which as an exhaustive allowlist means it
 * could not call `submit_plan` either — the one thing a Planner exists to do. No
 * test caught it because the integration tests inject a `plan_submitted` frame
 * directly, which is the right way to test the *server*, and exactly the wrong way
 * to notice that the model was never offered the tool.
 *
 * Note what this does *not* do: it does not widen what a persona may do in any
 * sense the attenuation cares about. These two tools are the platform's own
 * channels — submitting a plan has no effect the server does not then decide for
 * itself, and a note is data. Neither reads or writes the filesystem.
 */
 const platformTools = [
...(options.plannerTool ? [options.plannerTool.toolName]: []),
...(options.notesTool ? NOTES_TOOL_NAMES: []),
...(options.questionTool ? [ASK_HUMAN_TOOL_NAME]: []),
 ]

 return {
 cwd: options.cwd,
 agent: options.persona.name,
 agents: {
 [options.persona.name]: {
 description: options.persona.name,
 prompt: options.persona.systemPrompt,
 tools: [...options.persona.tools,...platformTools],
 model: options.persona.model,
 },
 },
 // 'default' rather than any of the bypass modes: every risky call must reach
 // `canUseTool`, which is the only path a human decision can travel.
 permissionMode: 'default' as const,
 settingSources,
 /**
 * The MCP analogue of `settingSources: []`, and load-bearing for the same
 * reason. Without it the SDK also reads the project's `.mcp.json` — a file
 * inside the run's clone, which the agent can write and which in the general
 * case nobody in this workspace authored. An MCP server is a route to a shell,
 * so a repository able to add one would walk straight around the gate.
 * The registry is meant to be the only way a capability enters a run;
 * this is what makes that true rather than intended.
 */
 strictMcpConfig: true,
...(Object.keys(mcpServers).length > 0 ? { mcpServers }: {}),
 /**
 * Explicit list, never `'all'`. The SDK documents `skills` as "a context
 * filter, not a sandbox" — unlisted skills stay on disk and remain readable —
 * so this narrows what the model is *offered*, while the registry provisioning
 * only those attached is what actually bounds what exists.
 */
...(skills.length > 0 ? { skills }: {}),
 // Only when an attachment narrowed scope: an empty list would mean "no tools",
 // the opposite of the "everything this server offers" default.
 // The platform's own in-process tools must survive that narrowing, or a persona
 // that also holds a scoped MCP capability would lose the delegation channel (a
 // Planner's only ability) or the notes channel as a side effect of
 // scoping something unrelated.
...(scopedMcpTools ? { allowedTools: [...scopedMcpTools,...platformTools] }: {}),
...(options.resumeSessionId ? { resume: options.resumeSessionId }: {}),
 }
}

/**
 * The run's opening prompt, with the tree's shared context after the task rather
 * than before it.
 *
 * The order is deliberate and is the reason this is a named function with a test.
 * The task is what the operator asked for; the ledger contains text other *models*
 * wrote. Putting the ledger first would frame the task as something arriving inside
 * a context an attacker already established — the same reason
 * `renderNotesForPrompt` puts its "this is data" warning before the fenced content
 * and not after.
 */
export const buildPrompt = (
 options: Pick<RunAgentOptions, 'persona' | 'task' | 'contextLedger'>,
): string => {
 const opening = options.task
 ? `You are ${options.persona.name}. ${options.task}`
: `You are ${options.persona.name}. Begin working now.`
 const ledger = options.contextLedger?.trim
 return ledger ? `${opening}\n\n${ledger}`: opening
}

/**
 * The run's input channel — the opening prompt, plus anything the platform delivers
 * while the run is still working.
 *
 * **This is why every run uses the SDK's streaming-input mode.** With a plain string
 * prompt the agent loop has no input channel at all once it starts: a decision made
 * after a worker began reaches that worker only if it happens to call `read_notes`
 * again, at a moment of its own choosing. The SDK's `AsyncIterable<SDKUserMessage>`
 * prompt is the channel that changes that, and it is also what enables the control
 * requests (`interrupt`, `setPermissionMode`) the SDK documents as streaming-only.
 *
 * `shouldQuery: false` is the load-bearing field: the SDK appends such a message to
 * the transcript "without triggering an assistant turn … merged into the next user
 * message that does query". So a delivery lands in the worker's context on its next
 * model call — its next tool result — rather than interrupting the turn in flight.
 * Interrupting is what the kill switch is for; this is propagation, not preemption.
 *
 * The queue closes on the first `result` message, which is what ends the run: in
 * streaming-input mode the SDK keeps the loop alive while the input iterable is open,
 * so a queue nobody closes is a run that never finishes.
 */
const createInputChannel = (opening: string) => {
 const pending: SDKUserMessage[] = []
 let notify: ( => void) | null = null
 let closed = false

 const wake = => {
 const resume = notify
 notify = null
 resume?.
 }

 const message = (text: string, first: boolean): SDKUserMessage => ({
 type: 'user',
 message: { role: 'user', content: text },
 parent_tool_use_id: null,
 // The opening prompt must start the turn; everything after it must not.
...(first ? {}: { shouldQuery: false }),
 })

 pending.push(message(opening, true))

 const stream = (async function* {
 for (;;) {
 while (pending.length > 0) {
 const next = pending.shift
 if (next) yield next
 }
 if (closed) return
 await new Promise<void>((resolve) => {
 notify = resolve
 })
 }
 })

 return {
 stream,
 deliver: (text: string) => {
 if (closed) return
 pending.push(message(text, false))
 wake
 },
 close: => {
 closed = true
 wake
 },
 }
}

export const runAgent = async (options: RunAgentOptions): Promise<void> => {
 const canUseTool: CanUseTool = async (toolName, input) => {
 if (!options.isRiskyTool(toolName)) {
 return { behavior: 'allow' }
 }

 // Any toolUseId scheme works as long as Runner and server agree — the
 // SDK's own per-call id isn't available at this callback layer, so a
 // fresh one is minted per gate and used consistently in the
 // permission_request/permission_response round-trip.
 const toolUseId = `${toolName}-${Date.now}-${Math.random.toString(36).slice(2)}`

 // Out-of-bounds writes are not a judgment call for a human to weigh —
 // deny outright, skipping the approval round-trip entirely. No separate
 // onEvent here: `message` becomes the tool_result the SDK reports back
 // to the model, which toWireEvents already renders as a visible
 // tool_result — a second manual emission would just duplicate that line.
 const effect = await options.classifyEffect(toolName, input)
 if (!effect.ok) {
 return { behavior: 'deny', message: effect.reason }
 }

 // Effect-based gating: a call the classifier *proved*
 // harmless skips the round-trip. This is the approval-fatigue half of effect-based classification's
 // complaint about name-based gating — and it is one-directional, since
 // anything unproven still asks.
 if (!effect.requiresApproval) {
 return { behavior: 'allow' }
 }

 // Per-persona opt-in:
 // skips the human round-trip for this run. The hard path-scoped write
 // boundary above still applies unconditionally — this only ever skips a
 // judgment call, never a boundary.
 if (options.persona.autoApprove) {
 return { behavior: 'allow' }
 }

 const decision = await options.onPermissionRequest(toolUseId, toolName, input)
 const result: PermissionResult =
 decision === 'allow'
 ? { behavior: 'allow' }
: { behavior: 'deny', message: 'Denied by human reviewer' }
 return result
 }

 const input = createInputChannel(buildPrompt(options))
 // Registered before the loop starts, so a delivery arriving in the same tick as
 // the first tool call is queued rather than dropped on the floor.
 options.onInputChannel?.({ deliver: input.deliver })

 const stream = query({
 prompt: input.stream,
 options: {
...buildQueryOptions(options),
 canUseTool,
...(options.abortController ? { abortController: options.abortController }: {}),
 },
 })

 // Every SDK message repeats the session id; only the first is interesting.
 let reportedSessionId: string | null = null

 /**
 * Context-window sampling.
 *
 * `getContextUsage` is a control request to the agent process, so it is throttled
 * rather than called per message: a burst of fourteen parallel tool results would
 * otherwise mean fourteen round trips to learn the same number. It is also wrapped,
 * because an observability read must never be the thing that fails a run — a Runner
 * that cannot answer reports nothing and the board says "unknown", which is true.
 *
 * Deliberately *not* `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`,
 * whose own name is the reason; `getContextUsage` is a stable method on the query.
 */
 let lastSampleAt = 0
 const sampleContextUsage = async : Promise<void> => {
 if (!options.onContextUsage) return
 const now = Date.now
 if (now - lastSampleAt < CONTEXT_SAMPLE_INTERVAL_MS) return
 lastSampleAt = now
 try {
 const usage = await stream.getContextUsage
 if (usage.totalTokens >= 0 && usage.maxTokens > 0) {
 options.onContextUsage({ totalTokens: usage.totalTokens, maxTokens: usage.maxTokens })
 }
 } catch {
 // The run continues regardless; see above.
 }
 }

 try {
 for await (const message of stream) {
 // Read off the raw message rather than routed through toWireEvents: a
 // session id is Runner bookkeeping for resumption, not something to render
 // in a thread, and the structured tier carries only what is shown.
 const sessionId = (message as { session_id?: unknown }).session_id
 if (typeof sessionId === 'string' && sessionId.length > 0 && sessionId !== reportedSessionId) {
 reportedSessionId = sessionId
 options.onSessionId?.(sessionId)
 }
 // Before mapping down: tier 3 is defined as what the provider actually sent,
 // so anything this platform's own model would drop must be captured first.
 if (options.onRawMessage) await options.onRawMessage(JSON.stringify(message))
 for (const event of toWireEvents(message)) {
 await options.onEvent(event)
 }
 /**
 * The run's work is done, so the input channel closes and the SDK's loop ends.
 *
 * In streaming-input mode the agent loop stays alive while the iterable is
 * open — which is the whole point mid-run, and a deadlock at the end of one.
 * Closed here rather than in a `finally`, because `finally` runs only once the
 * loop has already exited, which is the thing that will not happen.
 */
 if (message.type === 'result') input.close
 await sampleContextUsage
 }
 } catch (error) {
 input.close
 // An abort is an expected outcome, not a crash: the server already recorded
 // the run as cancelled before sending `cancel_run`, so reporting a
 // `run_failed` here would overwrite that with a misleading `failed`.
 if (options.abortController?.signal.aborted) return
 options.onEvent({
 kind: 'run_failed',
 message: error instanceof Error ? error.message: String(error),
 })
 }
}
