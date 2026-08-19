import { describe, expect, it } from 'vitest'
import { HAND_OVER_TOOL_NAME } from './handoff-tool.js'
import { RECORD_MAP_TOOL_NAME } from './map-tool.js'
import {
  buildPrompt,
  buildQueryOptions,
  gateBehavior,
  settingSourcesFromEnv,
} from './claude-agent-adapter.js'

/**
 * These assert the permission-relevant SDK options by name, the same way
 * sandbox.test.ts asserts the container flags: a human decision is the only path to a
 * risky effect, and both of these options are ways
 * that could stop being true without anything failing to compile.
 */

const persona = {
  name: 'swe',
  systemPrompt: 'do the work',
  model: 'claude-sonnet-5',
  tools: ['Read', 'Bash'],
  approvalMode: 'ask' as const,
  budgetCapUsd: null,
}

describe('buildQueryOptions', () => {
  it('loads no filesystem settings by default', () => {
    // `cwd` is the run's clone: content the agent writes to, and content nobody
    // here necessarily authored. A `.claude/settings.json` in it must not get a
    // say in what the run is permitted to do.
    expect(buildQueryOptions({ persona, cwd: '/clone' }).settingSources).toEqual([])
  })

  it('keeps the permission mode that routes every risky call through canUseTool', () => {
    // Any of the SDK's bypass modes would skip the gate entirely.
    expect(buildQueryOptions({ persona, cwd: '/clone' }).permissionMode).toBe('default')
  })

  it('runs in the clone, under the persona, with only the persona\'s tools', () => {
    const options = buildQueryOptions({ persona, cwd: '/clone' })
    expect(options.cwd).toBe('/clone')
    expect(options.agent).toBe('swe')
    expect(options.agents.swe?.tools).toEqual(['Read', 'Bash'])
    expect(options.agents.swe?.model).toBe('claude-sonnet-5')
  })

  it('resumes a session only when one was given', () => {
    expect(buildQueryOptions({ persona, cwd: '/clone' })).not.toHaveProperty('resume')
    expect(buildQueryOptions({ persona, cwd: '/clone', resumeSessionId: 'abc' }).resume).toBe('abc')
  })

  it('honours an operator opt-in to filesystem settings', () => {
    expect(buildQueryOptions({ persona, cwd: '/clone' }, ['project']).settingSources).toEqual([
      'project',
    ])
  })
})

describe('settingSourcesFromEnv', () => {
  it('is empty when unset', () => {
    expect(settingSourcesFromEnv(undefined)).toEqual([])
    expect(settingSourcesFromEnv('')).toEqual([])
  })

  it('parses a comma-separated opt-in', () => {
    expect(settingSourcesFromEnv('user, project')).toEqual(['user', 'project'])
  })

  it('ignores anything it does not recognize rather than guessing', () => {
    expect(settingSourcesFromEnv('project,managed,nonsense')).toEqual(['project'])
  })
})

/**
 * The worker-notes channel as the SDK sees it. Asserted here
 * rather than only in the server's integration tests because the failure mode is
 * silent: a notes server that is registered but whose tools are filtered out of
 * `allowedTools` produces a run that simply never writes a note, with nothing
 * failing anywhere.
 */
describe('buildQueryOptions: the notes channel', () => {
  const fakeServer = { type: 'sdk' as const, name: 'loom_notes', instance: {} as never }

  it('registers the notes server when a run has one', () => {
    const options = buildQueryOptions({ persona, cwd: '/clone', notesTool: fakeServer })
    expect(Object.keys(options.mcpServers ?? {})).toContain('loom_notes')
  })

  it('adds nothing when a run has no notes channel', () => {
    expect(buildQueryOptions({ persona, cwd: '/clone' })).not.toHaveProperty('mcpServers')
  })

  /**
   * The regression this exists for. `allowedTools` is only set when an MCP
   * *capability* narrowed scope — so scoping something unrelated used to silently
   * remove the platform's own in-process tools, since they are not in that list.
   */
  it('keeps the notes tools when an unrelated MCP capability narrows scope', () => {
    const scoped = {
      ...persona,
      capabilities: [
        {
          kind: 'mcp' as const,
          name: 'gitlab',
          transport: 'stdio' as const,
          command: 'gitlab-mcp',
          args: [],
          url: null,
          toolListHash: null,
          allowedTools: ['create_merge_request'],
          egressHosts: [],
        },
      ],
    }
    const options = buildQueryOptions({ persona: scoped, cwd: '/clone', notesTool: fakeServer })
    expect(options.allowedTools).toContain('mcp__loom_notes__write_note')
    expect(options.allowedTools).toContain('mcp__loom_notes__read_notes')
    // And the narrowing it was actually asked for still applies.
    expect(options.allowedTools).toContain('mcp__gitlab__create_merge_request')
  })

  /**
   * The atlas, asserted at the allowlist for the reason the comment on
   * `platformTools` gives: `AgentDefinition.tools` is *exhaustive*, so registering the
   * server and forgetting the name ships a tool the model is never offered — a feature
   * that passes every server-side test while being unreachable, which this repository has
   * now done four times.
   */
  it('offers the atlas tool when the run has that channel, and nothing when it does not', () => {
    const withAtlas = buildQueryOptions({ persona, cwd: '/clone', atlasTool: fakeServer })
    // `agents[name].tools` is the exhaustive list the model is offered — `allowedTools`
    // only appears when an MCP capability narrowed scope, so asserting there would pass
    // vacuously on the ordinary run this is about.
    expect(withAtlas.agents?.[persona.name]?.tools).toContain(
      'mcp__loom_atlas__look_across_projects',
    )
    expect(Object.keys(withAtlas.mcpServers ?? {})).toContain('loom_atlas')

    const without = buildQueryOptions({ persona, cwd: '/clone', notesTool: fakeServer })
    expect(without.agents?.[persona.name]?.tools ?? []).not.toContain(
      'mcp__loom_atlas__look_across_projects',
    )
  })

  /**
   * Continuity mode tier 1, at the same place and for the same reason — and it matters more
   * here than for the atlas: this is the one in-process tool whose *absence* is the
   * security property. A persona with no envelope may not rewrite itself, so the name
   * appearing in an exhaustive tool list it should not be in is the failure worth a test.
   */
  it('offers the self-edit tool only when the run has that channel', () => {
    const withSelf = buildQueryOptions({ persona, cwd: '/clone', selfTool: fakeServer })
    expect(withSelf.agents?.[persona.name]?.tools).toContain(
      'mcp__loom_self__revise_own_prompt',
    )
    // Tier 2 rides the same server; a tier that registered and was never named would be
    // the four-times-shipped failure this whole test exists for.
    expect(withSelf.agents?.[persona.name]?.tools).toContain('mcp__loom_self__revise_own_tools')
    expect(Object.keys(withSelf.mcpServers ?? {})).toContain('loom_self')

    const without = buildQueryOptions({ persona, cwd: '/clone', notesTool: fakeServer })
    expect(without.agents?.[persona.name]?.tools ?? []).not.toContain(
      'mcp__loom_self__revise_own_prompt',
    )
    expect(Object.keys(without.mcpServers ?? {})).not.toContain('loom_self')
  })
})

describe('buildPrompt', () => {
  /**
   * The ledger goes *after* the task, and that ordering is the point. The ledger contains
   * text other models wrote; putting it first would frame the operator's task as something
   * arriving inside a context an attacker already established.
   */
  it('puts the tree ledger after the task, never before it', () => {
    const prompt = buildPrompt({
      persona,
      task: 'Add the endpoint.',
      contextLedger: 'Shared context for this goal',
    })
    expect(prompt.indexOf('Add the endpoint.')).toBeLessThan(
      prompt.indexOf('Shared context for this goal'),
    )
  })

  it('adds nothing for an empty or absent ledger', () => {
    const bare = buildPrompt({ persona, task: 'Add the endpoint.' })
    expect(buildPrompt({ persona, task: 'Add the endpoint.', contextLedger: '   ' })).toBe(bare)
    expect(bare).toBe('You are swe. Add the endpoint.')
  })
})

/**
 * The regression that a live run found and every test had missed.
 *
 * The SDK documents `AgentDefinition.tools` as an *allowlist* — "if omitted, inherits
 * all tools from parent" — so a persona's declared tools exclude everything else,
 * including the platform's own in-process MCP tools. Registering the server is not
 * enough: the model is simply never offered the tool, the run completes normally, and
 * nothing anywhere reports a problem.
 */
describe('buildQueryOptions: the agent tool allowlist', () => {
  const fakeNotes = { type: 'sdk' as const, name: 'loom_notes', instance: {} as never }
  const fakePlanner = {
    server: { type: 'sdk' as const, name: 'loom_plan', instance: {} as never },
    toolName: 'mcp__loom_plan__submit_plan',
  }
  /**
   * A re-planning turn mounts the same server under a different tool name. Asserted because
   * the name travelling with the server is the whole reason the two cannot silently
   * disagree.
   */
  const fakeSteering = {
    server: { type: 'sdk' as const, name: 'loom_plan', instance: {} as never },
    toolName: 'mcp__loom_plan__submit_plan_delta',
  }

  const agentTools = (options: ReturnType<typeof buildQueryOptions>) =>
    (options.agents as Record<string, { tools: string[] }>)[persona.name]?.tools ?? []

  it("offers the notes tools to the model, not just to the SDK's server registry", () => {
    const options = buildQueryOptions({ persona, cwd: '/clone', notesTool: fakeNotes })
    expect(agentTools(options)).toContain('mcp__loom_notes__write_note')
    expect(agentTools(options)).toContain('mcp__loom_notes__read_notes')
    // The persona's own declared tools are still there.
    expect(agentTools(options)).toContain('Read')
  })

  /**
   * The sharper case: a Planner declares `tools: []`, so as an exhaustive allowlist
   * that is *no tools at all* — including the one thing a Planner exists to do. This
   * is what a real Planner run was silently doing before.
   */
  it('offers a tools:[] planner its delegation tool', () => {
    const planner = { ...persona, tools: [] }
    const options = buildQueryOptions({ persona: planner, cwd: '/clone', plannerTool: fakePlanner })
    expect(agentTools(options)).toEqual(['mcp__loom_plan__submit_plan'])
  })

  it('offers a re-planning turn the delta tool and not the plan tool', () => {
    const planner = { ...persona, tools: [] }
    const options = buildQueryOptions({ persona: planner, cwd: '/clone', plannerTool: fakeSteering })
    expect(agentTools(options)).toEqual(['mcp__loom_plan__submit_plan_delta'])
  })

  it('leaves a run with no platform channels exactly as declared', () => {
    expect(agentTools(buildQueryOptions({ persona, cwd: '/clone' }))).toEqual(['Read', 'Bash'])
  })
})

/**
 * The approval mode's effect on the gate.
 *
 * Asserted through `gateBehavior`, which is the decision `canUseTool` makes, because
 * the ordering *is* the security property: every boundary runs before a mode is
 * consulted, so a mode can only ever skip a question, never a rule.
 */
describe('gateBehavior', () => {
  const risky = (name: string) => ['Bash', 'Write', 'Edit', 'NotebookEdit'].includes(name)

  const decide = (mode: 'ask' | 'accept-edits' | 'auto', toolName: string, effect: {
    ok: boolean
    requiresApproval?: boolean
    reason?: string
  }) => gateBehavior({ approvalMode: mode, toolName, isRisky: risky(toolName), effect })

  it('never asks about a tool that is not risky', () => {
    expect(decide('ask', 'Read', { ok: true, requiresApproval: true })).toBe('allow')
  })

  /**
   * The ordering that matters. An out-of-clone write is denied in *every* mode —
   * including `auto`, where the temptation to treat the mode as a blanket permission
   * is strongest. It is a boundary, not a question.
   */
  it('denies a boundary violation in every mode', () => {
    for (const mode of ['ask', 'accept-edits', 'auto'] as const) {
      expect(decide(mode, 'Write', { ok: false, reason: 'outside the workspace' })).toBe('deny')
    }
  })

  it('allows a call the classifier proved harmless, without consulting the mode', () => {
    expect(decide('ask', 'Bash', { ok: true, requiresApproval: false })).toBe('allow')
  })

  it('gates everything risky under ask', () => {
    expect(decide('ask', 'Write', { ok: true, requiresApproval: true })).toBe('gate')
    expect(decide('ask', 'Bash', { ok: true, requiresApproval: true })).toBe('gate')
  })

  it('takes the edits and keeps the shell under accept-edits', () => {
    expect(decide('accept-edits', 'Write', { ok: true, requiresApproval: true })).toBe('allow')
    expect(decide('accept-edits', 'Edit', { ok: true, requiresApproval: true })).toBe('allow')
    expect(decide('accept-edits', 'Bash', { ok: true, requiresApproval: true })).toBe('gate')
  })

  it('asks about nothing under auto', () => {
    expect(decide('auto', 'Bash', { ok: true, requiresApproval: true })).toBe('allow')
  })
})

/**
 * The same guard, for the mapping channel.
 *
 * Written after a live run scored 0/9 on `record_map` while every unit and integration
 * test passed — the third time in this repository that a tool existed everywhere except
 * in the list the model is actually offered. The failure is silent by construction: the
 * run completes, the map is empty, and nothing anywhere reports a problem.
 */
describe('buildQueryOptions: the mapping channel', () => {
  const fakeMap = { type: 'sdk' as const, name: 'loom_map', instance: {} as never }

  it('registers the map server on a mastery run', () => {
    const options = buildQueryOptions({ persona, cwd: '/clone', mapTool: fakeMap })
    expect(Object.keys(options.mcpServers ?? {})).toContain('loom_map')
  })

  it('names record_map in the tool list, which is what makes it reachable', () => {
    const options = buildQueryOptions({ persona, cwd: '/clone', mapTool: fakeMap })
    expect(options.agents[persona.name]?.tools).toContain(RECORD_MAP_TOOL_NAME)
  })

  it('offers it to a read-only persona, whose exhaustive allowlist would otherwise drop it', () => {
    const readOnly = { ...persona, tools: ['Read', 'Grep', 'Glob'] }
    const options = buildQueryOptions({ persona: readOnly, cwd: '/clone', mapTool: fakeMap })
    expect(options.agents[readOnly.name]?.tools).toContain(RECORD_MAP_TOOL_NAME)
  })

  it('offers nothing to an ordinary run — a map is not something any worker may write', () => {
    const options = buildQueryOptions({ persona, cwd: '/clone' })
    expect(options.agents[persona.name]?.tools ?? []).not.toContain(RECORD_MAP_TOOL_NAME)
  })
})

/**
 * The handover channel. Guarded here for the reason `record_map` is: a tool that exists
 * everywhere except the list the model sees is a feature that runs, costs money and does
 * nothing — three times now.
 */
describe('buildQueryOptions: the handover channel', () => {
  it('names hand_over in the tool list, which is what makes it reachable', () => {
    const options = buildQueryOptions({
      persona,
      cwd: '/clone',
      handoffTool: {} as never,
    })
    expect(options.agents[persona.name]?.tools).toContain(HAND_OVER_TOOL_NAME)
  })

  /**
   * Offered to every run, unlike `record_map`. A map is persona-level state every later
   * run reads; a brief is read by one successor in one tree and is fenced when it gets
   * there, and the cost of withholding it is an agent that knows it is running out of
   * room and cannot say what it knows.
   */
  it('is not a mastery-only channel', () => {
    const options = buildQueryOptions({ persona, cwd: '/clone' })
    expect(options.agents[persona.name]?.tools ?? []).not.toContain(HAND_OVER_TOOL_NAME)
  })
})

describe('buildPrompt: a mastery run is told its deliverable is a map', () => {
  it('says the job is to learn and record, not to change anything', () => {
    const prompt = buildPrompt({
      persona,
      mastery: { subjectKind: 'repository', subjectRef: 'booking', revision: 'abc123' },
    })
    expect(prompt).toContain('record_map')
    expect(prompt).toContain('do not edit')
  })

  /**
   * The last leg of the directive. It is declared on the port, rendered at
   * the gateway, carried on the frame and through the sandbox schema — and this is where
   * it either reaches the model or is silently the fourth field this repository has
   * dropped between two places with no type error at either.
   */
  it('puts what it was asked to look for into the opening', () => {
    const prompt = buildPrompt({
      persona,
      mastery: {
        subjectKind: 'author',
        subjectRef: 'ada@example.com',
        revision: 'abc123',
        directive: 'FOCUS-BLOCK',
      },
    })
    expect(prompt).toContain('FOCUS-BLOCK')
    // After the general instruction: it narrows what to spend the run on, and is not
    // the whole of what the run is for.
    expect(prompt.indexOf('FOCUS-BLOCK')).toBeGreaterThan(prompt.indexOf('record_map'))
  })

  it('puts the map before the ledger, and both after the task', () => {
    const prompt = buildPrompt({
      persona,
      task: 'do the thing',
      mapContext: 'MAP-BLOCK',
      contextLedger: 'LEDGER-BLOCK',
    })
    expect(prompt.indexOf('do the thing')).toBeLessThan(prompt.indexOf('MAP-BLOCK'))
    expect(prompt.indexOf('MAP-BLOCK')).toBeLessThan(prompt.indexOf('LEDGER-BLOCK'))
  })
})
