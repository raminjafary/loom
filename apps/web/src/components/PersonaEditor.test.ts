import type { AgentPersona, PersonaDraft } from '@loom/api-contract'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PersonaEditor from './PersonaEditor.vue'

/**
 * The persona form and its raw-markdown toggle.
 *
 * What these assert is the part a `client-core` test cannot: that the *component*
 * reads the pure functions correctly — that a planner's Bash checkbox is actually
 * disabled, that a save sends the tab the human was looking at, and that switching
 * tabs goes through the server's parser rather than a guess.
 */

const persona = (overrides: Partial<AgentPersona> = {}): AgentPersona => ({
 id: 'p1',
 workspaceId: 'w1',
 name: 'swe',
 description: 'Writes code',
 markdownSource: '---\nname: swe\ndescription: Writes code\nmodel: m\ntools: [Read]\n---\n\nBody.',
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
})

const draft = (overrides: Partial<PersonaDraft> = {}): PersonaDraft => ({
 ok: true,
 problems: [],
 parsed: {
 name: 'parsed-name',
 description: 'from the server',
 model: 'claude-sonnet-5',
 tools: ['Read', 'Bash'],
 systemPrompt: 'Parsed body.',
 harnessEffort: null,
 harnessMaxTurns: null,
 harnessApprovalMode: 'ask' as const,
 harnessPlanner: false,
 harnessDelegates: [],
 harnessBudgetCapUsd: null,
 },
...overrides,
})

const editor = (personas: AgentPersona[] = [persona]) =>
 mount(PersonaEditor, { props: { personas, capabilities: [], attachments: [] } })

const openNew = async (wrapper: ReturnType<typeof editor>) => {
 await wrapper.get('.add').trigger('click')
 return wrapper
}

const fill = async (wrapper: ReturnType<typeof editor>) => {
 const inputs = wrapper.findAll('input[type="text"]')
 await inputs[0]?.setValue('new-persona')
 await inputs[1]?.setValue('Does a thing')
 await wrapper.get('textarea').setValue('You do a thing.')
}

describe('PersonaEditor', => {
 it('opens on the form, not on raw markdown', async => {
 const wrapper = await openNew(editor)
 expect(wrapper.find('textarea[aria-label="Persona markdown"]').exists).toBe(false)
 expect(wrapper.findAll('input[type="text"]').length).toBeGreaterThan(0)
 })

 it('will not save an incomplete persona, and says what is missing', async => {
 const wrapper = await openNew(editor)
 const submit = wrapper.get('button[type="submit"]')
 expect(submit.attributes('disabled')).toBeDefined
 expect(wrapper.get('.problems').text).toContain('name')
 })

 it('writes markdown from the form fields', async => {
 const wrapper = await openNew(editor)
 await fill(wrapper)
 await wrapper.get('form').trigger('submit')

 const emitted = wrapper.emitted('create-persona')
 expect(emitted).toHaveLength(1)
 const markdown = emitted?.[0]?.[0] as string
 expect(markdown).toContain('name: new-persona')
 expect(markdown).toContain('tools: [Read, Grep, Glob]')
 expect(markdown.endsWith('You do a thing.')).toBe(true)
 })

 /**
 * The rule that makes the planner boundary visible where it is set rather than in
 * a server error after the fact. Three separate correct refusals
 * currently combine to make a shipped persona undelegatable, and the roadmap names showing
 * that at design time as this surface's highest-value job.
 */
 it('disables every acting tool once a persona is marked a planner', async => {
 const wrapper = await openNew(editor)
 await fill(wrapper)
 const plannerBox = wrapper.findAll('input[type="checkbox"]').find((box) => {
 const parent = box.element.closest('label')
 return parent?.textContent?.includes('Planner') ?? false
 })
 await plannerBox?.setValue(true)

 const bash = wrapper
.findAll('.chips.chip')
.find((chip) => chip.text.startsWith('Bash'))
 expect(bash?.find('input').attributes('disabled')).toBeDefined
 })

 it('offers the delegation envelope only on a planner', async => {
 const wrapper = await openNew(editor)
 expect(wrapper.text).not.toContain('Delegation envelope')
 })

 it('will not let a persona be renamed, because a name is its address', async => {
 const wrapper = editor
 await wrapper.get('.link').trigger('click')
 const name = wrapper.findAll('input[type="text"]')[0]
 expect(name?.attributes('disabled')).toBeDefined
 })

 describe('the raw-markdown toggle', => {
 it('shows the form serialized, and sends that text on save', async => {
 const wrapper = await openNew(editor)
 await fill(wrapper)
 await wrapper.findAll('[role="tab"]')[1]?.trigger('click')

 const raw = wrapper.get('textarea[aria-label="Persona markdown"]')
 expect((raw.element as HTMLTextAreaElement).value).toContain('name: new-persona')

 await raw.setValue('---\nname: hand-written\ndescription: d\nmodel: m\n---\n\nBody.')
 await wrapper.get('form').trigger('submit')
 expect(wrapper.emitted('create-persona')?.[0]?.[0]).toContain('hand-written')
 })

 /**
 * Coming back from raw text is a parse, and the client does not own one — so it
 * asks the server. The fields that appear must be the server's reading, not a
 * second one, or the form shows settings a save would not store.
 */
 it('repopulates the form from the server parse, never from its own', async => {
 const wrapper = await openNew(editor)
 await fill(wrapper)
 await wrapper.findAll('[role="tab"]')[1]?.trigger('click')
 await wrapper.findAll('[role="tab"]')[0]?.trigger('click')

 const parse = wrapper.emitted('parse')
 expect(parse).toHaveLength(1)
 const done = parse?.[0]?.[1] as (d: PersonaDraft) => void
 done(draft)
 await wrapper.vm.$nextTick

 const inputs = wrapper.findAll('input[type="text"]')
 expect((inputs[0]?.element as HTMLInputElement).value).toBe('parsed-name')
 expect((inputs[1]?.element as HTMLInputElement).value).toBe('from the server')
 })

 it('stays on the raw tab when the draft does not parse, and shows why', async => {
 const wrapper = await openNew(editor)
 await fill(wrapper)
 await wrapper.findAll('[role="tab"]')[1]?.trigger('click')
 await wrapper.findAll('[role="tab"]')[0]?.trigger('click')

 const done = wrapper.emitted('parse')?.[0]?.[1] as (d: PersonaDraft) => void
 done({ ok: false, problems: ['frontmatter is not closed'], parsed: null })
 await wrapper.vm.$nextTick

 expect(wrapper.find('textarea[aria-label="Persona markdown"]').exists).toBe(true)
 expect(wrapper.get('.problems').text).toContain('not closed')
 })
 })

 /**
 * The guard on the one direction the client duplicates. If the markdown this form
 * wrote parses into something else, the human is looking at a persona they did not
 * author — and the honest thing is to say so, not to re-render the server's answer.
 */
 it('reports a save that stored something other than what was asked for', async => {
 const wrapper = await openNew(editor([]))
 await fill(wrapper)
 await wrapper.get('form').trigger('submit')

 await wrapper.setProps({
 personas: [persona({ name: 'new-persona', tools: ['Read', 'Bash'] })],
 })
 await wrapper.vm.$nextTick

 expect(wrapper.get('.discrepancy').text).toContain('tools')
 })

 it('says nothing when the save matches', async => {
 const wrapper = await openNew(editor([]))
 await fill(wrapper)
 await wrapper.get('form').trigger('submit')

 await wrapper.setProps({
 personas: [
 persona({
 name: 'new-persona',
 description: 'Does a thing',
 tools: ['Read', 'Grep', 'Glob'],
 }),
 ],
 })
 await wrapper.vm.$nextTick

 expect(wrapper.find('.discrepancy').exists).toBe(false)
 })
})
