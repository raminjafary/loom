import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import SidebarSection from './SidebarSection.vue'

/**
 * The first component test in this app.
 *
 * Four sessions of client work were protected only by `client-core` tests, which is
 * the right home for the *logic* and says nothing about whether a component reads it.
 * Started here because `SidebarSection` is the one component every panel is behind:
 * when it stays shut, a working panel is indistinguishable from a broken one — which
 * has already cost a debugging session and a line in a handoff telling the next person
 * to check localStorage before concluding the board is broken.
 */

const body = { default: '<p class="content">panel</p>' }

beforeEach(() => {
  localStorage.clear()
})

describe('SidebarSection', () => {
  it('remembers that it was opened, across mounts', async () => {
    const first = mount(SidebarSection, {
      props: { title: 'Swarm', storageKey: 'swarm' },
      slots: body,
    })
    expect(first.find('.content').exists()).toBe(false)

    await first.get('button').trigger('click')
    expect(localStorage.getItem('loom:section:swarm')).toBe('open')

    const second = mount(SidebarSection, {
      props: { title: 'Swarm', storageKey: 'swarm' },
      slots: body,
    })
    expect(second.find('.content').exists()).toBe(true)
  })

  it('prefers what was remembered over defaultOpen', () => {
    localStorage.setItem('loom:section:swarm', 'closed')
    const section = mount(SidebarSection, {
      props: { title: 'Swarm', storageKey: 'swarm', defaultOpen: true },
      slots: body,
    })
    expect(section.find('.content').exists()).toBe(false)
  })

  /**
   * A decision waiting behind a collapsed header is a decision that does not get made,
   * so this overrides what was remembered — deliberately, and only for this.
   */
  it('opens itself for attention whatever was remembered', async () => {
    localStorage.setItem('loom:section:approvals', 'closed')
    const section = mount(SidebarSection, {
      props: { title: 'Approvals', storageKey: 'approvals', attention: true },
      slots: body,
    })
    await section.vm.$nextTick()
    expect(section.find('.content').exists()).toBe(true)
  })

  describe('reveal', () => {
    it('opens when the user asks for what is inside', async () => {
      localStorage.setItem('loom:section:swarm', 'closed')
      const section = mount(SidebarSection, {
        props: { title: 'Swarm', storageKey: 'swarm', reveal: 0 },
        slots: body,
      })
      expect(section.find('.content').exists()).toBe(false)

      await section.setProps({ reveal: 1 })
      expect(section.find('.content').exists()).toBe(true)
    })

    /**
     * Why it is a counter and not a boolean. A flag that stays true fires its watcher
     * once, so a user who closed the section again would find the button dead.
     */
    it('opens again after the user closes it', async () => {
      const section = mount(SidebarSection, {
        props: { title: 'Swarm', storageKey: 'swarm', reveal: 1 },
        slots: body,
      })
      await section.setProps({ reveal: 2 })
      expect(section.find('.content').exists()).toBe(true)

      await section.get('button').trigger('click')
      expect(section.find('.content').exists()).toBe(false)

      await section.setProps({ reveal: 3 })
      expect(section.find('.content').exists()).toBe(true)
    })

    it('does not force a section open on first mount', async () => {
      // `reveal` is a request, not a default. A section the user closed must stay
      // closed until they ask for it again.
      localStorage.setItem('loom:section:swarm', 'closed')
      const section = mount(SidebarSection, {
        props: { title: 'Swarm', storageKey: 'swarm', reveal: 7 },
        slots: body,
      })
      await section.vm.$nextTick()
      expect(section.find('.content').exists()).toBe(false)
    })
  })
})
