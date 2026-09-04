import { describe, expect, it } from 'vitest'
import {
  SUBSCRIPTION_LEASE_MS,
  SUBSCRIPTION_RENEW_EVERY_MS,
  SUBSCRIPTION_TOKEN_TTL_MS,
  formatSubscriptionToken,
  originAllowed,
  parseSubscriptionToken,
  subscriptionRenewalVerdict,
  subscriptionTokenSignedInput,
  subscriptionTokenVerdict,
} from './subscription-token.js'

/**
 * The gateway's credential.
 *
 * The tests worth having are about the ways a token says something nobody signed: a
 * delimiter smuggled into a field, an expiry read before the signature that vouches for
 * it, and a refusal specific enough to tell a prober which half to work on.
 */

const CLAIMS = { workspaceId: 'ws-1', expiresAtMs: 1_000_000 }
const SIGNATURE = 'c2lnbmF0dXJl'

describe('subscriptionTokenSignedInput', () => {
  it('covers the version, the workspace and the expiry', () => {
    expect(subscriptionTokenSignedInput(CLAIMS)).toBe('v1.ws-1.1000000')
  })

  it('refuses a workspace id that could move the field boundary', () => {
    expect(() => subscriptionTokenSignedInput({ ...CLAIMS, workspaceId: 'ws.1' })).toThrow(/"\."/)
  })

  it('refuses an expiry that is not a positive epoch-millisecond integer', () => {
    expect(() => subscriptionTokenSignedInput({ ...CLAIMS, expiresAtMs: 0 })).toThrow(/expiry/)
    expect(() => subscriptionTokenSignedInput({ ...CLAIMS, expiresAtMs: 1.5 })).toThrow(/expiry/)
  })
})

describe('parseSubscriptionToken', () => {
  it('round-trips what was formatted, and reports the exact bytes the signature covers', () => {
    const parsed = parseSubscriptionToken(formatSubscriptionToken(CLAIMS, SIGNATURE))
    expect(parsed?.claims).toEqual(CLAIMS)
    expect(parsed?.signature).toBe(SIGNATURE)
    expect(parsed?.signedInput).toBe('v1.ws-1.1000000')
  })

  it('returns the signed bytes as received rather than reassembling them', () => {
    // A verifier that rebuilds the input from parsed claims would sign its own
    // normalisation of the token instead of the token, and a leading zero is the
    // cheapest way to show the difference.
    const parsed = parseSubscriptionToken(`v1.ws-1.0100.${SIGNATURE}`)
    expect(parsed?.signedInput).toBe('v1.ws-1.0100')
    expect(parsed?.claims.expiresAtMs).toBe(100)
  })

  it.each([
    ['an unknown version', `v2.ws-1.1000000.${SIGNATURE}`],
    ['a missing signature', 'v1.ws-1.1000000'],
    ['an extra field', `v1.ws-1.1000000.${SIGNATURE}.extra`],
    ['a non-numeric expiry', `v1.ws-1.later.${SIGNATURE}`],
    ['a negative expiry', `v1.ws-1.-5.${SIGNATURE}`],
    ['an empty workspace', `v1..1000000.${SIGNATURE}`],
    ['nothing at all', ''],
  ])('refuses %s', (_case, raw) => {
    expect(parseSubscriptionToken(raw)).toBeNull()
  })
})

describe('subscriptionTokenVerdict', () => {
  const token = parseSubscriptionToken(formatSubscriptionToken(CLAIMS, SIGNATURE))

  it('admits a signed, unexpired token and names the workspace it authorises', () => {
    expect(subscriptionTokenVerdict({ token, signatureMatches: true, nowMs: 999_999 })).toEqual({
      ok: true,
      workspaceId: 'ws-1',
    })
  })

  it('refuses an unsigned token, an expired one, and a malformed one identically', () => {
    const reasons = [
      subscriptionTokenVerdict({ token, signatureMatches: false, nowMs: 1 }),
      subscriptionTokenVerdict({ token, signatureMatches: true, nowMs: 1_000_000 }),
      subscriptionTokenVerdict({ token: null, signatureMatches: false, nowMs: 1 }),
    ]
    expect(reasons.every((verdict) => verdict.ok === false)).toBe(true)
    expect(new Set(reasons.map((verdict) => (verdict.ok ? '' : verdict.reason))).size).toBe(1)
  })

  it('does not let an expiry decide anything before the signature has vouched for it', () => {
    // The expiry is attacker-supplied until the signature says otherwise, so a token
    // that is both forged and unexpired must still be refused.
    expect(
      subscriptionTokenVerdict({ token, signatureMatches: false, nowMs: 1 }).ok,
    ).toBe(false)
  })

  it('treats the expiry instant itself as expired', () => {
    expect(subscriptionTokenVerdict({ token, signatureMatches: true, nowMs: 1_000_000 }).ok).toBe(
      false,
    )
  })
})

describe('originAllowed', () => {
  it('allows a client that sends no origin, which is every non-browser one', () => {
    expect(originAllowed(undefined, 'http://localhost:5173')).toBe(true)
    expect(originAllowed('', 'http://localhost:5173')).toBe(true)
  })

  it('refuses a browser that sends a different one', () => {
    expect(originAllowed('http://evil.example', 'http://localhost:5173')).toBe(false)
    expect(originAllowed('http://localhost:5173', 'http://localhost:5173')).toBe(true)
  })
})

describe('the TTL', () => {
  it('is short enough to be a connect-time credential rather than a session', () => {
    expect(SUBSCRIPTION_TOKEN_TTL_MS).toBeLessThanOrEqual(5 * 60_000)
  })
})

/**
 * The lease: what bounds how long one proof is worth, now that a socket can outlive the
 * token that opened it and still be closed for it.
 */
describe('subscriptionRenewalVerdict', () => {
  const parsed = (workspaceId: string, expiresAtMs = 2_000_000) =>
    parseSubscriptionToken(formatSubscriptionToken({ workspaceId, expiresAtMs }, SIGNATURE))

  it('extends the lease from now, not from the token’s expiry', () => {
    // A token about to expire and one just minted are worth the same lease: what the
    // token proves is that the session was live a moment ago, so a client renewing late
    // is not punished with a shorter lease than one renewing early.
    const verdict = subscriptionRenewalVerdict({
      token: parsed('ws-1', 1_000_001),
      signatureMatches: true,
      nowMs: 1_000_000,
      subscribedWorkspaceId: 'ws-1',
    })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.leaseExpiresAtMs).toBe(1_000_000 + SUBSCRIPTION_LEASE_MS)
  })

  it('refuses a valid token for another workspace, rather than moving the socket', () => {
    // The fan-out subscription is fixed at subscribe time, so honouring this would leave
    // the socket reading its old workspace under a new workspace's authority.
    const verdict = subscriptionRenewalVerdict({
      token: parsed('ws-2'),
      signatureMatches: true,
      nowMs: 1_000_000,
      subscribedWorkspaceId: 'ws-1',
    })
    expect(verdict.ok).toBe(false)
  })

  it('refuses an expired or unsigned token with the subscribe’s own sentence', () => {
    const expired = subscriptionRenewalVerdict({
      token: parsed('ws-1', 999),
      signatureMatches: true,
      nowMs: 1_000_000,
      subscribedWorkspaceId: 'ws-1',
    })
    const unsigned = subscriptionRenewalVerdict({
      token: parsed('ws-1'),
      signatureMatches: false,
      nowMs: 1_000_000,
      subscribedWorkspaceId: 'ws-1',
    })
    expect(expired).toEqual({ ok: false, reason: 'subscription refused' })
    // Identical, for the reason the subscribe's are: which half failed is not a
    // prober's business.
    expect(unsigned).toEqual(expired)
  })

  it('renews well inside the lease, so one failed mint is not a dropped stream', () => {
    expect(SUBSCRIPTION_RENEW_EVERY_MS).toBeLessThan(SUBSCRIPTION_LEASE_MS / 2)
  })

  it('keeps the lease a bound rather than a promise of immediacy', () => {
    // Minutes, not the lifetime of a browser tab — and not so short that renewing is
    // most of what a client does.
    expect(SUBSCRIPTION_LEASE_MS).toBeGreaterThan(SUBSCRIPTION_TOKEN_TTL_MS)
    expect(SUBSCRIPTION_LEASE_MS).toBeLessThanOrEqual(60 * 60_000)
  })
})
