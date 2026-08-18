/**
 * Deny-by-default network egress. The decision itself is
 * pure so it is testable without a socket; apps/egress-proxy owns the I/O.
 *
 * Honest scope, stated because the sandbox spec says to state it: this allowlists by *host*,
 * on the CONNECT tunnel, without decrypting it. That is deliberate — MITM'ing
 * every tunnel to inspect paths would mean a CA inside the sandbox and a much
 * larger attack surface, and it still would not close the real hole. The security model
 * the sandbox spec already names that hole: the model API call is itself an unblockable
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

/**
 * Whether an operator-authored host pattern is one this policy can honour.
 *
 * The same grammar the default list uses and nothing wider: a leading dot means "this
 * domain and its subdomains", anything else is an exact host. **No `*` patterns**, because
 * `registry.npmjs.org.evil.com` matches one and is not the host anybody meant — and this
 * list is now something a human types rather than a constant this repository reviews.
 *
 * Refused rather than sanitized. A pattern silently narrowed would be an allowlist entry
 * that does not say what it does, on the one control that decides where a compromised
 * agent can post a repository.
 */
export const parseEgressHost = (
 raw: string,
): { readonly ok: true; readonly host: string } | { readonly ok: false; readonly reason: string } => {
 const host = raw.trim.toLowerCase
 if (host.length === 0) return { ok: false, reason: 'An allowed host cannot be blank' }
 if (host.includes('*')) {
 return {
 ok: false,
 reason:
 `"${host}" uses a wildcard, and this allowlist has none. A leading dot covers ` +
 'subdomains — ".example.com" — and anything else must be an exact host, because ' +
 '"example.com.evil.test" matches a wildcard and is not the host you meant.',
 }
 }
 if (host.includes('/') || host.includes(':')) {
 return {
 ok: false,
 reason: `"${host}" is a host, not a URL — no scheme, no path, no port (443 only).`,
 }
 }
 if (!/^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
 return { ok: false, reason: `"${host}" is not a hostname` }
 }
 return { ok: true, host }
}

const ALLOWED_PORTS = new Set([443])

const hostMatches = (host: string, pattern: string): boolean =>
 pattern.startsWith('.') ? host === pattern.slice(1) || host.endsWith(pattern): host === pattern

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

 const host = authority.slice(0, lastColon).toLowerCase
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

/**
 * One recorded egress decision.
 *
 * the egress record's first increment, and the only one available without decrypting a tunnel: the CONNECT
 * authority is in the clear, so *who asked for what and what happened* is knowable even
 * though the traffic is not. Until now a refusal reached a Runner's stdout and nowhere else,
 * which left nobody able to answer "what did this run try to reach" after the fact — an audit
 * gap, and the reason an allowlist gets widened by guesswork.
 *
 * **`host` is untrusted text.** It comes from a CONNECT line a sandboxed process wrote, so
 * everything downstream treats it as data and `truncateEgressHost` bounds
 * it: a decision record is written to an audit log and rendered in a UI, and a 40KB host is
 * the cheapest way to make either of those a problem.
 */
export interface EgressDecision {
 readonly runId: string
 readonly host: string
 readonly port: number
 readonly allowed: boolean
 /** Why it was refused. Empty for an allowed decision — there is no reason to record. */
 readonly reason: string
 readonly at: Date
}

/**
 * The longest host a decision record keeps.
 *
 * 253 is the maximum length of a DNS name, so anything longer was never a host and its only
 * possible purpose is to be stored. Truncated rather than dropped: the fact that a run asked
 * for something malformed is exactly the kind of thing this record exists to preserve.
 */
export const MAX_EGRESS_HOST_CHARS = 253

export const truncateEgressHost = (host: string): string =>
 host.length <= MAX_EGRESS_HOST_CHARS ? host: `${host.slice(0, MAX_EGRESS_HOST_CHARS)}…`

/**
 * A refused decision as an operator-facing line.
 *
 * The wording is deliberately about *what to do*: a refusal that only says "denied" produces
 * an allowlist edited by guesswork, and the egress record's whole complaint about today's behaviour is that
 * nothing records what asked. The host is quoted because it is model-adjacent text and a
 * reader should see its edges.
 */
export const describeEgressRefusal = (decision: EgressDecision): string =>
 `Refused: "${truncateEgressHost(decision.host)}" on port ${decision.port}. ${decision.reason}. ` +
 'If this run should reach that host, grant it on the capability the persona holds — ' +
 'the deployment allowlist is not the place for one agent\'s dependency.'
