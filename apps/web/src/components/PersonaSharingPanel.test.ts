import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import PersonaSharingPanel from './PersonaSharingPanel.vue'
import type { AgentPersona } from '@loom/api-contract'

/**
 * Moving a persona between workspaces — reachable on the contract for as long as it existed
 * and from nowhere on screen, so a tuned persona could only travel by someone copying its
 * markdown out of the editor and losing the origin with it.
 */
const personas = [
  { id: 'p2', name: 'swe' },
  { id: 'p1', name: 'planner' },
] as unknown as AgentPersona[]

const settle = async (wrapper: { vm: { $nextTick: () => Promise<void> } }) => {
  await Promise.resolve()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

const panel = (over: Record<string, unknown> = {}) =>
  mount(PersonaSharingPanel, {
    props: {
      personas,
      export: vi.fn(async () => ({ text: '---\nname: swe\n---\nbody', digest: 'abcdef123456789' })),
      adopt: vi.fn(async () => ({
        name: 'swe',
        provenance: 'Claimed to come from another workspace on 3 September.',
        detail: 'Adopted as swe.',
      })),
      ...over,
    },
  })

describe('PersonaSharingPanel', () => {
  it('lists the personas in a stable order rather than the order they arrived', () => {
    const options = panel().findAll('option').map((option) => option.text())
    expect(options.slice(1)).toEqual(['planner', 'swe'])
  })

  it('shows the bundle as copyable text and never claims to have published it', async () => {
    const wrapper = panel()
    await wrapper.findAll('select')[0]!.setValue('p2')
    await wrapper.findAll('button')[0]!.trigger('click')
    await settle(wrapper)

    expect(wrapper.get('textarea.bundle').attributes('readonly')).toBeDefined()
    expect((wrapper.get('textarea.bundle').element as HTMLTextAreaElement).value).toContain('name: swe')
    // Affirmative forms only: the panel's own disclaimer says "nothing here publishes
    // anything", and a blunter pattern than this matches the promise instead of a breach of it.
    expect(wrapper.text()).not.toMatch(/\b(published|uploading|uploaded|hosted|stored on)\b/i)
  })

  /**
   * The load-bearing one. An adoption is a claim: the bundle's digest says the document has
   * not changed since it was exported and says nothing about who wrote it, so the surface has
   * to show the sentence being accepted rather than assert the transfer happened.
   */
  it('shows the provenance claim back after adopting, unedited', async () => {
    const adopt = vi.fn(async () => ({
      name: 'swe',
      provenance: 'Claimed to come from another workspace on 3 September.',
      detail: 'Adopted as swe.',
    }))
    const wrapper = panel({ adopt })
    await wrapper.findAll('textarea')[0]!.setValue('a bundle')
    await wrapper.findAll('button')[1]!.trigger('click')
    await settle(wrapper)

    expect(adopt).toHaveBeenCalledWith({ bundleText: 'a bundle', as: null })
    expect(wrapper.get('.provenance').text()).toBe(
      'Claimed to come from another workspace on 3 September.',
    )
  })

  it('passes a chosen name through, and null when the field is blank', async () => {
    const adopt = vi.fn(async () => ({ name: 'other', provenance: 'x', detail: 'ok' }))
    const wrapper = panel({ adopt })
    await wrapper.findAll('textarea')[0]!.setValue('a bundle')
    await wrapper.get('input').setValue('  renamed  ')
    await wrapper.findAll('button')[1]!.trigger('click')
    await settle(wrapper)

    expect(adopt).toHaveBeenCalledWith({ bundleText: 'a bundle', as: 'renamed' })
  })

  it('keeps the draft when the adoption was refused, so nobody re-pastes it', async () => {
    const adopt = vi.fn(async () => ({ name: null, provenance: '', detail: 'That is not a bundle.' }))
    const wrapper = panel({ adopt })
    await wrapper.findAll('textarea')[0]!.setValue('rubbish')
    await wrapper.findAll('button')[1]!.trigger('click')
    await settle(wrapper)

    expect(wrapper.text()).toContain('That is not a bundle.')
    expect((wrapper.findAll('textarea')[0]!.element as HTMLTextAreaElement).value).toBe('rubbish')
  })
})
