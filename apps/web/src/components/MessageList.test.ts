import type { Message } from '@loom/api-contract'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MessageList from './MessageList.vue'

/**
 * Rendering tests for the thread.
 *
 * `client-core`'s `buildThreadRows` decides *what* a row is; nothing until now checked
 * what the component does with it. The two bugs below are both of that shape — the row
 * was correct and the rendering lost something — which is exactly the gap four sessions
 * of client work had no runner to catch.
 */

const message = (over: Partial<Message> & { id: string }): Message => ({
  workspaceId: 'ws-1',
  threadId: 'th-1',
  author: { kind: 'system' },
  body: { kind: 'system', text: 'something happened' },
  toolUseId: null,
  createdAt: new Date(2026, 0, 1, 12, 0, 0),
  editedAt: null,
  ...over,
})

describe('MessageList', () => {
  /**
   * Every multi-line message the platform writes is newline-joined, and a `<p>` collapses
   * newlines to spaces — so a plan summary rendered as one run-on line. Seen in the real
   * app: "Plan finished: 2/2 subtasks completed, $0.3880 total. • product-manager —
   * completed → loom/run-3d034d3c • security-reviewer — completed → …".
   */
  it('keeps the line breaks in a multi-line system message', () => {
    const summary = [
      'Plan accepted: 2 subtask(s) started.',
      '• The docs area → planner',
      '• A single unit → swe',
    ].join('\n')

    const list = mount(MessageList, {
      props: { messages: [message({ id: 'm1', body: { kind: 'system', text: summary } })] },
    })

    const detail = list.get('.detail')
    // Both halves of the fix are asserted where they can be. The newlines must survive
    // into the DOM — a component that pre-joined or trimmed them would leave nothing for
    // any stylesheet to honour — and each line must be its own line rather than one
    // run-on string.
    expect(detail.element.textContent).toContain('\n')
    expect(
      (detail.element.textContent ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
    ).toEqual([
      'Plan accepted: 2 subtask(s) started.',
      '• The docs area → planner',
      '• A single unit → swe',
    ])

    /**
     * The `white-space: pre-wrap` half is deliberately *not* asserted here.
     * `@vue/test-utils` does not inject a SFC's scoped styles under happy-dom, so
     * `getComputedStyle` returns an empty string for every property — an assertion on it
     * passes or fails for reasons unrelated to the rule, which is worse than no
     * assertion. It is verified in the running app instead.
     */
  })

  /**
   * The no-`v-html` rule: model output is never markup. A system line can carry a persona
   * name, a task title or an error message, all of which are model-adjacent.
   */
  it('renders angle brackets in a system message as text, never as markup', () => {
    const list = mount(MessageList, {
      props: {
        messages: [
          message({ id: 'm2', body: { kind: 'system', text: 'Run failed: <img src=x onerror=1>' } }),
        ],
      },
    })
    expect(list.get('.detail').text()).toContain('<img src=x onerror=1>')
    expect(list.find('.detail img').exists()).toBe(false)
  })

  it('renders nothing at all for an empty thread', () => {
    const list = mount(MessageList, { props: { messages: [] } })
    expect(list.findAll('.row')).toHaveLength(0)
  })
})

/**
 * The way into an area.
 *
 * A sub-planner's whole subtree lives in its own thread, and this button is the only
 * thing in the parent conversation that leads there. `client-core`'s `area-threads`
 * decides *which* message opens which thread; nothing checked that the component
 * renders a way in — and a split that hides work is worse than no split at all, which
 * is precisely how "reply threads existed since Phase 0 and were unreachable" happened.
 */
describe('MessageList: the way into an area thread', () => {
  const announcement = message({
    id: 'm-area',
    body: { kind: 'system', text: 'API area → planner: delegated as its own area.' },
  })

  it('offers a way in on the message the area hangs off', async () => {
    const list = mount(MessageList, {
      props: { messages: [announcement], areaThreadByMessageId: { 'm-area': 'th-area' } },
    })
    await list.get('button.open-area').trigger('click')
    expect(list.emitted('open-thread')).toEqual([['th-area']])
  })

  it('offers nothing on a message with no area under it', () => {
    const list = mount(MessageList, {
      props: { messages: [announcement], areaThreadByMessageId: {} },
    })
    expect(list.find('button.open-area').exists()).toBe(false)
  })

  it('renders without the map at all, for a tree that has no areas', () => {
    // The prop is optional, and the flat fan-out — every Phase 2 swarm — never sets it.
    const list = mount(MessageList, { props: { messages: [announcement] } })
    expect(list.find('button.open-area').exists()).toBe(false)
    expect(list.text()).toContain('delegated as its own area')
  })

  /**
   * Someone who scrolled up to re-read something, then typed, is waiting to see what
   * they just said. The append rule is deliberately conditional — it leaves a reader
   * of history where they are — and sending is the case it gets wrong.
   */
  describe('following on send', () => {
    const scrollerOf = (list: ReturnType<typeof mount>) =>
      list.get('.messages').element as HTMLElement

    /** happy-dom reports zero heights, so the geometry is staged by hand. */
    const stageScrolledUp = (el: HTMLElement) => {
      Object.defineProperty(el, 'scrollHeight', { value: 1_000, configurable: true })
      Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true })
      el.scrollTop = 0
    }

    it('scrolls to the bottom when this client sends, wherever it was reading', async () => {
      const list = mount(MessageList, {
        props: { messages: [message({ id: 'm1' })], sentTick: 0 },
      })
      const el = scrollerOf(list)
      stageScrolledUp(el)

      await list.setProps({ sentTick: 1, messages: [message({ id: 'm1' }), message({ id: 'm2' })] })
      await list.vm.$nextTick()
      await list.vm.$nextTick()
      await list.vm.$nextTick()

      expect(el.scrollTop).toBe(1_000)
    })

    it('leaves a reader of history alone when someone else posts', async () => {
      const list = mount(MessageList, {
        props: { messages: [message({ id: 'm1' })], sentTick: 0 },
      })
      const el = scrollerOf(list)
      stageScrolledUp(el)
      // A scroll event is what tells the component it is no longer at the bottom.
      await list.get('.messages').trigger('scroll')

      await list.setProps({ messages: [message({ id: 'm1' }), message({ id: 'm2' })] })
      await list.vm.$nextTick()

      expect(el.scrollTop).toBe(0)
    })
  })
})
