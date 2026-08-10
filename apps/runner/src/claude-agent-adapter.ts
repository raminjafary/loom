import {
 query,
 type CanUseTool,
 type McpSdkServerConfigWithInstance,
 type McpServerConfig,
 type PermissionResult,
 type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { WireAgentEvent, WirePersonaSpec } from '@loom/runner-protocol'
import { allowedMcpToolNames, toMcpServers } from './capabilities.js'
import { PLANNER_SERVER_NAME, PLANNER_TOOL_NAME } from './planner-tool.js'

/**
 * `AgentExecutionPort` implementation for the Claude Agent SDK —
 * imported as a library, not shelled out to as a subprocess, per the
 * corrected design in the architecture/the driven side.
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

export interface RunAgentOptions {
 readonly persona: WirePersonaSpec
 readonly cwd: string
 /** What a human asked for via `@mention`; absent for the sidebar-picker path. */
 readonly task?: string
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
 */
 readonly plannerTool?: McpSdkServerConfigWithInstance
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
 options: Pick<RunAgentOptions, 'persona' | 'cwd' | 'resumeSessionId' | 'plannerTool'>,
 settingSources: SettingSourceName[] = settingSourcesFromEnv,
) => {
 const capabilities = options.persona.capabilities ?? []
 const mcpServers: Record<string, McpServerConfig> = toMcpServers(capabilities)
 // The Planner's one channel. Registered as an in-process
 // MCP server so the decomposition schema is enforced by the tool call, not by
 // parsing prose after the fact.
 if (options.plannerTool) mcpServers[PLANNER_SERVER_NAME] = options.plannerTool
 const skills = capabilities
.filter((capability) => capability.kind === 'skill')
.map((capability) => capability.name)
 const scopedMcpTools = allowedMcpToolNames(capabilities)

 return {
 cwd: options.cwd,
 agent: options.persona.name,
 agents: {
 [options.persona.name]: {
 description: options.persona.name,
 prompt: options.persona.systemPrompt,
 tools: options.persona.tools,
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
 // A Planner's tool must survive the scope narrowing above, or a Planner that
 // also holds a scoped MCP capability would lose the only thing it can do.
...(scopedMcpTools
 ? { allowedTools: options.plannerTool ? [...scopedMcpTools, PLANNER_TOOL_NAME]: scopedMcpTools }
: {}),
...(options.resumeSessionId ? { resume: options.resumeSessionId }: {}),
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

 const prompt = options.task
 ? `You are ${options.persona.name}. ${options.task}`
: `You are ${options.persona.name}. Begin working now.`

 const stream = query({
 prompt,
 options: {
...buildQueryOptions(options),
 canUseTool,
...(options.abortController ? { abortController: options.abortController }: {}),
 },
 })

 // Every SDK message repeats the session id; only the first is interesting.
 let reportedSessionId: string | null = null

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
 }
 } catch (error) {
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
