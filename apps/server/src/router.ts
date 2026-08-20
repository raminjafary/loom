import { contract } from '@loom/api-contract'
import {
  backfillMessages,
  bindRepository,
  createChannel,
  createPersona,
  createPersonaGroup,
  createRunnerPairingToken,
  deleteChannel,
  deletePersona,
  deleteRunner,
  decideApproval,
  deletePersonaGroup,
  attachCapability,
  cancelMergeQueueEntry,
  createCapability,
  createRepository,
  deleteCapability,
  detachCapability,
  discardAgentRun,
  unbindRepository,
  enqueueMergeRun,
  getActiveAgentRun,
  getAgentRun,
  getAgentRunDiff,
  getChannelRootThread,
  listChannelThreads,
  getNotificationConfig,
  getPersona,
  getRawTranscript,
  getRunControl,
  getSwarmBoard,
  getWorkspaceCostSummary,
  keepAgentRun,
  listActiveAgentRuns,
  listChannels,
  listChildAgentRuns,
  listCapabilities,
  listCapabilityAttachments,
  listMergeQueue,
  listMessages,
  listRunnerDirectory,
  listPendingApprovals,
  listPersonaGroups,
  listPersonas,
  listRepositories,
  listRunners,
  listRunsNeedingAttention,
  listSettledRuns,
  getMastery,
  concludeSession,
  acceptPlan,
  contendAtlasProposal,
  getPlanForReview,
  rejectPlan,
  requestPlanChanges,
  setModelRoutingEnabled,
  setPlanReviewRequired,
  conveneSession,
  decideAtlasProposal,
  listAtlasProposals,
  type AtlasEdge,
  curateMap,
  getSession as getColosseumSession,
  listSessions,
  recordOpeningClaim,
  settleSessionClaim,
  takeSessionTurn,
  listExpertiseUsedByRuns,
  listPersonaMaps,
  listRepositoryMaps,
  listWorkspaceMaps,
  setRetrievalOverride,
  listTreeNotes,
  delegationMatrixForWorkspace,
  delegationPreviewForPersona,
  parsePersonaDraft,
  pauseAllRuns,
  postMessage,
  pushAgentRun,
  registerNotificationTarget,
  resetPersonaToBuiltin,
  listUnread,
  markChannelRead,
  listPersonaRevisions,
  divergenceForPersona,
  promptTrialFor,
  supervisionLedgerFor,
  listVariantSearches,
  promoteVariant,
  discardVariantSearch,
  keepPromptRevision,
  revertPersonaPrompt,
  resumeAllRuns,
  setHandoffPolicy,
  setRepositoryInstallCommand,
  setRepositoryReconcilerEnabled,
  setRepositoryVerifyCommand,
  setRepositoryVerificationChecks,
  listRunVerifications,
  warmRepositoryCache,
  readSelfDeployment,
  startAgentRun,
  startVariantProposer,
  steerSwarm,
  unregisterNotificationTarget,
  updatePersona,
  updatePersonaGroup,
  writeHumanNote,
  type AgentDeps,
} from '@loom/application'
import {
  DomainError,
  builtinPersonaStatus,
  type AgentPersona,
  type PersonaRevision,
  type MergeQueueEntry,
  type WorkerNote,
} from '@loom/domain'
import {
  asAgentPersonaId,
  asPersonaVariantId,
  parsePersonaMarkdown,
  asPersonaRevisionId,
  asAgentRunId,
  asSubjectMapId,
  NotFoundError,
  ValidationError,
  parseMasteryDirective,
  asApprovalRequestId,
  asCapabilityId,
  asChannelId,
  asMergeQueueEntryId,
  asMessageId,
  asPersonaGroupId,
  asRepositoryId,
  asRunnerId,
  asThreadId,
} from '@loom/domain'
import { ORPCError, implement } from '@orpc/server'
import type { Principal } from './auth.js'
import type { SubscriptionTokenMinter } from './subscription-token.js'

/**
 * `position` is a Postgres bigserial, which a JSON number cannot carry faithfully,
 * so the wire form is a string (see MergeQueueEntrySchema). Everything else on the
 * entry passes through and is narrowed by the output schema.
 */
const toWireMergeQueueEntry = (entry: MergeQueueEntry) => ({
  ...entry,
  position: entry.position.toString(),
})

/**
 * Adds the derived `builtinStatus`.
 *
 * Derived here rather than stored, and rather than computed in the client: the client
 * has no copy of what this build ships, and giving it one would be a second place for
 * the shipped personas to live.
 */
const toWirePersona = (persona: AgentPersona) => ({
  ...persona,
  builtinStatus: builtinPersonaStatus(persona),
})

/**
 * A persona revision on the wire, field by field rather than
 * spread, for the reason `toWireAtlasEdge` gives below: a spread is how a field goes
 * missing across a port in this codebase, and this repository has now paid for that four
 * times.
 */
const toWirePersonaRevision = (revision: PersonaRevision) => ({
  id: revision.id,
  personaId: revision.personaId,
  markdownSource: revision.markdownSource,
  replacedByKind: revision.replacedByKind,
  replacedByRunId: revision.replacedByRunId,
  rationale: revision.rationale,
  createdAt: revision.createdAt.toISOString(),
})

/** `paths` is readonly in the domain and mutable on the wire — same as `runner.allowedRoots`. */
const toWireWorkerNote = (note: WorkerNote) => ({ ...note, paths: [...note.paths] })

/**
 * An atlas edge, field by field rather than spread.
 *
 * Named explicitly because a spread is how a field goes missing across a port in this
 * codebase — an excess-property check does not fire on one, so an added field arrives on
 * the type and never on the wire. Listing them makes a new field a compile error here.
 */
const toWireAtlasEdge = (edge: AtlasEdge) => ({
  id: edge.id,
  relation: edge.relation,
  rationale: edge.rationale,
  status: edge.status,
  from: { ...edge.from },
  to: { ...edge.to },
  proposedByPersonaName: edge.proposedByPersonaName,
  proposedByRunId: edge.proposedByRunId,
  sessionId: edge.sessionId,
  decidedByName: edge.decidedByName,
  decidedAt: edge.decidedAt,
  decisionNote: edge.decisionNote,
  createdAt: edge.createdAt,
})

export interface RouterContext {
  readonly principal: Principal
  readonly deps: AgentDeps
  /**
   * Mints the realtime gateway's credential. A capability rather than the
   * secret itself, so the router — which every client procedure runs through — never holds
   * the key that authorises reading a workspace's stream.
   */
  readonly mintSubscriptionToken: SubscriptionTokenMinter
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
      /**
       * Workspace limits a client must not invent. The composition
       * canvas has to know how deep delegation may go before it can say which of the
       * edges it draws a plan could actually use, and a client that hard-coded 2 would
       * be hard-coding server configuration.
       */
      limits: {
        maxDelegationDepth: context.deps.limits.maxDelegationDepth,
        maxConcurrentRunsPerWorkspace: context.deps.limits.maxConcurrentRunsPerWorkspace,
      },
    })),

    subscriptionToken: os.session.subscriptionToken.handler(({ context }) =>
      context.mintSubscriptionToken(context.principal.workspaceId),
    ),
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

    threads: os.channel.threads.handler(({ context, input }) =>
      guard(() =>
        listChannelThreads(context.deps, {
          workspaceId: context.principal.workspaceId,
          channelId: asChannelId(input.channelId),
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

    delete: os.channel.delete.handler(({ context, input }) =>
      guard(async () => {
        await deleteChannel(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          channelId: asChannelId(input.channelId),
          ...(input.acknowledgeRunHistoryLoss === undefined
            ? {}
            : { acknowledgeRunHistoryLoss: input.acknowledgeRunHistoryLoss }),
        })
        return { ok: true as const }
      }),
    ),

    unread: os.channel.unread.handler(({ context }) =>
      guard(async () =>
        (
          await listUnread(context.deps, {
            workspaceId: context.principal.workspaceId,
            actor: context.principal.actor,
          })
        ).map((row) => ({ channelId: row.channelId as string, unread: row.unread })),
      ),
    ),

    markRead: os.channel.markRead.handler(({ context, input }) =>
      guard(async () =>
        markChannelRead(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
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
          ...(input.view === undefined ? {} : { view: input.view }),
          ...(input.focusRunId === undefined ? {} : { focusRunId: input.focusRunId }),
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

    remove: os.runner.remove.handler(({ context, input }) =>
      guard(async () => {
        await deleteRunner(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          runnerId: asRunnerId(input.runnerId),
        })
        return { ok: true as const }
      }),
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

    listDirectory: os.repository.listDirectory.handler(({ context, input }) =>
      guard(async () => {
        const result = await listRunnerDirectory(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          runnerId: asRunnerId(input.runnerId),
          path: input.path,
        })
        // The union's ok:true discriminant is stripped here — a thrown
        // ValidationError already carried the failure case to the client.
        return {
          path: result.ok ? result.path : '',
          parent: result.ok ? result.parent : null,
          entries: result.ok ? result.entries : [],
          truncated: result.ok ? result.truncated : false,
        }
      }),
    ),

    createNew: os.repository.createNew.handler(({ context, input }) =>
      guard(() =>
        createRepository(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          runnerId: asRunnerId(input.runnerId),
          parentPath: input.parentPath,
          name: input.name,
          displayName: input.displayName,
        }),
      ),
    ),

    setInstallCommand: os.repository.setInstallCommand.handler(({ context, input }) =>
      guard(() =>
        setRepositoryInstallCommand(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          repositoryId: asRepositoryId(input.repositoryId),
          installCommand: input.installCommand,
        }),
      ),
    ),

    warmCache: os.repository.warmCache.handler(({ context, input }) =>
      guard(() =>
        warmRepositoryCache(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          repositoryId: asRepositoryId(input.repositoryId),
        }),
      ),
    ),

    setVerifyCommand: os.repository.setVerifyCommand.handler(({ context, input }) =>
      guard(() =>
        setRepositoryVerifyCommand(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          repositoryId: asRepositoryId(input.repositoryId),
          verifyCommand: input.verifyCommand,
        }),
      ),
    ),

    setVerificationChecks: os.repository.setVerificationChecks.handler(({ context, input }) =>
      guard(() =>
        setRepositoryVerificationChecks(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          repositoryId: asRepositoryId(input.repositoryId),
          checks: input.checks,
        }),
      ),
    ),

    setReconcilerEnabled: os.repository.setReconcilerEnabled.handler(({ context, input }) =>
      guard(() =>
        setRepositoryReconcilerEnabled(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          repositoryId: asRepositoryId(input.repositoryId),
          enabled: input.enabled,
        }),
      ),
    ),

    unbind: os.repository.unbind.handler(({ context, input }) =>
      guard(async () => {
        await unbindRepository(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          repositoryId: asRepositoryId(input.repositoryId),
          ...(input.acknowledgeRunHistoryLoss === undefined
            ? {}
            : { acknowledgeRunHistoryLoss: input.acknowledgeRunHistoryLoss }),
        })
        return { ok: true as const }
      }),
    ),
  },

  mergeQueue: {
    list: os.mergeQueue.list.handler(({ context }) =>
      guard(async () =>
        (await listMergeQueue(context.deps, { workspaceId: context.principal.workspaceId })).map(
          toWireMergeQueueEntry,
        ),
      ),
    ),

    enqueue: os.mergeQueue.enqueue.handler(({ context, input }) =>
      guard(async () =>
        toWireMergeQueueEntry(
          await enqueueMergeRun(context.deps, {
            workspaceId: context.principal.workspaceId,
            actor: context.principal.actor,
            agentRunId: asAgentRunId(input.agentRunId),
            ...(input.overrideBlockers ? { overrideBlockers: true } : {}),
          }),
        ),
      ),
    ),

    cancel: os.mergeQueue.cancel.handler(({ context, input }) =>
      guard(async () =>
        toWireMergeQueueEntry(
          await cancelMergeQueueEntry(context.deps, {
            workspaceId: context.principal.workspaceId,
            actor: context.principal.actor,
            entryId: asMergeQueueEntryId(input.entryId),
          }),
        ),
      ),
    ),
  },

  /** The worker-notes ledger and the board. */
  /**
   * A persona's expertise.
   *
   * No write path for nodes or edges, deliberately — see the contract. A client that
   * could write a map could put text of its choosing into every future run's prompt.
   */
  mastery: {
    listForPersona: os.mastery.listForPersona.handler(({ context, input }) =>
      guard(() =>
        listPersonaMaps(context.deps, {
          workspaceId: context.principal.workspaceId,
          personaId: asAgentPersonaId(input.personaId),
        }),
      ),
    ),

    listForRepository: os.mastery.listForRepository.handler(({ context, input }) =>
      guard(() =>
        listRepositoryMaps(context.deps, {
          workspaceId: context.principal.workspaceId,
          repositoryId: asRepositoryId(input.repositoryId),
        }),
      ),
    ),

    curate: os.mastery.curate.handler(({ context, input }) =>
      guard(() =>
        curateMap(context.deps, {
          workspaceId: context.principal.workspaceId,
          mapId: asSubjectMapId(input.mapId),
        }),
      ),
    ),

    listAll: os.mastery.listAll.handler(({ context }) =>
      guard(() => listWorkspaceMaps(context.deps, { workspaceId: context.principal.workspaceId })),
    ),

    usedByRuns: os.mastery.usedByRuns.handler(({ context, input }) =>
      guard(() =>
        listExpertiseUsedByRuns(context.deps, {
          workspaceId: context.principal.workspaceId,
          agentRunIds: input.agentRunIds.map(asAgentRunId),
        }),
      ),
    ),

    setRetrieval: os.mastery.setRetrieval.handler(({ context, input }) =>
      guard(() =>
        setRetrievalOverride(context.deps, {
          workspaceId: context.principal.workspaceId,
          mapId: asSubjectMapId(input.mapId),
          override: input.override,
        }),
      ),
    ),

    get: os.mastery.get.handler(({ context, input }) =>
      guard(async () => {
        const view = await getMastery(context.deps, {
          workspaceId: context.principal.workspaceId,
          mapId: asSubjectMapId(input.mapId),
        })
        // `paths` is readonly in the domain and mutable on the wire; spreading is the
        // same seam `toWireWorkerNote` is.
        return {
          ...view,
          nodes: view.nodes.map((node) => ({ ...node, paths: [...node.paths] })),
          hubs: view.hubs.map((hub) => ({ ...hub })),
        }
      }),
    ),

    /**
     * The mastery run. Goes through `startAgentRun` unchanged — "a mastery run is a
     * normal run: same sandbox, same egress metering, same budget cap. It is cheap
     * because it is read-only and Haiku-tier, not because it is exempt" — so the
     * concurrency limit, the kill switch and the reaper all see it as what it is.
     */
    start: os.mastery.start.handler(({ context, input }) =>
      guard(async () => {
        const repository = await context.deps.repositories.findById(
          context.principal.workspaceId,
          asRepositoryId(input.repositoryId),
        )
        if (!repository) throw new NotFoundError('Repository')

        /**
         * Which subject, and who. A repository subject's ref is the
         * repository's display name rather than its id — it is what a human reads on the
         * map, and an id would make every map's title a uuid. An author subject's ref is
         * the person, and the repository stays required because their record *is* that
         * repository's history: an author subject with no corpus is a map with nothing
         * behind it.
         */
        const subjectKind = input.subjectKind ?? 'repository'
        const subjectRef =
          subjectKind === 'author' ? (input.subjectRef ?? '').trim() : repository.displayName
        if (subjectKind === 'author' && subjectRef === '') {
          throw new ValidationError(
            'An author subject needs the name or email that this repository\'s history records for them — that is the corpus.',
          )
        }

        /**
         * Refused rather than dropped. A focus a subject has no record to satisfy would
         * produce either an invention or nothing, and the human read the option as a
         * promise when they picked it.
         */
        const verdict = parseMasteryDirective(
          {
            ...(input.focus === undefined ? {} : { focus: input.focus }),
            ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
          },
          subjectKind,
        )
        if (!verdict.ok) throw new ValidationError(verdict.reason)

        return startAgentRun(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          threadId: asThreadId(input.threadId),
          repositoryId: repository.id,
          personaId: asAgentPersonaId(input.personaId),
          ...(input.task === undefined ? {} : { task: input.task }),
          mastery: {
            subjectKind,
            subjectRef,
            directive: verdict.directive,
          },
        })
      }),
    ),
  },

  /** The venue. Nothing here writes a map — a session's output is claims with verdicts. */
  /**
   * The atlas's write side — the queue, the venue, and the decision.
   *
   * No `propose` handler, deliberately: a proposal reaches the platform over the Runner
   * channel, from a run that followed a lead and went and looked. A form here would let a
   * human record a relation nobody checked with the same status as one that was.
   */
  atlas: {
    listProposals: os.atlas.listProposals.handler(({ context, input }) =>
      guard(async () =>
        (
          await listAtlasProposals(context.deps, {
            workspaceId: context.principal.workspaceId,
            ...(input.status === undefined ? {} : { statuses: input.status }),
          })
        ).map(toWireAtlasEdge),
      ),
    ),

    contend: os.atlas.contend.handler(({ context, input }) =>
      guard(async () => {
        const held = await contendAtlasProposal(context.deps, {
          workspaceId: context.principal.workspaceId,
          threadId: asThreadId(input.threadId),
          edgeId: input.edgeId,
        })
        if (held) return { edge: toWireAtlasEdge(held.edge), sessionId: held.session.id }
        /**
         * No room, and that is an answer rather than a failure: one persona holding both
         * subjects cannot form a roster that can disagree. The proposal is unchanged and
         * still perfectly decidable by a human, so the edge comes back as it was.
         */
        const edges = await listAtlasProposals(context.deps, {
          workspaceId: context.principal.workspaceId,
        })
        const edge = edges.find((entry) => entry.id === input.edgeId)
        if (!edge) throw new NotFoundError('AtlasEdge')
        return { edge: toWireAtlasEdge(edge), sessionId: null }
      }),
    ),

    decide: os.atlas.decide.handler(({ context, input }) =>
      guard(async () =>
        toWireAtlasEdge(
          await decideAtlasProposal(context.deps, {
            workspaceId: context.principal.workspaceId,
            actor: context.principal.actor,
            edgeId: input.edgeId,
            decision: input.decision,
            ...(input.note === undefined ? {} : { note: input.note }),
            decidedByName: context.principal.displayName,
          }),
        ),
      ),
    ),
  },

  colosseum: {
    list: os.colosseum.list.handler(({ context }) =>
      guard(() => listSessions(context.deps, { workspaceId: context.principal.workspaceId })),
    ),

    get: os.colosseum.get.handler(({ context, input }) =>
      guard(() =>
        getColosseumSession(context.deps, {
          workspaceId: context.principal.workspaceId,
          sessionId: input.sessionId,
        }),
      ),
    ),

    convene: os.colosseum.convene.handler(({ context, input }) =>
      guard(() =>
        conveneSession(context.deps, {
          workspaceId: context.principal.workspaceId,
          threadId: asThreadId(input.threadId),
          repositoryId: input.repositoryId === null ? null : asRepositoryId(input.repositoryId),
          purpose: input.purpose,
          subject: input.subject,
          question: input.question,
          personaIds: input.personaIds.map(asAgentPersonaId),
          ...(input.turnCap === undefined ? {} : { turnCap: input.turnCap }),
          ...(input.spendCapUsd === undefined ? {} : { spendCapUsd: input.spendCapUsd }),
        }),
      ),
    ),

    recordClaim: os.colosseum.recordClaim.handler(({ context, input }) =>
      guard(() =>
        recordOpeningClaim(context.deps, {
          workspaceId: context.principal.workspaceId,
          sessionId: input.sessionId,
          personaId: asAgentPersonaId(input.personaId),
          statement: input.statement,
        }),
      ),
    ),

    settleClaim: os.colosseum.settleClaim.handler(({ context, input }) =>
      guard(() =>
        settleSessionClaim(context.deps, {
          workspaceId: context.principal.workspaceId,
          claimId: input.claimId,
          verdict: input.verdict,
          citation: input.citation,
        }),
      ),
    ),

    /**
     * One turn — one ordinary agent run, started here so the use case never has to know
     * `startAgentRun` exists (the same injection `hand_over` uses, for the same reason).
     *
     * The session's thread and repository, the speaker's persona, and what is left of the
     * session's ceiling as this run's budget cap. Nothing about it is a special execution
     * path: it is metered, sandboxed, approvable and killable exactly like any other run,
     * which is what makes the "a session is a thing on the board" true rather than
     * aspirational.
     */
    takeTurn: os.colosseum.takeTurn.handler(({ context, input }) =>
      guard(async () => {
        const result = await takeSessionTurn(
          {
            ...context.deps,
            startTurnRun: async ({ session, speaker, task, budgetCapUsd }) => {
              const run = await startAgentRun(context.deps, {
                workspaceId: context.principal.workspaceId,
                actor: context.principal.actor,
                threadId: session.threadId,
                // Non-null by the time this runs — `takeSessionTurn` refuses a session
                // with no repository before it ever gets here, and says why.
                repositoryId: session.repositoryId as never,
                personaId: speaker.personaId,
                task,
                ...(budgetCapUsd === null ? {} : { budgetCapUsd }),
              })
              return run.id
            },
          },
          {
            workspaceId: context.principal.workspaceId,
            sessionId: input.sessionId,
            ...(input.personaId === undefined
              ? {}
              : { personaId: asAgentPersonaId(input.personaId) }),
          },
        )
        return {
          ok: result.ok,
          reason: result.reason,
          agentRunId: result.agentRunId,
          speakerPersonaName: result.speaker?.personaName ?? null,
        }
      }),
    ),

    conclude: os.colosseum.conclude.handler(({ context, input }) =>
      guard(() =>
        concludeSession(context.deps, {
          workspaceId: context.principal.workspaceId,
          sessionId: input.sessionId,
        }),
      ),
    ),
  },

  workerNote: {
    listByTree: os.workerNote.listByTree.handler(({ context, input }) =>
      guard(async () =>
        (
          await listTreeNotes(context.deps, {
            workspaceId: context.principal.workspaceId,
            agentRunId: asAgentRunId(input.agentRunId),
          })
        ).map(toWireWorkerNote),
      ),
    ),

    write: os.workerNote.write.handler(({ context, input }) =>
      guard(async () =>
        toWireWorkerNote(
          await writeHumanNote(context.deps, {
            workspaceId: context.principal.workspaceId,
            actor: context.principal.actor,
            agentRunId: asAgentRunId(input.agentRunId),
            // The note is passed as an opaque value and validated by the domain, so the
            // contract schema and `parseNoteInput` cannot drift into disagreeing about
            // what a valid note is — there is one answer, and it is the domain's.
            note: {
              kind: input.kind,
              title: input.title,
              body: input.body,
              paths: input.paths ?? [],
            },
          }),
        ),
      ),
    ),

    board: os.workerNote.board.handler(({ context, input }) =>
      guard(() =>
        getSwarmBoard(context.deps, {
          workspaceId: context.principal.workspaceId,
          agentRunId: asAgentRunId(input.agentRunId),
        }),
      ),
    ),
  },

  /**
   * Workspace spend. Scoped to the caller's own workspace from the
   * session, never from input — the same rule as every other read here, and the reason
   * identity-bound approval insists identity comes off the session.
   */
  cost: {
    summary: os.cost.summary.handler(({ context, input }) =>
      guard(() =>
        getWorkspaceCostSummary(context.deps, {
          workspaceId: context.principal.workspaceId,
          windowHours: input.windowHours ?? null,
        }),
      ),
    ),
  },

  supervision: {
    ledger: os.supervision.ledger.handler(({ context }) =>
      guard(async () => {
        const { ledger, detail, since } = await supervisionLedgerFor(context.deps, {
          workspaceId: context.principal.workspaceId,
          now: new Date(),
        })
        // Field by field, as everywhere else here: a spread skips the excess-property check.
        return {
          since,
          detail,
          total: ledger.total,
          byKind: {
            approval: ledger.byKind.approval,
            disposition: ledger.byKind.disposition,
            promotion: ledger.byKind.promotion,
            veto: ledger.byKind.veto,
            envelope: ledger.byKind.envelope,
          },
          envelopeChanges: ledger.envelopeChanges,
          decidedRuns: ledger.decidedRuns,
          uncounted: ledger.uncounted,
          automatic: ledger.automatic,
        }
      }),
    ),
  },

  persona: {
    list: os.persona.list.handler(({ context }) =>
      guard(async () =>
        (await listPersonas(context.deps, { workspaceId: context.principal.workspaceId })).map(
          toWirePersona,
        ),
      ),
    ),

    get: os.persona.get.handler(({ context, input }) =>
      guard(async () =>
        toWirePersona(
          await getPersona(context.deps, {
            workspaceId: context.principal.workspaceId,
            personaId: asAgentPersonaId(input.personaId),
          }),
        ),
      ),
    ),

    delegationPreview: os.persona.delegationPreview.handler(({ context, input }) =>
      guard(() =>
        delegationPreviewForPersona(context.deps, {
          workspaceId: context.principal.workspaceId,
          personaId: asAgentPersonaId(input.personaId),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.budgetCapUsd === undefined ? {} : { budgetCapUsd: input.budgetCapUsd }),
        }),
      ),
    ),

    parse: os.persona.parse.handler(({ input }) =>
      guard(async () => parsePersonaDraft({ markdownSource: input.markdownSource })),
    ),

    create: os.persona.create.handler(({ context, input }) =>
      guard(async () =>
        toWirePersona(
          await createPersona(context.deps, {
            workspaceId: context.principal.workspaceId,
            actor: context.principal.actor,
            markdownSource: input.markdownSource,
          }),
        ),
      ),
    ),

    update: os.persona.update.handler(({ context, input }) =>
      guard(async () =>
        toWirePersona(
          await updatePersona(context.deps, {
            workspaceId: context.principal.workspaceId,
            actor: context.principal.actor,
            personaId: asAgentPersonaId(input.personaId),
            markdownSource: input.markdownSource,
          }),
        ),
      ),
    ),

    resetToBuiltin: os.persona.resetToBuiltin.handler(({ context, input }) =>
      guard(async () =>
        toWirePersona(
          await resetPersonaToBuiltin(context.deps, {
            workspaceId: context.principal.workspaceId,
            actor: context.principal.actor,
            personaId: asAgentPersonaId(input.personaId),
          }),
        ),
      ),
    ),

    revisions: os.persona.revisions.handler(({ context, input }) =>
      guard(async () =>
        (
          await listPersonaRevisions(context.deps, {
            workspaceId: context.principal.workspaceId,
            ...(input.personaId === undefined
              ? {}
              : { personaId: asAgentPersonaId(input.personaId) }),
          })
        ).map(toWirePersonaRevision),
      ),
    ),

    revert: os.persona.revert.handler(({ context, input }) =>
      guard(async () =>
        toWirePersona(
          await revertPersonaPrompt(context.deps, {
            workspaceId: context.principal.workspaceId,
            actor: context.principal.actor,
            personaId: asAgentPersonaId(input.personaId),
            revisionId: asPersonaRevisionId(input.revisionId),
          }),
        ),
      ),
    ),

    divergence: os.persona.divergence.handler(({ context, input }) =>
      guard(async () => {
        const found = await divergenceForPersona(context.deps, {
          workspaceId: context.principal.workspaceId,
          personaId: asAgentPersonaId(input.personaId),
        })
        if (!found) return null
        return {
          detail: found.detail,
          passedAndDiscarded: found.set.passedAndDiscarded,
          failedAndMerged: found.set.failedAndMerged,
          comparable: found.set.comparable,
          // Field by field rather than spread: an excess-property check does not fire on a
          // spread, which is how fields have gone missing across a port here before.
          runs: found.set.runs.map((run) => ({
            runId: run.runId,
            task: run.task,
            kind: run.kind,
            failingCheck: run.failingCheck,
            decidedAt: run.decidedAt,
          })),
        }
      }),
    ),

    trial: os.persona.trial.handler(({ context, input }) =>
      guard(async () => {
        const found = await promptTrialFor(context.deps, {
          workspaceId: context.principal.workspaceId,
          personaId: asAgentPersonaId(input.personaId),
        })
        if (!found) return null
        return {
          revisionId: found.revisionId as string,
          verdict: found.effect.verdict,
          detail: found.effect.detail,
          // Named field by field rather than spread: an excess-property check does not
          // fire on a spread, which is how four fields have gone missing across a port
          // in this codebase.
          arms: [found.effect.revised, found.effect.previous].map((arm) => ({
            arm: arm.arm,
            decided: arm.decided,
            merged: arm.merged,
            failed: arm.failed,
            verificationFailed: arm.verificationFailed,
            failingCheck: arm.failingCheck,
            meanCostUsd: arm.meanCostUsd,
          })),
        }
      }),
    ),

    keepRevision: os.persona.keepRevision.handler(({ context, input }) =>
      guard(async () => {
        await keepPromptRevision(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          personaId: asAgentPersonaId(input.personaId),
          revisionId: asPersonaRevisionId(input.revisionId),
        })
        return { ok: true as const }
      }),
    ),

    variantSearches: os.persona.variantSearches.handler(({ context }) =>
      guard(async () => {
        const searches = await listVariantSearches(context.deps, {
          workspaceId: context.principal.workspaceId,
        })
        /**
         * Named field by field, arms and candidates both — an excess-property check does
         * not fire on a spread, which is how four fields have gone missing across a port in
         * this codebase.
         *
         * The candidates carry their *body* rather than the whole document: the frontmatter
         * of a candidate is the persona's own, so putting it on the wire would invite a
         * client to render configuration that is not what a promotion would write.
         */
        return searches.map((found) => ({
          personaId: found.personaId as string,
          setId: found.setId as string,
          detail: found.effect.detail,
          leader: found.effect.leader === null ? null : (found.effect.leader as string),
          candidates: found.candidates.map((candidate) => ({
            variantId: candidate.id as string,
            body: parsePersonaMarkdown(candidate.markdownSource).systemPrompt,
            rationale: candidate.rationale,
          })),
          verifier:
            found.verifier === null
              ? null
              : {
                  pickedVariantId:
                    found.verifier.pickedVariantId === null
                      ? null
                      : (found.verifier.pickedVariantId as string),
                  reason: found.verifier.reason,
                  detail: found.verifier.detail,
                },
          // Named field by field for the reason the comment above gives, and this one is the
          // case it warns about: the screen is what decides whether a candidate is measured
          // at all, so a field dropped here is a refusal a human never sees.
          screen:
            found.screen === null
              ? null
              : {
                  replaySetVersion: found.screen.replaySetVersion,
                  detail: found.screen.detail,
                  itemCount: found.screen.itemCount,
                  arms: found.screen.arms.map((arm) => ({
                    variantId: arm.variantId === null ? null : (arm.variantId as string),
                    decision: arm.decision,
                    reason: arm.reason,
                    passed: arm.passed,
                    failed: arm.failed,
                    notScored: arm.notScored,
                    pending: arm.pending,
                    // The per-item rows, which are what lets a client compare two candidates
                    // to each other rather than only to the prompt in use.
                    items: arm.items.map((item) => ({
                      position: item.position,
                      outcome: item.outcome,
                    })),
                  })),
                },
          // Named field by field like the rest, and this one is a fact about *authorship*:
          // dropped, a panel would say a run proposed about its own work when it did not.
          proposer:
            found.proposer === null
              ? null
              : {
                  runId: found.proposer.runId as string,
                  detail: found.proposer.detail,
                },
          arms: found.effect.arms.map((arm) => ({
            variantId: arm.variantId === null ? null : (arm.variantId as string),
            decided: arm.decided,
            merged: arm.merged,
            failed: arm.failed,
            verificationFailed: arm.verificationFailed,
            failingCheck: arm.failingCheck,
            meanCostUsd: arm.meanCostUsd,
            standing: arm.standing,
          })),
        }))
      }),
    ),

    promoteVariant: os.persona.promoteVariant.handler(({ context, input }) =>
      guard(async () =>
        toWirePersona(
          await promoteVariant(context.deps, {
            workspaceId: context.principal.workspaceId,
            actor: context.principal.actor,
            personaId: asAgentPersonaId(input.personaId),
            variantId: asPersonaVariantId(input.variantId),
          }),
        ),
      ),
    ),

    discardVariants: os.persona.discardVariants.handler(({ context, input }) =>
      guard(async () => {
        await discardVariantSearch(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          personaId: asAgentPersonaId(input.personaId),
        })
        return { ok: true as const }
      }),
    ),

    startProposer: os.persona.startProposer.handler(({ context, input }) =>
      guard(async () => {
        const verdict = await startVariantProposer(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          personaId: asAgentPersonaId(input.personaId),
          threadId: asThreadId(input.threadId),
          repositoryId: asRepositoryId(input.repositoryId),
        })
        return verdict.ok
          ? { started: true as const, reason: null, agentRunId: verdict.run.id as string }
          : { started: false as const, reason: verdict.reason, agentRunId: null }
      }),
    ),

    delete: os.persona.delete.handler(({ context, input }) =>
      guard(async () => {
        await deletePersona(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          personaId: asAgentPersonaId(input.personaId),
        })
        return { ok: true as const }
      }),
    ),
  },

  capability: {
    list: os.capability.list.handler(({ context }) =>
      guard(() => listCapabilities(context.deps, { workspaceId: context.principal.workspaceId })),
    ),

    listAttachments: os.capability.listAttachments.handler(({ context }) =>
      guard(() =>
        listCapabilityAttachments(context.deps, { workspaceId: context.principal.workspaceId }),
      ),
    ),

    register: os.capability.register.handler(({ context, input }) =>
      guard(() =>
        createCapability(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          kind: input.kind,
          name: input.name,
          description: input.description,
          transport: input.transport ?? null,
          command: input.command ?? null,
          args: input.args ?? [],
          url: input.url ?? null,
          content: input.content ?? null,
          egressHosts: input.egressHosts ?? [],
        }),
      ),
    ),

    remove: os.capability.remove.handler(({ context, input }) =>
      guard(async () => {
        await deleteCapability(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          capabilityId: asCapabilityId(input.capabilityId),
        })
        return { ok: true as const }
      }),
    ),

    attach: os.capability.attach.handler(({ context, input }) =>
      guard(() =>
        attachCapability(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          personaId: asAgentPersonaId(input.personaId),
          capabilityId: asCapabilityId(input.capabilityId),
          ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
        }),
      ),
    ),

    detach: os.capability.detach.handler(({ context, input }) =>
      guard(async () => {
        await detachCapability(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          personaId: asAgentPersonaId(input.personaId),
          capabilityId: asCapabilityId(input.capabilityId),
        })
        return { ok: true as const }
      }),
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
          ...(input.layout === undefined ? {} : { layout: input.layout }),
          ...(input.fleet === undefined ? {} : { fleet: input.fleet }),
          ...(input.reviewers === undefined ? {} : { reviewers: input.reviewers }),
          ...(input.reportsTo === undefined ? {} : { reportsTo: input.reportsTo }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.extraRepositoryIds === undefined
            ? {}
            : { extraRepositoryIds: input.extraRepositoryIds }),
          // Null is forwarded, not dropped: it is how a human un-chooses a root, which
          // absent deliberately does not mean.
          ...(input.orchestratorId === undefined ? {} : { orchestratorId: input.orchestratorId }),
          // Forwarded on the same terms — null un-chooses the team's repository.
          ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
        }),
      ),
    ),

    delegationMatrix: os.personaGroup.delegationMatrix.handler(({ context }) =>
      guard(() =>
        delegationMatrixForWorkspace(context.deps, { workspaceId: context.principal.workspaceId }),
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
          ...(input.responseStyle === undefined ? {} : { responseStyle: input.responseStyle }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.budgetCapUsd === undefined ? {} : { budgetCapUsd: input.budgetCapUsd }),
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

    listActive: os.agentRun.listActive.handler(({ context }) =>
      guard(() => listActiveAgentRuns(context.deps, { workspaceId: context.principal.workspaceId })),
    ),

    listChildren: os.agentRun.listChildren.handler(({ context, input }) =>
      guard(() =>
        listChildAgentRuns(context.deps, {
          workspaceId: context.principal.workspaceId,
          agentRunId: asAgentRunId(input.agentRunId),
        }),
      ),
    ),

    getDiff: os.agentRun.getDiff.handler(({ context, input }) =>
      guard(async () => ({
        diff: await getAgentRunDiff(context.deps, {
          workspaceId: context.principal.workspaceId,
          agentRunId: asAgentRunId(input.agentRunId),
        }),
      })),
    ),

    getRawTranscript: os.agentRun.getRawTranscript.handler(({ context, input }) =>
      guard(() =>
        getRawTranscript(context.deps, {
          workspaceId: context.principal.workspaceId,
          agentRunId: asAgentRunId(input.agentRunId),
        }),
      ),
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

    steer: os.agentRun.steer.handler(({ context, input }) =>
      guard(() =>
        steerSwarm(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          agentRunId: asAgentRunId(input.agentRunId),
          message: input.message,
        }),
      ),
    ),

    listSettled: os.agentRun.listSettled.handler(({ context, input }) =>
      guard(() =>
        listSettledRuns(context.deps, {
          workspaceId: context.principal.workspaceId,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      ),
    ),

    listNeedsAttention: os.agentRun.listNeedsAttention.handler(({ context }) =>
      guard(() => listRunsNeedingAttention(context.deps, { workspaceId: context.principal.workspaceId })),
    ),

    listVerifications: os.agentRun.listVerifications.handler(({ context, input }) =>
      guard(async () => {
        const records = await listRunVerifications(context.deps, {
          workspaceId: context.principal.workspaceId,
          agentRunIds: input.agentRunIds.map(asAgentRunId),
        })
        // `checks` is readonly in the domain and mutable on the wire — same as
        // `runner.allowedRoots`.
        return records.map((record) => ({ ...record, checks: [...record.checks] }))
      }),
    ),
  },

  runControl: {
    get: os.runControl.get.handler(({ context }) =>
      guard(() => getRunControl(context.deps, { workspaceId: context.principal.workspaceId })),
    ),

    /**
     * Named field by field like every other projection here — and this one is the case the rule
     * exists for: a `retained` dropped on the wire turns "there is no way back" into a panel
     * that offers one.
     */
    selfDeployment: os.runControl.selfDeployment.handler(({ context }) =>
      guard(async () => {
        const result = await readSelfDeployment(context.deps)
        if (!result.ok) return { deployment: null, problem: result.reason }
        if (result.deployment === null) return { deployment: null, problem: null }
        const wire = (revision: (typeof result.deployment)['running']) =>
          revision === null
            ? null
            : {
                commit: revision.commit,
                builtAt: revision.builtAt,
                retained: revision.retained,
                health: revision.health,
              }
        return {
          deployment: {
            running: wire(result.deployment.running),
            previous: wire(result.deployment.previous),
          },
          problem: null,
        }
      }),
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

    /** When the platform *suggests* a handoff. It never swaps an agent on its own. */
    setHandoffPolicy: os.runControl.setHandoffPolicy.handler(({ context, input }) =>
      guard(() =>
        setHandoffPolicy(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          threshold: input.threshold,
          capPerTree: input.capPerTree,
        }),
      ),
    ),

    /** Whether a decomposition waits for a human before anything starts. */
    setModelRoutingEnabled: os.runControl.setModelRoutingEnabled.handler(({ context, input }) =>
      guard(() =>
        setModelRoutingEnabled(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          enabled: input.enabled,
        }),
      ),
    ),

    setPlanReviewRequired: os.runControl.setPlanReviewRequired.handler(({ context, input }) =>
      guard(() =>
        setPlanReviewRequired(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          required: input.required,
        }),
      ),
    ),
  },

  /**
   * Reviewing a plan before it builds. No `submit`: a decomposition
   * arrives from a Planner over the Runner channel, and a human authoring one here would be
   * a plan with no planner behind it.
   */
  plan: {
    get: os.plan.get.handler(({ context, input }) =>
      guard(() =>
        getPlanForReview(context.deps, {
          workspaceId: context.principal.workspaceId,
          agentRunId: asAgentRunId(input.agentRunId),
        }),
      ),
    ),

    accept: os.plan.accept.handler(({ context, input }) =>
      guard(() =>
        acceptPlan(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          agentRunId: asAgentRunId(input.agentRunId),
        }),
      ),
    ),

    requestChanges: os.plan.requestChanges.handler(({ context, input }) =>
      guard(() =>
        requestPlanChanges(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          agentRunId: asAgentRunId(input.agentRunId),
          note: input.note,
        }),
      ),
    ),

    reject: os.plan.reject.handler(({ context, input }) =>
      guard(() =>
        rejectPlan(context.deps, {
          workspaceId: context.principal.workspaceId,
          actor: context.principal.actor,
          agentRunId: asAgentRunId(input.agentRunId),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
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
          ...(input.answer === undefined ? {} : { answer: input.answer }),
        }),
      ),
    ),
  },
})

export type Router = typeof router
