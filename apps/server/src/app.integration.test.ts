import { contract, type Contract } from '@loom/api-contract'
import { createDatabase, seedWorkspace, truncateDomainTables } from '@loom/db'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import webpush from 'web-push'
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

/**
 * Real keys, generated per run: `webpush.setVapidDetails` validates their
 * shape, so hard-coded placeholders would fail at adapter construction and a
 * test with no keys at all could not exercise the subscribe path (an
 * unconfigured deployment refuses to register a target, by design).
 */
const vapidKeys = webpush.generateVAPIDKeys

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long-value',
 SERVER_PORT: '0',
 VAPID_PUBLIC_KEY: vapidKeys.publicKey,
 VAPID_PRIVATE_KEY: vapidKeys.privateKey,
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

 /**
 * The kill switch. `truncateDomainTables` deliberately spares
 * `workspace` (see packages/db/src/testing.ts), and the pause flag lives on
 * that row — so this test must resume before it ends, or every later test in
 * the file inherits a paused workspace.
 */
 it('pauses and resumes runs workspace-wide', async => {
 expect((await client.runControl.get).paused).toBe(false)

 const paused = await client.runControl.pauseAll
 expect(paused.control.paused).toBe(true)
 expect(paused.control.pausedByUserId).toBe('dev-user')
 // Nothing was in flight, so nothing to cancel — the flag is the point here.
 expect(paused.cancelledRunIds).toEqual([])
 expect((await client.runControl.get).paused).toBe(true)

 const resumed = await client.runControl.resume
 expect(resumed.paused).toBe(false)
 expect(resumed.pausedAt).toBeNull
 expect(resumed.pausedByUserId).toBeNull
 })

 it('rejects starting a run while the workspace is paused', async => {
 await client.runControl.pauseAll
 try {
 // Rejected before any lookup of thread/repo/persona, so the ids below
 // never need to exist — that ordering is the assertion.
 await expect(
 client.agentRun.start({
 threadId: '00000000-0000-0000-0000-000000000000',
 repositoryId: '00000000-0000-0000-0000-000000000000',
 personaId: '00000000-0000-0000-0000-000000000000',
 }),
).rejects.toThrow(/paused/i)
 } finally {
 await client.runControl.resume
 }
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
 'mergeQueue',
 'persona',
 'capability',
 'personaGroup',
 'agentRun',
 'runControl',
 'notification',
 'approval',
 ])
 expect(Object.keys(contract.channel)).toEqual(['list', 'create', 'rootThread'])
 expect(Object.keys(contract.message)).toEqual(['list', 'post', 'backfill'])
 expect(Object.keys(contract.runner)).toEqual(['list', 'createPairingToken'])
 expect(Object.keys(contract.repository)).toEqual([
 'list',
 'bindExisting',
 'listDirectory',
 'createNew',
 'setVerifyCommand',
 ])
 expect(Object.keys(contract.mergeQueue)).toEqual(['list', 'enqueue', 'cancel'])
 expect(Object.keys(contract.persona)).toEqual(['list', 'get', 'create', 'update'])
 expect(Object.keys(contract.personaGroup)).toEqual(['list', 'create', 'update', 'delete'])
 expect(Object.keys(contract.agentRun)).toEqual([
 'start',
 'get',
 'getActive',
 'listActive',
 'listChildren',
 'getDiff',
 'getRawTranscript',
 'keep',
 'discard',
 'push',
 'listNeedsAttention',
 ])
 expect(Object.keys(contract.runControl)).toEqual(['get', 'pauseAll', 'resume'])
 expect(Object.keys(contract.notification)).toEqual(['config', 'subscribe', 'unsubscribe'])
 expect(Object.keys(contract.approval)).toEqual(['listPending', 'decide'])
 })
})

/**
 * Notification targets over the real wire. This app is built
 * with real VAPID keys generated at setup, since an unconfigured deployment
 * refuses to register a target at all — which is itself asserted below.
 */
describe('notification targets', => {
 const endpoint = 'https://push.example.com/subscription/abc123'

 it('reports the transport and public key a client needs to subscribe', async => {
 const pushConfig = await client.notification.config
 expect(pushConfig.transport).toBe('web_push')
 expect(pushConfig.publicKey).toBe(vapidKeys.publicKey)
 })

 it('registers a target and upserts on a re-subscribe rather than duplicating it', async => {
 const first = await client.notification.subscribe({
 transport: 'web_push',
 endpoint,
 credentials: { p256dh: 'key-one', auth: 'auth-one' },
 })
 expect(first.endpoint).toBe(endpoint)
 // Write-only: the keys the browser gave us are never echoed back.
 expect(Object.keys(first)).not.toContain('credentials')

 const second = await client.notification.subscribe({
 transport: 'web_push',
 endpoint,
 credentials: { p256dh: 'key-two', auth: 'auth-two' },
 })
 // Same row, refreshed — a browser whose subscription rotated must not leave
 // a dead target behind that every later delivery retries.
 expect(second.id).toBe(first.id)
 })

 it('unsubscribes an endpoint, and treats an unknown one as already gone', async => {
 await client.notification.subscribe({
 transport: 'web_push',
 endpoint,
 credentials: { p256dh: 'k', auth: 'a' },
 })
 await expect(client.notification.unsubscribe({ endpoint })).resolves.toEqual({ ok: true })
 await expect(client.notification.unsubscribe({ endpoint })).resolves.toEqual({ ok: true })
 })

 it('refuses to register a target on a deployment with no notification transport', async => {
 const unconfigured = await buildApp(
 {...config, VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined },
 devAuth({ userId: 'dev-user', workspaceId }),
)
 await unconfigured.fastify.listen({ port: 0, host: '127.0.0.1' })
 try {
 const address = unconfigured.fastify.server.address
 if (address === null || typeof address === 'string') throw new Error('no bound port')
 const other: ContractRouterClient<Contract> = createORPCClient(
 new RPCLink({ url: `http://127.0.0.1:${address.port}/rpc` }),
)

 expect(await other.notification.config).toEqual({ transport: null, publicKey: null })
 // Better a clear refusal than a stored target nothing will ever deliver to.
 await expect(
 other.notification.subscribe({
 transport: 'web_push',
 endpoint,
 credentials: { p256dh: 'k', auth: 'a' },
 }),
).rejects.toThrow
 } finally {
 await unconfigured.close
 }
 })
})
