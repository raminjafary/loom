import { z } from 'zod'

/**
 * The wire shapes. No persistence type may cross this boundary (PLAN.md §4c) —
 * these Zod schemas are the single source of truth for every client, and the
 * OpenAPI document generated from them is what lets non-TypeScript clients
 * exist later without a second contract.
 */

export const ActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string() }),
  z.object({ kind: z.literal('agent_run'), agentRunId: z.string() }),
  z.object({ kind: z.literal('system') }),
])

export const MessageBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('system'), text: z.string() }),
])

export const MessageSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  threadId: z.string(),
  author: ActorSchema,
  body: MessageBodySchema,
  createdAt: z.date(),
  editedAt: z.date().nullable(),
})

export const ChannelSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  topic: z.string().nullable(),
  isPrivate: z.boolean(),
  createdAt: z.date(),
})

export const ThreadSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  channelId: z.string(),
  parentMessageId: z.string().nullable(),
  isRoot: z.boolean(),
  createdAt: z.date(),
})

export const MessagePageSchema = z.object({
  messages: z.array(MessageSchema),
  nextCursor: z.string().nullable(),
})

/** Realtime frames. Deliberately small: structure and status, never token deltas (PLAN.md §4d-bis). */
export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.created'),
    threadId: z.string(),
    message: MessageSchema,
  }),
  z.object({ type: z.literal('channel.created'), channel: ChannelSchema }),
  z.object({ type: z.literal('thread.created'), thread: ThreadSchema }),
])

export type Actor = z.infer<typeof ActorSchema>
export type Message = z.infer<typeof MessageSchema>
export type Channel = z.infer<typeof ChannelSchema>
export type Thread = z.infer<typeof ThreadSchema>
export type MessagePage = z.infer<typeof MessagePageSchema>
export type ServerEvent = z.infer<typeof ServerEventSchema>
