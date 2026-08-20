import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { usageCostUsd } from '@loom/domain'
import { buildPrompt, gateBehavior, type RunAgentOptions } from './claude-agent-adapter.js'

const execFileAsync = promisify(execFile)

/**
 * The second execution backend — a model served over the chat-completions protocol.
 *
 * The replaceability claim has been architectural since Phase 1: the port exists, it is
 * enforced by the boundary guard, and exactly one thing had ever been driven through it. This
 * is the second, and it is deliberately not a second *vendor's agent SDK*: what makes a
 * backend worth having here is that an operator can serve a small model themselves and have
 * the platform treat it like any other, which is the whole G3 track — small models, evolved
 * and map-subsidized, doing measured work at a fraction of the price.
 *
 * The protocol is the de-facto one that local serving stacks and most hosted APIs both speak:
 * `POST /chat/completions`, messages with roles, tools as JSON-schema function declarations,
 * tool calls in the assistant message, tool results as further messages. One adapter covers
 * every server that speaks it, which is the reason to write this one rather than three.
 *
 * ## The four rules it keeps, each of which is a rule and not a default
 *
 * **1. The tool vocabulary is the platform's, not this backend's.** `Read`, `Write`, `Edit`,
 * `Bash`, `Glob` and `Grep`, with the same argument names the other backend's SDK uses —
 * because `isRiskyTool`, `classifyToolEffect`, the approval card and a persona's declared
 * tool list are all written against those names. A backend that invented `read_file` would
 * make a persona mean two different things depending on which model it happened to run on,
 * and the gate would silently stop matching.
 *
 * **2. Every call goes through the same gate, in the same order.** `isRiskyTool` →
 * `classifyToolEffect` → `gateBehavior` → the human. That is not re-implemented here: it is
 * the same three functions the other adapter calls, in a shared helper, because two gates
 * that agree today are two gates that disagree after the next edit to one of them.
 *
 * **3. It refuses rather than degrades.** A run needing a channel this backend does not have
 * — a planner's `submit_plan`, a mastery run's `record_map`, a verifier's verdict, a
 * proposer's submission, tier 1's `revise_own_prompt`, tier 5's `record_experience` — is
 * *failed with a reason*, never run as a lesser agent. This repository has shipped "a tool
 * the model was never offered" three times and each one looked like a working run producing
 * nothing; a refusal that names the missing channel is the opposite of that failure.
 *
 * **4. The cost figure says what kind of figure it is.** There is no egress proxy in front of
 * a model on the operator's own machine, so what is available is the server's own `usage`
 * block priced by the reviewed table — a self-report, which is exactly the sort of number
 * this platform refuses elsewhere. For a `local/` model the table prices it at zero, which is
 * the honest answer about dollars; for anything else it is null and the run reports no cost
 * rather than an invented one.
 */

/** Where the operator's server is. No default: an unset base URL is a refusal, not localhost. */
export const CHAT_COMPLETIONS_BASE_URL_ENV = 'LOOM_CHAT_COMPLETIONS_BASE_URL'
export const CHAT_COMPLETIONS_KEY_ENV = 'LOOM_CHAT_COMPLETIONS_API_KEY'

/**
 * The model-id convention that selects this backend.
 *
 * A prefix rather than a per-run flag, so the choice travels with the persona document and
 * with every snapshot of it — a run's backend is then readable from the row months later,
 * which a flag on the dispatch call would not be. Everything after the prefix is the id the
 * operator's own endpoint knows the model by, passed through untouched.
 */
export const LOCAL_MODEL_PREFIX = 'local/'

export const usesChatCompletions = (model: string): boolean =>
  model.startsWith(LOCAL_MODEL_PREFIX)

/** The id to send upstream: the operator's own name for the model, without the prefix. */
export const upstreamModelId = (model: string): string =>
  model.startsWith(LOCAL_MODEL_PREFIX) ? model.slice(LOCAL_MODEL_PREFIX.length) : model

/** How many model calls one run may make before it is stopped. */
export const MAX_TURNS = Number(process.env.LOOM_CHAT_COMPLETIONS_MAX_TURNS ?? 40)

/** How much of a tool's output reaches the model. A file is not a context window. */
export const MAX_TOOL_RESULT_CHARS = 20_000

/** How long one shell command may run before it is killed, in milliseconds. */
const BASH_TIMEOUT_MS = Number(process.env.LOOM_CHAT_COMPLETIONS_BASH_TIMEOUT_MS ?? 120_000)

/**
 * Which of this run's channels this backend cannot provide — the refusal, as a sentence.
 *
 * Null means it can run. Everything named here is an in-process MCP server on the other
 * backend, and there is no equivalent yet: they are not *tools* so much as private channels
 * back to the platform, and wiring them through would mean re-expressing each one as a
 * function declaration plus a callback the Runner already holds. That is real work rather
 * than an oversight, and until it is done the honest behaviour is to refuse the run.
 */
export const chatCompletionsRefusal = (
  options: Pick<
    RunAgentOptions,
    'persona' | 'plannerTool' | 'mapTool' | 'verdictTool' | 'proposalTool' | 'selfTool' | 'experienceTool'
  >,
): string | null => {
  const missing: string[] = []
  if (options.plannerTool) missing.push('planning (submit_plan)')
  if (options.mapTool) missing.push('mastery (record_map)')
  if (options.verdictTool) missing.push('the verifier verdict')
  if (options.proposalTool) missing.push('candidate proposal')
  if (options.selfTool) missing.push('self-modification (revise_own_prompt)')
  if (options.experienceTool) missing.push('durable memory (record_experience)')
  if (options.persona.planner) missing.push('planning, which this persona is for')
  if (missing.length === 0) return null
  return (
    `A model served over the chat-completions backend cannot be offered ${missing.join(', ')}. ` +
    'The run is refused rather than started without them: a run whose whole job is a channel ' +
    'it was never offered looks like a working run that produced nothing.'
  )
}

/** The tools this backend implements, by the platform's own names. */
const TOOL_SCHEMAS: Readonly<Record<string, unknown>> = {
  Read: {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file from the repository. Returns its text, truncated if very large.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path, absolute or relative to the repository root.' },
        },
        required: ['file_path'],
      },
    },
  },
  Write: {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write a file, creating it or replacing its contents entirely.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  Edit: {
    type: 'function',
    function: {
      name: 'Edit',
      /**
       * The description states the exactly-once rule because the failure it prevents is the
       * expensive one: a replacement that matched twice silently changes something the model
       * did not look at, and one that matched nothing is a no-op the model reads as success.
       */
      description:
        'Replace an exact string in a file. The old string must appear exactly once, or the ' +
        'edit is refused and nothing changes.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  Bash: {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Run a shell command in the repository. Output is truncated if very long.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  Glob: {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'List repository files whose path contains a substring. Bounded.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
    },
  },
  Grep: {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search the repository for a literal string. Returns matching lines with paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Optional subdirectory to search.' },
        },
        required: ['pattern'],
      },
    },
  },
}

export const IMPLEMENTED_TOOLS: readonly string[] = Object.keys(TOOL_SCHEMAS)

const truncate = (text: string): string =>
  text.length <= MAX_TOOL_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated at ${MAX_TOOL_RESULT_CHARS} characters]`

/**
 * Files under the run's clone, bounded and with the noisy directories skipped.
 *
 * Written here rather than shelling out to `find`, because `Glob` is not a risky tool and must
 * not become one: a tool that ran a command would be gated like a command, and a listing that
 * needed approval is a listing nobody uses.
 */
const walkFiles = async (root: string, limit: number): Promise<string[]> => {
  const skip = new Set(['.git', 'node_modules', 'dist', '.turbo', 'coverage'])
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    if (found.length >= limit) return
    let entries: { name: string; isDirectory: () => boolean }[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      if (skip.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else found.push(relative(root, full))
    }
  }
  await walk(root)
  return found
}

interface ToolOutcome {
  readonly text: string
  readonly isError: boolean
}

const runTool = async (
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<ToolOutcome> => {
  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const resolved = filePath === null ? null : filePath.startsWith(sep) ? filePath : join(cwd, filePath)

  switch (toolName) {
    case 'Read': {
      if (resolved === null) return { text: 'Read needs a file_path.', isError: true }
      try {
        return { text: truncate(await readFile(resolved, 'utf8')), isError: false }
      } catch (error) {
        return { text: `Could not read it: ${String(error)}`, isError: true }
      }
    }
    case 'Write': {
      if (resolved === null || typeof input.content !== 'string') {
        return { text: 'Write needs a file_path and content.', isError: true }
      }
      try {
        await mkdir(dirname(resolved), { recursive: true })
        await writeFile(resolved, input.content)
        return { text: `Wrote ${input.content.length} characters.`, isError: false }
      } catch (error) {
        return { text: `Could not write it: ${String(error)}`, isError: true }
      }
    }
    case 'Edit': {
      if (
        resolved === null ||
        typeof input.old_string !== 'string' ||
        typeof input.new_string !== 'string'
      ) {
        return { text: 'Edit needs a file_path, an old_string and a new_string.', isError: true }
      }
      try {
        const before = await readFile(resolved, 'utf8')
        const occurrences = before.split(input.old_string).length - 1
        /**
         * Both directions are errors and both are reported as errors, which is the point:
         * a no-match replacement is a silent no-op the model reads as success, and a
         * multi-match one changes something nobody looked at.
         */
        if (occurrences === 0) {
          return { text: 'That exact string is not in the file; nothing changed.', isError: true }
        }
        if (occurrences > 1) {
          return {
            text: `That string appears ${occurrences} times; nothing changed. Include more context so it matches once.`,
            isError: true,
          }
        }
        await writeFile(resolved, before.replace(input.old_string, input.new_string))
        return { text: 'Edited.', isError: false }
      } catch (error) {
        return { text: `Could not edit it: ${String(error)}`, isError: true }
      }
    }
    case 'Bash': {
      if (typeof input.command !== 'string') return { text: 'Bash needs a command.', isError: true }
      try {
        const { stdout, stderr } = await execFileAsync('bash', ['-lc', input.command], {
          cwd,
          timeout: BASH_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        })
        return { text: truncate(`${stdout}${stderr}`) || '(no output)', isError: false }
      } catch (error) {
        const shell = error as { stdout?: string; stderr?: string; message?: string }
        return {
          text: truncate(`${shell.stdout ?? ''}${shell.stderr ?? ''}${shell.message ?? ''}`),
          isError: true,
        }
      }
    }
    case 'Glob': {
      if (typeof input.pattern !== 'string') return { text: 'Glob needs a pattern.', isError: true }
      const needle = input.pattern.replace(/[*]/g, '')
      const files = (await walkFiles(cwd, 2_000)).filter((path) => path.includes(needle))
      return {
        text: files.length === 0 ? '(no files matched)' : truncate(files.slice(0, 200).join('\n')),
        isError: false,
      }
    }
    case 'Grep': {
      if (typeof input.pattern !== 'string') return { text: 'Grep needs a pattern.', isError: true }
      const where = typeof input.path === 'string' ? join(cwd, input.path) : cwd
      try {
        const { stdout } = await execFileAsync(
          'grep',
          ['-rnI', '--exclude-dir=.git', '--exclude-dir=node_modules', '-F', input.pattern, '.'],
          { cwd: where, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
        )
        return { text: truncate(stdout) || '(no matches)', isError: false }
      } catch {
        // grep exits non-zero when nothing matched, which is an answer rather than a fault.
        return { text: '(no matches)', isError: false }
      }
    }
    default:
      return { text: `This backend does not implement ${toolName}.`, isError: true }
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/**
 * The agent loop.
 *
 * Same shape as the other backend's from the caller's side: it emits `WireAgentEvent`s, it
 * respects the abort controller, it takes deliveries mid-flight, and it ends with exactly one
 * `run_completed` or `run_failed`. What it does not do is hide a difference — see the header
 * for the four channels it refuses and the kind of number its cost figure is.
 */
export const runChatCompletionsAgent = async (options: RunAgentOptions): Promise<void> => {
  const refusal = chatCompletionsRefusal(options)
  if (refusal !== null) {
    await options.onEvent({ kind: 'run_failed', message: refusal })
    return
  }

  const baseUrl = process.env[CHAT_COMPLETIONS_BASE_URL_ENV]
  if (!baseUrl) {
    await options.onEvent({
      kind: 'run_failed',
      message:
        `This run's model is served over the chat-completions backend and ${CHAT_COMPLETIONS_BASE_URL_ENV} ` +
        'is not set on the Runner, so there is nowhere to send it. An unset base URL is a ' +
        'refusal rather than a guess at localhost.',
    })
    return
  }

  const offered = options.persona.tools.filter((tool) => tool in TOOL_SCHEMAS)
  const tools = offered.map((tool) => TOOL_SCHEMAS[tool])

  const messages: ChatMessage[] = [
    { role: 'system', content: options.persona.systemPrompt },
    { role: 'user', content: buildPrompt(options) },
  ]

  /**
   * Deliveries land as user messages before the next model call — the same propagation the
   * other backend's streaming-input mode gives, arrived at differently. A delivery mid-call
   * waits for that call to finish rather than interrupting it: interrupting is what the kill
   * switch is for.
   */
  const pending: string[] = []
  options.onInputChannel?.({ deliver: (text: string) => void pending.push(text) })

  let totalInput = 0
  let totalOutput = 0
  let turns = 0

  const emitCost = async (result: string): Promise<void> => {
    const cost = usageCostUsd(options.persona.model, {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    /**
     * Null — an unpriced model — reports zero *and* says so in the result line rather than
     * inventing a figure. The cap is enforced server-side against what is reported, so a
     * guess here would be a budget enforced against fiction.
     */
    await options.onEvent({
      kind: 'run_completed',
      totalCostUsd: cost ?? 0,
      result:
        cost === null
          ? `${result} (no price is on record for this model, so no cost is reported)`
          : result,
    })
  }

  try {
    while (turns < MAX_TURNS) {
      if (options.abortController?.signal.aborted === true) {
        await options.onEvent({ kind: 'run_failed', message: 'The run was cancelled.' })
        return
      }
      for (const delivery of pending.splice(0)) {
        messages.push({ role: 'user', content: delivery })
      }
      turns += 1

      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(process.env[CHAT_COMPLETIONS_KEY_ENV]
            ? { authorization: `Bearer ${process.env[CHAT_COMPLETIONS_KEY_ENV]}` }
            : {}),
        },
        body: JSON.stringify({
          model: upstreamModelId(options.persona.model),
          messages,
          ...(tools.length === 0 ? {} : { tools, tool_choice: 'auto' }),
        }),
        ...(options.abortController ? { signal: options.abortController.signal } : {}),
      })

      if (!response.ok) {
        await options.onEvent({
          kind: 'run_failed',
          message: `The model server answered ${response.status}: ${truncate(await response.text())}`,
        })
        return
      }

      const body = (await response.json()) as {
        choices?: { message?: ChatMessage; finish_reason?: string }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      if (options.onRawMessage) await options.onRawMessage(JSON.stringify(body))
      totalInput += body.usage?.prompt_tokens ?? 0
      totalOutput += body.usage?.completion_tokens ?? 0

      const message = body.choices?.[0]?.message
      if (!message) {
        await options.onEvent({
          kind: 'run_failed',
          message: 'The model server returned no message, which is a protocol error rather than an answer.',
        })
        return
      }

      if (typeof message.content === 'string' && message.content.trim().length > 0) {
        await options.onEvent({ kind: 'assistant_text', text: message.content })
      }

      const calls = message.tool_calls ?? []
      if (calls.length === 0) {
        await emitCost(message.content?.trim() || 'Finished.')
        return
      }

      messages.push({
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: calls,
      })

      for (const call of calls) {
        let input: Record<string, unknown> = {}
        try {
          input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
        } catch {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'Those arguments were not valid JSON, so nothing ran.',
          })
          continue
        }

        await options.onEvent({
          kind: 'tool_call',
          toolUseId: call.id,
          toolName: call.function.name,
          input,
        })

        const outcome = await gateAndRun(options, call.id, call.function.name, input)
        await options.onEvent({
          kind: 'tool_result',
          toolUseId: call.id,
          isError: outcome.isError,
          summary: outcome.text.slice(0, 2_000),
        })
        messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.text })
      }
    }

    /**
     * The turn cap is a stop, not a failure: the work so far is on the branch either way, and
     * a run reported as failed is one a reviewer skips.
     */
    await emitCost(`Stopped after ${MAX_TURNS} turns without finishing.`)
  } catch (error) {
    if (options.abortController?.signal.aborted === true) {
      await options.onEvent({ kind: 'run_failed', message: 'The run was cancelled.' })
      return
    }
    await options.onEvent({
      kind: 'run_failed',
      message: `The chat-completions backend failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

/**
 * The gate, then the tool — in the platform's order, using the platform's functions.
 *
 * Split out so the sequence is one thing rather than something inlined in a loop: the order
 * (risky? → what does it touch? → what does the persona's mode allow? → ask a human) is a
 * security property, and an inlined copy is a copy that gets reordered.
 */
const gateAndRun = async (
  options: RunAgentOptions,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> => {
  const isRisky = options.isRiskyTool(toolName)
  if (isRisky) {
    const effect = await options.classifyEffect(toolName, input)
    const behavior = gateBehavior({
      approvalMode: options.persona.approvalMode,
      toolName,
      isRisky,
      effect,
    })
    if (behavior === 'deny') {
      return { text: effect.ok ? 'Denied.' : effect.reason, isError: true }
    }
    if (behavior === 'gate') {
      const decision = await options.onPermissionRequest(toolUseId, toolName, input)
      if (decision === 'deny') return { text: 'Denied by human reviewer.', isError: true }
    }
  }
  return runTool(toolName, input, options.cwd)
}
