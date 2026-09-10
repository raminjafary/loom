import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { peerIsRefused, type Cidr } from './control-peers.js'
import { z } from 'zod'
import type { EgressDecision } from '@loom/domain'
import type { LeaseRegistry, UsageRecord } from './leases.js'

/**
 * The control plane. Deliberately a *second* listener rather
 * than more routes on the data plane: the data plane is reachable from inside
 * the sandbox, and lease issuance must not be.
 *
 * **A connection from the sandbox network is destroyed before it is read.** The listener
 * answers on every interface — it has to, because the Runner is a host process reaching a
 * published port, and a published port connects to the container's network interface — so
 * "not reachable from a sandbox" is enforced at accept time rather than by a bind address.
 * `control-peers.ts` carries the argument and works out which network that is.
 *
 * The secret is still checked, and it is still the thing that authenticates the caller. What
 * changed is that it is no longer the *only* barrier: it used to be all that stood between a
 * sandboxed agent and a lease for any run id, a sibling's revocation, or a drain of the
 * queues the Runner had not read yet.
 *
 * Only the Runner calls it — the host-side, trusted component that already holds
 * the authority to start and stop runs.
 */

const LeaseRequestSchema = z.object({
  runId: z.string().min(1),
  /** Null or absent means unmetered: no cap to enforce. */
  budgetCapUsd: z.number().positive().nullish(),
  /**
   * Hosts this run may reach beyond the deployment allowlist.
   *
   * Bounded here as well as validated server-side, because this endpoint is the boundary
   * a compromised Runner would push through: the control secret authenticates the
   * Runner, and a Runner is a machine an operator paired, not a trusted author of policy.
   */
  egressHosts: z.array(z.string().min(1).max(253)).max(32).optional(),
})

/** Null clears the token, e.g. when the Runner finds the host is no longer logged in. */
const UpstreamAuthSchema = z.object({ oauthToken: z.string().min(1).nullable() })

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
  /**
   * Egress decisions, drained the same way and for the same reason.
   *
   * Bounded by the caller, not here: this queue grows while nobody drains it, and a Runner
   * that has been disconnected for an hour must not be able to turn a refused-host loop into
   * this process's memory problem. See `main.ts`.
   */
  egressDecisionQueue: EgressDecision[]
  setOauthToken: (token: string | null) => void
  /**
   * Networks whose connections are dropped at accept time — the sandbox's, in every
   * deployment that has one. Empty means the old behaviour, where the secret is the only
   * barrier; `main.ts` says so out loud at startup rather than letting it pass for a
   * configured refusal.
   */
  refusedNetworks?: readonly Cidr[]
  /** Called when a connection is dropped, so the operator sees an attempt rather than a silence. */
  onRefusedPeer?: (remoteAddress: string) => void
}): Server => {
  const server = createServer((request, response) => {
    void (async () => {
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

      /**
       * Egress decisions, drain-on-read like usage above.
       *
       * Same shape deliberately: one polling loop in the Runner, one authenticated path to
       * the server, and one rule about what a drained record means — that it has been handed
       * over exactly once, so whoever took it owns forwarding it.
       */
      if (request.method === 'GET' && url === '/_control/egress-decisions') {
        const drained = options.egressDecisionQueue.splice(0, options.egressDecisionQueue.length)
        json(response, 200, { decisions: drained })
        return
      }

      json(response, 404, { error: 'no such control endpoint' })
    })().catch((error) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  /**
   * Before the request line, not after it: an HTTP-level 403 would still have parsed a
   * sandbox's bytes and told it there is something here to talk to. Destroyed, so what a
   * run sees is a connection that closes.
   */
  const refused = options.refusedNetworks ?? []
  if (refused.length > 0) {
    server.on('connection', (socket) => {
      if (!peerIsRefused(socket.remoteAddress, refused)) return
      options.onRefusedPeer?.(socket.remoteAddress ?? 'unknown')
      socket.destroy()
    })
  }

  return server
}
