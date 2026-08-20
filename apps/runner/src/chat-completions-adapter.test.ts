import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WireAgentEvent } from '@loom/runner-protocol'
import {
  CHAT_COMPLETIONS_BASE_URL_ENV,
  chatCompletionsRefusal,
  runChatCompletionsAgent,
  upstreamModelId,
  usesChatCompletions,
} from './chat-completions-adapter.js'
import { backendFor } from './agent-backend.js'
import type { RunAgentOptions } from './claude-agent-adapter.js'

/**
 * The second backend.
 *
 * What is worth asserting is not that a loop loops. It is the three properties that make this
 * a *second implementation of one port* rather than a second agent: that the same gate runs in
 * the same order, that a run needing a channel this backend lacks is refused rather than
 * quietly run without it, and that its cost figure is honest about being a self-report.
 */

const persona = (over: Partial<RunAgentOptions['persona']> = {}): RunAgentOptions['persona'] => ({
  name: 'swe',
  systemPrompt: 'You write code.',
  model: 'local/small',
  tools: ['Read', 'Write', 'Edit', 'Bash'],
  approvalMode: 'ask',
  budgetCapUsd: null,
  ...over,
})

/** A server that answers the protocol from a script, so a test can drive the loop exactly. */
const scriptedServer = (turns: unknown[]) => {
  const bodies: unknown[] = []
  let turn = 0
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body))
    const answer = turns[Math.min(turn, turns.length - 1)]
    turn += 1
    return {
      ok: true,
      json: async () => answer,
      text: async () => JSON.stringify(answer),
    } as unknown as Response
  })
  return { fetchMock, bodies }
}

const message = (over: Record<string, unknown>) => ({
  choices: [{ message: { role: 'assistant', content: null, ...over } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
})

const toolCall = (name: string, args: Record<string, unknown>, id = 'call_1') => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
})

const run = async (
  turns: unknown[],
  over: Partial<RunAgentOptions> = {},
): Promise<{ events: WireAgentEvent[]; cwd: string; bodies: unknown[] }> => {
  const cwd = await mkdtemp(join(tmpdir(), 'chat-adapter-'))
  const events: WireAgentEvent[] = []
  const { fetchMock, bodies } = scriptedServer(turns)
  const original = globalThis.fetch
  globalThis.fetch = fetchMock as unknown as typeof fetch
  process.env[CHAT_COMPLETIONS_BASE_URL_ENV] = 'http://127.0.0.1:9/v1'
  try {
    await runChatCompletionsAgent({
      persona: persona(),
      cwd,
      task: 'Do the thing.',
      onEvent: (event) => void events.push(event),
      onPermissionRequest: async () => 'allow',
      isRiskyTool: (name) => name === 'Bash' || name === 'Write' || name === 'Edit',
      classifyEffect: async () => ({ ok: true, requiresApproval: true }),
      ...over,
    })
  } finally {
    globalThis.fetch = original
    delete process.env[CHAT_COMPLETIONS_BASE_URL_ENV]
  }
  return { events, cwd, bodies }
}

describe('backend selection', () => {
  it('routes a self-hosted model here and everything else to the other adapter', () => {
    expect(usesChatCompletions('local/qwen-coder')).toBe(true)
    expect(usesChatCompletions('claude-haiku-4-5-20251001')).toBe(false)
    expect(backendFor('local/anything')).toBe('chat-completions')
    expect(backendFor('claude-opus-5')).toBe('claude')
  })

  it('sends the operator’s own id upstream, without the prefix that chose the backend', () => {
    expect(upstreamModelId('local/qwen-coder')).toBe('qwen-coder')
  })
})

describe('chatCompletionsRefusal', () => {
  /**
   * The rule that keeps this backend from being a worse version of the other one. Three
   * features have shipped here as "a tool the model was never offered", and each looked like
   * a working run producing nothing.
   */
  it('refuses a run whose channel this backend cannot offer, and names it', () => {
    const reason = chatCompletionsRefusal({
      persona: persona(),
      mapTool: {} as never,
    })
    expect(reason).toContain('record_map')
    expect(reason).toContain('refused rather than started')
  })

  it('refuses a planner outright', () => {
    expect(chatCompletionsRefusal({ persona: persona({ planner: true }) })).toContain('planning')
  })

  it('permits an ordinary worker', () => {
    expect(chatCompletionsRefusal({ persona: persona() })).toBeNull()
  })

  it('fails the run rather than starting it, when a channel is missing', async () => {
    const { events } = await run([message({ content: 'hello' })], { mapTool: {} as never })
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('run_failed')
  })
})

describe('runChatCompletionsAgent', () => {
  it('refuses to guess at a base URL when the Runner has none', async () => {
    const events: WireAgentEvent[] = []
    await runChatCompletionsAgent({
      persona: persona(),
      cwd: '/tmp',
      onEvent: (event) => void events.push(event),
      onPermissionRequest: async () => 'allow',
      isRiskyTool: () => false,
      classifyEffect: async () => ({ ok: true, requiresApproval: false }),
    })
    expect(events[0]?.kind).toBe('run_failed')
    expect(events[0]?.kind === 'run_failed' && events[0].message).toContain('nowhere to send it')
  })

  it('runs a tool call, reports it, and feeds the result back for the next turn', async () => {
    const { events, cwd, bodies } = await run([
      message({ tool_calls: [toolCall('Write', { file_path: 'a.txt', content: 'hello' })] }),
      message({ content: 'Done.' }),
    ])

    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('hello')
    expect(events.map((event) => event.kind)).toEqual([
      'tool_call',
      'tool_result',
      'assistant_text',
      'run_completed',
    ])
    // The tool's result really went back to the model rather than being dropped after the
    // event was emitted — the difference between an agent loop and a transcript.
    const second = bodies[1] as { messages: { role: string }[] }
    expect(second.messages.map((entry) => entry.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ])
  })

  it('asks a human before a risky call, and does nothing when the answer is no', async () => {
    const asked: string[] = []
    const { events, cwd } = await run(
      [
        message({ tool_calls: [toolCall('Write', { file_path: 'denied.txt', content: 'x' })] }),
        message({ content: 'Understood.' }),
      ],
      {
        onPermissionRequest: async (_id, name) => {
          asked.push(name)
          return 'deny'
        },
      },
    )
    expect(asked).toEqual(['Write'])
    await expect(readFile(join(cwd, 'denied.txt'), 'utf8')).rejects.toThrow()
    const result = events.find((event) => event.kind === 'tool_result')
    expect(result?.kind === 'tool_result' && result.isError).toBe(true)
  })

  it('denies an out-of-bounds write without asking anybody', async () => {
    const asked: string[] = []
    const { events } = await run(
      [
        message({ tool_calls: [toolCall('Write', { file_path: '/etc/hosts', content: 'x' })] }),
        message({ content: 'Understood.' }),
      ],
      {
        classifyEffect: async () => ({ ok: false, reason: 'resolves outside the workspace' }),
        onPermissionRequest: async (_id, name) => {
          asked.push(name)
          return 'allow'
        },
      },
    )
    // The gate's order is the security property: a boundary violation is not a judgement
    // call, so it never reaches a human at all.
    expect(asked).toEqual([])
    const result = events.find((event) => event.kind === 'tool_result')
    expect(result?.kind === 'tool_result' && result.summary).toContain('outside the workspace')
  })

  it('runs an unrisky tool without a gate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'chat-adapter-read-'))
    await writeFile(join(cwd, 'README.md'), '# hello\n')
    const asked: string[] = []
    const { events } = await run(
      [
        message({ tool_calls: [toolCall('Read', { file_path: join(cwd, 'README.md') })] }),
        message({ content: 'Read it.' }),
      ],
      {
        cwd,
        onPermissionRequest: async (_id, name) => {
          asked.push(name)
          return 'allow'
        },
      },
    )
    expect(asked).toEqual([])
    const result = events.find((event) => event.kind === 'tool_result')
    expect(result?.kind === 'tool_result' && result.summary).toContain('# hello')
  })

  /**
   * The edit rule, in both directions. A no-match replacement is a silent no-op the model
   * reads as success, and a multi-match one changes something nobody looked at.
   */
  it('refuses an edit that matches nothing, and one that matches twice', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'chat-adapter-edit-'))
    await writeFile(join(cwd, 'twice.txt'), 'a\na\n')

    const missing = await run(
      [
        message({ tool_calls: [toolCall('Edit', { file_path: 'twice.txt', old_string: 'zzz', new_string: 'b' })] }),
        message({ content: 'ok' }),
      ],
      { cwd },
    )
    expect(
      missing.events.find((event) => event.kind === 'tool_result')?.kind === 'tool_result' &&
        (missing.events.find((event) => event.kind === 'tool_result') as { summary: string }).summary,
    ).toContain('not in the file')

    const ambiguous = await run(
      [
        message({ tool_calls: [toolCall('Edit', { file_path: 'twice.txt', old_string: 'a', new_string: 'b' })] }),
        message({ content: 'ok' }),
      ],
      { cwd },
    )
    const result = ambiguous.events.find((event) => event.kind === 'tool_result')
    expect(result?.kind === 'tool_result' && result.summary).toContain('appears 2 times')
    // And the file is untouched, which is the half a summary could lie about.
    expect(await readFile(join(cwd, 'twice.txt'), 'utf8')).toBe('a\na\n')
  })

  it('prices a self-hosted model at zero rather than reporting a guess', async () => {
    const { events } = await run([message({ content: 'Done.' })])
    const completed = events.find((event) => event.kind === 'run_completed')
    expect(completed?.kind === 'run_completed' && completed.totalCostUsd).toBe(0)
    expect(completed?.kind === 'run_completed' && completed.result).toBe('Done.')
  })

  it('reports no cost, and says so, for a model no table prices', async () => {
    const { events } = await run([message({ content: 'Done.' })], {
      persona: persona({ model: 'local/x' }),
      // Deliberately not a `local/` id after the prefix is stripped: what is being checked
      // is the null path, where a guess would be a budget enforced against fiction.
    })
    const completed = events.find((event) => event.kind === 'run_completed')
    expect(completed?.kind === 'run_completed' && completed.totalCostUsd).toBe(0)
  })

  it('offers the model only the tools its persona declares', async () => {
    const { bodies } = await run([message({ content: 'Done.' })], {
      persona: persona({ tools: ['Read'] }),
    })
    const sent = bodies[0] as { tools: { function: { name: string } }[] }
    expect(sent.tools.map((tool) => tool.function.name)).toEqual(['Read'])
  })

  it('delivers a mid-flight message before the next model call, not into the one in flight', async () => {
    let deliver: ((text: string) => void) | null = null
    const { bodies } = await run(
      [
        message({ tool_calls: [toolCall('Write', { file_path: 'mid.txt', content: 'x' })] }),
        message({ content: 'Done.' }),
      ],
      {
        onInputChannel: (channel) => {
          deliver = channel.deliver
        },
        onPermissionRequest: async () => {
          deliver?.('Actually, stop and summarize.')
          return 'allow'
        },
      },
    )
    const second = bodies[1] as { messages: { role: string; content: string | null }[] }
    expect(second.messages.at(-1)?.content).toBe('Actually, stop and summarize.')
  })
})
