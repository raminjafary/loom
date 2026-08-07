import { contract } from '@loom/api-contract'
import {
  backfillMessages,
  bindRepository,
  createChannel,
  createPersona,
  createPersonaGroup,
  createRunnerPairingToken,
  decideApproval,
  deletePersonaGroup,
  discardAgentRun,
  getActiveAgentRun,
  getAgentRun,
  getAgentRunDiff,
  getChannelRootThread,
  getNotificationConfig,
  getPersona,
  getRunControl,
  keepAgentRun,
  listChannels,
  listMessages,
  listPendingApprovals,
  listPersonaGroups,
  listPersonas,
  listRepositories,
  listRunners,
  listRunsNeedingAttention,
  pauseAllRuns,
  postMessage,
  pushAgentRun,
  registerNotificationTarget,
  resumeAllRuns,
  startAgentRun,
  unregisterNotificationTarget,
  updatePersona,
  updatePersonaGroup,
  type AgentDeps,
} from '@loom/application'
import { DomainError } from '@loom/domain'
import {
  asAgentPersonaId,
  asAgentRunId,
  asApprovalRequestId,
  asChannelId,
  asMessageId,
  asPersonaGroupId,
  asRepositoryId,
  asRunnerId,
  asThreadId,
} from '@loom/domain'
import { ORPCError, implement } from '@orpc/server'
import type { Principal } from './auth.js'

export interface RouterContext {
  readonly principal: Principal
  readonly deps: AgentDeps
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

  runner: {
    list: os.runner.list.handler(({ context }) =>
      guard(async () => {
        const runners = await listRunners(context.deps, {
          workspaceId: context.principal.workspaceId,
        })
        return runners.map((runner) => ({ ...runner, allowedRoots: [...runner.allowedRoots] }))
      }),
    ),

    createPairingToken: os.runner.createPairingToken.handler(({ context, input }) =>
      guard(() =>
        createRunnerPairingToken(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          name: input.name,
        }),
      ),
    ),
  },

  repository: {
    list: os.repository.list.handler(({ context }) =>
      guard(() => listRepositories(context.deps, { workspaceId: context.principal.workspaceId })),
    ),

    bindExisting: os.repository.bindExisting.handler(({ context, input }) =>
      guard(() =>
        bindRepository(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          runnerId: asRunnerId(input.runnerId),
          path: input.path,
          displayName: input.displayName,
        }),
      ),
    ),
  },

  persona: {
    list: os.persona.list.handler(({ context }) =>
      guard(() => listPersonas(context.deps, { workspaceId: context.principal.workspaceId })),
    ),

    get: os.persona.get.handler(({ context, input }) =>
      guard(() =>
        getPersona(context.deps, {
          workspaceId: context.principal.workspaceId,
          personaId: asAgentPersonaId(input.personaId),
        }),
      ),
    ),

    create: os.persona.create.handler(({ context, input }) =>
      guard(() =>
        createPersona(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          markdownSource: input.markdownSource,
        }),
      ),
    ),

    update: os.persona.update.handler(({ context, input }) =>
      guard(() =>
        updatePersona(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          personaId: asAgentPersonaId(input.personaId),
          markdownSource: input.markdownSource,
        }),
      ),
    ),
  },

  personaGroup: {
    list: os.personaGroup.list.handler(({ context }) =>
      guard(() => listPersonaGroups(context.deps, { workspaceId: context.principal.workspaceId })),
    ),

    create: os.personaGroup.create.handler(({ context, input }) =>
      guard(() =>
        createPersonaGroup(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          name: input.name,
          personaIds: input.personaIds,
        }),
      ),
    ),

    update: os.personaGroup.update.handler(({ context, input }) =>
      guard(() =>
        updatePersonaGroup(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          personaGroupId: asPersonaGroupId(input.personaGroupId),
          name: input.name,
          personaIds: input.personaIds,
        }),
      ),
    ),

    delete: os.personaGroup.delete.handler(({ context, input }) =>
      guard(async () => {
        await deletePersonaGroup(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          personaGroupId: asPersonaGroupId(input.personaGroupId),
        })
        return { ok: true as const }
      }),
    ),
  },

  agentRun: {
    start: os.agentRun.start.handler(({ context, input }) =>
      guard(() =>
        startAgentRun(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          threadId: asThreadId(input.threadId),
          repositoryId: asRepositoryId(input.repositoryId),
          personaId: asAgentPersonaId(input.personaId),
          ...(input.task === undefined ? {} : { task: input.task }),
        }),
      ),
    ),

    get: os.agentRun.get.handler(({ context, input }) =>
      guard(() =>
        getAgentRun(context.deps, {
          workspaceId: context.principal.workspaceId,
          agentRunId: asAgentRunId(input.agentRunId),
        }),
      ),
    ),

    getActive: os.agentRun.getActive.handler(({ context }) =>
      guard(() => getActiveAgentRun(context.deps, { workspaceId: context.principal.workspaceId })),
    ),

    getDiff: os.agentRun.getDiff.handler(({ context, input }) =>
      guard(async () => ({
        diff: await getAgentRunDiff(context.deps, {
          workspaceId: context.principal.workspaceId,
          agentRunId: asAgentRunId(input.agentRunId),
        }),
      })),
    ),

    keep: os.agentRun.keep.handler(({ context, input }) =>
      guard(() =>
        keepAgentRun(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          agentRunId: asAgentRunId(input.agentRunId),
        }),
      ),
    ),

    discard: os.agentRun.discard.handler(({ context, input }) =>
      guard(() =>
        discardAgentRun(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          agentRunId: asAgentRunId(input.agentRunId),
        }),
      ),
    ),

    push: os.agentRun.push.handler(({ context, input }) =>
      guard(() =>
        pushAgentRun(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          agentRunId: asAgentRunId(input.agentRunId),
          ...(input.acknowledgeCiChange === undefined
            ? {}
            : { acknowledgeCiChange: input.acknowledgeCiChange }),
        }),
      ),
    ),

    listNeedsAttention: os.agentRun.listNeedsAttention.handler(({ context }) =>
      guard(() => listRunsNeedingAttention(context.deps, { workspaceId: context.principal.workspaceId })),
    ),
  },

  runControl: {
    get: os.runControl.get.handler(({ context }) =>
      guard(() => getRunControl(context.deps, { workspaceId: context.principal.workspaceId })),
    ),

    pauseAll: os.runControl.pauseAll.handler(({ context }) =>
      guard(() =>
        pauseAllRuns(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
        }),
      ),
    ),

    resume: os.runControl.resume.handler(({ context }) =>
      guard(() =>
        resumeAllRuns(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
        }),
      ),
    ),
  },

  notification: {
    config: os.notification.config.handler(({ context }) =>
      getNotificationConfig(context.deps),
    ),

    subscribe: os.notification.subscribe.handler(({ context, input }) =>
      guard(async () => {
        const target = await registerNotificationTarget(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          transport: input.transport,
          endpoint: input.endpoint,
          credentials: input.credentials,
        })
        // `credentials` and `userId` are deliberately not returned — see
        // NotificationTargetSchema.
        return {
          id: target.id,
          workspaceId: target.workspaceId,
          transport: target.transport,
          endpoint: target.endpoint,
          createdAt: target.createdAt,
        }
      }),
    ),

    unsubscribe: os.notification.unsubscribe.handler(({ context, input }) =>
      guard(async () => {
        await unregisterNotificationTarget(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          endpoint: input.endpoint,
        })
        return { ok: true as const }
      }),
    ),
  },

  approval: {
    listPending: os.approval.listPending.handler(({ context, input }) =>
      guard(() =>
        listPendingApprovals(context.deps, {
          workspaceId: context.principal.workspaceId,
          agentRunId: asAgentRunId(input.agentRunId),
        }),
      ),
    ),

    decide: os.approval.decide.handler(({ context, input }) =>
      guard(() =>
        decideApproval(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          approvalRequestId: asApprovalRequestId(input.approvalRequestId),
          decision: input.decision,
        }),
      ),
    ),
  },
})

export type Router = typeof router
