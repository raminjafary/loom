import { ServerEventSchema, type Contract } from '@loom/api-contract'
import { createDatabase, seedWorkspace, truncateDomainTables } from '@loom/db'
import { asWorkspaceId } from '@loom/domain'
import { buildApp, devAuth, loadConfig, subscriptionTokenMinter, type App } from '@loom/server'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildGateway } from './gateway.js'

/**
 * The full realtime path: HTTP mutation → use-case → Valkey publish → gateway
 * fan-out → browser frame. Every earlier test stubbed part of this; this one
 * stubs nothing, which makes it the test that actually proves Phase 0 works.
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
let gateway: FastifyInstance
let client: ContractRouterClient<Contract>
let workspaceId: string
let wsUrl: string

const nextFrame = (socket: WebSocket, predicate: (value: unknown) => boolean, timeoutMs = 5000) =>
 new Promise<Record<string, unknown>>((resolve, reject) => {
 const timer = setTimeout( => {
 socket.off('message', onMessage)
 reject(new Error(`no matching frame within ${timeoutMs}ms`))
 }, timeoutMs)

 function onMessage(raw: WebSocket.RawData) {
 let parsed: unknown
 try {
 parsed = JSON.parse(raw.toString)
 } catch {
 return
 }
 if (!predicate(parsed)) return
 clearTimeout(timer)
 socket.off('message', onMessage)
 resolve(parsed as Record<string, unknown>)
 }

 socket.on('message', onMessage)
 })

const openSocket = async : Promise<WebSocket> => {
 const socket = new WebSocket(wsUrl)
 await new Promise<void>((resolve, reject) => {
 socket.once('open', => resolve)
 socket.once('error', reject)
 })
 return socket
}

/**
 * Minted the way the server mints, not the way the gateway verifies —
 * a test that built its own token would be checking the verifier against itself.
 *
 * The signing helper is used directly rather than through `client.session.subscriptionToken`
 * only where the target is a workspace this session is not in; the authorised path is
 * exercised through the real procedure below.
 */
const mint = subscriptionTokenMinter(config.WS_SUBSCRIPTION_SECRET)

const subscribedSocket = async (targetWorkspace?: string): Promise<WebSocket> => {
 const token = targetWorkspace
 ? mint(asWorkspaceId(targetWorkspace)).token
: (await client.session.subscriptionToken).token
 const socket = await openSocket
 socket.send(JSON.stringify({ type: 'subscribe', token }))
 await nextFrame(socket, (v) => (v as { type?: string }).type === 'subscribed')
 return socket
}

const closed = (socket: WebSocket, timeoutMs = 2000) =>
 new Promise<void>((resolve, reject) => {
 if (socket.readyState === WebSocket.CLOSED) return resolve
 const timer = setTimeout( => reject(new Error('socket stayed open')), timeoutMs)
 socket.once('close', => {
 clearTimeout(timer)
 resolve
 })
 })

beforeAll(async => {
 const row = await seedWorkspace(db, `realtime-${Date.now}`)
 workspaceId = row.id

 app = await buildApp(config, devAuth({ userId: 'dev-user', workspaceId }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const apiAddress = app.fastify.server.address
 if (apiAddress === null || typeof apiAddress === 'string') throw new Error('no api port')
 client = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${apiAddress.port}/rpc` }))

 gateway = await buildGateway({
 valkeyUrl: config.VALKEY_URL,
 webOrigin: config.WEB_ORIGIN,
 subscriptionSecret: config.WS_SUBSCRIPTION_SECRET,
 })
 await gateway.listen({ port: 0, host: '127.0.0.1' })
 const wsAddress = gateway.server.address
 if (wsAddress === null || typeof wsAddress === 'string') throw new Error('no ws port')
 wsUrl = `ws://127.0.0.1:${wsAddress.port}/ws/client`
})

beforeEach(async => {
 await truncateDomainTables(db)
})

afterAll(async => {
 await gateway.close
 await app.close
 await closeDb
})

describe('realtime fan-out', => {
 it('delivers a posted message to a subscribed client', async => {
 const socket = await subscribedSocket
 const { rootThread } = await client.channel.create({ name: 'realtime' })

 const frame = nextFrame(
 socket,
 (v) => (v as { type?: string }).type === 'message.created',
)
 const posted = await client.message.post({
 threadId: rootThread.id,
 text: 'over the wire',
 })

 const received = await frame
 expect(received.type).toBe('message.created')
 const message = received.message as { id: string; body: { text: string } }
 expect(message.id).toBe(posted.id)
 expect(message.body.text).toBe('over the wire')

 socket.close
 })

 /**
 * The assertion this file was missing, and the reason the thread was not realtime
 * for as long as it had a socket.
 *
 * Every test above reads the delivered frame as raw JSON, which proves the transport
 * and nothing about whether a client can *use* what arrives. A browser does not read
 * raw JSON: `connectRealtime` runs `ServerEventSchema.safeParse` and — correctly, so
 * that control frames are ignored — silently discards anything that fails. So a
 * frame whose timestamps became strings in `JSON.stringify` was delivered, validated
 * against a schema demanding `Date`, rejected, and dropped without a sound, while
 * the connection indicator kept saying "Live".
 *
 * Validating with the contract here is what makes that a test failure rather than a
 * thing a human notices weeks later by watching a run produce nothing.
 */
 it('delivers frames the contract schema accepts, not merely well-formed JSON', async => {
 const socket = await subscribedSocket
 const { rootThread } = await client.channel.create({ name: 'contract-shaped' })

 const frame = nextFrame(socket, (v) => (v as { type?: string }).type === 'message.created')
 await client.message.post({ threadId: rootThread.id, text: 'must survive the socket' })

 const parsed = ServerEventSchema.safeParse(await frame)
 expect(parsed.success, parsed.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')).toBe(true)
 if (parsed.success && parsed.data.type === 'message.created') {
 // Revived, not merely accepted — every consumer treats these as Dates.
 expect(parsed.data.message.createdAt).toBeInstanceOf(Date)
 expect(parsed.data.message.body.text).toBe('must survive the socket')
 }

 socket.close
 })

 it('delivers channel creation frames too', async => {
 const socket = await subscribedSocket
 const frame = nextFrame(
 socket,
 (v) => (v as { type?: string }).type === 'channel.created',
)
 await client.channel.create({ name: 'announcements' })

 const received = await frame
 const channel = received.channel as { name: string }
 expect(channel.name).toBe('announcements')

 socket.close
 })

 it('fans out to every subscriber, not just the first', async => {
 const [a, b] = await Promise.all([subscribedSocket, subscribedSocket])
 const { rootThread } = await client.channel.create({ name: 'broadcast' })

 const frames = Promise.all([
 nextFrame(a, (v) => (v as { type?: string }).type === 'message.created'),
 nextFrame(b, (v) => (v as { type?: string }).type === 'message.created'),
 ])
 await client.message.post({ threadId: rootThread.id, text: 'to both' })

 const [fa, fb] = await frames
 expect((fa.message as { body: { text: string } }).body.text).toBe('to both')
 expect((fb.message as { body: { text: string } }).body.text).toBe('to both')

 a.close
 b.close
 })

 it('does not leak frames across workspace boundaries', async => {
 const other = await seedWorkspace(db, `realtime-other-${Date.now}`)
 const outsider = await subscribedSocket(other.id)

 const { rootThread } = await client.channel.create({ name: 'private-ish' })
 const leaked = nextFrame(
 outsider,
 (v) => (v as { type?: string }).type === 'message.created',
 1200,
)
 await client.message.post({ threadId: rootThread.id, text: 'should not escape' })

 await expect(leaked).rejects.toThrow(/no matching frame/)
 outsider.close
 })

 it('rejects a malformed frame without dropping the connection', async => {
 const socket = await openSocket
 const error = nextFrame(socket, (v) => (v as { type?: string }).type === 'error')
 socket.send('this is not json')

 const received = await error
 expect(received.message).toBe('malformed frame')
 expect(socket.readyState).toBe(WebSocket.OPEN)

 socket.close
 })

 it('refuses a second subscribe on one socket', async => {
 const socket = await subscribedSocket
 const error = nextFrame(socket, (v) => (v as { type?: string }).type === 'error')
 socket.send(JSON.stringify({ type: 'subscribe', token: 'anything' }))

 const received = await error
 expect(received.message).toBe('already subscribed')

 socket.close
 })
})

/**
 * The open-items list — "`/ws/client` is unauthenticated". Before this, the subscribe frame carried
 * a plain `workspaceId`, so any peer that could reach this port named a workspace and
 * received its entire agent transcript. One workspace existing is what hid it.
 *
 * These assert on the transcript actually not arriving, not merely on the refusal frame:
 * an error reply beside an open subscription would look identical from the client's side
 * and leak everything.
 */
describe('subscription authentication', => {
 const attempt = async (frame: unknown) => {
 const socket = await openSocket
 const error = nextFrame(socket, (v) => (v as { type?: string }).type === 'error')
 socket.send(JSON.stringify(frame))
 const received = await error
 await closed(socket)
 return received
 }

 it('refuses a subscribe with no token at all — the frame this gateway used to accept', async => {
 const socket = await openSocket
 const error = nextFrame(socket, (v) => (v as { type?: string }).type === 'error')
 socket.send(JSON.stringify({ type: 'subscribe', workspaceId }))
 expect((await error).message).toBe('expected subscribe frame')
 socket.close
 })

 it('refuses a token signed with the wrong secret', async => {
 const forged = subscriptionTokenMinter('a-different-secret-of-at-least-32-chars')(
 asWorkspaceId(workspaceId),
).token
 expect((await attempt({ type: 'subscribe', token: forged })).message).toBe(
 'subscription refused',
)
 })

 it('refuses an expired token, and says nothing more than it refuses one', async => {
 // A minter with a clock two minutes behind produces a token whose TTL has already run out.
 const stale = subscriptionTokenMinter(config.WS_SUBSCRIPTION_SECRET, => Date.now - 300_000)(
 asWorkspaceId(workspaceId),
).token
 // Identical to the forged case: telling a prober which half failed tells them which to work on.
 expect((await attempt({ type: 'subscribe', token: stale })).message).toBe(
 'subscription refused',
)
 })

 it('refuses a token whose claims were edited after signing', async => {
 const other = await seedWorkspace(db, `realtime-tamper-${Date.now}`)
 const honest = mint(asWorkspaceId(workspaceId))
 const tampered = honest.token.replace(workspaceId, other.id)
 expect(tampered).not.toBe(honest.token)
 expect((await attempt({ type: 'subscribe', token: tampered })).message).toBe(
 'subscription refused',
)
 })

 it('delivers nothing to a refused socket, which is the assertion that matters', async => {
 const socket = await openSocket
 socket.send(JSON.stringify({ type: 'subscribe', token: 'v1.nope.9999999999999.forged' }))
 await closed(socket)

 const { rootThread } = await client.channel.create({ name: 'not-for-you' })
 const leaked = nextFrame(socket, (v) => (v as { type?: string }).type === 'message.created', 1200)
 await client.message.post({ threadId: rootThread.id, text: 'should never arrive' })
 await expect(leaked).rejects.toThrow(/no matching frame/)
 })

 it('closes a browser socket whose Origin is not the one this deployment serves', async => {
 const socket = new WebSocket(wsUrl, { origin: 'http://evil.example' })
 const error = nextFrame(socket, (v) => (v as { type?: string }).type === 'error')
 expect((await error).message).toBe('origin not allowed')
 await closed(socket)
 })

 it('accepts a client that sends no Origin, because a terminal client is one', async => {
 // The contract is client-agnostic; refusing an absent Origin would make the browser
 // the only client that can subscribe.
 const socket = await subscribedSocket
 expect(socket.readyState).toBe(WebSocket.OPEN)
 socket.close
 })
})
