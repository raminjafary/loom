import { describe, expect, it } from 'vitest'
import { buildQueryOptions, settingSourcesFromEnv } from './claude-agent-adapter.js'

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
