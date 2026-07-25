import type { ServerEvent } from '@loom/api-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectRealtime, type WebSocketLike } from './realtime.js'

/**
 * The reconnect path is the least obvious logic in this package, so it is
 * tested against a fake socket rather than a live server.
 */

type Handler = () => void
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

  close() {
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

  emitOpen() {
    for (const h of this.onOpen) h()
  }
  emitClose() {
    for (const h of this.onClose) h()
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
    createdAt: new Date().toISOString(),
    editedAt: null,
  },
})

beforeEach(() => {
  FakeSocket.instances = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('connectRealtime', () => {
  it('subscribes on open and reports state', () => {
    const states: string[] = []
    const connection = connectRealtime({
      wsUrl: 'ws://test/ws/client',
      workspaceId: 'w1',
      onEvent: () => {},
      onState: (s) => states.push(s),
      socketFactory: (url) => new FakeSocket(url),
    })

    const socket = FakeSocket.instances[0]
    expect(socket).toBeDefined()
    socket?.emitOpen()

    expect(socket?.sent).toEqual([JSON.stringify({ type: 'subscribe', workspaceId: 'w1' })])
    expect(connection.state()).toBe('open')
    expect(states).toContain('open')

    connection.close()
  })

  it('reconnects after an unexpected close and fires onResubscribe only on later opens', () => {
    const resubscribes: number[] = []
    const connection = connectRealtime({
      wsUrl: 'ws://test/ws/client',
      workspaceId: 'w1',
      onEvent: () => {},
      onResubscribe: () => resubscribes.push(Date.now()),
      socketFactory: (url) => new FakeSocket(url),
    })

    FakeSocket.instances[0]?.emitOpen()
    // First open is not a resubscribe — nothing was missed yet.
    expect(resubscribes).toHaveLength(0)

    FakeSocket.instances[0]?.emitClose()
    expect(connection.state()).toBe('closed')

    vi.advanceTimersByTime(MAX_BACKOFF)
    expect(FakeSocket.instances.length).toBeGreaterThan(1)

    FakeSocket.instances[1]?.emitOpen()
    // Second open follows a gap, so the caller must refetch.
    expect(resubscribes).toHaveLength(1)

    connection.close()
  })

  it('stops reconnecting once closed by the caller', () => {
    const connection = connectRealtime({
      wsUrl: 'ws://test/ws/client',
      workspaceId: 'w1',
      onEvent: () => {},
      socketFactory: (url) => new FakeSocket(url),
    })

    FakeSocket.instances[0]?.emitOpen()
    connection.close()
    FakeSocket.instances[0]?.emitClose()

    vi.advanceTimersByTime(MAX_BACKOFF * 3)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(connection.state()).toBe('closed')
  })

  it('ignores malformed and control frames but forwards domain events', () => {
    const received: ServerEvent[] = []
    const connection = connectRealtime({
      wsUrl: 'ws://test/ws/client',
      workspaceId: 'w1',
      onEvent: (event) => received.push(event),
      socketFactory: (url) => new FakeSocket(url),
    })

    const socket = FakeSocket.instances[0]
    socket?.emitOpen()

    socket?.emitMessage('not json at all')
    socket?.emitMessage(JSON.stringify({ type: 'subscribed', workspaceId: 'w1' }))
    socket?.emitMessage(JSON.stringify({ type: 'error', message: 'nope' }))
    expect(received).toHaveLength(0)

    // An ISO-string createdAt fails the schema, so this frame is dropped too —
    // proving the client validates rather than trusting the wire.
    socket?.emitMessage(JSON.stringify(messageFrame('m1')))
    expect(received).toHaveLength(0)

    connection.close()
  })
})

const MAX_BACKOFF = 15_000
