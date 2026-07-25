import type { DomainEvent, EventPublisherPort } from '@loom/application'
import type { WorkspaceId } from '@loom/domain'
import { Redis } from 'ioredis'

/**
 * Valkey adapter for EventPublisherPort. One channel per workspace so a
 * gateway process only receives frames it will actually fan out.
 */

const channelFor = (workspaceId: WorkspaceId): string => `loom:ws:${workspaceId}`

export const createEventPublisher = (
  url: string,
): EventPublisherPort & { close: () => Promise<void> } => {
  const redis = new Redis(url)
  return {
    async publish(event: DomainEvent) {
      await redis.publish(channelFor(event.workspaceId), JSON.stringify(event))
    },
    close: async () => {
      redis.disconnect()
    },
  }
}

/** Separate connection: a Redis client in subscribe mode cannot issue commands. */
export const createEventSubscriber = (url: string) => {
  const redis = new Redis(url)
  return {
    async subscribe(
      workspaceId: WorkspaceId,
      handler: (event: DomainEvent) => void,
    ): Promise<() => Promise<void>> {
      const channel = channelFor(workspaceId)
      await redis.subscribe(channel)
      const listener = (received: string, payload: string) => {
        if (received !== channel) return
        try {
          handler(JSON.parse(payload) as DomainEvent)
        } catch {
          // A malformed frame must not tear down the subscription.
        }
      }
      redis.on('message', listener)
      return async () => {
        redis.off('message', listener)
        await redis.unsubscribe(channel)
      }
    },
    close: async () => {
      redis.disconnect()
    },
  }
}
