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

 /**
 * The envelope. The roadmap says a Planner
 * declares `tools: []` and the data model says a child may not exceed its parent — read
 * together against the same list, a Planner can only delegate to workers that
 * also have nothing, which makes the feature not exist. `delegates` is the
 * human-set ceiling that separates what a run may do *itself* from what it may
 * hand down.
 */
 it('lets a Planner delegate within its declared envelope', => {
 const planner = spec({ name: 'planner', tools: [], planner: true, delegates: ['Read', 'Edit'] })
 expect(attenuateChildPersona(planner, spec({ tools: ['Read', 'Edit'] }))).toEqual({ ok: true })
 })

 it('refuses a child asking for more than the envelope allows', => {
 const planner = spec({ name: 'planner', tools: [], planner: true, delegates: ['Read'] })
 const verdict = attenuateChildPersona(planner, spec({ tools: ['Read', 'Bash'] }))
 expect(verdict.ok).toBe(false)
 if (verdict.ok) return
 expect(verdict.reason).toContain('Bash')
 // Names the envelope, not "its parent lacks" — the parent lacks everything,
 // and saying so would send someone looking at the wrong list.
 expect(verdict.reason).toContain('envelope')
 })

 /**
 * The envelope attenuates too, and this is the case every other test in this file
 * reads straight past: a child Planner holds `tools: []` like any Planner, so
 * checking only `tools` calls it harmless. Its *envelope* is the thing being
 * handed down, and left unchecked it can be wider than the one that granted it.
 */
 it('refuses a child Planner whose envelope is wider than its parent ceiling', => {
 const outer = spec({ name: 'outer', tools: [], planner: true, delegates: ['Read', 'Edit'] })
 const inner = spec({
 name: 'inner',
 tools: [],
 planner: true,
 delegates: ['Read', 'Edit', 'Bash'],
 })
 const verdict = attenuateChildPersona(outer, inner)
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toContain('Bash')
 })

 it('allows a child Planner that narrows its parent envelope', => {
 const outer = spec({ name: 'outer', tools: [], planner: true, delegates: ['Read', 'Edit'] })
 const inner = spec({ name: 'inner', tools: [], planner: true, delegates: ['Read'] })
 expect(attenuateChildPersona(outer, inner)).toEqual({ ok: true })
 })

 it('bounds a child Planner under a non-planner parent by that parent tools', => {
 // A worker spawning a Planner: there is no envelope above, so the ceiling is
 // what the worker itself holds — the same rule, with `tools` as the ceiling.
 const worker = spec({ tools: ['Read', 'Edit'] })
 const inner = spec({ name: 'inner', tools: [], planner: true, delegates: ['Read', 'Bash'] })
 const verdict = attenuateChildPersona(worker, inner)
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toContain('Bash')
 })

 // The envelope only widens what may be *handed down*. Everything else still
 // measures against the parent's own values.
 it('does not let the envelope widen budget, tier or auto-approve', => {
 const planner = spec({
 name: 'planner',
 tools: [],
 planner: true,
 delegates: ['Read'],
 budgetCapUsd: 1,
 autoApprove: false,
 })
 expect(attenuateChildPersona(planner, spec({ tools: ['Read'], budgetCapUsd: 5 })).ok).toBe(false)
 expect(
 attenuateChildPersona(planner, spec({ tools: ['Read'], budgetCapUsd: 1, autoApprove: true })).ok,
).toBe(false)
 })

 // An envelope on a non-planner would be a general way to hand children more
 // than the parent holds — refused where personas are authored, and ignored here.
 it('ignores an envelope on a persona that is not a planner', => {
 const parent = spec({ tools: ['Read'], delegates: ['Bash'] })
 expect(attenuateChildPersona(parent, spec({ tools: ['Bash'] })).ok).toBe(false)
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
