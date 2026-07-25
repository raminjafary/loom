import {
  ForbiddenError,
  NotFoundError,
  isHuman,
  normalizeChannelName,
  validateMessageText,
  type Actor,
  type Channel,
  type ChannelId,
  type Message,
  type MessageId,
  type Thread,
  type ThreadId,
  type WorkspaceId,
} from '@loom/domain'
import { ValidationError } from '@loom/domain'
import type {
  AuditPort,
  ChannelRepositoryPort,
  EventPublisherPort,
  MessagePage,
  MessageRepositoryPort,
  ThreadRepositoryPort,
} from './ports.js'

export interface Deps {
  readonly channels: ChannelRepositoryPort
  readonly threads: ThreadRepositoryPort
  readonly messages: MessageRepositoryPort
  readonly audit: AuditPort
  readonly events: EventPublisherPort
}

export const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 50

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError('limit must be a positive integer')
  }
  return Math.min(limit, MAX_PAGE_SIZE)
}

export const createChannel = async (
  deps: Deps,
  input: {
    workspaceId: WorkspaceId
    actor: Actor
    name: string
    topic?: string | null
    isPrivate?: boolean
  },
): Promise<{ channel: Channel; rootThread: Thread }> => {
  if (!isHuman(input.actor)) {
    throw new ForbiddenError('Only a human may create a channel')
  }

  const name = normalizeChannelName(input.name)
  const existing = await deps.channels.findByName(input.workspaceId, name)
  if (existing) throw new ValidationError(`Channel #${name} already exists`)

  const channel = await deps.channels.create({
    workspaceId: input.workspaceId,
    name,
    topic: input.topic ?? null,
    isPrivate: input.isPrivate ?? false,
  })

  const rootThread = await deps.threads.createRoot({
    workspaceId: input.workspaceId,
    channelId: channel.id,
  })

  await deps.audit.record({
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'channel.created',
    subjectType: 'channel',
    subjectId: channel.id,
    metadata: { name },
  })

  await deps.events.publish({
    type: 'channel.created',
    workspaceId: input.workspaceId,
    channel,
  })
  await deps.events.publish({
    type: 'thread.created',
    workspaceId: input.workspaceId,
    thread: rootThread,
  })

  return { channel, rootThread }
}

export const listChannels = (
  deps: Deps,
  input: { workspaceId: WorkspaceId },
): Promise<Channel[]> => deps.channels.listByWorkspace(input.workspaceId)

export const postMessage = async (
  deps: Deps,
  input: {
    workspaceId: WorkspaceId
    actor: Actor
    threadId: ThreadId
    text: string
  },
): Promise<Message> => {
  const thread = await deps.threads.findById(input.workspaceId, input.threadId)
  if (!thread) throw new NotFoundError('Thread')

  const text = validateMessageText(input.text)

  const message = await deps.messages.append({
    workspaceId: input.workspaceId,
    threadId: thread.id,
    author: input.actor,
    body: { kind: 'text', text },
  })

  await deps.events.publish({
    type: 'message.created',
    workspaceId: input.workspaceId,
    threadId: thread.id,
    message,
  })

  return message
}

export const listMessages = async (
  deps: Deps,
  input: {
    workspaceId: WorkspaceId
    threadId: ThreadId
    limit?: number
    cursor?: string | undefined
  },
): Promise<MessagePage> => {
  const thread = await deps.threads.findById(input.workspaceId, input.threadId)
  if (!thread) throw new NotFoundError('Thread')

  return deps.messages.listByThread({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    limit: clampLimit(input.limit),
    cursor: input.cursor,
  })
}

/** Reconnect path: replay what a client missed while its socket was down. */
export const backfillMessages = async (
  deps: Deps,
  input: {
    workspaceId: WorkspaceId
    threadId: ThreadId
    afterMessageId: MessageId
    limit?: number
  },
): Promise<Message[]> => {
  const thread = await deps.threads.findById(input.workspaceId, input.threadId)
  if (!thread) throw new NotFoundError('Thread')

  return deps.messages.listSince({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    afterMessageId: input.afterMessageId,
    limit: clampLimit(input.limit),
  })
}

export const startThread = async (
  deps: Deps,
  input: {
    workspaceId: WorkspaceId
    actor: Actor
    channelId: ChannelId
    parentMessageId: MessageId
  },
): Promise<Thread> => {
  const channel = await deps.channels.findById(input.workspaceId, input.channelId)
  if (!channel) throw new NotFoundError('Channel')

  const thread = await deps.threads.createReply({
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    parentMessageId: input.parentMessageId,
  })

  await deps.events.publish({
    type: 'thread.created',
    workspaceId: input.workspaceId,
    thread,
  })

  return thread
}

export const getChannelRootThread = async (
  deps: Deps,
  input: { workspaceId: WorkspaceId; channelId: ChannelId },
): Promise<Thread> => {
  const thread = await deps.threads.findRootByChannel(input.workspaceId, input.channelId)
  if (!thread) throw new NotFoundError('Root thread')
  return thread
}
