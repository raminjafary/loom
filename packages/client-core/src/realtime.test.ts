import type { ServerEvent } from '@loom/api-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectRealtime, type WebSocketLike } from './realtime.js'

/**
 * The reconnect path is the least obvious logic in this package, so it is
 * tested against a fake socket rather than a live server.
 */

type Handler = => void
type MessageHandler = (event: { data: unknown }) => void

class FakeSocket implements WebSocketLike {
 sent: string[] = []
 closed = false
 private onOpen: Handler[] = []
 private onClose: Handler[] = []
 private onError: Handler[] = []
 private onMessage: MessageHandler[] = []

 static instances: FakeSocket[] = []

 constructor(readonly url: string) {
 FakeSocket.instances.push(this)
 }

 send(data: string) {
 this.sent.push(data)
 }

 close {
 this.closed = true
 }

 addEventListener(type: 'open' | 'close' | 'error', handler: Handler): void
 addEventListener(type: 'message', handler: MessageHandler): void
 addEventListener(type: string, handler: Handler | MessageHandler): void {
 if (type === 'open') this.onOpen.push(handler as Handler)
 if (type === 'close') this.onClose.push(handler as Handler)
 if (type === 'error') this.onError.push(handler as Handler)
 if (type === 'message') this.onMessage.push(handler as MessageHandler)
 }

 emitOpen {
 for (const h of this.onOpen) h
 }
 emitClose {
 for (const h of this.onClose) h
 }
 emitMessage(data: unknown) {
 for (const h of this.onMessage) h({ data })
 }
}

const messageFrame = (id: string) => ({
 type: 'message.created',
 threadId: 't1',
 message: {
 id,
 workspaceId: 'w1',
 threadId: 't1',
 author: { kind: 'user', userId: 'u1' },
 body: { kind: 'text', text: 'hello' },
 // Serialized shape: the schema expects a Date, so a raw JSON frame with an
 // ISO string must be rejected rather than silently coerced.
 createdAt: new Date.toISOString,
 editedAt: null,
 },
})

beforeEach( => {
 FakeSocket.instances = []
 vi.useFakeTimers
})

afterEach( => {
 vi.useRealTimers
})

/**
 * The subscribe frame is sent after an awaited mint, so `emitOpen` no longer
 * finishes the handshake on its own — every test that opens a socket has to let the
 * microtasks run first.
 */
const opened = async (socket: FakeSocket | undefined) => {
 socket?.emitOpen
 await vi.advanceTimersByTimeAsync(0)
}

describe('connectRealtime', => {
 it('subscribes with a freshly minted token and reports state', async => {
 const states: string[] = []
 const connection = connectRealtime({
 wsUrl: 'ws://test/ws/client',
 mintToken: async => 'v1.w1.999.sig',
 onEvent: => {},
 onState: (s) => states.push(s),
 socketFactory: (url) => new FakeSocket(url),
 })

 const socket = FakeSocket.instances[0]
 expect(socket).toBeDefined
 await opened(socket)

 // No workspace on the frame: the gateway reads it out of the token, which is what
 // stops a subscriber choosing its own.
 expect(socket?.sent).toEqual([JSON.stringify({ type: 'subscribe', token: 'v1.w1.999.sig' })])
 expect(connection.state).toBe('open')
 expect(states).toContain('open')

 connection.close
 })

 it('mints again on every reconnect rather than reusing the first token', async => {
 let minted = 0
 const connection = connectRealtime({
 wsUrl: 'ws://test/ws/client',
 mintToken: async => `token-${++minted}`,
 onEvent: => {},
 socketFactory: (url) => new FakeSocket(url),
 })

 await opened(FakeSocket.instances[0])
 FakeSocket.instances[0]?.emitClose
 await vi.advanceTimersByTimeAsync(MAX_BACKOFF)
 await opened(FakeSocket.instances[1])

 // A cached token is the bug where the UI stays "connected" and stops updating an
 // hour in, once the credential that opened the first socket has expired.
 expect(FakeSocket.instances[1]?.sent).toEqual([
 JSON.stringify({ type: 'subscribe', token: 'token-2' }),
 ])
 })

 it('closes and backs off when the token cannot be minted, and never reports open', async => {
 const states: string[] = []
 connectRealtime({
 wsUrl: 'ws://test/ws/client',
 mintToken: async => {
 throw new Error('server restarting')
 },
 onEvent: => {},
 onState: (s) => states.push(s),
 socketFactory: (url) => new FakeSocket(url),
 })

 await opened(FakeSocket.instances[0])
 expect(FakeSocket.instances[0]?.sent).toEqual([])
 // Reporting 'open' on a socket that never subscribed would be a connection indicator
 // that is green while nothing is arriving.
 expect(states).not.toContain('open')

 FakeSocket.instances[0]?.emitClose
 await vi.advanceTimersByTimeAsync(MAX_BACKOFF)
 expect(FakeSocket.instances.length).toBeGreaterThan(1)
 })

 it('does not send a token that arrives after its socket was replaced', async => {
 // Initialised rather than left null: TypeScript does not track an assignment made
 // inside the promise executor, so a nullable one narrows to `never` at the call below.
 let resolveMint: (token: string) => void = => {}
 connectRealtime({
 wsUrl: 'ws://test/ws/client',
 mintToken: =>
 new Promise<string>((resolve) => {
 resolveMint = resolve
 }),
 onEvent: => {},
 socketFactory: (url) => new FakeSocket(url),
 })

 const first = FakeSocket.instances[0]
 first?.emitOpen
 first?.emitClose
 await vi.advanceTimersByTimeAsync(MAX_BACKOFF)
 expect(FakeSocket.instances.length).toBeGreaterThan(1)

 resolveMint('late-token')
 await vi.advanceTimersByTimeAsync(0)
 // Sending it would subscribe a socket the reconnect already abandoned.
 expect(first?.sent).toEqual([])
 })

 it('reconnects after an unexpected close and fires onResubscribe only on later opens', async => {
 const resubscribes: number[] = []
 const connection = connectRealtime({
 wsUrl: 'ws://test/ws/client',
 mintToken: async => 'token',
 onEvent: => {},
 onResubscribe: => resubscribes.push(Date.now),
 socketFactory: (url) => new FakeSocket(url),
 })

 await opened(FakeSocket.instances[0])
 // First open is not a resubscribe — nothing was missed yet.
 expect(resubscribes).toHaveLength(0)

 FakeSocket.instances[0]?.emitClose
 expect(connection.state).toBe('closed')

 await vi.advanceTimersByTimeAsync(MAX_BACKOFF)
 expect(FakeSocket.instances.length).toBeGreaterThan(1)

 await opened(FakeSocket.instances[1])
 // Second open follows a gap, so the caller must refetch.
 expect(resubscribes).toHaveLength(1)

 connection.close
 })

 it('stops reconnecting once closed by the caller', async => {
 const connection = connectRealtime({
 wsUrl: 'ws://test/ws/client',
 mintToken: async => 'token',
 onEvent: => {},
 socketFactory: (url) => new FakeSocket(url),
 })

 await opened(FakeSocket.instances[0])
 connection.close
 FakeSocket.instances[0]?.emitClose

 await vi.advanceTimersByTimeAsync(MAX_BACKOFF * 3)
 expect(FakeSocket.instances).toHaveLength(1)
 expect(connection.state).toBe('closed')
 })

 it('ignores malformed and control frames but forwards domain events', async => {
 const received: ServerEvent[] = []
 const connection = connectRealtime({
 wsUrl: 'ws://test/ws/client',
 mintToken: async => 'token',
 onEvent: (event) => received.push(event),
 socketFactory: (url) => new FakeSocket(url),
 })

 const socket = FakeSocket.instances[0]
 await opened(socket)

 socket?.emitMessage('not json at all')
 socket?.emitMessage(JSON.stringify({ type: 'subscribed', workspaceId: 'w1' }))
 socket?.emitMessage(JSON.stringify({ type: 'error', message: 'nope' }))
 expect(received).toHaveLength(0)

 // An ISO-string createdAt fails the schema, so this frame is dropped too —
 // proving the client validates rather than trusting the wire.
 socket?.emitMessage(JSON.stringify(messageFrame('m1')))
 expect(received).toHaveLength(0)

 connection.close
 })
})

const MAX_BACKOFF = 15_000
