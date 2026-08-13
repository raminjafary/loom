import { describe, expect, it } from 'vitest'
import { DEFAULT_ALLOWED_EGRESS_HOSTS, classifyEgress, parseEgressHost } from './egress-policy.js'

const allow = DEFAULT_ALLOWED_EGRESS_HOSTS

describe('classifyEgress', => {
 it('allows an allowlisted host on 443', => {
 expect(classifyEgress('registry.npmjs.org:443', allow)).toEqual({
 allowed: true,
 host: 'registry.npmjs.org',
 port: 443,
 })
 })

 it('denies a host that is not on the allowlist', => {
 const verdict = classifyEgress('evil.example:443', allow)
 expect(verdict.allowed).toBe(false)
 })

 it('denies a lookalike that merely ends with an allowlisted name', => {
 // The whole reason patterns are exact-or-dot-prefixed rather than wildcards.
 expect(classifyEgress('registry.npmjs.org.evil.com:443', allow).allowed).toBe(false)
 })

 it('allows a subdomain only under a dot-prefixed pattern', => {
 expect(classifyEgress('foo.npmjs.org:443', allow).allowed).toBe(true)
 expect(classifyEgress('foo.pypi.org:443', allow).allowed).toBe(false)
 })

 it('denies plaintext and non-443 ports even for an allowlisted host', => {
 expect(classifyEgress('registry.npmjs.org:80', allow).allowed).toBe(false)
 expect(classifyEgress('registry.npmjs.org:22', allow).allowed).toBe(false)
 })

 it('rejects a malformed target instead of defaulting the port to 443', => {
 expect(classifyEgress('registry.npmjs.org', allow).allowed).toBe(false)
 expect(classifyEgress('registry.npmjs.org:notaport', allow).allowed).toBe(false)
 expect(classifyEgress(':443', allow).allowed).toBe(false)
 })

 it('matches hosts case-insensitively', => {
 expect(classifyEgress('REGISTRY.NPMJS.ORG:443', allow).allowed).toBe(true)
 })

 it('denies everything when the allowlist is empty', => {
 expect(classifyEgress('registry.npmjs.org:443', []).allowed).toBe(false)
 })
})

describe('parseEgressHost — an operator types this now', => {
 it('accepts an exact host and a subdomain pattern', => {
 expect(parseEgressHost('api.search.example')).toEqual({
 ok: true,
 host: 'api.search.example',
 })
 expect(parseEgressHost('.example.com')).toEqual({ ok: true, host: '.example.com' })
 })

 it('lowercases, so a typed capital cannot become a host that never matches', => {
 expect(parseEgressHost(' API.Example.COM ')).toEqual({ ok: true, host: 'api.example.com' })
 })

 /**
 * Refused rather than narrowed. `registry.npmjs.org.evil.com` matches a wildcard and is
 * not the host anybody meant, and this list is now something a human types rather than a
 * constant this repository reviews.
 */
 it('refuses a wildcard, and says why', => {
 const verdict = parseEgressHost('*.example.com')
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toContain('evil.test')
 })

 it('refuses a URL, a port and a path — this is a host', => {
 expect(parseEgressHost('https://example.com').ok).toBe(false)
 expect(parseEgressHost('example.com:8080').ok).toBe(false)
 expect(parseEgressHost('example.com/search').ok).toBe(false)
 })

 it('refuses a bare word, which would match nothing and look like it works', => {
 expect(parseEgressHost('localhost').ok).toBe(false)
 expect(parseEgressHost('').ok).toBe(false)
 })
})

describe('classifyEgress — a lease may add hosts, never remove them', => {
 /**
 * The union is what makes "off by default" a statement about an agent rather than about
 * a deployment: a run whose persona holds no granting capability reaches exactly the
 * package registries, and one that does reaches those plus what its operator named.
 */
 it('allows a host the lease was granted, on top of the base allowlist', => {
 const base = ['registry.npmjs.org']
 expect(classifyEgress('api.search.example:443', base).allowed).toBe(false)
 expect(classifyEgress('api.search.example:443', [...base, 'api.search.example']).allowed).toBe(
 true,
)
 // The base list still applies — a grant adds, it does not replace.
 expect(classifyEgress('registry.npmjs.org:443', [...base, 'api.search.example']).allowed).toBe(
 true,
)
 })
})
