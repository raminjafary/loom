import websocket from '@fastify/websocket'
import {
  originAllowed,
  parseSubscriptionToken,
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
 */

const ClientHelloSchema = z.object({
  type: z.literal('subscribe'),
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

  const authorize = (raw: string): { workspaceId: string } | null => {
    const token = parseSubscriptionToken(raw)
    const verdict = subscriptionTokenVerdict({
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
    })
    return verdict.ok ? { workspaceId: verdict.workspaceId } : null
  }

  fastify.register(async (instance) => {
    instance.get('/ws/client', { websocket: true }, (socket, request) => {
      // One Redis connection per socket: a client in subscribe mode cannot
      // issue other commands, and per-socket isolation keeps a bad frame from
      // affecting other subscribers.
      let redis: Redis | null = null
      let subscribed: string | null = null

      const closeRedis = () => {
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
