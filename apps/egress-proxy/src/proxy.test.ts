import { DEFAULT_ALLOWED_EGRESS_HOSTS } from '@loom/domain'
import { createServer, type Server } from 'node:http'
import { connect as netConnect } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLeaseRegistry, type UsageRecord } from './leases.js'
import { createEgressProxy } from './proxy.js'

/**
 * Drives the real proxy over real HTTP against a stub "provider". What matters
 * here is the security behaviour, not the plumbing: the sandbox's token is
 * swapped for the real key, an unleased caller gets nothing, and metering reads
 * the provider's own response rather than trusting a caller's claim (PLAN.md
 * §6 A6).
 */

const REAL_KEY = 'sk-real-key-never-in-the-sandbox'

let upstream: Server
let upstreamUrl: string
let proxy: Server
let proxyUrl: string
let usage: UsageRecord[]
let exhausted: string[]
let leases: ReturnType<typeof createLeaseRegistry>
/** What the stub provider saw, so tests can assert on the injected credential. */
let lastUpstreamHeaders: Record<string, string | string[] | undefined> = {}

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no bound port')
      resolve(address.port)
    })
  })

beforeAll(async () => {
  upstream = createServer((request, response) => {
    lastUpstreamHeaders = request.headers
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        model: 'claude-sonnet-5',
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      }),
    )
  })
  upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`

  usage = []
  exhausted = []
  leases = createLeaseRegistry({ onUsage: (record) => usage.push(record) })
  proxy = createEgressProxy({
    leases,
    anthropicApiKey: REAL_KEY,
    anthropicBaseUrl: upstreamUrl,
    allowedHosts: DEFAULT_ALLOWED_EGRESS_HOSTS,
    onBudgetExhausted: (runId) => exhausted.push(runId),
  })
  proxyUrl = `http://127.0.0.1:${await listen(proxy)}`
})

afterAll(async () => {
  proxy.close()
  upstream.close()
})

const post = (token: string | null, path = '/anthropic/v1/messages') =>
  fetch(`${proxyUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
  })

describe('egress proxy: credential injection', () => {
  it('swaps the sandbox lease token for the real key', async () => {
    const lease = leases.issue({ runId: 'run-inject', budgetCapUsd: null })
    const response = await post(lease.token)
    expect(response.status).toBe(200)

    // The whole point of A6: the sandbox held an opaque token, the provider saw
    // the real key, and the two never met.
    expect(lastUpstreamHeaders['x-api-key']).toBe(REAL_KEY)
    expect(lastUpstreamHeaders.authorization).toBeUndefined()
    expect(JSON.stringify(lastUpstreamHeaders)).not.toContain(lease.token)

    leases.revoke('run-inject')
  })

  it('refuses a caller with no lease', async () => {
    expect((await post(null)).status).toBe(401)
    expect((await post('a-token-nobody-issued')).status).toBe(401)
  })

  it('refuses a revoked lease', async () => {
    const lease = leases.issue({ runId: 'run-revoked', budgetCapUsd: null })
    leases.revoke('run-revoked')
    expect((await post(lease.token)).status).toBe(401)
  })

  it('accepts an absolute-form target, as a proxy-configured client sends', async () => {
    // A client with HTTP_PROXY set sends `http://host/path`, not `/path`. The
    // sandbox's SDK does exactly this, and treating it as a forward-proxy attempt
    // refused a request that was aimed here correctly.
    const lease = leases.issue({ runId: 'run-absolute', budgetCapUsd: null })
    const response = await fetch(`${proxyUrl}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
    })
    expect(response.status).toBe(200)

    // Normalizing the absolute form must not turn this into an open proxy: an
    // absolute URL means "addressed to me", never "forward me to that host".
    const openProxy = await fetch(`${proxyUrl}/anything-else`, {
      headers: { authorization: `Bearer ${lease.token}` },
    })
    expect(openProxy.status).toBe(403)

    leases.revoke('run-absolute')
  })

  it('refuses to act as an open forward proxy over plain HTTP', async () => {
    const lease = leases.issue({ runId: 'run-open', budgetCapUsd: null })
    const response = await fetch(`${proxyUrl}/http://evil.example/`, {
      headers: { authorization: `Bearer ${lease.token}` },
    })
    expect(response.status).toBe(403)
    leases.revoke('run-open')
  })
})

/**
 * The CONNECT path's refusals, which is the half that matters for A5. The
 * allow-and-tunnel case would need a real TLS upstream to prove anything the
 * policy unit tests don't already cover (see egress-policy.test.ts), so it is
 * left to the live check rather than simulated here.
 */
describe('egress proxy: CONNECT allowlist', () => {
  const connectStatus = (authority: string, token: string | null): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = netConnect(Number(new URL(proxyUrl).port), '127.0.0.1', () => {
        socket.write(
          `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
            (token === null ? '' : `Proxy-Authorization: Bearer ${token}\r\n`) +
            '\r\n',
        )
      })
      socket.once('data', (chunk: Buffer) => {
        resolve(chunk.toString('utf8').split('\r\n')[0] ?? '')
        socket.destroy()
      })
      socket.once('error', reject)
      setTimeout(() => reject(new Error('no CONNECT response')), 4000)
    })

  it('requires a lease even for an allowlisted host', async () => {
    expect(await connectStatus('registry.npmjs.org:443', null)).toContain('407')
  })

  it('refuses a host that is not on the allowlist', async () => {
    const lease = leases.issue({ runId: 'run-connect', budgetCapUsd: null })
    expect(await connectStatus('evil.example:443', lease.token)).toContain('403')
    // Plaintext is refused even for an allowlisted host.
    expect(await connectStatus('registry.npmjs.org:80', lease.token)).toContain('403')
    leases.revoke('run-connect')
  })
})

describe('egress proxy: metering and budget caps', () => {
  it('meters from the provider response, not from the caller', async () => {
    const lease = leases.issue({ runId: 'run-meter', budgetCapUsd: null })
    usage.length = 0
    await post(lease.token)

    const record = usage.at(-1)
    if (!record) throw new Error('expected a metered record')
    // The stub reports 1M input tokens on sonnet ($3/MTok) regardless of what the
    // request body claimed — that asymmetry is what "authoritative" means.
    expect(record.runId).toBe('run-meter')
    expect(record.costUsd).toBeCloseTo(3)
    expect(record.spentUsd).toBeCloseTo(3)

    leases.revoke('run-meter')
  })

  it('signals exhaustion and then refuses further calls once a cap is passed', async () => {
    const lease = leases.issue({ runId: 'run-cap', budgetCapUsd: 1 })
    exhausted.length = 0

    // First call succeeds and is what breaches the cap: enforcement cannot be
    // pre-emptive, since the cost of a turn is only known once it returns.
    expect((await post(lease.token)).status).toBe(200)
    expect(exhausted).toContain('run-cap')

    // The next one is refused outright, so a blown budget cannot buy another turn
    // while the kill propagates.
    const second = await post(lease.token)
    expect(second.status).toBe(402)
    expect(await second.text()).toContain('budget cap')

    leases.revoke('run-cap')
  })

  it('carries spend across a re-lease so reconnecting cannot reset a budget', async () => {
    const first = leases.issue({ runId: 'run-release', budgetCapUsd: 10 })
    await post(first.token)
    const second = leases.issue({ runId: 'run-release', budgetCapUsd: 10 })

    expect(second.spentUsd).toBeCloseTo(3)
    expect(second.token).not.toBe(first.token)
    // The old token is dead, so a re-lease leaves no usable orphan behind.
    expect((await post(first.token)).status).toBe(401)

    leases.revoke('run-release')
  })
})
