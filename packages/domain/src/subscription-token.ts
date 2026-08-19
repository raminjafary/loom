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
 * the socket then lives as long as it lives. That is the honest limit of a connect-time
 * credential; closing it means re-authorizing an open socket, which needs a session the
 * gateway still does not have.
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
