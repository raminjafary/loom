import { describe, expect, it } from 'vitest'
import { ActorSchema, MessageSchema, ServerEventSchema } from './schemas.js'

describe('ActorSchema', () => {
  it('accepts each actor kind', () => {
    expect(ActorSchema.parse({ kind: 'user', userId: 'u1' })).toEqual({
      kind: 'user',
      userId: 'u1',
    })
    expect(ActorSchema.parse({ kind: 'agent_run', agentRunId: 'r1' }).kind).toBe('agent_run')
    expect(ActorSchema.parse({ kind: 'system' }).kind).toBe('system')
  })

  it('rejects an unknown kind and a user actor missing its id', () => {
    expect(ActorSchema.safeParse({ kind: 'robot' }).success).toBe(false)
    expect(ActorSchema.safeParse({ kind: 'user' }).success).toBe(false)
  })

  it('rejects a user actor carrying an agent id — the kinds must not blur', () => {
    expect(ActorSchema.safeParse({ kind: 'user', agentRunId: 'r1' }).success).toBe(false)
  })
})

describe('MessageSchema', () => {
  const valid = {
    id: 'm1',
    workspaceId: 'w1',
    threadId: 't1',
    author: { kind: 'user' as const, userId: 'u1' },
    body: { kind: 'text' as const, text: 'hi' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    editedAt: null,
  }

  it('accepts a well-formed message', () => {
    expect(MessageSchema.parse(valid).body.text).toBe('hi')
  })

  it('requires a Date, not an ISO string — the wire codec must preserve type', () => {
    expect(
      MessageSchema.safeParse({ ...valid, createdAt: '2026-01-01T00:00:00Z' }).success,
    ).toBe(false)
  })

  it('rejects an unknown body kind', () => {
    expect(MessageSchema.safeParse({ ...valid, body: { kind: 'html', text: '<b>' } }).success).toBe(
      false,
    )
  })
})

describe('ServerEventSchema', () => {
  it('accepts a message.created frame', () => {
    const frame = {
      type: 'message.created' as const,
      threadId: 't1',
      message: {
        id: 'm1',
        workspaceId: 'w1',
        threadId: 't1',
        author: { kind: 'system' as const },
        body: { kind: 'system' as const, text: 'joined' },
        createdAt: new Date(),
        editedAt: null,
      },
    }
    expect(ServerEventSchema.parse(frame).type).toBe('message.created')
  })

  it('rejects control frames, which are transport-level and not domain events', () => {
    expect(ServerEventSchema.safeParse({ type: 'subscribed', workspaceId: 'w1' }).success).toBe(
      false,
    )
    expect(ServerEventSchema.safeParse({ type: 'error', message: 'nope' }).success).toBe(false)
  })
})
