import { describe, expect, it } from 'vitest'
import { attenuateChildPersona } from './attenuation.js'
import type { PersonaSpec } from './agents.js'

/**
 * The attenuation rule, one test per way a swarm could otherwise be used
 * to acquire what its parent was denied. The Planner case is the sharpest: the product shape gives
 * a Planner `tools: []` on purpose, and without these checks it could just spawn a
 * child that has them.
 */

const spec = (over: Partial<PersonaSpec> = {}): PersonaSpec => ({
 name: 'worker',
 systemPrompt: 'work',
 model: 'claude-sonnet-5',
 tools: ['Read', 'Edit', 'Bash'],
 autoApprove: false,
 budgetCapUsd: 5,
...over,
})

describe('attenuateChildPersona', => {
 it('allows a child that asks for no more than its parent has', => {
 expect(attenuateChildPersona(spec, spec({ tools: ['Read'], budgetCapUsd: 1 }))).toEqual({
 ok: true,
 })
 })

 it('allows an identical child', => {
 expect(attenuateChildPersona(spec, spec)).toEqual({ ok: true })
 })

 it("refuses tools the parent does not have", => {
 const verdict = attenuateChildPersona(spec({ tools: ['Read'] }), spec({ tools: ['Read', 'Bash'] }))
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toContain('Bash')
 })

 it('stops a tools-[] Planner from spawning a child with tools', => {
 // The whole point of the Planner trust boundary.
 const planner = spec({ name: 'planner', tools: [], model: 'claude-opus-5' })
 const verdict = attenuateChildPersona(planner, spec({ tools: ['Bash'] }))
 expect(verdict.ok).toBe(false)
 })

 it('refuses a child that would skip the approval its parent cannot skip', => {
 const verdict = attenuateChildPersona(spec({ autoApprove: false }), spec({ autoApprove: true }))
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toMatch(/auto-approve/)
 })

 it('lets an auto-approving parent hand that down', => {
 expect(
 attenuateChildPersona(spec({ autoApprove: true }), spec({ autoApprove: true })).ok,
).toBe(true)
 })

 it('refuses a higher budget cap', => {
 const verdict = attenuateChildPersona(spec({ budgetCapUsd: 5 }), spec({ budgetCapUsd: 50 }))
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toMatch(/exceeds/)
 })

 it('refuses an uncapped child of a capped parent', => {
 // Otherwise the cheapest escalation available is simply omitting the cap.
 const verdict = attenuateChildPersona(spec({ budgetCapUsd: 5 }), spec({ budgetCapUsd: null }))
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toMatch(/must carry a budget cap/)
 })

 it('constrains nothing on budget when the parent is uncapped', => {
 expect(
 attenuateChildPersona(spec({ budgetCapUsd: null }), spec({ budgetCapUsd: null })).ok,
).toBe(true)
 })

 it('refuses a higher model tier', => {
 const verdict = attenuateChildPersona(
 spec({ model: 'claude-sonnet-5' }),
 spec({ model: 'claude-opus-5' }),
)
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toMatch(/higher tier/)
 })

 it('allows a lower model tier, including a dated variant id', => {
 expect(
 attenuateChildPersona(
 spec({ model: 'claude-opus-5' }),
 spec({ model: 'claude-haiku-4-5-20251001' }),
).ok,
).toBe(true)
 })

 it('refuses an unranked child model under a ranked parent', => {
 // A typo or a newly-added id is otherwise the one remaining way past the
 // tier check.
 const verdict = attenuateChildPersona(
 spec({ model: 'claude-sonnet-5' }),
 spec({ model: 'some-future-model' }),
)
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toMatch(/unranked/)
 })

 it('does not impose a ranking on a self-hosted parent that has none', => {
 // The open-weight path has no place in this table at all; refusing every
 // child there would make swarms impossible on a self-hosted deployment.
 expect(
 attenuateChildPersona(
 spec({ model: 'glm-5.2' }),
 spec({ model: 'deepseek-v4' }),
).ok,
).toBe(true)
 })
})
