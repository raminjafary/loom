import type { ApprovalRequest } from '@loom/api-contract'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ApprovalCard from './ApprovalCard.vue'

/**
 * The two gates a human decides through, and they are not the same gate
 *.
 *
 * A tool approval shows the exact argv and asks allow/deny. A clarifying question is
 * that same mechanism carrying a prompt and returning a string — model-composed, and
 * therefore attacker-controllable text rendered in a box wearing the
 * platform's own chrome. The risk in a different shape, which is why the label and
 * the plain interpolation are asserted here rather than left to review.
 */

const approval = (over: Partial<ApprovalRequest> & { id: string }): ApprovalRequest =>
 ({
 workspaceId: 'ws-1',
 agentRunId: 'run-1',
 toolUseId: 'tu-1',
 toolName: 'Bash',
 input: { command: 'rm -rf /tmp/x' },
 status: 'pending',
 question: null,
 answer: null,
 requestedAt: new Date(2026, 0, 1, 12, 0, 0),
 resolvedAt: null,
 resolvedByUserId: null,
...over,
 }) as ApprovalRequest

describe('ApprovalCard: a tool approval', => {
 it('shows the exact argv rather than a summary of it', => {
 // Effect-based classification: a human deciding on a model's summary of what it is about to run is
 // deciding on the wrong thing.
 const card = mount(ApprovalCard, { props: { approvals: [approval({ id: 'a1' })] } })
 expect(card.get('.argv').text).toContain('rm -rf /tmp/x')
 expect(card.text).toContain('Bash')
 })

 it('emits allow and deny with the request id', async => {
 const card = mount(ApprovalCard, { props: { approvals: [approval({ id: 'a1' })] } })
 await card.get('button.approve').trigger('click')
 await card.get('button.deny').trigger('click')
 expect(card.emitted('decide')).toEqual([
 ['a1', 'approve'],
 ['a1', 'deny'],
 ])
 })
})

describe('ApprovalCard: a clarifying question', => {
 const asked = (over: Partial<ApprovalRequest> = {}) =>
 approval({ id: 'q1', question: 'Should the export be CSV or JSON?',...over })

 it('labels the question as the agent’s words, not the platform’s', => {
 const card = mount(ApprovalCard, { props: { approvals: [asked] } })
 expect(card.text).toContain('Asked by the agent')
 expect(card.get('.question').text).toBe('Should the export be CSV or JSON?')
 })

 it('never renders a question as markup', => {
 // The whole point of the fence. An agent that can inject markup into a box
 // carrying the platform's chrome is the no-`v-html` rule with extra steps.
 const card = mount(ApprovalCard, {
 props: { approvals: [asked({ question: '<img src=x onerror="alert(1)">' })] },
 })
 expect(card.get('.question').text).toBe('<img src=x onerror="alert(1)">')
 expect(card.find('.question img').exists).toBe(false)
 })

 it('sends the answer text with the approval, and clears the box', async => {
 const card = mount(ApprovalCard, { props: { approvals: [asked] } })
 await card.get('textarea.answer').setValue('JSON only.')
 await card.get('button.approve').trigger('click')
 expect(card.emitted('decide')).toEqual([['q1', 'approve', 'JSON only.']])
 expect((card.get('textarea.answer').element as HTMLTextAreaElement).value).toBe('')
 })

 it('refuses to send an empty answer', async => {
 /**
 * Approving with no answer is a refusal in disguise: the run resumes and reads
 * silence as assent. The button stays disabled rather than sending an empty
 * string — the same rule the server enforces, held one layer earlier so the
 * human sees why.
 */
 const card = mount(ApprovalCard, { props: { approvals: [asked] } })
 expect(card.get('button.approve').attributes('disabled')).toBeDefined
 await card.get('textarea.answer').setValue(' ')
 expect(card.get('button.approve').attributes('disabled')).toBeDefined
 await card.get('button.approve').trigger('click')
 expect(card.emitted('decide')).toBeUndefined
 })

 it('declines without an answer, which is not the same as denying a tool', async => {
 const card = mount(ApprovalCard, { props: { approvals: [asked] } })
 await card.get('button.deny').trigger('click')
 expect(card.emitted('decide')).toEqual([['q1', 'deny']])
 })

 /**
 * Several runs can be blocked on questions at once. A single shared `ref` for the
 * draft answer would put one run's reply into another run's box — and the answer
 * is what that run resumes with.
 */
 it('keeps draft answers separate per request', async => {
 const card = mount(ApprovalCard, {
 props: { approvals: [asked, approval({ id: 'q2', question: 'Which region?' })] },
 })
 const boxes = card.findAll('textarea.answer')
 await boxes[0]!.setValue('JSON only.')
 expect((boxes[1]!.element as HTMLTextAreaElement).value).toBe('')
 await card.findAll('button.approve')[1]!.trigger('click')
 expect(card.emitted('decide')).toBeUndefined
 })
})
