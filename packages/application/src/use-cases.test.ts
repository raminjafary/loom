import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  agentRunActor,
  asAgentRunId,
  asThreadId,
  asUserId,
  asWorkspaceId,
  userActor,
} from '@loom/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { FakeStore, fakeDeps } from './testing/fakes.js'
import {
  backfillMessages,
  createChannel,
  listChannels,
  listMessages,
  postMessage,
  type Deps,
} from './use-cases.js'

const WS = asWorkspaceId('ws_1')
const OTHER_WS = asWorkspaceId('ws_2')
const human = userActor(asUserId('u_1'))
const agent = agentRunActor(asAgentRunId('run_1'))

let deps: Deps
let store: FakeStore

beforeEach(() => {
  const built = fakeDeps(new FakeStore())
  deps = built.deps
  store = built.store
})

describe('createChannel', () => {
  it('creates a channel with a root thread and audits it', async () => {
    const { channel, rootThread } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'Backend Team',
    })

    expect(channel.name).toBe('backend-team')
    expect(rootThread.isRoot).toBe(true)
    expect(rootThread.channelId).toBe(channel.id)
    expect(store.audits).toHaveLength(1)
    expect(store.audits[0]?.action).toBe('channel.created')
    expect(store.published.map((e) => e.type)).toEqual(['channel.created', 'thread.created'])
  })

  it('refuses an agent actor — only humans create channels', async () => {
    await expect(
      createChannel(deps, { workspaceId: WS, actor: agent, name: 'agent-made' }),
    ).rejects.toThrow(ForbiddenError)
  })

  it('rejects duplicate names within a workspace', async () => {
    await createChannel(deps, { workspaceId: WS, actor: human, name: 'general' })
    await expect(
      createChannel(deps, { workspaceId: WS, actor: human, name: 'General' }),
    ).rejects.toThrow(ValidationError)
  })

  it('scopes names per workspace, so the same name is free elsewhere', async () => {
    await createChannel(deps, { workspaceId: WS, actor: human, name: 'general' })
    const other = await createChannel(deps, {
      workspaceId: OTHER_WS,
      actor: human,
      name: 'general',
    })
    expect(other.channel.workspaceId).toBe(OTHER_WS)
  })
})

describe('postMessage', () => {
  it('appends and publishes, recording the actor', async () => {
    const { rootThread } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'general',
    })

    const message = await postMessage(deps, {
      workspaceId: WS,
      actor: agent,
      threadId: rootThread.id,
      text: '  hello from a run  ',
    })

    expect(message.body).toEqual({ kind: 'text', text: 'hello from a run' })
    expect(message.author).toEqual(agent)
    expect(store.published.at(-1)?.type).toBe('message.created')
  })

  it('rejects an unknown thread', async () => {
    await expect(
      postMessage(deps, {
        workspaceId: WS,
        actor: human,
        threadId: asThreadId('th_missing'),
        text: 'hi',
      }),
    ).rejects.toThrow(NotFoundError)
  })

  it('will not cross a workspace boundary', async () => {
    const { rootThread } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'general',
    })
    await expect(
      postMessage(deps, {
        workspaceId: OTHER_WS,
        actor: human,
        threadId: rootThread.id,
        text: 'leaking',
      }),
    ).rejects.toThrow(NotFoundError)
  })
})

describe('listMessages', () => {
  it('pages newest-first and walks the cursor to exhaustion', async () => {
    const { rootThread } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'general',
    })
    for (let i = 1; i <= 5; i += 1) {
      await postMessage(deps, {
        workspaceId: WS,
        actor: human,
        threadId: rootThread.id,
        text: `m${i}`,
      })
    }

    const first = await listMessages(deps, {
      workspaceId: WS,
      threadId: rootThread.id,
      limit: 2,
    })
    expect(first.messages.map((m) => m.body)).toEqual([
      { kind: 'text', text: 'm5' },
      { kind: 'text', text: 'm4' },
    ])
    expect(first.nextCursor).not.toBeNull()

    const second = await listMessages(deps, {
      workspaceId: WS,
      threadId: rootThread.id,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    })
    expect(second.messages.map((m) => m.body)).toEqual([
      { kind: 'text', text: 'm3' },
      { kind: 'text', text: 'm2' },
    ])

    const third = await listMessages(deps, {
      workspaceId: WS,
      threadId: rootThread.id,
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    })
    expect(third.messages.map((m) => m.body)).toEqual([{ kind: 'text', text: 'm1' }])
    expect(third.nextCursor).toBeNull()
  })

  it('clamps an oversized limit instead of trusting the caller', async () => {
    const { rootThread } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'general',
    })
    await postMessage(deps, {
      workspaceId: WS,
      actor: human,
      threadId: rootThread.id,
      text: 'one',
    })
    const page = await listMessages(deps, {
      workspaceId: WS,
      threadId: rootThread.id,
      limit: 10_000,
    })
    expect(page.messages).toHaveLength(1)
  })
})

describe('backfillMessages', () => {
  it('returns only what a reconnecting client missed, oldest-first', async () => {
    const { rootThread } = await createChannel(deps, {
      workspaceId: WS,
      actor: human,
      name: 'general',
    })
    const seen = await postMessage(deps, {
      workspaceId: WS,
      actor: human,
      threadId: rootThread.id,
      text: 'seen',
    })
    await postMessage(deps, {
      workspaceId: WS,
      actor: human,
      threadId: rootThread.id,
      text: 'missed-1',
    })
    await postMessage(deps, {
      workspaceId: WS,
      actor: human,
      threadId: rootThread.id,
      text: 'missed-2',
    })

    const missed = await backfillMessages(deps, {
      workspaceId: WS,
      threadId: rootThread.id,
      afterMessageId: seen.id,
    })

    expect(missed.map((m) => m.body)).toEqual([
      { kind: 'text', text: 'missed-1' },
      { kind: 'text', text: 'missed-2' },
    ])
  })
})

describe('listChannels', () => {
  it('only returns the requested workspace', async () => {
    await createChannel(deps, { workspaceId: WS, actor: human, name: 'mine' })
    await createChannel(deps, { workspaceId: OTHER_WS, actor: human, name: 'theirs' })
    const mine = await listChannels(deps, { workspaceId: WS })
    expect(mine.map((c) => c.name)).toEqual(['mine'])
  })
})
