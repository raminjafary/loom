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

export const RunnerSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  allowedRoots: z.array(z.string()),
  connected: z.boolean(),
  lastSeenAt: z.date().nullable(),
  createdAt: z.date(),
})

export const RepositorySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  runnerId: z.string(),
  displayName: z.string(),
  absolutePath: z.string(),
  defaultBranch: z.string(),
  createdAt: z.date(),
})

/** Inline for Phase 1 — no markdown/git-backed persona storage yet (PLAN.md §4/§4e). */
export const PersonaSpecSchema = z.object({
  name: z.string().min(1).max(100),
  systemPrompt: z.string().min(1).max(20_000),
  model: z.string().min(1),
  tools: z.array(z.string()),
  autoApprove: z.boolean(),
  budgetCapUsd: z.number().nullable(),
})

/** PLAN.md §4e Phase 1 subset — read/CRUD only, no git-backed versioning yet. */
export const AgentPersonaSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string(),
  markdownSource: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  harnessEffort: z.string().nullable(),
  harnessMaxTurns: z.number().nullable(),
  harnessAutoApprove: z.boolean(),
  harnessBudgetCapUsd: z.number().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

/** PLAN.md §3a — organizational grouping of personas, not a Team/roster. */
export const PersonaGroupSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  personaIds: z.array(z.string()),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const AgentRunStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
])

export const AgentRunBranchDispositionSchema = z.enum(['kept', 'discarded', 'pushed'])

export const AgentRunSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  threadId: z.string(),
  repositoryId: z.string(),
  runnerId: z.string(),
  persona: PersonaSpecSchema,
  status: AgentRunStatusSchema,
  totalCostUsd: z.number().nullable(),
  errorMessage: z.string().nullable(),
  clonePath: z.string().nullable(),
  branchName: z.string().nullable(),
  branchDisposition: AgentRunBranchDispositionSchema.nullable(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
})

/** Global kill switch state (PLAN.md §6 runtime safety). */
export const RunControlSchema = z.object({
  workspaceId: z.string(),
  paused: z.boolean(),
  pausedAt: z.date().nullable(),
  pausedByUserId: z.string().nullable(),
})

/**
 * PLAN.md §3/§4a notifications. `transport: null` means this deployment has no
 * notification adapter configured — a client must be able to tell that apart
 * from "configured, but you have not subscribed", so it can say so instead of
 * offering a button that cannot work.
 */
export const NotificationTransportSchema = z.enum(['web_push'])

export const NotificationConfigSchema = z.object({
  transport: NotificationTransportSchema.nullable(),
  publicKey: z.string().nullable(),
})

/**
 * A registered destination. `credentials` is transport-specific — for web push,
 * the subscription's `p256dh` and `auth` keys. Deliberately not echoed back in
 * any output shape: it is write-only from the client's side, and the browser
 * already holds its own copy.
 */
export const NotificationTargetSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  transport: NotificationTransportSchema,
  endpoint: z.string(),
  createdAt: z.date(),
})

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied'])

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentRunId: z.string(),
  toolUseId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  status: ApprovalStatusSchema,
  createdAt: z.date(),
  resolvedAt: z.date().nullable(),
})

export type Actor = z.infer<typeof ActorSchema>
export type Message = z.infer<typeof MessageSchema>
export type Channel = z.infer<typeof ChannelSchema>
export type Thread = z.infer<typeof ThreadSchema>
export type MessagePage = z.infer<typeof MessagePageSchema>
export type ServerEvent = z.infer<typeof ServerEventSchema>
export type Runner = z.infer<typeof RunnerSchema>
export type Repository = z.infer<typeof RepositorySchema>
export type PersonaSpec = z.infer<typeof PersonaSpecSchema>
export type AgentPersona = z.infer<typeof AgentPersonaSchema>
export type PersonaGroup = z.infer<typeof PersonaGroupSchema>
export type AgentRun = z.infer<typeof AgentRunSchema>
export type RunControl = z.infer<typeof RunControlSchema>
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>
export type NotificationTransport = z.infer<typeof NotificationTransportSchema>
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>
export type NotificationTarget = z.infer<typeof NotificationTargetSchema>
