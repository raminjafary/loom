import type { Contract } from '@loom/api-contract'
import { createDatabase, truncateAll } from '@loom/db'
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
 * This is what proves the swap in the tech stack actually works, not just
 * typechecks.
 *
 * Requires `docker compose up -d`.
 */

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long-value',
} as NodeJS.ProcessEnv)

const { db, close: closeDb } = createDatabase(config.DATABASE_URL)

let app: App
let baseUrl: string

beforeAll(async => {
 app = await buildApp(config)
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const address = app.fastify.server.address
 if (address === null || typeof address === 'string') throw new Error('no bound port')
 baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async => {
 await truncateAll(db)
})

afterAll(async => {
 await app.close
 await closeDb
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
 createORPCClient(new RPCLink({ url: `${baseUrl}/rpc`, headers: => ({ cookie }) }))

describe('Better Auth over HTTP', => {
 it('rejects an unauthenticated call to /rpc', async => {
 const anonymous = createORPCClient<ContractRouterClient<Contract>>(
 new RPCLink({ url: `${baseUrl}/rpc` }),
)
 await expect(anonymous.health).rejects.toThrow
 })

 it('signs up, resolves a session, and provisions the default workspace', async => {
 const cookie = await signUp(`alice-${Date.now}@example.test`)
 const client = clientAs(cookie)

 const me = await client.session.me
 expect(me.actor.kind).toBe('user')
 expect(me.workspaceId).toBeTruthy
 })

 it('gives two different users the same default workspace (Phase 1 single-workspace scope cut)', async => {
 const cookieA = await signUp(`a-${Date.now}@example.test`)
 const cookieB = await signUp(`b-${Date.now}@example.test`)

 const meA = await clientAs(cookieA).session.me
 const meB = await clientAs(cookieB).session.me

 expect(meA.workspaceId).toBe(meB.workspaceId)
 })

 it('lets a signed-up user actually use the contract end to end', async => {
 const cookie = await signUp(`worker-${Date.now}@example.test`)
 const client = clientAs(cookie)

 const created = await client.channel.create({ name: 'via-better-auth' })
 const posted = await client.message.post({
 threadId: created.rootThread.id,
 text: 'authenticated for real',
 })
 expect(posted.author.kind).toBe('user')
 })

 it('rejects a request with no session cookie at all', async => {
 const anonymous = createORPCClient<ContractRouterClient<Contract>>(
 new RPCLink({ url: `${baseUrl}/rpc` }),
)
 await expect(anonymous.session.me).rejects.toThrow
 })

 it('rejects a garbage cookie rather than treating it as a valid session', async => {
 const client = clientAs('better-auth.session_token=not-a-real-token')
 await expect(client.session.me).rejects.toThrow
 })
})
