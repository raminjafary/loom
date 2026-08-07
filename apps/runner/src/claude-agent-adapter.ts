import { query, type CanUseTool, type PermissionResult, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { WireAgentEvent, WirePersonaSpec } from '@loom/runner-protocol'

/**
 * `AgentExecutionPort` implementation for the Claude Agent SDK (PLAN.md §4b) —
 * imported as a library, not shelled out to as a subprocess, per the
 * corrected design in PLAN.md §4/§4b.
 *
 * Branding note (§8): must be called "Claude Agent" in any user-facing text,
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
  Array.isArray(content) ? (content as ContentBlockLike[]) : []

const summarizeToolResultContent = (content: unknown): string => {
  if (typeof content === 'string') return content.slice(0, 2000)
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        const b = block as ContentBlockLike
        return typeof b.text === 'string' ? b.text : JSON.stringify(b)
      })
      .join('\n')
      .slice(0, 2000)
  }
  return JSON.stringify(content).slice(0, 2000)
}

/**
 * Maps the SDK's ~40-variant message union down to the structured tier this
 * platform actually renders (PLAN.md §4d-bis) — everything else (thinking
 * tokens, hook lifecycle, session-state changes, ...) is deliberately not
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
  /** What a human asked for via `@mention` (PLAN.md §3a); absent for the sidebar-picker path. */
  readonly task?: string
  /**
   * May return a promise, and the stream loop awaits it — that await is how the
   * Runner applies backpressure (PLAN.md §7 Phase 1): while it is unresolved the
   * SDK's iterator is not pulled, so the agent loop itself slows rather than the
   * Runner buffering without limit.
   */
  readonly onEvent: (event: WireAgentEvent) => void | Promise<void>
  /**
   * Aborts the SDK's agent loop mid-flight (PLAN.md §6 kill switch). Owned by
   * the caller so a `cancel_run` frame arriving on the socket can reach a run
   * that is already streaming.
   */
  readonly abortController?: AbortController
  /**
   * The SDK's session id, reported as soon as the session announces itself.
   * Persisting it is what makes a run resumable rather than restartable after a
   * Runner crash (PLAN.md §7 Phase 1).
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
  /** Path-scoped write check (PLAN.md §6 A3) — see packages/domain/src/risky-tools.ts. */
  readonly classifyEffect: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>
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
 * `canUseTool` gate that PLAN.md §6 A1/A3 make the whole point. Loom does not
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
    .map((part) => part.trim())
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
  options: Pick<RunAgentOptions, 'persona' | 'cwd' | 'resumeSessionId'>,
  settingSources: SettingSourceName[] = settingSourcesFromEnv(),
) => ({
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
  // `canUseTool`, which is the only path a human decision can travel (§6 A1).
  permissionMode: 'default' as const,
  settingSources,
  ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
})

export const runAgent = async (options: RunAgentOptions): Promise<void> => {
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (!options.isRiskyTool(toolName)) {
      return { behavior: 'allow' }
    }

    // Any toolUseId scheme works as long as Runner and server agree — the
    // SDK's own per-call id isn't available at this callback layer, so a
    // fresh one is minted per gate and used consistently in the
    // permission_request/permission_response round-trip.
    const toolUseId = `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`

    // Out-of-bounds writes are not a judgment call for a human to weigh —
    // deny outright, skipping the approval round-trip entirely. No separate
    // onEvent here: `message` becomes the tool_result the SDK reports back
    // to the model, which toWireEvents already renders as a visible
    // tool_result — a second manual emission would just duplicate that line.
    const effect = await options.classifyEffect(toolName, input)
    if (!effect.ok) {
      return { behavior: 'deny', message: effect.reason }
    }

    // Per-persona opt-in (PLAN.md §6, per-persona `harness.autoApprove`):
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
      ...(options.abortController ? { abortController: options.abortController } : {}),
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
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
