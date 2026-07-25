import { type Contract } from '@loom/api-contract'
import { createDatabase, seedWorkspace, truncateDomainTables } from '@loom/db'
import { buildApp, devAuth, loadConfig, type App } from '@loom/server'
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
} as NodeJS.ProcessEnv)
const { db, close: closeDb } = createDatabase(config.DATABASE_URL)

let app: App
let gateway: FastifyInstance
let client: ContractRouterClient<Contract>
let workspaceId: string
let wsUrl: string

const nextFrame = (socket: WebSocket, predicate: (value: unknown) => boolean, timeoutMs = 5000) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error(`no matching frame within ${timeoutMs}ms`))
    }, timeoutMs)

    function onMessage(raw: WebSocket.RawData) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString())
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

const openSocket = async (): Promise<WebSocket> => {
  const socket = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return socket
}

const subscribedSocket = async (targetWorkspace = workspaceId): Promise<WebSocket> => {
  const socket = await openSocket()
  socket.send(JSON.stringify({ type: 'subscribe', workspaceId: targetWorkspace }))
  await nextFrame(socket, (v) => (v as { type?: string }).type === 'subscribed')
  return socket
}

beforeAll(async () => {
  const row = await seedWorkspace(db, `realtime-${Date.now()}`)
  workspaceId = row.id

  app = await buildApp(config, devAuth({ userId: 'dev-user', workspaceId }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const apiAddress = app.fastify.server.address()
  if (apiAddress === null || typeof apiAddress === 'string') throw new Error('no api port')
  client = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${apiAddress.port}/rpc` }))

  gateway = await buildGateway({
    valkeyUrl: config.VALKEY_URL,
    webOrigin: config.WEB_ORIGIN,
  })
  await gateway.listen({ port: 0, host: '127.0.0.1' })
  const wsAddress = gateway.server.address()
  if (wsAddress === null || typeof wsAddress === 'string') throw new Error('no ws port')
  wsUrl = `ws://127.0.0.1:${wsAddress.port}/ws/client`
})

beforeEach(async () => {
  await truncateDomainTables(db)
})

afterAll(async () => {
  await gateway.close()
  await app.close()
  await closeDb()
})

describe('realtime fan-out', () => {
  it('delivers a posted message to a subscribed client', async () => {
    const socket = await subscribedSocket()
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

    socket.close()
  })

  it('delivers channel creation frames too', async () => {
    const socket = await subscribedSocket()
    const frame = nextFrame(
      socket,
      (v) => (v as { type?: string }).type === 'channel.created',
    )
    await client.channel.create({ name: 'announcements' })

    const received = await frame
    const channel = received.channel as { name: string }
    expect(channel.name).toBe('announcements')

    socket.close()
  })

  it('fans out to every subscriber, not just the first', async () => {
    const [a, b] = await Promise.all([subscribedSocket(), subscribedSocket()])
    const { rootThread } = await client.channel.create({ name: 'broadcast' })

    const frames = Promise.all([
      nextFrame(a, (v) => (v as { type?: string }).type === 'message.created'),
      nextFrame(b, (v) => (v as { type?: string }).type === 'message.created'),
    ])
    await client.message.post({ threadId: rootThread.id, text: 'to both' })

    const [fa, fb] = await frames
    expect((fa.message as { body: { text: string } }).body.text).toBe('to both')
    expect((fb.message as { body: { text: string } }).body.text).toBe('to both')

    a.close()
    b.close()
  })

  it('does not leak frames across workspace boundaries', async () => {
    const other = await seedWorkspace(db, `realtime-other-${Date.now()}`)
    const outsider = await subscribedSocket(other.id)

    const { rootThread } = await client.channel.create({ name: 'private-ish' })
    const leaked = nextFrame(
      outsider,
      (v) => (v as { type?: string }).type === 'message.created',
      1200,
    )
    await client.message.post({ threadId: rootThread.id, text: 'should not escape' })

    await expect(leaked).rejects.toThrow(/no matching frame/)
    outsider.close()
  })

  it('rejects a malformed frame without dropping the connection', async () => {
    const socket = await openSocket()
    const error = nextFrame(socket, (v) => (v as { type?: string }).type === 'error')
    socket.send('this is not json')

    const received = await error
    expect(received.message).toBe('malformed frame')
    expect(socket.readyState).toBe(WebSocket.OPEN)

    socket.close()
  })

  it('refuses a second subscribe on one socket', async () => {
    const socket = await subscribedSocket()
    const error = nextFrame(socket, (v) => (v as { type?: string }).type === 'error')
    socket.send(JSON.stringify({ type: 'subscribe', workspaceId }))

    const received = await error
    expect(received.message).toBe('already subscribed')

    socket.close()
  })

})
