import { describe, expect, it } from 'vitest'
import { DEFAULT_ALLOWED_EGRESS_HOSTS, classifyEgress } from './egress-policy.js'

const allow = DEFAULT_ALLOWED_EGRESS_HOSTS

describe('classifyEgress', () => {
  it('allows an allowlisted host on 443', () => {
    expect(classifyEgress('registry.npmjs.org:443', allow)).toEqual({
      allowed: true,
      host: 'registry.npmjs.org',
      port: 443,
    })
  })

  it('denies a host that is not on the allowlist', () => {
    const verdict = classifyEgress('evil.example:443', allow)
    expect(verdict.allowed).toBe(false)
  })

  it('denies a lookalike that merely ends with an allowlisted name', () => {
    // The whole reason patterns are exact-or-dot-prefixed rather than wildcards.
    expect(classifyEgress('registry.npmjs.org.evil.com:443', allow).allowed).toBe(false)
  })

  it('allows a subdomain only under a dot-prefixed pattern', () => {
    expect(classifyEgress('foo.npmjs.org:443', allow).allowed).toBe(true)
    expect(classifyEgress('foo.pypi.org:443', allow).allowed).toBe(false)
  })

  it('denies plaintext and non-443 ports even for an allowlisted host', () => {
    expect(classifyEgress('registry.npmjs.org:80', allow).allowed).toBe(false)
    expect(classifyEgress('registry.npmjs.org:22', allow).allowed).toBe(false)
  })

  it('rejects a malformed target instead of defaulting the port to 443', () => {
    expect(classifyEgress('registry.npmjs.org', allow).allowed).toBe(false)
    expect(classifyEgress('registry.npmjs.org:notaport', allow).allowed).toBe(false)
    expect(classifyEgress(':443', allow).allowed).toBe(false)
  })

  it('matches hosts case-insensitively', () => {
    expect(classifyEgress('REGISTRY.NPMJS.ORG:443', allow).allowed).toBe(true)
  })

  it('denies everything when the allowlist is empty', () => {
    expect(classifyEgress('registry.npmjs.org:443', []).allowed).toBe(false)
  })
})
