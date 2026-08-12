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

describe('MessageList', => {
 /**
 * Every multi-line message the platform writes is newline-joined, and a `<p>` collapses
 * newlines to spaces — so a plan summary rendered as one run-on line. Seen in the real
 * app: "Plan finished: 2/2 subtasks completed, $0.3880 total. • product-manager —
 * completed → loom/run-3d034d3c • security-reviewer — completed → …".
 */
 it('keeps the line breaks in a multi-line system message', => {
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
 (detail.element.textContent ?? '').split('\n').map((line) => line.trim).filter(Boolean),
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
 * The no-`v-html` rule: model output is never markup. A system line can carry a persona name, a task
 * title or an error message, all of which are model-adjacent.
 */
 it('renders angle brackets in a system message as text, never as markup', => {
 const list = mount(MessageList, {
 props: {
 messages: [
 message({ id: 'm2', body: { kind: 'system', text: 'Run failed: <img src=x onerror=1>' } }),
 ],
 },
 })
 expect(list.get('.detail').text).toContain('<img src=x onerror=1>')
 expect(list.find('.detail img').exists).toBe(false)
 })

 it('renders nothing at all for an empty thread', => {
 const list = mount(MessageList, { props: { messages: [] } })
 expect(list.findAll('.row')).toHaveLength(0)
 })
})
