import { ServerEventSchema, type ServerEvent } from '@loom/api-contract'

export type ConnectionState = 'connecting' | 'open' | 'closed'

export interface RealtimeOptions {
  readonly wsUrl: string
  /**
   * Fetches a fresh subscription token. Called on **every** connect rather
   * than once, because the token is short-lived and this connection is not: a client that
   * cached one would subscribe successfully at startup and silently fail to resubscribe an
   * hour later, which is the shape of bug where the UI looks connected and stops updating.
   *
   * The workspace is no longer sent — it is inside the token, where a client cannot choose it.
   */
  readonly mintToken: () => Promise<string>
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
      /**
       * The token is fetched after the socket opens, not before, so a gateway that is down
       * costs no request. A mint that fails closes the socket and falls into the same
       * backoff as any other drop — the usual cause is a server that is restarting, which
       * is exactly what backoff is for. `attempt` is reset only once a subscribe has
       * actually been sent, or a failing mint would reset the backoff on every retry.
       */
      void options
        .mintToken()
        .then((token) => {
          if (disposed || socket !== next) return
          attempt = 0
          next.send(JSON.stringify({ type: 'subscribe', token }))
          setState('open')
          if (hadOpened) options.onResubscribe?.()
          hadOpened = true
        })
        .catch(() => {
          next.close()
        })
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
