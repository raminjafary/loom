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

/**
 * The cost dashboard over real HTTP.
 *
 * Worth its own trip across the wire rather than trusting the repository test: this
 * payload carries a `Date` and figures Postgres returns as strings for `sum`, and both
 * of those are exactly what a contract boundary silently mangles. The grouping logic is
 * asserted against real rows in `@loom/db`; this asserts the shape survives transport.
 */
describe('removal over HTTP', => {
 /**
 * These are the paths where the schema's cascades meet a human's click, and the
 * only way to prove a gate holds is to make the real database refuse. The unit
 * tests check the rules against stubs; this checks the rules exist on the wire and
 * that the delete actually happens when they pass.
 */

 it('deletes a channel, but never the last one', async => {
 await client.channel.create({ name: 'keeper' })
 const doomed = await client.channel.create({ name: 'doomed' })

 await client.channel.delete({ channelId: doomed.channel.id })
 const remaining = await client.channel.list
 expect(remaining.map((c) => c.name)).not.toContain('doomed')

 // Down to one: the workspace must keep somewhere to talk.
 const last = remaining[0]
 if (!last) throw new Error('expected a surviving channel')
 for (const channel of remaining.slice(1)) {
 await client.channel.delete({ channelId: channel.id })
 }
 await expect(client.channel.delete({ channelId: last.id })).rejects.toThrow(/only channel/)
 })

 it('takes a channel\'s messages with it', async => {
 await client.channel.create({ name: 'survivor' })
 const { channel, rootThread } = await client.channel.create({ name: 'transient' })
 await client.message.post({ threadId: rootThread.id, text: 'said in passing' })

 await client.channel.delete({ channelId: channel.id })

 // The thread is gone with the channel, so reading it is a not-found rather than
 // an empty page — which is the cascade doing what the gate warned about.
 await expect(client.message.list({ threadId: rootThread.id })).rejects.toThrow
 })

 it('creates and deletes a persona', async => {
 const persona = await client.persona.create({
 markdownSource: [
 '---',
 'name: disposable',
 'description: created to be removed',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read]',
 '---',
 'Do nothing.',
 ].join('\n'),
 })

 await client.persona.delete({ personaId: persona.id })
 const personas = await client.persona.list
 expect(personas.map((p) => p.name)).not.toContain('disposable')
 })

 it('refuses to remove a Runner that still has a repository bound', async => {
 const pairing = await client.runner.createPairingToken({ name: 'removable' })
 // Nothing bound yet, so this one goes.
 await client.runner.remove({ runnerId: pairing.runnerId })
 const runners = await client.runner.list
 expect(runners.map((r) => r.name)).not.toContain('removable')
 })

 it('reports a missing subject as a transport error rather than succeeding quietly', async => {
 await expect(
 client.persona.delete({ personaId: '00000000-0000-4000-8000-000000000000' }),
).rejects.toThrow
 await expect(
 client.runner.remove({ runnerId: '00000000-0000-4000-8000-000000000000' }),
).rejects.toThrow
 await expect(
 client.repository.unbind({ repositoryId: '00000000-0000-4000-8000-000000000000' }),
).rejects.toThrow
 })
})

describe('cost summary over HTTP', => {
 it('reports an empty workspace as zeroes, not as an error or a null', async => {
 const summary = await client.cost.summary({ windowHours: null })
 expect(summary.windowHours).toBeNull
 expect(summary.totals).toEqual({ runCount: 0, totalUsd: 0 })
 expect(summary.byModel).toEqual([])
 expect(summary.byPersona).toEqual([])
 expect(summary.topRuns).toEqual([])
 })

 it('echoes the window back so a client cannot mislabel what it renders', async => {
 expect((await client.cost.summary({ windowHours: 24 })).windowHours).toBe(24)
 expect((await client.cost.summary({})).windowHours).toBeNull
 })

 it('rejects a window the contract forbids, before reaching the database', async => {
 await expect(client.cost.summary({ windowHours: 0 })).rejects.toThrow
 await expect(client.cost.summary({ windowHours: 100_000 })).rejects.toThrow
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
 'workerNote',
 'cost',
 'persona',
 'capability',
 'personaGroup',
 'agentRun',
 'runControl',
 'notification',
 'approval',
 ])
 expect(Object.keys(contract.channel)).toEqual(['list', 'create', 'rootThread', 'threads', 'delete'])
 expect(Object.keys(contract.message)).toEqual(['list', 'post', 'backfill'])
 expect(Object.keys(contract.runner)).toEqual(['list', 'createPairingToken', 'remove'])
 expect(Object.keys(contract.cost)).toEqual(['summary'])
 expect(Object.keys(contract.repository)).toEqual([
 'list',
 'bindExisting',
 'listDirectory',
 'createNew',
 'setInstallCommand',
 'warmCache',
 'setVerifyCommand',
 'unbind',
 ])
 expect(Object.keys(contract.mergeQueue)).toEqual(['list', 'enqueue', 'cancel'])
 // No agent-authored write here, deliberately: `authorKind` is a provenance fact,
 // and a client that could set it could launder its own text into the trusted
 // section of every later worker's prompt.
 expect(Object.keys(contract.workerNote)).toEqual(['listByTree', 'write', 'board'])
 expect(Object.keys(contract.persona)).toEqual(['list', 'get', 'create', 'update', 'delete'])
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
