import { describe, expect, it } from 'vitest'
import {
 attenuateChildCapabilities,
 canonicalToolList,
 verifyToolListHash,
 type CapabilitySpec,
} from './capabilities.js'

/**
 * The registry, and the attenuation applied to it.
 *
 * Capabilities are the sharpest case of the attenuation rule. The product shape gives a Planner
 * `tools: []` on purpose; an MCP server is a route to a shell, so a child able to
 * attach one its parent lacks would make that boundary decorative — the same
 * failure `attenuateChildPersona` already prevents for tools and model tier.
 */

const mcp = (name: string, allowedTools: string[] = []): CapabilitySpec => ({
 kind: 'mcp',
 name,
 transport: 'stdio',
 command: 'server',
 args: [],
 url: null,
 toolListHash: null,
 allowedTools,
 egressHosts: [],
})

const skill = (name: string): CapabilitySpec => ({
 kind: 'skill',
 name,
 content: '# skill',
 egressHosts: [],
})

describe('attenuateChildCapabilities', => {
 it('allows a child holding a subset of its parent', => {
 expect(attenuateChildCapabilities([mcp('files'), skill('style')], [skill('style')])).toEqual({
 ok: true,
 })
 })

 it('allows a child holding nothing', => {
 expect(attenuateChildCapabilities([mcp('files')], [])).toEqual({ ok: true })
 })

 /** The Planner case: a parent with no capabilities cannot hand one down. */
 it('refuses a capability the parent lacks', => {
 const verdict = attenuateChildCapabilities([], [mcp('shell')])
 expect(verdict.ok).toBe(false)
 if (verdict.ok) return
 expect(verdict.reason).toContain('shell')
 })

 it('refuses a widened scope on a capability the parent narrowed', => {
 const verdict = attenuateChildCapabilities([mcp('files', ['read'])], [mcp('files', ['read', 'write'])])
 expect(verdict.ok).toBe(false)
 if (verdict.ok) return
 expect(verdict.reason).toContain('write')
 })

 /**
 * Empty means "everything this server offers", so a child with an empty scope
 * under a narrowed parent is asking for *more*, not less — the one case where
 * the obvious reading of an empty list is backwards.
 */
 it('refuses an unscoped child under a scoped parent', => {
 const verdict = attenuateChildCapabilities([mcp('files', ['read'])], [mcp('files', [])])
 expect(verdict.ok).toBe(false)
 if (verdict.ok) return
 expect(verdict.reason).toContain('all tools')
 })

 it('allows a narrower scope than the parent', => {
 expect(attenuateChildCapabilities([mcp('files', ['read', 'write'])], [mcp('files', ['read'])])).toEqual({
 ok: true,
 })
 })

 it('imposes no scope constraint when the parent is unscoped', => {
 expect(attenuateChildCapabilities([mcp('files', [])], [mcp('files', ['read'])])).toEqual({ ok: true })
 })
})

describe('canonicalToolList', => {
 // MCP does not promise a stable listing order, so ordering must not read as a
 // server having changed what it offers.
 it('is stable under reordering and duplication', => {
 expect(canonicalToolList(['b', 'a'])).toBe(canonicalToolList(['a', 'b']))
 expect(canonicalToolList(['a', 'a', 'b'])).toBe(canonicalToolList(['a', 'b']))
 })

 it('distinguishes a genuinely different tool set', => {
 expect(canonicalToolList(['a', 'b'])).not.toBe(canonicalToolList(['a', 'b', 'c']))
 })
})

describe('verifyToolListHash', => {
 it('accepts and marks a first observation, since there is nothing to compare against', => {
 expect(verifyToolListHash(null, 'abc')).toEqual({ ok: true, firstObservation: true })
 })

 it('accepts an unchanged tool list', => {
 expect(verifyToolListHash('abc', 'abc')).toEqual({ ok: true, firstObservation: false })
 })

 /**
 * The reason for pinning at all: a server reviewed offering three read-only
 * tools can start offering a fourth that writes. A refusal, not a prompt — the
 * human approved a specific set, and this server is no longer that one.
 */
 it('refuses a changed tool list rather than asking about it', => {
 const verdict = verifyToolListHash('abc', 'def')
 expect(verdict.ok).toBe(false)
 if (verdict.ok) return
 expect(verdict.reason).toContain('Re-review')
 })
})
