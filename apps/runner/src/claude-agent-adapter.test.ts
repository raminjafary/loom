import { describe, expect, it } from 'vitest'
import { buildPrompt, buildQueryOptions, settingSourcesFromEnv } from './claude-agent-adapter.js'

/**
 * These assert the permission-relevant SDK options by name, the same way
 * sandbox.test.ts asserts the sandbox spec container flags: identity-bound approval say a human
 * decision is the only path to a risky effect, and both of these options are ways
 * that could stop being true without anything failing to compile.
 */

const persona = {
 name: 'swe',
 systemPrompt: 'do the work',
 model: 'claude-sonnet-5',
 tools: ['Read', 'Bash'],
 autoApprove: false,
 budgetCapUsd: null,
}

describe('buildQueryOptions', => {
 it('loads no filesystem settings by default', => {
 // `cwd` is the run's clone: content the agent writes to, and content nobody
 // here necessarily authored. A `.claude/settings.json` in it must not get a
 // say in what the run is permitted to do.
 expect(buildQueryOptions({ persona, cwd: '/clone' }).settingSources).toEqual([])
 })

 it('keeps the permission mode that routes every risky call through canUseTool', => {
 // Any of the SDK's bypass modes would skip the gate entirely.
 expect(buildQueryOptions({ persona, cwd: '/clone' }).permissionMode).toBe('default')
 })

 it('runs in the clone, under the persona, with only the persona\'s tools', => {
 const options = buildQueryOptions({ persona, cwd: '/clone' })
 expect(options.cwd).toBe('/clone')
 expect(options.agent).toBe('swe')
 expect(options.agents.swe?.tools).toEqual(['Read', 'Bash'])
 expect(options.agents.swe?.model).toBe('claude-sonnet-5')
 })

 it('resumes a session only when one was given', => {
 expect(buildQueryOptions({ persona, cwd: '/clone' })).not.toHaveProperty('resume')
 expect(buildQueryOptions({ persona, cwd: '/clone', resumeSessionId: 'abc' }).resume).toBe('abc')
 })

 it('honours an operator opt-in to filesystem settings', => {
 expect(buildQueryOptions({ persona, cwd: '/clone' }, ['project']).settingSources).toEqual([
 'project',
 ])
 })
})

describe('settingSourcesFromEnv', => {
 it('is empty when unset', => {
 expect(settingSourcesFromEnv(undefined)).toEqual([])
 expect(settingSourcesFromEnv('')).toEqual([])
 })

 it('parses a comma-separated opt-in', => {
 expect(settingSourcesFromEnv('user, project')).toEqual(['user', 'project'])
 })

 it('ignores anything it does not recognize rather than guessing', => {
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
describe('buildQueryOptions: the notes channel', => {
 const fakeServer = { type: 'sdk' as const, name: 'loom_notes', instance: {} as never }

 it('registers the notes server when a run has one', => {
 const options = buildQueryOptions({ persona, cwd: '/clone', notesTool: fakeServer })
 expect(Object.keys(options.mcpServers ?? {})).toContain('loom_notes')
 })

 it('adds nothing when a run has no notes channel', => {
 expect(buildQueryOptions({ persona, cwd: '/clone' })).not.toHaveProperty('mcpServers')
 })

 /**
 * The regression this exists for. `allowedTools` is only set when an MCP
 * *capability* narrowed scope — so scoping something unrelated used to silently
 * remove the platform's own in-process tools, since they are not in that list.
 */
 it('keeps the notes tools when an unrelated MCP capability narrows scope', => {
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
 },
 ],
 }
 const options = buildQueryOptions({ persona: scoped, cwd: '/clone', notesTool: fakeServer })
 expect(options.allowedTools).toContain('mcp__loom_notes__write_note')
 expect(options.allowedTools).toContain('mcp__loom_notes__read_notes')
 // And the narrowing it was actually asked for still applies.
 expect(options.allowedTools).toContain('mcp__gitlab__create_merge_request')
 })
})

describe('buildPrompt', => {
 /**
 * The ledger goes *after* the task, and that ordering is the point. The ledger contains text other models wrote; putting it first would
 * frame the operator's task as something arriving inside a context an attacker
 * already established.
 */
 it('puts the tree ledger after the task, never before it', => {
 const prompt = buildPrompt({
 persona,
 task: 'Add the endpoint.',
 contextLedger: 'Shared context for this goal',
 })
 expect(prompt.indexOf('Add the endpoint.')).toBeLessThan(
 prompt.indexOf('Shared context for this goal'),
)
 })

 it('adds nothing for an empty or absent ledger', => {
 const bare = buildPrompt({ persona, task: 'Add the endpoint.' })
 expect(buildPrompt({ persona, task: 'Add the endpoint.', contextLedger: ' ' })).toBe(bare)
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
describe('buildQueryOptions: the agent tool allowlist', => {
 const fakeNotes = { type: 'sdk' as const, name: 'loom_notes', instance: {} as never }
 const fakePlanner = { type: 'sdk' as const, name: 'loom_plan', instance: {} as never }

 const agentTools = (options: ReturnType<typeof buildQueryOptions>) =>
 (options.agents as Record<string, { tools: string[] }>)[persona.name]?.tools ?? []

 it("offers the notes tools to the model, not just to the SDK's server registry", => {
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
 it('offers a tools:[] planner its delegation tool', => {
 const planner = {...persona, tools: [] }
 const options = buildQueryOptions({ persona: planner, cwd: '/clone', plannerTool: fakePlanner })
 expect(agentTools(options)).toEqual(['mcp__loom_plan__submit_plan'])
 })

 it('leaves a run with no platform channels exactly as declared', => {
 expect(agentTools(buildQueryOptions({ persona, cwd: '/clone' }))).toEqual(['Read', 'Bash'])
 })
})
