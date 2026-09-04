/**
 * The realtime gateway's proof of who is asking.
 *
 * The gateway is stateless by design: it holds no database connection, so it has nothing
 * to check a session against, and giving it one would make the fan-out service a second
 * place that knows about workspaces. So the server — which does have the session — mints a
 * short-lived token that says one thing, "the bearer may read this workspace's stream",
 * and the gateway verifies it with a shared secret and nothing else.
 *
 * This module owns the *format* and the *verdict*. The HMAC is computed in the adapters,
 * where `node:crypto` lives, and the two adapters are deliberately different programs:
 * apps/server signs and never verifies, apps/ws-gateway verifies and never signs. There is
 * no shared implementation to drift because there is no shared implementation.
 *
 * What the token does **not** do: authorize each frame. It authorizes the subscribe, and
 * the stream then flows without a per-frame check — the fan-out payload is already shaped
 * for that workspace, and a check per frame would be a check of the same fact thousands of
 * times.
 *
 * What it *does* now do is bound how long one proof is worth. A subscription is a **lease**:
 * the subscribe grants one, the bearer renews it by presenting a *fresh* token, and a socket
 * whose lease lapses is closed. That closes the earlier limit — a socket outliving the token
 * that opened it, and therefore outliving the session behind it — without giving this process
 * a session to check: renewing means minting, minting happens on the server, and the server
 * is the thing that has the session. The authority stays exactly where it was.
 *
 * The bound is a bound and not an eviction: a revoked session keeps its stream until the
 * current lease lapses, which is minutes rather than the lifetime of a browser tab.
 */

/** Bumped when the signed input changes shape, so an old token is refused rather than misread. */
export const SUBSCRIPTION_TOKEN_VERSION = 'v1'

/**
 * Two minutes. The token is minted immediately before a connect and used immediately
 * after, so anything longer is only a longer replay window; anything shorter starts
 * failing on ordinary latency. No skew grace: the server and the gateway share a
 * deployment, and two clocks that have drifted should say so loudly rather than quietly
 * widening the window.
 */
export const SUBSCRIPTION_TOKEN_TTL_MS = 120_000

/**
 * How long one proof keeps a socket alive.
 *
 * Fifteen minutes, and the number is a trade rather than a preference. A lease as short as
 * the token's own two minutes would cost a mint per client every two minutes for no gain —
 * the thing being bounded is how long a *revoked* session keeps reading, and nobody's
 * revocation is urgent to the minute. Much longer and the lease stops being a bound at all.
 */
export const SUBSCRIPTION_LEASE_MS = 15 * 60_000

/**
 * When a subscriber renews: comfortably inside the lease, so one failed mint — a server
 * restarting, a network blip — is a retry rather than a dropped stream.
 */
export const SUBSCRIPTION_RENEW_EVERY_MS = 5 * 60_000

export interface SubscriptionTokenClaims {
  readonly workspaceId: string
  /** Absolute, epoch milliseconds. Absolute rather than a duration so the bearer cannot extend it. */
  readonly expiresAtMs: number
}

export interface ParsedSubscriptionToken {
  readonly claims: SubscriptionTokenClaims
  /** Exactly the bytes the signature covers — never reassembled by the verifier. */
  readonly signedInput: string
  readonly signature: string
}

/**
 * `.` separates the fields, so a workspace id containing one could move the boundary and
 * make a token parse as claims nobody signed. Ids here are uuids and never contain one;
 * this refuses rather than assumes, because "it cannot happen" is how a delimiter injection
 * gets shipped.
 */
const isSignableField = (value: string): boolean => value.length > 0 && !value.includes('.')

/** The bytes an adapter signs. Never sent on its own — `formatSubscriptionToken` appends the signature. */
export const subscriptionTokenSignedInput = (claims: SubscriptionTokenClaims): string => {
  if (!isSignableField(claims.workspaceId)) {
    throw new Error('workspace id cannot be put in a subscription token: it contains a "."')
  }
  if (!Number.isSafeInteger(claims.expiresAtMs) || claims.expiresAtMs <= 0) {
    throw new Error('subscription token expiry must be a positive epoch-millisecond integer')
  }
  return `${SUBSCRIPTION_TOKEN_VERSION}.${claims.workspaceId}.${claims.expiresAtMs}`
}

export const formatSubscriptionToken = (
  claims: SubscriptionTokenClaims,
  signature: string,
): string => {
  if (!isSignableField(signature)) {
    throw new Error('subscription token signature cannot contain a "."')
  }
  return `${subscriptionTokenSignedInput(claims)}.${signature}`
}

/**
 * Returns null for anything that is not a well-formed token of a version this build knows.
 * A caller must not distinguish "malformed" from "wrong signature" to its client — see
 * `subscriptionTokenVerdict`.
 */
export const parseSubscriptionToken = (raw: string): ParsedSubscriptionToken | null => {
  const parts = raw.split('.')
  if (parts.length !== 4) return null
  const [version, workspaceId, expiresAt, signature] = parts as [string, string, string, string]
  if (version !== SUBSCRIPTION_TOKEN_VERSION) return null
  if (workspaceId.length === 0 || signature.length === 0) return null
  if (!/^[0-9]+$/.test(expiresAt)) return null
  const expiresAtMs = Number(expiresAt)
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) return null
  return {
    claims: { workspaceId, expiresAtMs },
    signedInput: `${version}.${workspaceId}.${expiresAt}`,
    signature,
  }
}

export type SubscriptionTokenVerdict =
  | { readonly ok: true; readonly workspaceId: string }
  | { readonly ok: false; readonly reason: string }

/**
 * The order is the point: shape, then signature, then expiry.
 *
 * Expiry is checked **after** the signature because `expiresAtMs` is attacker-supplied
 * until the signature says otherwise — reporting "expired" for an unsigned token answers a
 * question about a claim nobody made. And every failure returns the same sentence, because
 * "bad signature" and "expired" together tell a prober which half to work on.
 */
export const subscriptionTokenVerdict = (input: {
  readonly token: ParsedSubscriptionToken | null
  readonly signatureMatches: boolean
  readonly nowMs: number
}): SubscriptionTokenVerdict => {
  const refused = { ok: false as const, reason: 'subscription refused' }
  if (!input.token) return refused
  if (!input.signatureMatches) return refused
  if (input.token.claims.expiresAtMs <= input.nowMs) return refused
  return { ok: true, workspaceId: input.token.claims.workspaceId }
}

export type SubscriptionRenewalVerdict =
  | { readonly ok: true; readonly leaseExpiresAtMs: number }
  | { readonly ok: false; readonly reason: string }

/**
 * Whether a renewal extends this socket's lease.
 *
 * The token is verified exactly as a subscribe's is — same order, same single sentence for
 * every failure — and then one rule that only exists for a renewal: **it must name the
 * workspace this socket is already subscribed to.** A valid token for another workspace is
 * refused rather than honoured, because the fan-out subscription is fixed at subscribe time:
 * accepting it would either leave the socket reading its old workspace under a new
 * workspace's authority, or make a renewal frame a workspace switch. Reconnecting is the way
 * to read a different workspace.
 *
 * The lease is granted from *now*, not from the token's expiry: the token proves the session
 * was live a moment ago, which is what the lease is a bound on. A token about to expire and
 * one just minted are worth the same lease, so a client is never punished for renewing late.
 */
export const subscriptionRenewalVerdict = (input: {
  readonly token: ParsedSubscriptionToken | null
  readonly signatureMatches: boolean
  readonly nowMs: number
  /** The workspace this socket subscribed to. A renewal may not move it. */
  readonly subscribedWorkspaceId: string
}): SubscriptionRenewalVerdict => {
  const refused = { ok: false as const, reason: 'subscription refused' }
  const verdict = subscriptionTokenVerdict(input)
  if (!verdict.ok) return refused
  if (verdict.workspaceId !== input.subscribedWorkspaceId) return refused
  return { ok: true, leaseExpiresAtMs: input.nowMs + SUBSCRIPTION_LEASE_MS }
}

/**
 * Whether a browser's `Origin` is one this deployment serves.
 *
 * Absent is allowed, and that is deliberate rather than lax: The contract is
 * client-agnostic, a terminal client sends no `Origin` at all, and a check that refused
 * one would make the browser the only client that can subscribe. A *present* origin is
 * checked, because a browser that sends the wrong one is a page that should not be here.
 * The token is the authentication; this is a second, weaker fence that costs nothing.
 */
export const originAllowed = (origin: string | undefined, webOrigin: string): boolean => {
  if (origin === undefined || origin === '') return true
  return origin === webOrigin
}
