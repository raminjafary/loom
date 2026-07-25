import { contract } from '@loom/api-contract'
import {
  backfillMessages,
  createChannel,
  getChannelRootThread,
  listChannels,
  listMessages,
  postMessage,
  type Deps,
} from '@loom/application'
import { DomainError } from '@loom/domain'
import { asChannelId, asMessageId, asThreadId } from '@loom/domain'
import { ORPCError, implement } from '@orpc/server'
import type { Principal } from './auth.js'

export interface RouterContext {
  readonly principal: Principal
  readonly deps: Deps
}

const os = implement(contract).$context<RouterContext>()

/**
 * Domain errors carry their own codes; map them to transport codes here so the
 * application layer never has to know an HTTP status exists.
 */
const toTransportError = (error: unknown): never => {
  if (error instanceof DomainError) {
    switch (error.code) {
      case 'NOT_FOUND':
        throw new ORPCError('NOT_FOUND', { message: error.message })
      case 'FORBIDDEN':
        throw new ORPCError('FORBIDDEN', { message: error.message })
      case 'VALIDATION':
        throw new ORPCError('BAD_REQUEST', { message: error.message })
      default:
        throw new ORPCError('INTERNAL_SERVER_ERROR', { message: error.message })
    }
  }
  throw error
}

const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (error) {
    return toTransportError(error)
  }
}

export const router = os.router({
  health: os.health.handler(() => ({ status: 'ok' as const, time: new Date() })),

  session: {
    me: os.session.me.handler(({ context }) => ({
      actor: context.principal.actor,
      workspaceId: context.principal.workspaceId,
    })),
  },

  channel: {
    list: os.channel.list.handler(({ context }) =>
      guard(() =>
        listChannels(context.deps, { workspaceId: context.principal.workspaceId }),
      ),
    ),

    create: os.channel.create.handler(({ context, input }) =>
      guard(() =>
        createChannel(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          name: input.name,
          topic: input.topic ?? null,
          ...(input.isPrivate === undefined ? {} : { isPrivate: input.isPrivate }),
        }),
      ),
    ),

    rootThread: os.channel.rootThread.handler(({ context, input }) =>
      guard(() =>
        getChannelRootThread(context.deps, {
          workspaceId: context.principal.workspaceId,
          channelId: asChannelId(input.channelId),
        }),
      ),
    ),
  },

  message: {
    list: os.message.list.handler(({ context, input }) =>
      guard(() =>
        listMessages(context.deps, {
          workspaceId: context.principal.workspaceId,
          threadId: asThreadId(input.threadId),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          cursor: input.cursor,
        }),
      ),
    ),

    post: os.message.post.handler(({ context, input }) =>
      guard(() =>
        postMessage(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          threadId: asThreadId(input.threadId),
          text: input.text,
        }),
      ),
    ),

    backfill: os.message.backfill.handler(({ context, input }) =>
      guard(() =>
        backfillMessages(context.deps, {
          workspaceId: context.principal.workspaceId,
          threadId: asThreadId(input.threadId),
          afterMessageId: asMessageId(input.afterMessageId),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      ),
    ),
  },
})

export type Router = typeof router
