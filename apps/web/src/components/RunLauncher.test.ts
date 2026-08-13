import type { AgentPersona, PersonaGroup, Repository } from '@loom/api-contract'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RunLauncher from './RunLauncher.vue'

/**
 * The launcher is the *reader* of the team repository, which is what keeps that
 * setting from being a decoration — the rule for the design canvas is that it may only
 * draw what the runtime executes.
 *
 * These tests exist because of last session's lesson 1: a policy field with no caller
 * is green in every test and absent from the product. What is asserted here is the caller.
 */

const persona = (id: string, overrides: Partial<AgentPersona> = {}): AgentPersona =>
 ({
 id,
 workspaceId: 'w1',
 name: id,
 description: 'Writes code',
 markdownSource: '---\nname: swe\n---\n',
 model: 'claude-haiku-4-5-20251001',
 tools: ['Read'],
 harnessEffort: null,
 harnessMaxTurns: null,
 harnessApprovalMode: 'ask' as const,
 harnessPlanner: false,
 harnessDelegates: [],
 harnessBudgetCapUsd: null,
 builtinStatus: null,
 createdAt: new Date(0),
 updatedAt: new Date(0),
...overrides,
 }) as AgentPersona

const repository = (id: string, displayName: string) =>
 ({
 id,
 workspaceId: 'w1',
 runnerId: 'runner-1',
 displayName,
 absolutePath: `/src/${displayName}`,
 defaultBranch: 'main',
 verifyCommand: null,
 installCommand: null,
 createdAt: new Date(0),
 }) as unknown as Repository

const group = (overrides: Partial<PersonaGroup> = {}): PersonaGroup =>
 ({
 id: 'g1',
 workspaceId: 'w1',
 name: 'Team A',
 personaIds: ['swe'],
 layout: {},
 fleet: {},
 reviewers: {},
 orchestratorId: null,
 repositoryId: null,
 createdAt: new Date(0),
 updatedAt: new Date(0),
...overrides,
 }) as PersonaGroup

const launcher = (options: { groups?: PersonaGroup[] } = {}) =>
 mount(RunLauncher, {
 props: {
 repositories: [repository('r1', 'loom'), repository('r2', 'atlas')],
 personas: [persona('swe'), persona('qa')],
 groups: options.groups ?? [],
 disabled: false,
 },
 })

describe('RunLauncher', => {
 describe("the team's repository", => {
 it('fills the repository in when the chosen agent’s team has one', async => {
 const wrapper = launcher({ groups: [group({ repositoryId: 'r2' })] })
 await wrapper.get('select[aria-label="Agent"]').setValue('swe')
 expect((wrapper.get('select[aria-label="Repository"]').element as HTMLSelectElement).value).toBe(
 'r2',
)
 })

 /** Said rather than silently done — a field that fills itself in stops being read. */
 it('says whose choice it was', async => {
 const wrapper = launcher({ groups: [group({ repositoryId: 'r2' })] })
 await wrapper.get('select[aria-label="Agent"]').setValue('swe')
 expect(wrapper.text).toContain('atlas is where swe’s team lands its work')
 })

 it('leaves the field alone for an agent on no team', async => {
 const wrapper = launcher({ groups: [group({ repositoryId: 'r2' })] })
 await wrapper.get('select[aria-label="Agent"]').setValue('qa')
 expect((wrapper.get('select[aria-label="Repository"]').element as HTMLSelectElement).value).toBe(
 '',
)
 })

 /**
 * Teams that disagree default to nothing: a pre-filled field a human did not choose
 * and cannot see the reasoning for is worse than an empty one.
 */
 it('fills in nothing when the agent’s teams land in different places', async => {
 const wrapper = launcher({
 groups: [
 group({ repositoryId: 'r1' }),
 group({ id: 'g2', name: 'Team B', repositoryId: 'r2' }),
 ],
 })
 await wrapper.get('select[aria-label="Agent"]').setValue('swe')
 expect((wrapper.get('select[aria-label="Repository"]').element as HTMLSelectElement).value).toBe(
 '',
)
 })

 /** A default, not a constraint — and the start carries what the human sees. */
 it('starts on the repository a human picked over the team’s', async => {
 const wrapper = launcher({ groups: [group({ repositoryId: 'r2' })] })
 await wrapper.get('select[aria-label="Agent"]').setValue('swe')
 await wrapper.get('select[aria-label="Repository"]').setValue('r1')
 await wrapper.get('textarea[aria-label="Task"]').setValue('Fix the thing')
 await wrapper.get('form').trigger('submit')
 expect(wrapper.emitted('start')?.[0]?.[0]).toMatchObject({
 repositoryId: 'r1',
 personaId: 'swe',
 })
 })
 })
})
