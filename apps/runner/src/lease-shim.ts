import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'

/**
 * A loopback shim inside the sandbox that attaches the run's lease token to model
 * API calls (PLAN.md §6 A6).
 *
 * Why this exists rather than passing the token through the SDK's own env: the
 * bundled CLI validates `ANTHROPIC_API_KEY` locally — prefix, length, and something
 * checksum-like — and then *rewrites* what it forwards. Verified by experiment: a
 * 109-character token arrived at the proxy as 108, later as 102, and an all-zeros
 * placeholder made the CLI send no auth header at all. `ANTHROPIC_CUSTOM_HEADERS`
 * never arrived either. So the token cannot ride on anything the CLI touches.
 *
 * The shim sidesteps all of it. The CLI is pointed at `127.0.0.1` inside its own
 * network namespace, sends whatever key it likes, and this replaces the auth entirely
 * before forwarding to the egress proxy. The CLI's key only has to satisfy the CLI.
 *
 * This is not a weakening of A6: the shim runs inside the sandbox and holds only the
 * opaque per-run lease token, exactly as the sandbox already did. The real credential
 * still lives solely in the proxy.
 */

export interface LeaseShimOptions {
  /** Loopback port the SDK is pointed at via ANTHROPIC_BASE_URL. */
  readonly port: number
  /** Opaque per-run lease token. Never the real model key. */
  readonly leaseToken: string
  /** The egress proxy's data plane, e.g. http://loom-egress:8080. */
  readonly egressUrl: string
  readonly leaseHeader: string
  readonly log?: (message: string) => void
}

/**
 * Headers dropped before forwarding. The CLI's own auth attempt is discarded rather
 * than passed along — it is meaningless to the proxy and, being CLI-rewritten, is
 * exactly the value that could not be trusted to arrive intact.
 */
const DROPPED = new Set(['authorization', 'x-api-key', 'host', 'connection', 'content-length'])

export const startLeaseShim = (options: LeaseShimOptions): Promise<Server> => {
  const log = options.log ?? (() => {})

  const ownAddresses = localAddresses()

  const server = createServer((request, response) => {
    void (async () => {
      // Bound on all interfaces rather than loopback, because the CLI ignores a
      // loopback ANTHROPIC_BASE_URL and goes straight to api.anthropic.com. That
      // means siblings on the shared sandbox network could otherwise reach this and
      // spend another run's budget, so the shim answers only its own container.
      const remote = request.socket.remoteAddress ?? ''
      if (!ownAddresses.has(normalizeAddress(remote))) {
        log(`refusing shim request from ${remote}`)
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ type: 'error', error: { type: 'shim_denied', message: 'not this sandbox' } }),
        )
        return
      }

      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)

      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(request.headers)) {
        if (DROPPED.has(key.toLowerCase())) continue
        if (typeof value === 'string') headers[key] = value
      }
      headers[options.leaseHeader] = options.leaseToken

      try {
        const upstream = await fetch(`${options.egressUrl}${request.url ?? '/'}`, {
          method: request.method ?? 'POST',
          headers,
          ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
        })
        const payload = Buffer.from(await upstream.arrayBuffer())
        const outHeaders: Record<string, string> = {}
        upstream.headers.forEach((value, key) => {
          // Re-adding these would contradict the body actually being written here.
          if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') {
            return
          }
          outHeaders[key] = value
        })
        response.writeHead(upstream.status, outHeaders)
        response.end(payload)
      } catch (error) {
        log(`lease shim upstream failed: ${error instanceof Error ? error.message : String(error)}`)
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ type: 'error', error: { type: 'shim_error', message: 'egress proxy unreachable' } }),
        )
      }
    })()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '0.0.0.0', () => resolve(server))
  })
}

/** IPv6-mapped IPv4 (`::ffff:172.19.0.3`) reduces to its IPv4 form. */
const normalizeAddress = (address: string): string => address.replace(/^::ffff:/, '')

/**
 * Every address this container answers on, so the shim can tell "my own agent" from
 * "a different sandbox on the same network".
 */
const localAddresses = (): Set<string> => {
  const addresses = new Set(['127.0.0.1', '::1'])
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(normalizeAddress(entry.address))
  }
  return addresses
}
