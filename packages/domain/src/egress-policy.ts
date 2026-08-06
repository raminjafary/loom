/**
 * Deny-by-default network egress (PLAN.md §6 A5/A6). The decision itself is
 * pure so it is testable without a socket; apps/egress-proxy owns the I/O.
 *
 * Honest scope, stated because A5 says to state it: this allowlists by *host*,
 * on the CONNECT tunnel, without decrypting it. That is deliberate — MITM'ing
 * every tunnel to inspect paths would mean a CA inside the sandbox and a much
 * larger attack surface, and it still would not close the real hole. PLAN.md §6
 * A5 already names that hole: the model API call is itself an unblockable
 * exfiltration channel, so the load-bearing control is "secrets never enter the
 * sandbox", not "the sandbox cannot talk out".
 */

export type EgressVerdict =
  | { readonly allowed: true; readonly host: string; readonly port: number }
  | { readonly allowed: false; readonly reason: string }

/**
 * Hosts a run may reach through the proxy, beyond the model API (which is
 * proxied separately, with credential injection). Kept small on purpose: every
 * entry is a place an injected agent could post a repo to.
 *
 * A leading dot means "this domain and its subdomains"; anything else is an
 * exact host match. No wildcards beyond that — `*` patterns invite
 * `registry.npmjs.org.evil.com`.
 */
export const DEFAULT_ALLOWED_EGRESS_HOSTS: readonly string[] = [
  'registry.npmjs.org',
  '.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'proxy.golang.org',
]

const ALLOWED_PORTS = new Set([443])

const hostMatches = (host: string, pattern: string): boolean =>
  pattern.startsWith('.') ? host === pattern.slice(1) || host.endsWith(pattern) : host === pattern

/**
 * `authority` is a CONNECT target: `host:port`. Rejecting a missing or
 * non-numeric port rather than defaulting to 443 keeps a malformed request from
 * being silently normalized into an allowed one.
 */
export const classifyEgress = (
  authority: string,
  allowedHosts: readonly string[],
): EgressVerdict => {
  const lastColon = authority.lastIndexOf(':')
  if (lastColon <= 0) return { allowed: false, reason: `malformed CONNECT target: ${authority}` }

  const host = authority.slice(0, lastColon).toLowerCase()
  const port = Number(authority.slice(lastColon + 1))
  if (!Number.isInteger(port) || port <= 0) {
    return { allowed: false, reason: `malformed CONNECT port: ${authority}` }
  }

  // Plaintext egress is refused outright: it is both an exfiltration channel and
  // a way to fetch tampered dependencies, and nothing a run legitimately needs
  // is HTTP-only in 2026.
  if (!ALLOWED_PORTS.has(port)) {
    return { allowed: false, reason: `egress to port ${port} is not permitted (443 only)` }
  }

  if (!allowedHosts.some((pattern) => hostMatches(host, pattern))) {
    return { allowed: false, reason: `egress to ${host} is not on the allowlist` }
  }

  return { allowed: true, host, port }
}
