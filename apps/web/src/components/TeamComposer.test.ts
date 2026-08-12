import type { AgentPersona, DelegationEdge, PersonaGroup } from '@loom/api-contract'
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
 harnessAutoApprove: false,
 harnessPlanner: false,
 harnessDelegates: [],
 harnessBudgetCapUsd: null,
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
 layout: {},
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

const composer = (options: {
 personas?: AgentPersona[]
 groups?: PersonaGroup[]
 matrix?: DelegationEdge[]
} = {}) =>
 mount(TeamComposer, {
 props: {
 personas: options.personas ?? [lead, persona],
 groups: options.groups ?? [group],
 matrix: options.matrix ?? [],
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
})
