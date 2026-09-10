import type { Contract } from '@loom/api-contract'
import { createDatabase, truncateAll } from '@loom/db'
import { parseSubscriptionToken } from '@loom/domain'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp, type App } from './app.js'
import { loadConfig } from './config.js'

/**
 * Drives real Better Auth sign-up over real HTTP, then verifies the resulting
 * session resolves to a workspace-scoped principal through the actual
 * AuthPort used in production — no devAuth override anywhere in this file.
 * This is what proves the auth swap actually works, not just typechecks.
 *
 * Requires `docker compose up -d`.
 */

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long-value',
  WS_SUBSCRIPTION_SECRET: 'test-subscription-secret-at-least-32-chars',
} as NodeJS.ProcessEnv)

const { db, close: closeDb } = createDatabase(config.DATABASE_URL)

let app: App
let baseUrl: string

beforeAll(async () => {
  app = await buildApp(config)
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const address = app.fastify.server.address()
  if (address === null || typeof address === 'string') throw new Error('no bound port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await app.close()
  await closeDb()
})

const extractCookie = (response: Response): string => {
  const setCookie = response.headers.get('set-cookie')
  if (!setCookie) throw new Error('no set-cookie header on sign-up response')
  return setCookie.split(';')[0] ?? ''
}

const signUp = async (email: string): Promise<string> => {
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: 'Test User' }),
  })
  expect(response.status).toBe(200)
  return extractCookie(response)
}

/** A real client, exactly as apps/web would build one, just with a cookie attached. */
const clientAs = (cookie: string): ContractRouterClient<Contract> =>
  createORPCClient(new RPCLink({ url: `${baseUrl}/rpc`, headers: () => ({ cookie }) }))

describe('Better Auth over HTTP', () => {
  /**
   * The realtime gateway's credential, minted over a real session.
   *
   * `realtime.e2e.test.ts` drives the whole socket but through `devAuth`, which trusts a
   * header. The question only this file can answer is whether the *production* AuthPort is
   * what decides which workspace a subscription token authorises — because a token minted
   * from anything a caller supplies is the forgery identity-bound approval exists to close,
   * and this endpoint's entire output is authority.
   */
  it('refuses to mint a subscription token without a session', async () => {
    const anonymous = createORPCClient<ContractRouterClient<Contract>>(
      new RPCLink({ url: `${baseUrl}/rpc` }),
    )
    await expect(anonymous.session.subscriptionToken()).rejects.toThrow()
  })

  it('mints a token for the workspace the session resolves to, never one supplied by the caller', async () => {
    const cookie = await signUp(`realtime-${Date.now()}@example.test`)
    const client = clientAs(cookie)
    const me = await client.session.me()
    const granted = await client.session.subscriptionToken()

    const parsed = parseSubscriptionToken(granted.token)
    expect(parsed).not.toBeNull()
    expect(parsed?.claims.workspaceId).toBe(me.workspaceId)
    expect(granted.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('mints a fresh token each time, which is what a reconnect depends on', async () => {
    // A cached token subscribes at startup and silently fails to resubscribe once it expires —
    // the failure where the connection indicator stays green and nothing arrives.
    const cookie = await signUp(`refresh-${Date.now()}@example.test`)
    const client = clientAs(cookie)
    const first = await client.session.subscriptionToken()
    const second = await client.session.subscriptionToken()
    expect(parseSubscriptionToken(first.token)?.claims.workspaceId).toBe(
      parseSubscriptionToken(second.token)?.claims.workspaceId,
    )
    // Same workspace, and an expiry that has moved: the mint is not a stored value.
    expect(second.expiresAt.getTime()).toBeGreaterThanOrEqual(first.expiresAt.getTime())
  })

  it('rejects an unauthenticated call to /rpc', async () => {
    const anonymous = createORPCClient<ContractRouterClient<Contract>>(
      new RPCLink({ url: `${baseUrl}/rpc` }),
    )
    await expect(anonymous.health()).rejects.toThrow()
  })

  it('signs up, resolves a session, and provisions the default workspace', async () => {
    const cookie = await signUp(`alice-${Date.now()}@example.test`)
    const client = clientAs(cookie)

    const me = await client.session.me()
    expect(me.actor.kind).toBe('user')
    expect(me.workspaceId).toBeTruthy()
  })

  it('gives two different users the same default workspace (Phase 1 single-workspace scope cut)', async () => {
    const cookieA = await signUp(`a-${Date.now()}@example.test`)
    const cookieB = await signUp(`b-${Date.now()}@example.test`)

    const meA = await clientAs(cookieA).session.me()
    const meB = await clientAs(cookieB).session.me()

    expect(meA.workspaceId).toBe(meB.workspaceId)
  })

  it('lets a signed-up user actually use the contract end to end', async () => {
    const cookie = await signUp(`worker-${Date.now()}@example.test`)
    const client = clientAs(cookie)

    const created = await client.channel.create({ name: 'via-better-auth' })
    const posted = await client.message.post({
      threadId: created.rootThread.id,
      text: 'authenticated for real',
    })
    expect(posted.author.kind).toBe('user')
  })

  /**
   * The burst a new user's first page load actually makes.
   *
   * Seeding the built-ins runs on every request and is read-then-write — list what the
   * workspace has, insert what is missing — so half a dozen simultaneous calls against a fresh
   * workspace each found it empty and each inserted the same fourteen personas. One won and the
   * rest came back `500`. What the user saw was a shell that rendered with no personas, no cost
   * summary and no run list, on their very first load, and nothing in the logs said "race".
   *
   * Asserted as *nothing rejected* rather than as a persona count, because the count was always
   * right afterwards — the winner's inserts landed. The defect was entirely in what the other
   * five callers were told.
   */
  it('survives a burst of requests against a workspace that still needs seeding', async () => {
    const cookie = await signUp(`burst-${Date.now()}@example.test`)
    const client = clientAs(cookie)

    /**
     * One built-in removed through the product's own operation, *after* sign-up — because
     * sign-up seeds serially and a burst that arrives to find the work already done races over
     * nothing. A single missing persona is the state that actually recurs: it is what every
     * existing workspace looks like the first time a newly shipped built-in is seen, and what a
     * brand-new one looks like for the length of its first page load.
     *
     * Deleted rather than truncated, so the workspace stays coherent — a bulk truncation leaves
     * teams pointing at personas that no longer exist, which is a state the product cannot
     * produce and which fails for its own unrelated reason.
     */
    const before = await client.persona.list()
    const doomed = before.find((persona) => persona.name === 'prosecutor')
    expect(doomed, 'no prosecutor to delete').toBeDefined()
    await client.persona.delete({ personaId: doomed!.id })

    const results = await Promise.allSettled([
      client.persona.list(),
      client.persona.list(),
      client.persona.list(),
      client.persona.list(),
      client.session.me(),
      client.session.me(),
    ])
    const rejected = results.flatMap((result) =>
      result.status === 'rejected' ? [String(result.reason).slice(0, 120)] : [],
    )
    expect(rejected).toEqual([])
  })

  it('rejects a request with no session cookie at all', async () => {
    const anonymous = createORPCClient<ContractRouterClient<Contract>>(
      new RPCLink({ url: `${baseUrl}/rpc` }),
    )
    await expect(anonymous.session.me()).rejects.toThrow()
  })

  it('rejects a garbage cookie rather than treating it as a valid session', async () => {
    const client = clientAs('better-auth.session_token=not-a-real-token')
    await expect(client.session.me()).rejects.toThrow()
  })
})
