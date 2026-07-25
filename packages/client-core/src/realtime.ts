import { ServerEventSchema, type ServerEvent } from '@loom/api-contract'

export type ConnectionState = 'connecting' | 'open' | 'closed'

export interface RealtimeOptions {
  readonly wsUrl: string
  readonly workspaceId: string
  readonly onEvent: (event: ServerEvent) => void
  readonly onState?: (state: ConnectionState) => void
  /** Called after a reconnect so the caller can refetch what it missed. */
  readonly onResubscribe?: () => void
  readonly socketFactory?: (url: string) => WebSocketLike
}

/** Minimal surface so this module works in a browser, in Node, and in tests. */
export interface WebSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error', handler: () => void): void
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void
}

export interface RealtimeConnection {
  readonly state: () => ConnectionState
  close(): void
}

const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 15_000

/**
 * Reconnecting subscription. Backoff is jittered because a server restart
 * otherwise brings every client back simultaneously.
 */
export const connectRealtime = (options: RealtimeOptions): RealtimeConnection => {
  let socket: WebSocketLike | null = null
  let state: ConnectionState = 'connecting'
  let attempt = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let hadOpened = false

  const factory =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike)

  const setState = (next: ConnectionState) => {
    if (state === next) return
    state = next
    options.onState?.(next)
  }

  const scheduleReconnect = () => {
    if (disposed) return
    const backoff = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
    const jittered = backoff * (0.5 + Math.random() * 0.5)
    attempt += 1
    timer = setTimeout(open, jittered)
  }

  function open() {
    if (disposed) return
    setState('connecting')

    const next = factory(options.wsUrl)
    socket = next

    next.addEventListener('open', () => {
      if (disposed) return
      attempt = 0
      next.send(JSON.stringify({ type: 'subscribe', workspaceId: options.workspaceId }))
      setState('open')
      if (hadOpened) options.onResubscribe?.()
      hadOpened = true
    })

    next.addEventListener('message', (event: { data: unknown }) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(event.data))
      } catch {
        return
      }
      // Control frames (`subscribed`, `error`) are not domain events; ignore
      // anything the contract schema does not recognise rather than throwing.
      const result = ServerEventSchema.safeParse(parsed)
      if (result.success) options.onEvent(result.data)
    })

    next.addEventListener('close', () => {
      if (disposed) return
      setState('closed')
      scheduleReconnect()
    })

    next.addEventListener('error', () => {
      // 'close' always follows, which is where reconnection is handled.
    })
  }

  open()

  return {
    state: () => state,
    close: () => {
      disposed = true
      if (timer) clearTimeout(timer)
      socket?.close()
      setState('closed')
    },
  }
}
