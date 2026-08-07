import { classifyEgress, parseUsage, type TokenUsage } from '@loom/domain'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { LeaseRegistry } from './leases.js'

/**
 * The data plane. Two jobs, on one listener, both reachable only
 * from the sandbox network:
 *
 * 1. **Credential-injecting reverse proxy** for the model API, under
 * `/anthropic/*`. The sandbox presents its opaque per-run lease token; this
 * swaps in the real key, which never enters the sandbox. Being on the request
 * path is also what makes cost metering *authoritative* rather than
 * self-reported.
 *
 * 2. **Allowlisting forward proxy** via CONNECT, for everything else a run
 * legitimately needs (package registries). Tunnels are not decrypted — see
 * egress-policy.ts for why that is the honest boundary.
 *
 * Anything else is refused. That is the "deny-by-default" half of the sandbox spec: the
 * sandbox sits on a Docker network with no route off the host, so this process
 * is the only way out, and it answers exactly these two shapes.
 */

/**
 * How the proxy authenticates to the provider. Host-side only either way — this is the
 * secret the credential broker keeps out of the sandbox.
 *
 * `oauth` is the preferred mode: the sandbox presents its lease token in the position a
 * credential would occupy, and this replaces it outright, so no real credential ever
 * enters a run. It also expires in hours rather than never. The token is supplied and
 * refreshed by the Runner over the control plane, because Claude Code keeps it in the
 * host's keychain where a container cannot reach it.
 */
export interface UpstreamAuth {
 /** Current bearer token, or null when the Runner has not supplied one yet. */
 oauthToken: string | null
 /** Fallback when no OAuth token is configured. */
 readonly apiKey: string | null
}

export interface ProxyOptions {
 readonly leases: LeaseRegistry
 readonly upstream: UpstreamAuth
 readonly anthropicBaseUrl: string
 readonly allowedHosts: readonly string[]
 /**
 * Called when a run exceeds its budget cap. Refusing the request is only
 * half of enforcement — something has to stop the run, and the proxy cannot
 * reach a Runner directly.
 */
 readonly onBudgetExhausted?: (runId: string) => void
 readonly log?: (message: string) => void
}

/**
 * Extracts a lease token from an auth header. Accepts Bearer, Basic, and a bare
 * token, because the three clients that present one all do it differently: the
 * Agent SDK sends `x-api-key`/Bearer, and `HTTP_PROXY`-aware tools (npm, curl,
 * git) send Basic credentials taken from the proxy URL's userinfo — which is the
 * only way to give them a proxy credential at all.
 */
const authToken = (header: string | undefined): string | null => {
 if (!header) return null
 const trimmed = header.trim

 const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed)
 if (bearerMatch?.[1]) return bearerMatch[1]

 const basicMatch = /^Basic\s+(.+)$/i.exec(trimmed)
 if (basicMatch?.[1]) {
 const decoded = Buffer.from(basicMatch[1], 'base64').toString('utf8')
 // The username is ignored: only the password carries the token, so callers
 // are free to use any placeholder user.
 const colon = decoded.indexOf(':')
 return colon === -1 ? decoded: decoded.slice(colon + 1)
 }

 return trimmed
}

/**
 * Short hash of a token, for logs. Never the token itself: a refusal log has to be
 * comparable against what was issued without becoming a place credentials leak.
 */
const fingerprint = (token: string | null): string =>
 token === null ? 'none': createHash('sha256').update(token).digest('hex').slice(0, 10)

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
/** Where the sandbox carries its lease token. See handleModelRequest for why. */
export const LEASE_HEADER = 'x-loom-lease'

const STRIPPED_REQUEST_HEADERS = new Set([
 'authorization',
 'x-api-key',
 LEASE_HEADER,
 'host',
 'connection',
 'proxy-authorization',
 'content-length',
 'transfer-encoding',
 'keep-alive',
 'upgrade',
])

/**
 * Absolute-form request targets reduce to their path; anything else is returned
 * unchanged. Deliberately does *not* treat an absolute URL as permission to
 * forward to that host — that would make this an open proxy. It only means "this
 * request was addressed to me", and the path is then matched as usual.
 */
const normalizePath = (target: string): string => {
 if (!/^https?:\/\//i.test(target)) return target
 try {
 const parsed = new URL(target)
 return `${parsed.pathname}${parsed.search}`
 } catch {
 return target
 }
}

export const createEgressProxy = (options: ProxyOptions): Server => {
 const log = options.log ?? ( => {})

 const handleModelRequest = async (
 request: IncomingMessage,
 response: ServerResponse,
 path: string,
): Promise<void> => {
 // `x-loom-lease` first, and it is the channel that actually matters. The Agent
 // SDK's bundled CLI validates ANTHROPIC_API_KEY's shape locally — apparently
 // including a checksum, since a 109-character token passed and a 108-character
 // one did not — and mangles what it forwards. Carrying the lease in a header of
 // our own means authentication never depends on surviving that validator.
 // authorization/x-api-key remain accepted for plain HTTP clients (see the tests).
 const token =
 (typeof request.headers[LEASE_HEADER] === 'string' ? request.headers[LEASE_HEADER]: null) ??
 authToken(request.headers.authorization) ??
 (typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key']: null)
 const lease = options.leases.resolve(token)
 if (!lease) {
 // Logged with the shape of what arrived, never the value. An authenticating
 // proxy that does not record its own refusals is undebuggable: a rejected
 // agent reports only "invalid API key", which says nothing about why.
 log(
 `model request refused: no valid lease. path=${path} auth=${
 request.headers.authorization ? 'authorization': 'none'
 } x-api-key=${request.headers['x-api-key'] ? 'present': 'absent'} tokenLen=${
 token?.length ?? 0
 } presented=${fingerprint(token)} known=[${options.leases.fingerprints.join(', ')}]`,
)
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
 if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase)) continue
 if (typeof value === 'string') headers[key] = value
 }
 // The sandbox's lease is replaced with the real upstream credential here, and only
 // here. OAuth is preferred: it is what the sandbox's fake credentials file
 // makes the CLI send, and it expires in hours rather than never.
 if (options.upstream.oauthToken) {
 headers.authorization = `Bearer ${options.upstream.oauthToken}`
 } else if (options.upstream.apiKey) {
 headers['x-api-key'] = options.upstream.apiKey
 // The sandbox always presents an OAuth-shaped credentials file (it is the only
 // channel the CLI forwards intact), so the CLI declares `oauth-2025-04-20` in
 // anthropic-beta. Forwarding that alongside an API key asks the provider to honour
 // two contradictory auth modes at once. The rest of the beta list is unrelated to
 // auth and is kept — dropping it wholesale would silently disable prompt caching
 // and change what the run costs.
 const beta = headers['anthropic-beta']
 if (typeof beta === 'string') {
 const kept = beta
.split(',')
.map((flag) => flag.trim)
.filter((flag) => flag.length > 0 && !flag.startsWith('oauth-'))
 if (kept.length > 0) headers['anthropic-beta'] = kept.join(',')
 else delete headers['anthropic-beta']
 }
 } else {
 log('model request refused: proxy has no upstream credential configured')
 deny(response, 503, 'the egress proxy has no upstream credential configured')
 return
 }

 if (process.env.LOOM_EGRESS_TRACE_HEADERS === '1') {
 log(`upstream headers: ${JSON.stringify(Object.keys(headers).sort)}`)
 log(`anthropic-beta: ${headers['anthropic-beta'] ?? '(none)'}`)
 }

 let upstream: Response
 try {
 upstream = await fetch(`${options.anthropicBaseUrl}${path}`, {
 method: request.method ?? 'POST',
 headers,
...(body.length > 0 ? { body: new Uint8Array(body) }: {}),
 })
 } catch (error) {
 deny(response, 502, `upstream request failed: ${error instanceof Error ? error.message: String(error)}`)
 return
 }

 const upstreamBody = Buffer.from(await upstream.arrayBuffer)

 // Metering reads the response the provider actually returned, which is the
 // point of doing it here. A streaming response (SSE) carries its
 // usage in a terminal `message_delta` event rather than a JSON body; that is
 // parsed out of the raw text below rather than by buffering a parsed stream.
 const meterable = extractUsagePayload(upstreamBody, upstream.headers.get('content-type'))
 if (meterable) {
 const record = options.leases.meter(lease, meterable.model, meterable.usage)
 log(
 `run ${lease.runId} +$${(record.costUsd ?? 0).toFixed(6)} (total $${record.spentUsd.toFixed(4)}${
 record.capUsd === null ? '': ` of $${record.capUsd.toFixed(2)}`
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
 // A client configured with HTTP_PROXY sends the absolute form
 // (`http://host/path`) rather than a bare path. Normalized here so the model
 // endpoint is reachable either way — the alternative is a confusing "must use
 // CONNECT" refusal for a request that was aimed at this proxy correctly.
 const url = normalizePath(request.url ?? '/')

 if (url === '/healthz') {
 response.writeHead(200, { 'content-type': 'application/json' })
 response.end(JSON.stringify({ status: 'ok' }))
 return
 }

 // Both spellings reach the model endpoint. `/anthropic/*` is the explicit one;
 // `/v1/*` exists because the Agent SDK's bundled CLI discards any path in
 // ANTHROPIC_BASE_URL and requests `/v1/messages` off the bare origin — so the
 // sandbox points at the origin and this is what it actually asks for. Learned by
 // watching it CONNECT straight to api.anthropic.com instead.
 const modelPath = url.startsWith('/anthropic/')
 ? url.slice('/anthropic'.length)
: url.startsWith('/v1/')
 ? url
: null

 if (modelPath !== null) {
 void handleModelRequest(request, response, modelPath).catch((error) => {
 deny(response, 500, error instanceof Error ? error.message: String(error))
 })
 return
 }

 // A plain (non-CONNECT) request for anything else is an attempt to use this
 // as an open forward proxy. Refused rather than tunnelled: allowlisting is
 // done on CONNECT, where the target is explicit.
 deny(response, 403, 'egress must use CONNECT, or the /anthropic model endpoint')
 })

 server.on('connect', (request: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
 // Attached first, before any refusal path. A Duplex with no 'error' listener
 // throws, and an unhandled throw here takes the whole proxy down — which wipes
 // every in-memory lease and cascades into "no valid run lease" for runs that
 // were perfectly valid a moment earlier. That is exactly what happened: a
 // client whose refused CONNECT socket then errored restarted the process
 // mid-run, and the resulting failure looked like an auth bug several layers away.
 clientSocket.on('error', => clientSocket.destroy)

 const refuse = (status: string, reason: string) => {
 log(`CONNECT ${request.url ?? '?'} refused: ${reason}`)
 clientSocket.write(`HTTP/1.1 ${status}\r\n\r\n`)
 clientSocket.end
 }

 // Even an allowlisted host requires a valid lease: the allowlist bounds
 // *where* a run may talk, the lease is what says a run exists at all.
 const lease = options.leases.resolve(authToken(request.headers['proxy-authorization']))
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
 const upstream = netConnect({ host: verdict.host, port: verdict.port }, => {
 clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
 if (head.length > 0) upstream.write(head)
 upstream.pipe(clientSocket)
 clientSocket.pipe(upstream)
 })

 const teardown = => {
 upstream.destroy
 clientSocket.destroy
 }
 upstream.on('error', teardown)
 clientSocket.on('close', teardown)
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
 parsed = JSON.parse(line.slice(5).trim)
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
