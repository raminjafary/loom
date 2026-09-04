import websocket from '@fastify/websocket'
import {
  SUBSCRIPTION_LEASE_MS,
  originAllowed,
  parseSubscriptionToken,
  subscriptionRenewalVerdict,
  subscriptionTokenVerdict,
} from '@loom/domain'
import Fastify, { type FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

/**
 * Dedicated realtime service — client-facing fan-out only.
 *
 * The Runner protocol (`/ws/runner`) does NOT live here: it needs to persist
 * agent_run/approval_request rows, which means it needs the application layer
 * and a database connection — exactly what this service deliberately doesn't
 * have. It lives on apps/server instead (see apps/server/src/runner-gateway.ts).
 * Only tier-1 stream frames pass through here.
 *
 * Authentication is a signed token and not a session, for that same reason.
 * This process verifies and never signs: it can admit a subscriber to the workspace a
 * token already names, and it cannot mint one.
 *
 * A subscription is a **lease**, not a permanent admission: the subscribe grants one, a
 * `renew` frame carrying a fresh token extends it, and a socket whose lease lapses is closed.
 * That is how a stateless process bounds the lifetime of a credential it cannot re-check —
 * renewing means minting, and minting happens where the session is. See
 * `subscription-token.ts`.
 */

const ClientHelloSchema = z.object({
  /**
   * `subscribe` opens the stream; `renew` extends the lease it opened.
   *
   * One schema and one token field for both, because they carry the same credential and
   * differ only in what a valid one is allowed to do — which is a rule about the socket's
   * state, not about the frame's shape, and lives in the domain rather than here.
   */
  type: z.enum(['subscribe', 'renew']),
  /**
   * The token is the only thing that says which workspace. It used to be a plain
   * `workspaceId` field, which is to say a subscriber chose its own — any peer reaching
   * this port got a workspace's entire agent transcript. Sending both would need a rule
   * for which one wins; there is only one.
   */
  token: z.string().min(1),
})

export interface GatewayOptions {
  readonly valkeyUrl: string
  readonly webOrigin: string
  /** Shared with apps/server, which signs with it. */
  readonly subscriptionSecret: string
  /**
   * How long one proof keeps a socket alive. Defaults to the domain's lease.
   *
   * A seam for tests and nothing else: the behaviour under test is "the socket closes when
   * the lease lapses", and a test that waited fifteen real minutes to see it would be a
   * test nobody runs.
   */
  readonly leaseMs?: number
}

/**
 * Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch, which
 * would turn a forged token of the wrong length into a 500 rather than a refusal.
 */
const signatureMatches = (expected: string, received: string): boolean => {
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export const buildGateway = async (options: GatewayOptions): Promise<FastifyInstance> => {
  const fastify = Fastify({ logger: process.env.NODE_ENV !== 'test' })
  await fastify.register(websocket)

  fastify.get('/healthz', async () => ({ status: 'ok' }))

  /**
   * The verified token, or null. One function for both frames, so a renewal cannot end up
   * verified by a second, subtly different implementation of the same check.
   */
  const verify = (raw: string) => {
    const token = parseSubscriptionToken(raw)
    return {
      token,
      signatureMatches:
        token !== null &&
        signatureMatches(
          createHmac('sha256', options.subscriptionSecret)
            // The bytes as received, never reassembled from the parsed claims: signing a
            // normalisation of the token would verify something the sender did not send.
            .update(token.signedInput)
            .digest('base64url'),
          token.signature,
        ),
      nowMs: Date.now(),
    }
  }

  const authorize = (raw: string): { workspaceId: string } | null => {
    const verdict = subscriptionTokenVerdict(verify(raw))
    return verdict.ok ? { workspaceId: verdict.workspaceId } : null
  }

  fastify.register(async (instance) => {
    instance.get('/ws/client', { websocket: true }, (socket, request) => {
      // One Redis connection per socket: a client in subscribe mode cannot
      // issue other commands, and per-socket isolation keeps a bad frame from
      // affecting other subscribers.
      let redis: Redis | null = null
      let subscribed: string | null = null
      let workspace: string | null = null
      /**
       * The lease timer. One timer per socket, reset on renewal rather than a clock read
       * per frame: the fan-out is the hot path and a lease is a fact about the socket, not
       * about a message.
       */
      let lease: ReturnType<typeof setTimeout> | null = null

      const clearLease = () => {
        if (lease) {
          clearTimeout(lease)
          lease = null
        }
      }

      const extendLease = () => {
        clearLease()
        lease = setTimeout(() => {
          // Told, then closed: a client whose renewal never arrived should see the reason
          // in the frame rather than infer it from a bare disconnect. It reconnects with a
          // fresh token, which is the same path a restart takes.
          refuse('subscription lease expired')
          socket.close()
        }, options.leaseMs ?? SUBSCRIPTION_LEASE_MS)
        // Node keeps the process alive for a pending timer; a socket's lease must not be
        // the reason the gateway cannot shut down.
        lease.unref?.()
      }

      const closeRedis = () => {
        clearLease()
        if (redis) {
          redis.disconnect()
          redis = null
        }
      }

      const refuse = (message: string) => {
        socket.send(JSON.stringify({ type: 'error', message }))
      }

      if (!originAllowed(request.headers.origin, options.webOrigin)) {
        refuse('origin not allowed')
        socket.close()
        return
      }

      socket.on('message', (rawFrame: Buffer | ArrayBuffer | Buffer[]) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(rawFrame.toString())
        } catch {
          refuse('malformed frame')
          return
        }

        const hello = ClientHelloSchema.safeParse(parsed)
        if (!hello.success) {
          refuse('expected subscribe frame')
          return
        }

        if (hello.data.type === 'renew') {
          if (!subscribed || workspace === null) {
            refuse('nothing to renew')
            return
          }
          const renewal = subscriptionRenewalVerdict({
            ...verify(hello.data.token),
            subscribedWorkspaceId: workspace,
          })
          if (!renewal.ok) {
            // Closed rather than left open, exactly as a refused subscribe is: a client
            // holding a token this gateway will not take has nothing to retry with on
            // this socket.
            refuse('subscription refused')
            socket.close()
            return
          }
          extendLease()
          socket.send(JSON.stringify({ type: 'renewed', workspaceId: workspace }))
          return
        }

        if (subscribed) {
          refuse('already subscribed')
          return
        }

        const authorized = authorize(hello.data.token)
        if (!authorized) {
          // The socket is closed rather than left open for another attempt: a client with
          // a stale token reconnects, and anything else is a retry loop on this port.
          refuse('subscription refused')
          socket.close()
          return
        }

        const workspaceId = authorized.workspaceId
        const channel = `loom:ws:${workspaceId}`
        subscribed = channel
        workspace = workspaceId
        extendLease()
        redis = new Redis(options.valkeyUrl)

        void redis.subscribe(channel).then(() => {
          socket.send(JSON.stringify({ type: 'subscribed', workspaceId }))
        })

        redis.on('message', (received, payload) => {
          if (received !== channel) return
          // Forwarded verbatim: the server already shaped this frame, and
          // re-parsing here would duplicate the contract in two places.
          socket.send(payload)
        })

        redis.on('error', (error: Error) => {
          fastify.log.error({ err: error }, 'gateway redis error')
        })
      })

      socket.on('close', closeRedis)
      socket.on('error', closeRedis)
    })
  })

  return fastify
}
