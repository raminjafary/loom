import { contract, type Contract } from '@loom/api-contract'
import { createDatabase, seedWorkspace, truncateDomainTables } from '@loom/db'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type App } from './app.js'
import { devAuth } from './auth.js'
import { loadConfig } from './config.js'

/**
 * Drives the real oRPC contract over real HTTP against real Postgres and
 * Valkey. This is what proves the wire boundary works — the unit tests only
 * prove the use-cases do.
 *
 * Requires `docker compose up -d`.
 */

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long-value',
 SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const { db, close: closeDb } = createDatabase(config.DATABASE_URL)

let app: App
let client: ContractRouterClient<Contract>
let workspaceId: string
let baseUrl: string

beforeAll(async => {
 const row = await seedWorkspace(db, `server-test-${Date.now}`)
 workspaceId = row.id

 app = await buildApp(config, devAuth({ userId: 'dev-user', workspaceId }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })

 const address = app.fastify.server.address
 if (address === null || typeof address === 'string') throw new Error('no bound port')
 baseUrl = `http://127.0.0.1:${address.port}/rpc`

 client = createORPCClient(new RPCLink({ url: baseUrl }))
})

beforeEach(async => {
 await truncateDomainTables(db)
})

afterAll(async => {
 await app.close
 await closeDb
})

describe('contract over HTTP', => {
 it('serves health', async => {
 const result = await client.health
 expect(result.status).toBe('ok')
 expect(result.time).toBeInstanceOf(Date)
 })

 it('creates a channel and lists it back', async => {
 const created = await client.channel.create({ name: 'engineering' })
 expect(created.channel.name).toBe('engineering')
 expect(created.rootThread.isRoot).toBe(true)

 const channels = await client.channel.list
 expect(channels.map((c) => c.name)).toEqual(['engineering'])
 })

 it('round-trips a message with a Date preserved across the wire', async => {
 const { rootThread } = await client.channel.create({ name: 'general' })

 const posted = await client.message.post({ threadId: rootThread.id, text: 'hello' })
 expect(posted.body).toEqual({ kind: 'text', text: 'hello' })
 expect(posted.author).toEqual({ kind: 'user', userId: 'dev-user' })
 // oRPC preserves Date over the wire; a string here means the codec regressed.
 expect(posted.createdAt).toBeInstanceOf(Date)

 const page = await client.message.list({ threadId: rootThread.id })
 expect(page.messages).toHaveLength(1)
 expect(page.nextCursor).toBeNull
 })

 it('maps a domain validation failure to a transport error', async => {
 await client.channel.create({ name: 'duplicate' })
 await expect(client.channel.create({ name: 'duplicate' })).rejects.toThrow
 })

 it('maps a missing thread to a transport error', async => {
 await expect(
 client.message.post({
 threadId: '00000000-0000-4000-8000-000000000000',
 text: 'nowhere',
 }),
).rejects.toThrow
 })

 it('rejects input the contract schema forbids, before reaching the domain', async => {
 // Contract says name is min 2 chars; this must fail at the boundary.
 await expect(client.channel.create({ name: 'x' })).rejects.toThrow
 })

 it('pages with a cursor over HTTP', async => {
 const { rootThread } = await client.channel.create({ name: 'paging' })
 for (let i = 1; i <= 3; i += 1) {
 await client.message.post({ threadId: rootThread.id, text: `m${i}` })
 }

 const first = await client.message.list({ threadId: rootThread.id, limit: 2 })
 expect(first.messages.map((m) => m.body.text)).toEqual(['m3', 'm2'])
 expect(first.nextCursor).not.toBeNull

 const second = await client.message.list({
 threadId: rootThread.id,
 limit: 2,
 cursor: first.nextCursor ?? undefined,
 })
 expect(second.messages.map((m) => m.body.text)).toEqual(['m1'])
 expect(second.nextCursor).toBeNull
 })

 it('rejects an unauthenticated caller', async => {
 const anonymous = await buildApp(config, { resolve: async => null })
 await anonymous.fastify.listen({ port: 0, host: '127.0.0.1' })
 const address = anonymous.fastify.server.address
 if (address === null || typeof address === 'string') throw new Error('no bound port')

 const anonClient: ContractRouterClient<Contract> = createORPCClient(
 new RPCLink({ url: `http://127.0.0.1:${address.port}/rpc` }),
)
 await expect(anonClient.health).rejects.toThrow
 await anonymous.close
 })
})

describe('contract completeness', => {
 it('exposes every declared procedure on the client', => {
 // Guards the contract-first rule: the contract is the only surface, so a procedure
 // declared but not implemented must be caught here rather than at runtime.
 expect(Object.keys(contract)).toEqual([
 'health',
 'session',
 'channel',
 'message',
 'runner',
 'repository',
 'agentRun',
 'approval',
 ])
 expect(Object.keys(contract.channel)).toEqual(['list', 'create', 'rootThread'])
 expect(Object.keys(contract.message)).toEqual(['list', 'post', 'backfill'])
 expect(Object.keys(contract.runner)).toEqual(['createPairingToken'])
 expect(Object.keys(contract.repository)).toEqual(['list', 'bindExisting'])
 expect(Object.keys(contract.agentRun)).toEqual(['start', 'get'])
 expect(Object.keys(contract.approval)).toEqual(['listPending', 'decide'])
 })
})
