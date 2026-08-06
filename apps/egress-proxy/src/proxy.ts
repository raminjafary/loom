import { classifyEgress, parseUsage, type TokenUsage } from '@loom/domain'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { LeaseRegistry } from './leases.js'

/**
 * The data plane (PLAN.md §6 A6). Two jobs, on one listener, both reachable only
 * from the sandbox network:
 *
 * 1. **Credential-injecting reverse proxy** for the model API, under
 *    `/anthropic/*`. The sandbox presents its opaque per-run lease token; this
 *    swaps in the real key, which never enters the sandbox. Being on the request
 *    path is also what makes cost metering *authoritative* rather than
 *    self-reported (§6 A6).
 *
 * 2. **Allowlisting forward proxy** via CONNECT, for everything else a run
 *    legitimately needs (package registries). Tunnels are not decrypted — see
 *    egress-policy.ts for why that is the honest boundary.
 *
 * Anything else is refused. That is the "deny-by-default" half of A5: the
 * sandbox sits on a Docker network with no route off the host, so this process
 * is the only way out, and it answers exactly these two shapes.
 */

export interface ProxyOptions {
  readonly leases: LeaseRegistry
  /** The real model API key. Host-side only — this is the secret A6 keeps out of the sandbox. */
  readonly anthropicApiKey: string
  readonly anthropicBaseUrl: string
  readonly allowedHosts: readonly string[]
  /**
   * Called when a run exceeds its budget cap (PLAN.md §6 "enforced budget caps
   * ... and a hard kill, metered at the proxy"). Refusing the request is only
   * half of enforcement — something has to stop the run, and the proxy cannot
   * reach a Runner directly.
   */
  readonly onBudgetExhausted?: (runId: string) => void
  readonly log?: (message: string) => void
}

const bearer = (header: string | undefined): string | null => {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? header.trim()
}

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const deny = (response: ServerResponse, status: number, message: string): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  // Shaped like a provider error so the agent SDK surfaces it as an API failure
  // it already knows how to report, rather than as unparseable garbage.
  response.end(JSON.stringify({ type: 'error', error: { type: 'proxy_denied', message } }))
}

/**
 * Headers that must not be forwarded upstream. `authorization`/`x-api-key` carry
 * the sandbox's lease token, which is meaningless to the provider and must be
 * replaced, not passed along; the hop-by-hop ones are per-connection by
 * definition and re-adding them corrupts the upstream request.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'host',
  'connection',
  'proxy-authorization',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
])

export const createEgressProxy = (options: ProxyOptions): Server => {
  const log = options.log ?? (() => {})

  const handleModelRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> => {
    const token =
      bearer(request.headers.authorization) ??
      (typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : null)
    const lease = options.leases.resolve(token)
    if (!lease) {
      deny(response, 401, 'no valid run lease presented')
      return
    }

    // Checked before forwarding, not just after metering: a run whose cap is
    // already blown must not get one more turn's worth of spend in while its
    // abort propagates.
    if (lease.exhausted) {
      deny(
        response,
        402,
        `run ${lease.runId} has reached its budget cap of $${lease.budgetCapUsd?.toFixed(2) ?? '0'}`,
      )
      return
    }

    const body = await readBody(request)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers)) {
      if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue
      if (typeof value === 'string') headers[key] = value
    }
    headers['x-api-key'] = options.anthropicApiKey

    let upstream: Response
    try {
      upstream = await fetch(`${options.anthropicBaseUrl}${path}`, {
        method: request.method ?? 'POST',
        headers,
        ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
      })
    } catch (error) {
      deny(response, 502, `upstream request failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const upstreamBody = Buffer.from(await upstream.arrayBuffer())

    // Metering reads the response the provider actually returned, which is the
    // point of doing it here (§6 A6). A streaming response (SSE) carries its
    // usage in a terminal `message_delta` event rather than a JSON body; that is
    // parsed out of the raw text below rather than by buffering a parsed stream.
    const meterable = extractUsagePayload(upstreamBody, upstream.headers.get('content-type'))
    if (meterable) {
      const record = options.leases.meter(lease, meterable.model, meterable.usage)
      log(
        `run ${lease.runId} +$${(record.costUsd ?? 0).toFixed(6)} (total $${record.spentUsd.toFixed(4)}${
          record.capUsd === null ? '' : ` of $${record.capUsd.toFixed(2)}`
        })`,
      )
      if (record.exhausted) {
        log(`run ${lease.runId} exhausted its budget cap — signalling a kill`)
        options.onBudgetExhausted?.(lease.runId)
      }
    }

    const outHeaders: Record<string, string> = {}
    upstream.headers.forEach((value, key) => {
      if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return
      outHeaders[key] = value
    })
    response.writeHead(upstream.status, outHeaders)
    response.end(upstreamBody)
  }

  const server = createServer((request, response) => {
    const url = request.url ?? '/'

    if (url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (url.startsWith('/anthropic/')) {
      void handleModelRequest(request, response, url.slice('/anthropic'.length)).catch((error) => {
        deny(response, 500, error instanceof Error ? error.message : String(error))
      })
      return
    }

    // A plain (non-CONNECT) request for anything else is an attempt to use this
    // as an open forward proxy. Refused rather than tunnelled: allowlisting is
    // done on CONNECT, where the target is explicit.
    deny(response, 403, 'egress must use CONNECT, or the /anthropic model endpoint')
  })

  server.on('connect', (request: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    const refuse = (status: string, reason: string) => {
      log(`CONNECT ${request.url ?? '?'} refused: ${reason}`)
      clientSocket.write(`HTTP/1.1 ${status}\r\n\r\n`)
      clientSocket.end()
    }

    // Even an allowlisted host requires a valid lease: the allowlist bounds
    // *where* a run may talk, the lease is what says a run exists at all.
    const lease = options.leases.resolve(bearer(request.headers['proxy-authorization']))
    if (!lease) {
      refuse('407 Proxy Authentication Required', 'no valid run lease presented')
      return
    }

    const verdict = classifyEgress(request.url ?? '', options.allowedHosts)
    if (!verdict.allowed) {
      refuse('403 Forbidden', verdict.reason)
      return
    }

    // Plain TCP, deliberately not a TLS connection. The client performs its own
    // TLS handshake end-to-end *through* this tunnel, so the proxy must forward
    // opaque bytes; terminating TLS here would wrap the client's own handshake in
    // a second one and the upstream would see nothing it could parse.
    //
    // It is also what makes the "no decryption" claim in egress-policy.ts true:
    // the proxy never holds a session key for this traffic.
    const upstream = netConnect({ host: verdict.host, port: verdict.port }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })

    const teardown = () => {
      upstream.destroy()
      clientSocket.destroy()
    }
    upstream.on('error', teardown)
    clientSocket.on('error', teardown)
  })

  return server
}

/**
 * Pulls a `(model, usage)` pair out of an upstream response, whether it came
 * back as a single JSON body or as an SSE stream.
 *
 * The stream case matters: the agent SDK streams, so if only JSON bodies were
 * metered the proxy would report every real run as free — which is exactly the
 * "authoritative metering" claim failing silently. Streamed usage arrives split
 * across `message_start` (input/cache counts and the model) and `message_delta`
 * (output count), so both are collected before pricing.
 */
const extractUsagePayload = (
  body: Buffer,
  contentType: string | null,
): { model: string; usage: TokenUsage } | null => {
  const text = body.toString('utf8')

  if (contentType?.includes('text/event-stream')) {
    let model: string | null = null
    let inputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let outputTokens = 0

    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line.slice(5).trim())
      } catch {
        continue
      }
      const event = parsed as {
        type?: string
        message?: { model?: string; usage?: unknown }
        usage?: unknown
      }
      if (event.type === 'message_start' && event.message) {
        if (typeof event.message.model === 'string') model = event.message.model
        const usage = parseUsage(event.message)
        if (usage) {
          inputTokens = usage.inputTokens
          cacheReadTokens = usage.cacheReadTokens
          cacheWriteTokens = usage.cacheWriteTokens
          // message_start also reports output_tokens, but only the handful
          // generated so far; message_delta carries the final count.
        }
      }
      if (event.type === 'message_delta') {
        const usage = parseUsage(event)
        if (usage && usage.outputTokens > 0) outputTokens = usage.outputTokens
      }
    }

    if (!model) return null
    return { model, usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const usage = parseUsage(parsed)
  const model = (parsed as { model?: unknown }).model
  if (!usage || typeof model !== 'string') return null
  return { model, usage }
}
