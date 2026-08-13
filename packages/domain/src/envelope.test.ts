import { describe, expect, it } from 'vitest'
import {
 attenuateEnvelope,
 envelopeAllows,
 maySelfModify,
 type Envelope,
} from './envelope.js'
import type { PersonaSpec } from './agents.js'

/**
 * The envelope — the ceiling that makes tiers 2–4 bounded at all.
 *
 * Every test here is one of the four decisions the module documents: absence is a
 * refusal, a persona fits its own ceiling, `delegates` is bounded by it too, and a
 * child's envelope shrinks under its parent's.
 */

const envelope = (over: Partial<Envelope> = {}): Envelope => ({
 tools: ['Read', 'Grep', 'Glob', 'Edit'],
 model: 'claude-sonnet-5',
 budgetCapUsd: 10,
 capabilities: ['github'],
 subagentDepth: 2,
 approvalMode: 'accept-edits',
...over,
})

const spec = (over: Partial<PersonaSpec> = {}): PersonaSpec => ({
 name: 'swe',
 systemPrompt: 'body',
 model: 'claude-sonnet-5',
 tools: ['Read', 'Edit'],
 approvalMode: 'ask',
 budgetCapUsd: 5,
...over,
})

describe('maySelfModify', => {
 /**
 * The decision this whole file turns on. Read the other way — null as "no ceiling" —
 * every persona predating the field becomes a self-rewriting agent with no bound.
 */
 it('treats an absent envelope as no permission rather than no ceiling', => {
 expect(maySelfModify(null)).toBe(false)
 expect(maySelfModify(envelope)).toBe(true)
 })

 /** An envelope with nothing in it is the tier 1: rewrite your prompt, nothing else. */
 it('treats an empty envelope as permission to change nothing but the prompt', => {
 const empty: Envelope = {
 tools: [],
 model: null,
 budgetCapUsd: null,
 capabilities: [],
 subagentDepth: null,
 approvalMode: null,
 }
 expect(maySelfModify(empty)).toBe(true)
 expect(envelopeAllows(empty, spec({ tools: ['Read'] })).ok).toBe(false)
 expect(envelopeAllows(empty, spec({ tools: [] })).ok).toBe(true)
 })
})

describe('envelopeAllows', => {
 it('accepts a persona inside its ceiling', => {
 expect(envelopeAllows(envelope, spec).ok).toBe(true)
 })

 it('refuses with no envelope, and says what to do about it', => {
 const verdict = envelopeAllows(null, spec)
 expect(verdict.ok).toBe(false)
 expect(verdict.refusals[0]?.rule).toBe('absent')
 expect(verdict.refusals[0]?.request).toContain('no permission')
 })

 it('refuses a tool outside the ceiling', => {
 const verdict = envelopeAllows(envelope, spec({ tools: ['Read', 'Bash'] }))
 expect(verdict.ok).toBe(false)
 expect(verdict.refusals.map((r) => r.rule)).toContain('tools')
 expect(verdict.refusals[0]?.detail).toContain('Bash')
 })

 /**
 * Continuity mode: "rejected and surfaced to a human as a request, not silently clamped — clamping
 * teaches an agent to probe." So every refusal names the widening, and nothing here
 * returns a narrowed value.
 */
 it('asks for a widening rather than narrowing the request', => {
 const verdict = envelopeAllows(envelope, spec({ tools: ['Bash'] }))
 expect(verdict.refusals[0]?.request).toContain('envelope')
 expect(verdict.refusals[0]?.request).toContain('Bash')
 })

 /**
 * Decision 3. `delegates` is what a planner hands down, and a planner permitted to
 * rewrite its own delegation envelope past a ceiling nobody checked could mint a worker
 * stronger than anything its own envelope allows.
 */
 it('bounds what a planner hands down, not only what it holds', => {
 const verdict = envelopeAllows(
 envelope({ tools: ['Read', 'Grep', 'Glob'] }),
 spec({ tools: ['Read'], planner: true, delegates: ['Read', 'Bash'] }),
)
 expect(verdict.ok).toBe(false)
 expect(verdict.refusals.map((r) => r.rule)).toContain('delegates')
 expect(verdict.refusals.find((r) => r.rule === 'delegates')?.detail).toContain('Bash')
 })

 it('ignores delegates on a persona that is not a planner', => {
 expect(
 envelopeAllows(
 envelope({ tools: ['Read'] }),
 spec({ tools: ['Read'], planner: false, delegates: ['Bash'] }),
).ok,
).toBe(true)
 })

 it('refuses a model above the ceiling tier, and an unranked one against a ranked ceiling', => {
 expect(envelopeAllows(envelope, spec({ model: 'claude-opus-5' })).ok).toBe(false)
 expect(envelopeAllows(envelope, spec({ model: 'some-local-model' })).ok).toBe(false)
 // Both unranked is not a failure — a self-hosted deployment has no place in the ranking.
 expect(
 envelopeAllows(envelope({ model: null }), spec({ model: 'some-local-model' })).ok,
).toBe(true)
 })

 it('refuses an uncapped persona under a capped ceiling', => {
 const verdict = envelopeAllows(envelope, spec({ budgetCapUsd: null }))
 expect(verdict.ok).toBe(false)
 expect(verdict.refusals.map((r) => r.rule)).toContain('budget')
 })

 it('refuses a capability the ceiling does not name', => {
 const verdict = envelopeAllows(
 envelope,
 spec({
 capabilities: [
 { kind: 'mcp', name: 'shell-mcp', allowedTools: [], egressHosts: [] } as never,
 ],
 }),
)
 expect(verdict.ok).toBe(false)
 expect(verdict.refusals.find((r) => r.rule === 'capabilities')?.request).toContain(
 'route to a shell',
)
 })

 /** A ceiling on tools with a self-edit free to flip `ask` to `auto` bounds the wrong axis. */
 it('refuses an approval mode wider than the ceiling', => {
 const verdict = envelopeAllows(envelope, spec({ approvalMode: 'auto' }))
 expect(verdict.ok).toBe(false)
 expect(verdict.refusals.map((r) => r.rule)).toContain('approvalMode')
 })

 it('reports every refusal rather than the first', => {
 const verdict = envelopeAllows(
 envelope({ tools: ['Read'] }),
 spec({ tools: ['Bash'], model: 'claude-opus-5', budgetCapUsd: 999, approvalMode: 'auto' }),
)
 expect(verdict.refusals.map((r) => r.rule).sort).toEqual([
 'approvalMode',
 'budget',
 'model',
 'tools',
 ])
 })
})

describe('attenuateEnvelope', => {
 /**
 * The asymmetry is the whole function. A parent with no envelope cannot rewrite itself,
 * so the ordinary attenuation against its own tools is the live check; refusing every
 * child of an envelope-less parent would make the field impossible to adopt.
 */
 it('bounds nothing when the parent has no envelope', => {
 expect(attenuateEnvelope(null, envelope).ok).toBe(true)
 })

 /** A worker nobody intends to let rewrite itself is the common case. */
 it('accepts a child with no envelope', => {
 expect(attenuateEnvelope(envelope, null).ok).toBe(true)
 })

 it('refuses a child envelope reaching tools its parent cannot', => {
 const verdict = attenuateEnvelope(
 envelope({ tools: ['Read'] }),
 envelope({ tools: ['Read', 'Bash'] }),
)
 expect(verdict.ok).toBe(false)
 expect(verdict.refusals[0]?.detail).toContain('Bash')
 })

 /**
 * The case `envelopeAllows` does not have: null there means "this dimension is not
 * raised", which is safe because the parent's own values still bound the run. Here the
 * child envelope *is* the ceiling a later self-edit is measured against, so leaving a
 * dimension open hands the child something its parent had closed.
 */
 it('refuses a child envelope that leaves open a dimension its parent closed', => {
 expect(attenuateEnvelope(envelope, envelope({ model: null })).ok).toBe(false)
 expect(attenuateEnvelope(envelope, envelope({ budgetCapUsd: null })).ok).toBe(false)
 expect(attenuateEnvelope(envelope, envelope({ subagentDepth: null })).ok).toBe(false)
 expect(attenuateEnvelope(envelope, envelope({ approvalMode: null })).ok).toBe(false)
 })

 /**
 * Strictly less, not less-or-equal: a chain of planners each allowed its parent's own
 * depth reaches as far as the chain is long.
 */
 it('requires depth to shrink at every hop', => {
 expect(attenuateEnvelope(envelope({ subagentDepth: 2 }), envelope({ subagentDepth: 2 })).ok).toBe(
 false,
)
 expect(attenuateEnvelope(envelope({ subagentDepth: 2 }), envelope({ subagentDepth: 1 })).ok).toBe(
 true,
)
 })

 it('accepts a child envelope narrower on every axis', => {
 expect(
 attenuateEnvelope(
 envelope,
 envelope({
 tools: ['Read'],
 model: 'claude-haiku-4-5-20251001',
 budgetCapUsd: 1,
 capabilities: [],
 subagentDepth: 0,
 approvalMode: 'ask',
 }),
).ok,
).toBe(true)
 })
})
