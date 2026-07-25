import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import { z } from 'zod'

/**
 * Dedicated realtime service — client-facing fan-out only.
 *
 * The Runner protocol (`/ws/runner`) does NOT live here: it needs to persist
 * agent_run/approval_request rows, which means it needs the application layer
 * and a database connection — exactly what this service deliberately doesn't
 * have. It lives on apps/server instead (see apps/server/src/runner-gateway.ts).
 * Only tier-1 stream frames pass through here.
 */

const ClientHelloSchema = z.object({
 type: z.literal('subscribe'),
 workspaceId: z.string.min(1),
})

export interface GatewayOptions {
 readonly valkeyUrl: string
 readonly webOrigin: string
}

export const buildGateway = async (options: GatewayOptions): Promise<FastifyInstance> => {
 const fastify = Fastify({ logger: process.env.NODE_ENV !== 'test' })
 await fastify.register(websocket)

 fastify.get('/healthz', async => ({ status: 'ok' }))

 fastify.register(async (instance) => {
 instance.get('/ws/client', { websocket: true }, (socket) => {
 // One Redis connection per socket: a client in subscribe mode cannot
 // issue other commands, and per-socket isolation keeps a bad frame from
 // affecting other subscribers.
 let redis: Redis | null = null
 let subscribed: string | null = null

 const closeRedis = => {
 if (redis) {
 redis.disconnect
 redis = null
 }
 }

 socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
 let parsed: unknown
 try {
 parsed = JSON.parse(raw.toString)
 } catch {
 socket.send(JSON.stringify({ type: 'error', message: 'malformed frame' }))
 return
 }

 const hello = ClientHelloSchema.safeParse(parsed)
 if (!hello.success) {
 socket.send(JSON.stringify({ type: 'error', message: 'expected subscribe frame' }))
 return
 }

 if (subscribed) {
 socket.send(JSON.stringify({ type: 'error', message: 'already subscribed' }))
 return
 }

 const channel = `loom:ws:${hello.data.workspaceId}`
 subscribed = channel
 redis = new Redis(options.valkeyUrl)

 void redis.subscribe(channel).then( => {
 socket.send(JSON.stringify({ type: 'subscribed', workspaceId: hello.data.workspaceId }))
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
