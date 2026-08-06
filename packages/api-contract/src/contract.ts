import { oc } from '@orpc/contract'
import { z } from 'zod'
import {
  ActorSchema,
  AgentPersonaSchema,
  AgentRunSchema,
  ApprovalRequestSchema,
  ChannelSchema,
  MessagePageSchema,
  MessageSchema,
  PersonaGroupSchema,
  RepositorySchema,
  RunControlSchema,
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

  /** PLAN.md §4e Phase 1 subset — markdown+frontmatter, read/CRUD only. */
  persona: {
    list: oc.output(z.array(AgentPersonaSchema)),

    get: oc.input(z.object({ personaId: z.string() })).output(AgentPersonaSchema),

    create: oc
      .input(z.object({ markdownSource: z.string().min(1).max(40_000) }))
      .output(AgentPersonaSchema),

    update: oc
      .input(z.object({ personaId: z.string(), markdownSource: z.string().min(1).max(40_000) }))
      .output(AgentPersonaSchema),
  },

  /** PLAN.md §3a — organizational only; does not start anything, does not bind a channel/Planner. */
  personaGroup: {
    list: oc.output(z.array(PersonaGroupSchema)),

    create: oc
      .input(z.object({ name: z.string().min(1).max(100), personaIds: z.array(z.string()) }))
      .output(PersonaGroupSchema),

    update: oc
      .input(
        z.object({
          personaGroupId: z.string(),
          name: z.string().min(1).max(100),
          personaIds: z.array(z.string()),
        }),
      )
      .output(PersonaGroupSchema),

    delete: oc.input(z.object({ personaGroupId: z.string() })).output(z.object({ ok: z.literal(true) })),
  },

  agentRun: {
    start: oc
      .input(
        z.object({
          threadId: z.string(),
          repositoryId: z.string(),
          personaId: z.string(),
          /** What a human asked for via `@mention` (PLAN.md §3a); absent for the sidebar picker. */
          task: z.string().min(1).max(4_000).optional(),
        }),
      )
      .output(AgentRunSchema),

    get: oc.input(z.object({ agentRunId: z.string() })).output(AgentRunSchema),

    /** Lets a client resume watching an already-active run after a reload (PLAN.md §3a). */
    getActive: oc.output(AgentRunSchema.nullable()),

    /** On-demand branch diff for end-of-run review (PLAN.md §5a). */
    getDiff: oc
      .input(z.object({ agentRunId: z.string() }))
      .output(z.object({ diff: z.string() })),

    /** Keeps a finished run's branch as-is — no push, no host action (PLAN.md §7 ship criterion's "keep" case). */
    keep: oc.input(z.object({ agentRunId: z.string() })).output(AgentRunSchema),

    /** Discards a finished run's branch: the Runner deletes the on-disk clone. */
    discard: oc.input(z.object({ agentRunId: z.string() })).output(AgentRunSchema),

    /**
     * Host-side pushes the run's branch to the bound repo's `origin` and
     * best-effort opens a PR/MR (PLAN.md §6 A2) — the agent never holds git
     * credentials or pushes. `acknowledgeCiChange` re-submits a push the
     * policy blocked for touching CI config, confirming human review.
     */
    push: oc
      .input(z.object({ agentRunId: z.string(), acknowledgeCiChange: z.boolean().optional() }))
      .output(AgentRunSchema),

    /** Runs needing a human decision — the inbox's data source (PLAN.md §3). */
    listNeedsAttention: oc.output(z.array(AgentRunSchema)),
  },

  /**
   * The global kill switch (PLAN.md §6 runtime safety: "One button. Nothing had
   * one."). `pauseAll` blocks new runs *and* cancels every in-flight one;
   * `resume` only lifts the block — it never restarts what the pause killed.
   */
  runControl: {
    get: oc.output(RunControlSchema),

    pauseAll: oc.output(
      z.object({ control: RunControlSchema, cancelledRunIds: z.array(z.string()) }),
    ),

    resume: oc.output(RunControlSchema),
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
