import type { Deps } from '@loom/application'
import {
  auditAdapter,
  channelRepository,
  createDatabase,
  messageRepository,
  threadRepository,
} from '@loom/db'
import { RPCHandler } from '@orpc/server/node'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { devAuth, type AuthPort } from './auth.js'
import type { Config } from './config.js'
import { createEventPublisher } from './events.js'
import { router } from './router.js'

export interface App {
  readonly fastify: FastifyInstance
  readonly deps: Deps
  close(): Promise<void>
}

export const buildApp = async (config: Config, authOverride?: AuthPort): Promise<App> => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const events = createEventPublisher(config.VALKEY_URL)

  const deps: Deps = {
    channels: channelRepository(db),
    threads: threadRepository(db),
    messages: messageRepository(db),
    audit: auditAdapter(db),
    events,
  }

  const auth =
    authOverride ??
    devAuth({
      userId: 'dev-user',
      workspaceId: process.env.LOOM_DEV_WORKSPACE_ID ?? '',
    })

  const fastify = Fastify({ logger: config.NODE_ENV !== 'test' })

  await fastify.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
  })

  const handler = new RPCHandler(router)

  // oRPC reads the raw request stream itself, so Fastify must not consume the
  // body first. Anchored regex: an unanchored /.*/ makes MIME essence detection
  // unreliable, which Fastify flags as a CORS risk.
  fastify.removeAllContentTypeParsers()
  fastify.addContentTypeParser(/^.*$/, (_req, _payload, done) => done(null, undefined))

  fastify.all('/rpc/*', async (request, reply) => {
    const principal = await auth.resolve(request.headers)
    if (!principal) {
      await reply.code(401).send({ error: 'unauthenticated' })
      return
    }

    const { matched } = await handler.handle(request.raw, reply.raw, {
      prefix: '/rpc',
      context: { principal, deps },
    })

    if (!matched) {
      await reply.code(404).send({ error: 'no matching procedure' })
    }
  })

  fastify.get('/healthz', async () => ({ status: 'ok' }))

  return {
    fastify,
    deps,
    close: async () => {
      await fastify.close()
      await events.close()
      await closeDb()
    },
  }
}
