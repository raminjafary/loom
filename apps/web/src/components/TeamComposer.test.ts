import type {
 AgentPersona,
 DelegationEdge,
 PersonaGroup,
 Repository,
} from '@loom/api-contract'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TeamComposer from './TeamComposer.vue'

/**
 * The composition canvas.
 *
 * Vue Flow itself is stubbed. What is worth asserting is not that a graph library
 * renders — it does — but the two rules the roadmap gives this surface: that it cannot draw an
 * edge the runtime would refuse, and that a refusal is shown in full rather than
 * discovered one runtime error at a time.
 */

const persona = (overrides: Partial<AgentPersona> = {}): AgentPersona => ({
 id: 'swe',
 workspaceId: 'w1',
 name: 'swe',
 description: 'Writes code',
 markdownSource:
 '---\nname: swe\ndescription: Writes code\nmodel: claude-haiku-4-5-20251001\ntools: [Read]\n---\n\nBody.',
 model: 'claude-haiku-4-5-20251001',
 tools: ['Read'],
 harnessEffort: null,
 harnessMaxTurns: null,
 harnessApprovalMode: 'ask' as const,
 harnessPlanner: false,
 harnessDelegates: [],
 harnessBudgetCapUsd: null,
 envelope: null,
 builtinStatus: null,
 createdAt: new Date(0),
 updatedAt: new Date(0),
...overrides,
})

const lead = persona({
 id: 'lead',
 name: 'lead',
 model: 'claude-sonnet-5',
 tools: ['Read', 'Grep', 'Glob'],
 harnessPlanner: true,
 harnessDelegates: ['Read'],
 markdownSource: [
 '---',
 'name: lead',
 'description: Decomposes',
 'model: claude-sonnet-5',
 'tools: [Read, Grep, Glob]',
 'harness:',
 ' planner: true',
 ' delegates: [Read]',
 '---',
 '',
 'You decompose.',
 ].join('\n'),
})

const group = (overrides: Partial<PersonaGroup> = {}): PersonaGroup => ({
 id: 'g1',
 workspaceId: 'w1',
 name: 'Team A',
 personaIds: ['lead', 'swe'],
 fleet: {},
 reviewers: {},
 layout: {},
 orchestratorId: null,
 repositoryId: null,
 createdAt: new Date(0),
 updatedAt: new Date(0),
...overrides,
})

/** Vue Flow is a canvas; these tests are about what the canvas is told and what it emits. */
const VueFlowStub = {
 name: 'VueFlow',
 props: ['nodes', 'edges'],
 emits: ['connect', 'nodeDragStop', 'edgeClick'],
 template: '<div class="flow-stub" />',
}

const repository = (
 id: string,
 displayName: string,
 overrides: {
 verifyCommand?: string | null
 installCommand?: string | null
 reconcilerEnabled?: boolean
 } = {},
) =>
 ({
 id,
 workspaceId: 'w1',
 runnerId: 'runner-1',
 displayName,
 absolutePath: `/src/${displayName}`,
 defaultBranch: 'main',
 verifyCommand: overrides.verifyCommand ?? null,
 installCommand: overrides.installCommand ?? null,
 reconcilerEnabled: overrides.reconcilerEnabled ?? true,
 createdAt: new Date(0),
 }) as unknown as Repository

const composer = (options: {
 personas?: AgentPersona[]
 groups?: PersonaGroup[]
 repositories?: Repository[]
 matrix?: DelegationEdge[]
 maxDelegationDepth?: number
 expertise?: {
 personaId: string
 subjectRef: string
 subjectKind: string
 retrievalState: 'trial' | 'on' | 'off'
 }[]
} = {}) =>
 mount(TeamComposer, {
 props: {
 personas: options.personas ?? [lead, persona],
 groups: options.groups ?? [group],
 repositories: options.repositories ?? [repository('r1', 'loom'), repository('r2', 'atlas')],
 matrix: options.matrix ?? [],
 maxDelegationDepth: options.maxDelegationDepth ?? 2,
 expertise: options.expertise ?? [],
 },
 global: { stubs: { VueFlow: VueFlowStub } },
 })

const flow = (wrapper: ReturnType<typeof composer>) => wrapper.findComponent(VueFlowStub)

describe('TeamComposer', => {
 /**
 * Designing a team is what a human does before there is a swarm, so the canvas
 * opens on the act of creating one rather than on an instruction to go elsewhere
 * first.
 */
 it('offers to create the first team on the canvas itself', async => {
 const wrapper = composer({ groups: [] })
 expect(wrapper.find('.flow-stub').exists).toBe(false)

 await wrapper.get('.new-team input').setValue('Frontend squad')
 await wrapper.get('.new-team').trigger('submit')

 expect(wrapper.emitted('create-group')?.[0]?.[0]).toEqual({
 name: 'Frontend squad',
 personaIds: [],
 })
 })

 it('selects a team that appears while it is open, rather than staying empty', async => {
 const wrapper = composer({ groups: [] })
 await wrapper.setProps({ groups: [group] })
 expect(wrapper.find('.flow-stub').exists).toBe(true)
 })

 /**
 * Found in the browser: the team was stored and the canvas went on showing the
 * previous one, so creating a team looked like nothing happening. The reselect rule
 * could not catch it — the previous selection was still there.
 */
 it('switches to the team it just created, not the one already selected', async => {
 const existing = group({ id: 'g1', name: 'Team A' })
 const wrapper = composer({ groups: [existing] })

 await wrapper.findAll('.link').find((b) => b.text === '+ New team')?.trigger('click')
 await wrapper.get('.new-team input').setValue('Frontend squad')
 await wrapper.get('.new-team').trigger('submit')

 const created = group({ id: 'g2', name: 'Frontend squad', personaIds: ['lead'] })
 await wrapper.setProps({ groups: [existing, created] })
 await wrapper.vm.$nextTick

 expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('g2')
 })

 it('tells a human what to do with an empty team instead of showing a void', => {
 const wrapper = composer({ groups: [group({ personaIds: [] })] })
 expect(wrapper.find('.flow-stub').exists).toBe(false)
 expect(wrapper.get('.canvas-empty').text).toContain('nobody on it yet')
 })

 it('puts every member on the canvas, and marks the planner', => {
 const nodes = flow(composer).props('nodes') as { id: string; class: string }[]
 expect(nodes.map((node) => node.id).sort).toEqual(['lead', 'swe'])
 expect(nodes.find((node) => node.id === 'lead')?.class).toContain('planner')
 })

 /**
 * The first caution, kept literally: every edge is the matrix's answer. With no
 * matrix row there is no line, however the personas are arranged.
 */
 it('draws no edge the matrix does not report', => {
 expect(flow(composer).props('edges')).toEqual([])
 })

 it('draws a refused edge as refused, with its reason on the line', => {
 const edges = flow(
 composer({
 matrix: [
 {
 plannerId: 'lead',
 workerId: 'swe',
 ok: false,
 refusals: [{ rule: 'tools', detail: 'holds Bash', fix: 'widen the envelope' }],
 },
 ],
 }),
).props('edges') as { label: string; class: string }[]
 expect(edges[0]?.class).toContain('refused')
 expect(edges[0]?.label).toBe('tools')
 })

 describe('connecting two nodes', => {
 const refusedOnTools: DelegationEdge = {
 plannerId: 'lead',
 workerId: 'swe',
 ok: false,
 refusals: [
 { rule: 'tools', detail: 'swe holds Bash', fix: 'widen', widenEnvelopeWith: ['Bash'] },
 ],
 }

 it('does not add an edge — it asks for one', async => {
 const wrapper = composer({ matrix: [refusedOnTools] })
 const before = flow(wrapper).props('edges')
 await flow(wrapper).vm.$emit('connect', { source: 'lead', target: 'swe' })
 expect(flow(wrapper).props('edges')).toEqual(before)
 })

 it('offers the envelope widening, and writes it through persona.update', async => {
 const wrapper = composer({ matrix: [refusedOnTools] })
 await flow(wrapper).vm.$emit('connect', { source: 'lead', target: 'swe' })

 expect(wrapper.get('.pending').text).toContain('Bash')
 await wrapper.get('.pending button').trigger('click')

 const emitted = wrapper.emitted('update-persona')
 expect(emitted).toHaveLength(1)
 const input = emitted?.[0]?.[0] as { personaId: string; markdownSource: string }
 expect(input.personaId).toBe('lead')
 expect(input.markdownSource).toContain('delegates: [Read, Bash]')
 })

 /**
 * The rule that keeps a gesture from rewriting a persona other teams share.
 */
 it('refuses, and edits nothing, when a refusal is about what the worker is', async => {
 const wrapper = composer({
 matrix: [
 {
 plannerId: 'lead',
 workerId: 'swe',
 ok: false,
 refusals: [{ rule: 'model', detail: 'higher tier', fix: 'move it down' }],
 },
 ],
 })
 await flow(wrapper).vm.$emit('connect', { source: 'lead', target: 'swe' })

 expect(wrapper.get('.pending').text).toContain('higher tier')
 expect(wrapper.emitted('update-persona')).toBeUndefined
 // And there is no control that could apply one — the only button is Dismiss.
 const buttons = wrapper.get('.pending').findAll('button')
 expect(buttons).toHaveLength(1)
 expect(buttons[0]?.text).toBe('Dismiss')
 })

 it('says a non-planner cannot delegate, rather than silently doing nothing', async => {
 const wrapper = composer
 await flow(wrapper).vm.$emit('connect', { source: 'swe', target: 'lead' })
 expect(wrapper.get('.pending').text).toContain('not a planner')
 expect(wrapper.emitted('update-persona')).toBeUndefined
 })
 })

 describe('the layout', => {
 it('persists a position when a node is dropped, not while it moves', async => {
 const wrapper = composer
 await flow(wrapper).vm.$emit('nodeDragStop', {
 node: { id: 'swe', position: { x: 42, y: 7 } },
 })
 const saved = wrapper.emitted('save-group')?.[0]?.[0] as {
 layout: Record<string, { x: number; y: number }>
 }
 expect(saved.layout.swe).toEqual({ x: 42, y: 7 })
 })

 it('sends the layout along when the roster changes, so one edit cannot lose the other', async => {
 const wrapper = composer
 await wrapper.findAll('.chips button').at(0)?.trigger('click')
 const saved = wrapper.emitted('save-group')?.[0]?.[0] as {
 personaIds: string[]
 layout: Record<string, { x: number; y: number }>
 }
 expect(saved.personaIds).not.toContain('lead')
 expect(Object.keys(saved.layout)).toContain('swe')
 })
 })

 it('shows every refusal at once when an edge is inspected', async => {
 const wrapper = composer({
 matrix: [
 {
 plannerId: 'lead',
 workerId: 'swe',
 ok: false,
 refusals: [
 { rule: 'tools', detail: 'holds Bash', fix: 'widen the envelope' },
 { rule: 'budget', detail: 'uncapped', fix: 'give it a cap' },
 { rule: 'model', detail: 'higher tier', fix: 'move it down' },
 ],
 },
 ],
 })
 await flow(wrapper).vm.$emit('edgeClick', { edge: { id: 'lead->swe' } })

 const inspector = wrapper.get('.inspector')
 expect(inspector.findAll('.refusals li')).toHaveLength(3)
 expect(inspector.text).toContain('give it a cap')
 })

 /**
 * Selecting an edge (the operator's report: "I selected one edge and it referenced
 * every worker losing something").
 *
 * Two halves, and they fail separately: the canvas has to show *which* line is being
 * discussed, and the sidebar has to name that line rather than describing the class of
 * thing it belongs to.
 */
 /**
 * The operator's report was "remove edge not working", and everything worked — the
 * inspector and its proposal rendered several screens below the fold, under the roster
 * and the whole Add list. Order is the fix, so order is what is asserted.
 */
 it('puts the edge a human just selected above the standing configuration', async => {
 const wrapper = composer({
 matrix: [{ plannerId: 'lead', workerId: 'swe', ok: true, refusals: [] } as DelegationEdge],
 })
 await flow(wrapper).vm.$emit('edgeClick', { edge: { id: 'lead->swe' } })

 const side = wrapper.get('.side').element
 const inspector = wrapper.get('.inspector').element
 const roster = wrapper.findAll('.side section').find((s) => s.text.includes('On this team'))
 expect(roster).toBeDefined
 const order = [...side.querySelectorAll('section')]
 expect(order.indexOf(inspector as HTMLElement)).toBeLessThan(
 order.indexOf(roster!.element as HTMLElement),
)
 })

 describe('selecting an edge', => {
 const qa = persona({ id: 'qa', name: 'qa', tools: ['Read'] })
 const teamOfThree = group({ personaIds: ['lead', 'swe', 'qa'] })
 const allowed: DelegationEdge[] = [
 { plannerId: 'lead', workerId: 'swe', ok: true, refusals: [] },
 { plannerId: 'lead', workerId: 'qa', ok: true, refusals: [] },
 ]

 const selected = async => {
 const wrapper = composer({
 personas: [lead, persona, qa],
 groups: [teamOfThree],
 matrix: allowed,
 })
 await flow(wrapper).vm.$emit('edgeClick', { edge: { id: 'lead->swe' } })
 return wrapper
 }

 it('marks the chosen line and fades the rest, so "this edge" has a referent', async => {
 const wrapper = await selected
 const drawn = flow(wrapper).props('edges') as {
 id: string
 class: string
 label: string
 style: Record<string, unknown>
 }[]

 const chosen = drawn.find((edge) => edge.id === 'lead->swe')!
 const other = drawn.find((edge) => edge.id === 'lead->qa')!
 expect(chosen.class).toContain('chosen')
 expect(chosen.style.strokeWidth).toBe(4)
 expect(chosen.label).toBe('lead → swe')
 expect(other.class).toContain('muted')
 expect(other.style.opacity).toBe(0.25)
 })

 it('outlines both ends of it on the canvas', async => {
 const wrapper = await selected
 const drawn = flow(wrapper).props('nodes') as { id: string; class: string }[]
 expect(drawn.find((node) => node.id === 'lead')!.class).toContain('endpoint')
 expect(drawn.find((node) => node.id === 'swe')!.class).toContain('endpoint')
 expect(drawn.find((node) => node.id === 'qa')!.class).not.toContain('endpoint')
 })

 it('names the pair in the removal notice and offers the other narrowings', async => {
 const wrapper = await selected
 await wrapper.get('.inspector.link.danger').trigger('click')

 const notice = wrapper.get('.pending')
 expect(notice.text).toContain('Remove lead → swe')
 expect(notice.text).toContain('It also stops lead delegating to qa')
 // lead's envelope is [Read] and qa needs Read too, so this is the honest
 // "there is no free narrowing" case rather than an ordinary trade.
 expect(notice.text).toContain('no narrowing that costs nothing')
 // One tool in the envelope, so there is no alternative to offer — the list
 // appears only when a choice actually exists.
 expect(notice.findAll('.options li')).toHaveLength(0)
 })
 })

 /**
 * The chain of command, on the canvas (the operator's report: adding a second
 * planner turned a five-member team into a tangle in which nothing said which planner
 * was the root).
 */
 describe('the chain of command', => {
 const second = persona({
 id: 'second',
 name: 'second',
 model: 'claude-sonnet-5',
 tools: ['Read', 'Grep', 'Glob'],
 harnessPlanner: true,
 harnessDelegates: ['Read'],
 })
 const personas = [lead, second, persona]
 const teamOfThree = group({ personaIds: ['lead', 'second', 'swe'], orchestratorId: 'lead' })
 const mutual: DelegationEdge[] = [
 { plannerId: 'lead', workerId: 'second', ok: true, refusals: [] },
 { plannerId: 'second', workerId: 'lead', ok: true, refusals: [] },
 { plannerId: 'lead', workerId: 'swe', ok: true, refusals: [] },
 { plannerId: 'second', workerId: 'swe', ok: true, refusals: [] },
 ]

 const canvas = => composer({ personas, groups: [teamOfThree], matrix: mutual })

 it('marks the root and lays the tiers out top-down', => {
 const wrapper = canvas
 const nodes = flow(wrapper).props('nodes') as {
 id: string
 class: string
 label: string
 position: { x: number; y: number }
 }[]

 const root = nodes.find((node) => node.id === 'lead')!
 expect(root.class).toContain('seat-orchestrator')
 expect(root.label).toContain('★ root')
 expect(nodes.find((node) => node.id === 'second')!.position.y).toBeGreaterThan(
 root.position.y,
)
 })

 /**
 * The claim the canvas was making falsely: `second → lead` is a legal pair and there
 * is nowhere on this team it can be used from, because a planner one hop down has no
 * hop left beneath it.
 */
 it('draws an edge this arrangement cannot use as its own state, not as refused', => {
 const drawn = flow(canvas).props('edges') as { id: string; class: string; label: string }[]
 const sideways = drawn.find((edge) => edge.id === 'second->lead')!

 expect(sideways.class).toContain('out-of-depth')
 expect(sideways.class).not.toContain('refused')
 expect(sideways.label).toBe('too deep here')
 expect(drawn.find((edge) => edge.id === 'lead->second')!.class).toContain('ok')
 })

 it('says why, on the edge, rather than leaving it to a refused subtask', async => {
 const wrapper = canvas
 await flow(wrapper).vm.$emit('edgeClick', { edge: { id: 'second->lead' } })
 expect(wrapper.get('.inspector').text).toContain('nothing below it could run')
 })

 it('saves the root a human picks, along with everything else the team holds', async => {
 const wrapper = canvas
 await wrapper.get('.root-picker').setValue('second')

 const saved = wrapper.emitted('save-group')?.at(-1)?.[0] as { orchestratorId: string | null }
 expect(saved.orchestratorId).toBe('second')
 })

 it('rearranges to the hierarchy on request, replacing what was dragged', async => {
 const dragged = group({
 personaIds: ['lead', 'second', 'swe'],
 orchestratorId: 'lead',
 layout: { swe: { x: 900, y: -900 } },
 })
 const wrapper = composer({ personas, groups: [dragged], matrix: mutual })

 // Honoured until asked otherwise: position is a fact a human recorded.
 const before = flow(wrapper).props('nodes') as { id: string; position: { y: number } }[]
 expect(before.find((node) => node.id === 'swe')!.position.y).toBe(-900)

 await wrapper.findAll('.link').find((button) => button.text === 'Arrange')?.trigger('click')

 const after = flow(wrapper).props('nodes') as { id: string; position: { y: number } }[]
 expect(after.find((node) => node.id === 'swe')!.position.y).toBeGreaterThan(0)
 const saved = wrapper.emitted('save-group')?.at(-1)?.[0] as {
 layout: Record<string, { x: number; y: number }>
 }
 expect(saved.layout.swe?.y).toBeGreaterThan(0)
 })

 it('names a member no chain from the root reaches', => {
 const stranded = group({ personaIds: ['lead', 'second', 'swe'], orchestratorId: 'second' })
 const noReach: DelegationEdge[] = [
 { plannerId: 'second', workerId: 'swe', ok: true, refusals: [] },
 ]
 const wrapper = composer({ personas, groups: [stranded], matrix: noReach })
 expect(wrapper.get('.chain').text).toContain('lead')
 expect(wrapper.get('.chain').text).toContain('nothing the root plans can start them')
 })
 })

 /**
 * Portable expertise, and the operator's case: two agents in one role, one of which learned a
 * particular subsystem. The answer is two *personas* — expertise attaches to an
 * identity, never to a slot on a team — and the canvas has to make that visible and
 * cheap, or the two are indistinguishable names.
 */
 /**
 * The design-canvas policy: which repository this team's work lands in. The item
 * the other two on that canvas were blocked on, because verification and reconciliation
 * are fields on a repository.
 */
 describe('where the work lands', => {
 it('says nothing is chosen rather than showing an empty picker', => {
 const wrapper = composer
 expect(wrapper.get('.lands').text).toContain('No repository chosen')
 })

 it('names the repository and the branch a run would start on', => {
 const wrapper = composer({ groups: [group({ repositoryId: 'r1' })] })
 const text = wrapper.get('.lands').text
 expect(text).toContain('loom')
 expect(text).toContain('main')
 })

 it('saves the choice along with everything else the team holds', async => {
 const wrapper = composer({ groups: [group({ orchestratorId: 'lead' })] })
 await wrapper.get('.repo-picker').setValue('r2')
 const saved = wrapper.emitted('save-group')?.[0]?.[0] as {
 repositoryId: string | null
 orchestratorId: string | null
 personaIds: string[]
 }
 expect(saved.repositoryId).toBe('r2')
 // The single save path is what makes this hold: one control must not clear another.
 expect(saved.orchestratorId).toBe('lead')
 expect(saved.personaIds).toEqual(['lead', 'swe'])
 })

 it('un-chooses with null rather than with an empty string the server would look up', async => {
 const wrapper = composer({ groups: [group({ repositoryId: 'r1' })] })
 await wrapper.get('.repo-picker').setValue('')
 const saved = wrapper.emitted('save-group')?.[0]?.[0] as { repositoryId: string | null }
 expect(saved.repositoryId).toBeNull
 })

 /**
 * The launcher defaults from a *persona's* teams, so a member on two teams that land
 * in different places gets no default at all. Correct, and invisible unless said.
 */
 it('names members whose other team lands somewhere else', => {
 const wrapper = composer({
 groups: [
 group({ repositoryId: 'r1' }),
 group({ id: 'g2', name: 'Team B', personaIds: ['swe'], repositoryId: 'r2' }),
 ],
 })
 expect(wrapper.get('.lands.shared').text).toContain('swe')
 })

 it('says nothing about members whose other team agrees', => {
 const wrapper = composer({
 groups: [
 group({ repositoryId: 'r1' }),
 group({ id: 'g2', name: 'Team B', personaIds: ['swe'], repositoryId: 'r1' }),
 ],
 })
 expect(wrapper.find('.lands.shared').exists).toBe(false)
 })
 })

 /**
 * The second policy item, which cost nothing once the first existed: the merge
 * queue already reads `verifyCommand`, so this is a second surface onto one field
 * rather than a second store for it.
 */
 describe('the verify command as team policy', => {
 it('says branches land unverified when no command is set', => {
 const wrapper = composer({ groups: [group({ repositoryId: 'r1' })] })
 expect(wrapper.get('.lands').text).toContain('unverified')
 })

 it('says what the queue runs before a merge, and what happens when it fails', => {
 const wrapper = composer({
 groups: [group({ repositoryId: 'r1' })],
 repositories: [repository('r1', 'loom', { verifyCommand: 'pnpm -r test' })],
 })
 const text = wrapper.get('.lands').text
 expect(text).toContain('pnpm -r test')
 expect(text).toContain('hands the branch back')
 })

 it('sets it through the same procedure Settings uses', async => {
 const wrapper = composer({ groups: [group({ repositoryId: 'r1' })] })
 await wrapper.get('.lands button.link').trigger('click')
 await wrapper.get('.verify-form input').setValue('pnpm -r test')
 await wrapper.get('.verify-form').trigger('submit')
 expect(wrapper.emitted('set-verify-command')?.[0]).toEqual(['r1', 'pnpm -r test'])
 })

 /** Empty clears it — a repository with no command merges unverified and says so. */
 it('clears it with null rather than an empty command the queue would try to run', async => {
 const wrapper = composer({
 groups: [group({ repositoryId: 'r1' })],
 repositories: [repository('r1', 'loom', { verifyCommand: 'pnpm -r test' })],
 })
 await wrapper.get('.lands button.link').trigger('click')
 await wrapper.get('.verify-form input').setValue(' ')
 await wrapper.get('.verify-form').trigger('submit')
 expect(wrapper.emitted('set-verify-command')?.[0]).toEqual(['r1', null])
 })

 /**
 * Verification runs with the network closed, so a verify command without an
 * install command is the configuration that looks right and merges unverified anyway.
 */
 it('warns when there is a command to run and no warmed cache to run it against', => {
 const withInstall = composer({
 groups: [group({ repositoryId: 'r1' })],
 repositories: [
 repository('r1', 'loom', { verifyCommand: 'pnpm -r test', installCommand: 'pnpm i' }),
 ],
 })
 expect(withInstall.get('.lands').text).not.toContain('network closed')

 const without = composer({
 groups: [group({ repositoryId: 'r1' })],
 repositories: [repository('r1', 'loom', { verifyCommand: 'pnpm -r test' })],
 })
 expect(without.get('.lands').text).toContain('network closed')
 })
 })

 /**
 * The third policy item, and the one that needed the runtime moved before it
 * could be drawn: it was `LOOM_RECONCILER_ENABLED`, an operator-wide env var, and a
 * canvas may not draw what the runtime does not read.
 */
 describe('reconciliation as team policy', => {
 it('says what happens to a conflict, both ways', => {
 const on = composer({ groups: [group({ repositoryId: 'r1' })] })
 expect(on.get('.lands').text).toContain('an agent attempts it')

 const off = composer({
 groups: [group({ repositoryId: 'r1' })],
 repositories: [repository('r1', 'loom', { reconcilerEnabled: false })],
 })
 expect(off.get('.lands').text).toContain('waits for a human')
 })

 it('turns it off for this repository, through the field the runtime reads', async => {
 const wrapper = composer({ groups: [group({ repositoryId: 'r1' })] })
 await wrapper.get('.reconciler input').setValue(false)
 expect(wrapper.emitted('set-reconciler-enabled')?.[0]).toEqual(['r1', false])
 })

 /** Nothing to show and nothing to set when the team has not said where it lands. */
 it('offers no policy at all until a repository is chosen', => {
 const wrapper = composer
 expect(wrapper.find('.reconciler').exists).toBe(false)
 expect(wrapper.find('.verify-form').exists).toBe(false)
 })
 })

 describe('expertise on the roster', => {
 const expertise = [
 {
 personaId: 'swe',
 subjectRef: 'payments',
 subjectKind: 'repository',
 retrievalState: 'on' as const,
 },
 {
 personaId: 'swe',
 subjectRef: 'billing-docs',
 subjectKind: 'corpus',
 retrievalState: 'off' as const,
 },
 ]

 it('names each subject under the member, with what is being done with it', => {
 const wrapper = composer({ expertise })
 const rows = wrapper.findAll('.chips li.knows')

 expect(rows).toHaveLength(2)
 expect(rows[0]?.text).toContain('payments')
 expect(rows[0]?.text).toContain('in use')
 // A withheld map is said to be withheld rather than shown as ordinary expertise.
 expect(rows[1]?.text).toContain('withheld')
 })

 it('marks the node, counting only what is actually being handed to runs', => {
 const nodes = flow(composer({ expertise })).props('nodes') as {
 id: string
 label: string
 }[]
 expect(nodes.find((node) => node.id === 'swe')?.label).toContain('◆1')
 expect(nodes.find((node) => node.id === 'lead')?.label).not.toContain('◆')
 })

 it('derives a second agent from a member, keeping its tools and taking a new model', async => {
 const wrapper = composer
 await wrapper.get('.new-planner select').setValue('swe')
 await wrapper.get('.new-planner input[type="text"]').setValue('swe-payments')
 await wrapper.findAll('.new-planner input')[1]?.setValue('claude-sonnet-5')
 await wrapper.get('.new-planner').trigger('submit')

 const emitted = wrapper.emitted('create-persona')?.[0]?.[0] as { markdownSource: string }
 expect(emitted.markdownSource).toContain('name: swe-payments')
 expect(emitted.markdownSource).toContain('model: claude-sonnet-5')
 // The copy is the point: it inherits what this team was designed against.
 expect(emitted.markdownSource).toContain('tools: [Read]')
 })
 })
})
