import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { LeaseRegistry, UsageRecord } from './leases.js'

/**
 * The control plane. Deliberately a *second* listener rather
 * than more routes on the data plane: the data plane is reachable from inside
 * the sandbox, and lease issuance must not be. Bound to loopback and published
 * only to the host, so a run cannot reach this port even knowing the secret.
 *
 * Only the Runner calls it — the host-side, trusted component that already holds
 * the authority to start and stop runs.
 */

const LeaseRequestSchema = z.object({
 runId: z.string.min(1),
 /** Null or absent means unmetered: no cap to enforce. */
 budgetCapUsd: z.number.positive.nullish,
 /**
 * Hosts this run may reach beyond the deployment allowlist.
 *
 * Bounded here as well as validated server-side, because this endpoint is the boundary
 * a compromised Runner would push through: the control secret authenticates the
 * Runner, and a Runner is a machine an operator paired, not a trusted author of policy.
 */
 egressHosts: z.array(z.string.min(1).max(253)).max(32).optional,
})

/** Null clears the token, e.g. when the Runner finds the host is no longer logged in. */
const UpstreamAuthSchema = z.object({ oauthToken: z.string.min(1).nullable })

const constantTimeEquals = (a: string, b: string): boolean => {
 const left = Buffer.from(a)
 const right = Buffer.from(b)
 // timingSafeEqual throws on a length mismatch, which would itself leak length.
 if (left.length !== right.length) return false
 return timingSafeEqual(left, right)
}

const json = (response: ServerResponse, status: number, payload: unknown): void => {
 response.writeHead(status, { 'content-type': 'application/json' })
 response.end(JSON.stringify(payload))
}

const readJson = async (request: IncomingMessage): Promise<unknown> => {
 const chunks: Buffer[] = []
 for await (const chunk of request) chunks.push(chunk as Buffer)
 if (chunks.length === 0) return {}
 try {
 return JSON.parse(Buffer.concat(chunks).toString('utf8'))
 } catch {
 return null
 }
}

export const createControlServer = (options: {
 leases: LeaseRegistry
 controlSecret: string
 /** Drained by the Runner so metered spend reaches the server over the socket it already trusts. */
 usageQueue: UsageRecord[]
 setOauthToken: (token: string | null) => void
}): Server =>
 createServer((request, response) => {
 void (async => {
 const secret = request.headers['x-loom-control-secret']
 if (typeof secret !== 'string' || !constantTimeEquals(secret, options.controlSecret)) {
 json(response, 401, { error: 'invalid control secret' })
 return
 }

 const url = request.url ?? '/'

 if (request.method === 'POST' && url === '/_control/lease') {
 const parsed = LeaseRequestSchema.safeParse(await readJson(request))
 if (!parsed.success) {
 json(response, 400, { error: 'malformed lease request' })
 return
 }
 const lease = options.leases.issue({
 runId: parsed.data.runId,
 budgetCapUsd: parsed.data.budgetCapUsd ?? null,
 egressHosts: parsed.data.egressHosts ?? [],
 })
 // The token is the only thing that crosses into the sandbox. The real
 // credential stays in this process.
 json(response, 200, {
 token: lease.token,
 spentUsd: lease.spentUsd,
 budgetCapUsd: lease.budgetCapUsd,
 })
 return
 }

 /**
 * The Runner supplies (and periodically refreshes) the upstream OAuth token
 *. It lives host-side in the operator's keychain, which a
 * container cannot read, so the trusted host-side component pushes it here rather
 * than the proxy reaching for it.
 *
 * Held in memory only, like leases: a credential that outlives the process that
 * was given it is one nobody revoked.
 */
 if (request.method === 'PUT' && url === '/_control/upstream-auth') {
 const parsed = UpstreamAuthSchema.safeParse(await readJson(request))
 if (!parsed.success) {
 json(response, 400, { error: 'malformed upstream auth' })
 return
 }
 options.setOauthToken(parsed.data.oauthToken)
 json(response, 200, { ok: true })
 return
 }

 if (request.method === 'DELETE' && url.startsWith('/_control/lease/')) {
 const runId = decodeURIComponent(url.slice('/_control/lease/'.length))
 json(response, 200, { revoked: options.leases.revoke(runId) })
 return
 }

 /**
 * Drain-on-read rather than a push to the server: the proxy holds no
 * server session and adding one would be a third authenticated surface.
 * The Runner polls this and forwards spend over its existing /ws/runner
 * socket, so metered cost reaches the database through a path that is
 * already authenticated and already trusted with run state.
 */
 if (request.method === 'GET' && url === '/_control/usage') {
 const drained = options.usageQueue.splice(0, options.usageQueue.length)
 json(response, 200, { records: drained })
 return
 }

 json(response, 404, { error: 'no such control endpoint' })
 }).catch((error) => {
 json(response, 500, { error: error instanceof Error ? error.message: String(error) })
 })
 })
