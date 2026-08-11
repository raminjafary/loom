import type { Message } from '@loom/api-contract'
import { describe, expect, it, vi } from 'vitest'
import type { LoomApi } from './api.js'
import type { WebSocketLike } from './realtime.js'
import { createWorkspaceSession } from './workspace-session.js'

/**
 * History paging and the reconnect backfill, which are the two places this session
 * can lose messages without anything looking wrong on screen.
 */

const message = (id: string, atMs: number): Message => ({
  id,
  workspaceId: 'w1',
  threadId: 't1',
  author: { kind: 'user', userId: 'u1' },
  body: { kind: 'text', text: id },
  toolUseId: null,
  createdAt: new Date(atMs),
  editedAt: null,
})

/** Newest-first, the way the server returns a page. */
const page = (messages: Message[], nextCursor: string | null) => ({
  messages: [...messages].reverse(),
  nextCursor,
})

class SilentSocket implements WebSocketLike {
  send() {}
  close() {}
  addEventListener() {}
}

const stubApi = (overrides: {
  list: (input: { threadId: string; limit?: number; cursor?: string }) => Promise<{
    messages: Message[]
    nextCursor: string | null
  }>
  backfill?: (input: { afterMessageId: string; limit?: number }) => Promise<Message[]>
}): LoomApi =>
  ({
    session: { me: async () => ({ actor: { kind: 'user', userId: 'u1' }, workspaceId: 'w1' }) },
    channel: {
      list: async () => [
        {
          id: 'c1',
          workspaceId: 'w1',
          name: 'general',
          topic: null,
          isPrivate: false,
          createdAt: new Date(0),
        },
      ],
      rootThread: async () => ({
        id: 't1',
        workspaceId: 'w1',
        channelId: 'c1',
        parentMessageId: null,
        isRoot: true,
        createdAt: new Date(0),
      }),
    },
    message: {
      list: overrides.list,
      backfill: overrides.backfill ?? (async () => []),
      post: async () => message('posted', 0),
    },
  }) as unknown as LoomApi

const start = async (api: LoomApi) => {
  // The socket is not what these tests are about; connectRealtime has its own.
  const session = createWorkspaceSession({
    api,
    wsUrl: 'ws://test',
    socketFactory: () => new SilentSocket(),
  })
  await session.init()
  return session
}

describe('message history', () => {
  it('reports that older messages exist when the first page is not the whole thread', async () => {
    const session = await start(
      stubApi({ list: async () => page([message('m50', 50)], 'cursor-1') }),
    )
    expect(session.snapshot().hasMoreHistory).toBe(true)
  })

  /**
   * The gap this closes: a thread's first page is the newest 50, and one agent run
   * posts hundreds of events — so the start of every interesting conversation was
   * off the top with no way back.
   */
  it('prepends the older page in ascending order and follows the cursor', async () => {
    const calls: Array<string | undefined> = []
    const session = await start(
      stubApi({
        list: async ({ cursor }) => {
          calls.push(cursor)
          if (cursor === undefined) return page([message('m3', 3), message('m4', 4)], 'cursor-1')
          return page([message('m1', 1), message('m2', 2)], null)
        },
      }),
    )

    await session.loadOlderMessages()

    expect(calls).toEqual([undefined, 'cursor-1'])
    expect(session.snapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(session.snapshot().hasMoreHistory).toBe(false)
  })

  it('stops asking once the beginning is reached', async () => {
    const list = vi.fn(async () => page([message('m1', 1)], null))
    const session = await start(stubApi({ list }))

    await session.loadOlderMessages()
    await session.loadOlderMessages()

    expect(list).toHaveBeenCalledTimes(1)
  })

  it('forgets the cursor when the channel changes', async () => {
    const session = await start(
      stubApi({ list: async () => page([message('m1', 1)], 'cursor-1') }),
    )
    await session.selectChannel('c1')
    expect(session.snapshot().hasMoreHistory).toBe(true)
    expect(session.snapshot().messages.map((m) => m.id)).toEqual(['m1'])
  })
})

describe('reconnect', () => {
  /**
   * Refetching the newest page was the old behaviour, and it both discarded paged-in
   * history and left a hole whenever more than a page arrived while the socket was
   * down. Backfill asks the only question that converges.
   */
  it('replays only what was missed, keeping older history that was paged in', async () => {
    const backfill = vi.fn(async ({ afterMessageId }: { afterMessageId: string }) =>
      afterMessageId === 'm2' ? [message('m3', 3), message('m4', 4)] : [],
    )
    const list = vi.fn(async ({ cursor }: { cursor?: string }) =>
      cursor === undefined ? page([message('m2', 2)], 'cursor-1') : page([message('m1', 1)], null),
    )

    const session = await start(stubApi({ list, backfill }))
    await session.loadOlderMessages()
    expect(session.snapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2'])

    // Exactly what onResubscribe calls, in the state the session is actually in.
    await session.refreshAfterReconnect()

    expect(backfill).toHaveBeenCalledWith({ threadId: 't1', afterMessageId: 'm2', limit: 100 })
    expect(session.snapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('falls back to the newest page when the server does not know the anchor', async () => {
    const backfill = vi.fn(async () => {
      throw new Error('Message not found')
    })
    const list = vi.fn(async () => page([message('m9', 9)], null))
    const session = await start(stubApi({ list, backfill }))

    await session.refreshAfterReconnect()

    expect(session.snapshot().messages.map((m) => m.id)).toEqual(['m9'])
  })
})
