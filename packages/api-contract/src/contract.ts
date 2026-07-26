import { oc } from '@orpc/contract'
import { z } from 'zod'
import {
  ActorSchema,
  AgentRunSchema,
  ApprovalRequestSchema,
  ChannelSchema,
  MessagePageSchema,
  MessageSchema,
  PersonaSpecSchema,
  RepositorySchema,
  RunnerSchema,
  ThreadSchema,
} from './schemas.js'

/**
 * Every use-case a client may invoke. The hard rule from PLAN.md §4c: if it is
 * not declared here, no client can do it — including the browser. That forces
 * this contract to be complete rather than letting the web app grow a private
 * side channel, which is what makes a terminal client reach parity for free.
 */

export const contract = {
  health: oc.output(z.object({ status: z.literal('ok'), time: z.date() })),

  /**
   * Who am I, and which workspace am I in. Clients must learn identity from the
   * session rather than from build-time config — otherwise the workspace id
   * becomes a client-supplied value, which is exactly the forgery surface
   * PLAN.md §6 A1 closes.
   */
  session: {
    me: oc.output(z.object({ actor: ActorSchema, workspaceId: z.string() })),
  },

  channel: {
    list: oc.output(z.array(ChannelSchema)),

    create: oc
      .input(
        z.object({
          name: z.string().min(2).max(64),
          topic: z.string().max(500).nullish(),
          isPrivate: z.boolean().optional(),
        }),
      )
      .output(z.object({ channel: ChannelSchema, rootThread: ThreadSchema })),

    rootThread: oc
      .input(z.object({ channelId: z.string() }))
      .output(ThreadSchema),
  },

  message: {
    list: oc
      .input(
        z.object({
          threadId: z.string(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.string().optional(),
        }),
      )
      .output(MessagePageSchema),

    post: oc
      .input(z.object({ threadId: z.string(), text: z.string().min(1).max(16_000) }))
      .output(MessageSchema),

    /** Reconnect path — replay what the client missed while its socket was down. */
    backfill: oc
      .input(
        z.object({
          threadId: z.string(),
          afterMessageId: z.string(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
      )
      .output(z.array(MessageSchema)),
  },

  runner: {
    list: oc.output(z.array(RunnerSchema)),

    createPairingToken: oc
      .input(z.object({ name: z.string().min(1).max(100) }))
      .output(z.object({ runnerId: z.string(), rawToken: z.string() })),
  },

  /**
   * Phase 1 scope cut (PLAN.md §5a): bind an existing repo by absolute path on
   * an already-paired Runner. No directory-picker or `git init` flow yet.
   */
  repository: {
    list: oc.output(z.array(RepositorySchema)),

    bindExisting: oc
      .input(
        z.object({
          runnerId: z.string(),
          path: z.string().min(1),
          displayName: z.string().min(1).max(100),
        }),
      )
      .output(RepositorySchema),
  },

  agentRun: {
    /** Inline persona for Phase 1 — no persona CRUD/markdown storage yet. */
    start: oc
      .input(
        z.object({
          threadId: z.string(),
          repositoryId: z.string(),
          persona: PersonaSpecSchema,
        }),
      )
      .output(AgentRunSchema),

    get: oc.input(z.object({ agentRunId: z.string() })).output(AgentRunSchema),
  },

  /**
   * Human-only resolution of a pending risky-tool gate (PLAN.md §6 A1) — the
   * use-case enforces this is a `user` actor, not this schema, since that's a
   * server-side identity check no client input can carry.
   */
  approval: {
    listPending: oc
      .input(z.object({ agentRunId: z.string() }))
      .output(z.array(ApprovalRequestSchema)),

    decide: oc
      .input(
        z.object({
          approvalRequestId: z.string(),
          decision: z.enum(['approve', 'deny']),
        }),
      )
      .output(ApprovalRequestSchema),
  },
} as const

export type Contract = typeof contract
