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
 getMastery,
 concludeSession,
 conveneSession,
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
 resumeAllRuns,
 setHandoffPolicy,
 setRepositoryInstallCommand,
 setRepositoryVerifyCommand,
 warmRepositoryCache,
 startAgentRun,
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
 type MergeQueueEntry,
 type WorkerNote,
} from '@loom/domain'
import {
 asAgentPersonaId,
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

/**
 * `position` is a Postgres bigserial, which a JSON number cannot carry faithfully,
 * so the wire form is a string (see MergeQueueEntrySchema). Everything else on the
 * entry passes through and is narrowed by the output schema.
 */
const toWireMergeQueueEntry = (entry: MergeQueueEntry) => ({
...entry,
 position: entry.position.toString,
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

/** `paths` is readonly in the domain and mutable on the wire — same as `runner.allowedRoots`. */
const toWireWorkerNote = (note: WorkerNote) => ({...note, paths: [...note.paths] })

export interface RouterContext {
 readonly principal: Principal
 readonly deps: AgentDeps
}

const os = implement(contract).$context<RouterContext>

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

const guard = async <T>(fn: => Promise<T>): Promise<T> => {
 try {
 return await fn
 } catch (error) {
 return toTransportError(error)
 }
}

export const router = os.router({
 health: os.health.handler( => ({ status: 'ok' as const, time: new Date })),

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
 },

 channel: {
 list: os.channel.list.handler(({ context }) =>
 guard( =>
 listChannels(context.deps, { workspaceId: context.principal.workspaceId }),
),
),

 create: os.channel.create.handler(({ context, input }) =>
 guard( =>
 createChannel(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 name: input.name,
 topic: input.topic ?? null,
...(input.isPrivate === undefined ? {}: { isPrivate: input.isPrivate }),
 }),
),
),

 threads: os.channel.threads.handler(({ context, input }) =>
 guard( =>
 listChannelThreads(context.deps, {
 workspaceId: context.principal.workspaceId,
 channelId: asChannelId(input.channelId),
 }),
),
),

 rootThread: os.channel.rootThread.handler(({ context, input }) =>
 guard( =>
 getChannelRootThread(context.deps, {
 workspaceId: context.principal.workspaceId,
 channelId: asChannelId(input.channelId),
 }),
),
),

 delete: os.channel.delete.handler(({ context, input }) =>
 guard(async => {
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
 },

 message: {
 list: os.message.list.handler(({ context, input }) =>
 guard( =>
 listMessages(context.deps, {
 workspaceId: context.principal.workspaceId,
 threadId: asThreadId(input.threadId),
...(input.limit === undefined ? {}: { limit: input.limit }),
 cursor: input.cursor,
 }),
),
),

 post: os.message.post.handler(({ context, input }) =>
 guard( =>
 postMessage(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 threadId: asThreadId(input.threadId),
 text: input.text,
 }),
),
),

 backfill: os.message.backfill.handler(({ context, input }) =>
 guard( =>
 backfillMessages(context.deps, {
 workspaceId: context.principal.workspaceId,
 threadId: asThreadId(input.threadId),
 afterMessageId: asMessageId(input.afterMessageId),
...(input.limit === undefined ? {}: { limit: input.limit }),
 }),
),
),
 },

 runner: {
 list: os.runner.list.handler(({ context }) =>
 guard(async => {
 const runners = await listRunners(context.deps, {
 workspaceId: context.principal.workspaceId,
 })
 return runners.map((runner) => ({...runner, allowedRoots: [...runner.allowedRoots] }))
 }),
),

 createPairingToken: os.runner.createPairingToken.handler(({ context, input }) =>
 guard( =>
 createRunnerPairingToken(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 name: input.name,
 }),
),
),

 remove: os.runner.remove.handler(({ context, input }) =>
 guard(async => {
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
 guard( => listRepositories(context.deps, { workspaceId: context.principal.workspaceId })),
),

 bindExisting: os.repository.bindExisting.handler(({ context, input }) =>
 guard( =>
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
 guard(async => {
 const result = await listRunnerDirectory(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 runnerId: asRunnerId(input.runnerId),
 path: input.path,
 })
 // The union's ok:true discriminant is stripped here — a thrown
 // ValidationError already carried the failure case to the client.
 return {
 path: result.ok ? result.path: '',
 parent: result.ok ? result.parent: null,
 entries: result.ok ? result.entries: [],
 truncated: result.ok ? result.truncated: false,
 }
 }),
),

 createNew: os.repository.createNew.handler(({ context, input }) =>
 guard( =>
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
 guard( =>
 setRepositoryInstallCommand(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 repositoryId: asRepositoryId(input.repositoryId),
 installCommand: input.installCommand,
 }),
),
),

 warmCache: os.repository.warmCache.handler(({ context, input }) =>
 guard( =>
 warmRepositoryCache(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 repositoryId: asRepositoryId(input.repositoryId),
 }),
),
),

 setVerifyCommand: os.repository.setVerifyCommand.handler(({ context, input }) =>
 guard( =>
 setRepositoryVerifyCommand(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 repositoryId: asRepositoryId(input.repositoryId),
 verifyCommand: input.verifyCommand,
 }),
),
),

 unbind: os.repository.unbind.handler(({ context, input }) =>
 guard(async => {
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
 guard(async =>
 (await listMergeQueue(context.deps, { workspaceId: context.principal.workspaceId })).map(
 toWireMergeQueueEntry,
),
),
),

 enqueue: os.mergeQueue.enqueue.handler(({ context, input }) =>
 guard(async =>
 toWireMergeQueueEntry(
 await enqueueMergeRun(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 agentRunId: asAgentRunId(input.agentRunId),
...(input.overrideBlockers ? { overrideBlockers: true }: {}),
 }),
),
),
),

 cancel: os.mergeQueue.cancel.handler(({ context, input }) =>
 guard(async =>
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
 guard( =>
 listPersonaMaps(context.deps, {
 workspaceId: context.principal.workspaceId,
 personaId: asAgentPersonaId(input.personaId),
 }),
),
),

 listForRepository: os.mastery.listForRepository.handler(({ context, input }) =>
 guard( =>
 listRepositoryMaps(context.deps, {
 workspaceId: context.principal.workspaceId,
 repositoryId: asRepositoryId(input.repositoryId),
 }),
),
),

 curate: os.mastery.curate.handler(({ context, input }) =>
 guard( =>
 curateMap(context.deps, {
 workspaceId: context.principal.workspaceId,
 mapId: asSubjectMapId(input.mapId),
 }),
),
),

 listAll: os.mastery.listAll.handler(({ context }) =>
 guard( => listWorkspaceMaps(context.deps, { workspaceId: context.principal.workspaceId })),
),

 usedByRuns: os.mastery.usedByRuns.handler(({ context, input }) =>
 guard( =>
 listExpertiseUsedByRuns(context.deps, {
 workspaceId: context.principal.workspaceId,
 agentRunIds: input.agentRunIds.map(asAgentRunId),
 }),
),
),

 setRetrieval: os.mastery.setRetrieval.handler(({ context, input }) =>
 guard( =>
 setRetrievalOverride(context.deps, {
 workspaceId: context.principal.workspaceId,
 mapId: asSubjectMapId(input.mapId),
 override: input.override,
 }),
),
),

 get: os.mastery.get.handler(({ context, input }) =>
 guard(async => {
 const view = await getMastery(context.deps, {
 workspaceId: context.principal.workspaceId,
 mapId: asSubjectMapId(input.mapId),
 })
 // `paths` is readonly in the domain and mutable on the wire; spreading is the
 // same seam `toWireWorkerNote` is.
 return {
...view,
 nodes: view.nodes.map((node) => ({...node, paths: [...node.paths] })),
 hubs: view.hubs.map((hub) => ({...hub })),
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
 guard(async => {
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
 subjectKind === 'author' ? (input.subjectRef ?? '').trim: repository.displayName
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
...(input.focus === undefined ? {}: { focus: input.focus }),
...(input.guidance === undefined ? {}: { guidance: input.guidance }),
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
...(input.task === undefined ? {}: { task: input.task }),
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
 colosseum: {
 list: os.colosseum.list.handler(({ context }) =>
 guard( => listSessions(context.deps, { workspaceId: context.principal.workspaceId })),
),

 get: os.colosseum.get.handler(({ context, input }) =>
 guard( =>
 getColosseumSession(context.deps, {
 workspaceId: context.principal.workspaceId,
 sessionId: input.sessionId,
 }),
),
),

 convene: os.colosseum.convene.handler(({ context, input }) =>
 guard( =>
 conveneSession(context.deps, {
 workspaceId: context.principal.workspaceId,
 threadId: asThreadId(input.threadId),
 repositoryId: input.repositoryId === null ? null: asRepositoryId(input.repositoryId),
 purpose: input.purpose,
 subject: input.subject,
 question: input.question,
 personaIds: input.personaIds.map(asAgentPersonaId),
...(input.turnCap === undefined ? {}: { turnCap: input.turnCap }),
...(input.spendCapUsd === undefined ? {}: { spendCapUsd: input.spendCapUsd }),
 }),
),
),

 recordClaim: os.colosseum.recordClaim.handler(({ context, input }) =>
 guard( =>
 recordOpeningClaim(context.deps, {
 workspaceId: context.principal.workspaceId,
 sessionId: input.sessionId,
 personaId: asAgentPersonaId(input.personaId),
 statement: input.statement,
 }),
),
),

 settleClaim: os.colosseum.settleClaim.handler(({ context, input }) =>
 guard( =>
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
 guard(async => {
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
...(budgetCapUsd === null ? {}: { budgetCapUsd }),
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
 guard( =>
 concludeSession(context.deps, {
 workspaceId: context.principal.workspaceId,
 sessionId: input.sessionId,
 }),
),
),
 },

 workerNote: {
 listByTree: os.workerNote.listByTree.handler(({ context, input }) =>
 guard(async =>
 (
 await listTreeNotes(context.deps, {
 workspaceId: context.principal.workspaceId,
 agentRunId: asAgentRunId(input.agentRunId),
 })
).map(toWireWorkerNote),
),
),

 write: os.workerNote.write.handler(({ context, input }) =>
 guard(async =>
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
 guard( =>
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
 * Identity-bound approval insists identity comes off the session.
 */
 cost: {
 summary: os.cost.summary.handler(({ context, input }) =>
 guard( =>
 getWorkspaceCostSummary(context.deps, {
 workspaceId: context.principal.workspaceId,
 windowHours: input.windowHours ?? null,
 }),
),
),
 },

 persona: {
 list: os.persona.list.handler(({ context }) =>
 guard(async =>
 (await listPersonas(context.deps, { workspaceId: context.principal.workspaceId })).map(
 toWirePersona,
),
),
),

 get: os.persona.get.handler(({ context, input }) =>
 guard(async =>
 toWirePersona(
 await getPersona(context.deps, {
 workspaceId: context.principal.workspaceId,
 personaId: asAgentPersonaId(input.personaId),
 }),
),
),
),

 delegationPreview: os.persona.delegationPreview.handler(({ context, input }) =>
 guard( =>
 delegationPreviewForPersona(context.deps, {
 workspaceId: context.principal.workspaceId,
 personaId: asAgentPersonaId(input.personaId),
...(input.model === undefined ? {}: { model: input.model }),
...(input.budgetCapUsd === undefined ? {}: { budgetCapUsd: input.budgetCapUsd }),
 }),
),
),

 parse: os.persona.parse.handler(({ input }) =>
 guard(async => parsePersonaDraft({ markdownSource: input.markdownSource })),
),

 create: os.persona.create.handler(({ context, input }) =>
 guard(async =>
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
 guard(async =>
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
 guard(async =>
 toWirePersona(
 await resetPersonaToBuiltin(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 personaId: asAgentPersonaId(input.personaId),
 }),
),
),
),

 delete: os.persona.delete.handler(({ context, input }) =>
 guard(async => {
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
 guard( => listCapabilities(context.deps, { workspaceId: context.principal.workspaceId })),
),

 listAttachments: os.capability.listAttachments.handler(({ context }) =>
 guard( =>
 listCapabilityAttachments(context.deps, { workspaceId: context.principal.workspaceId }),
),
),

 register: os.capability.register.handler(({ context, input }) =>
 guard( =>
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
 guard(async => {
 await deleteCapability(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 capabilityId: asCapabilityId(input.capabilityId),
 })
 return { ok: true as const }
 }),
),

 attach: os.capability.attach.handler(({ context, input }) =>
 guard( =>
 attachCapability(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 personaId: asAgentPersonaId(input.personaId),
 capabilityId: asCapabilityId(input.capabilityId),
...(input.allowedTools === undefined ? {}: { allowedTools: input.allowedTools }),
 }),
),
),

 detach: os.capability.detach.handler(({ context, input }) =>
 guard(async => {
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
 guard( => listPersonaGroups(context.deps, { workspaceId: context.principal.workspaceId })),
),

 create: os.personaGroup.create.handler(({ context, input }) =>
 guard( =>
 createPersonaGroup(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 name: input.name,
 personaIds: input.personaIds,
 }),
),
),

 update: os.personaGroup.update.handler(({ context, input }) =>
 guard( =>
 updatePersonaGroup(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 personaGroupId: asPersonaGroupId(input.personaGroupId),
 name: input.name,
 personaIds: input.personaIds,
...(input.layout === undefined ? {}: { layout: input.layout }),
...(input.fleet === undefined ? {}: { fleet: input.fleet }),
...(input.reviewers === undefined ? {}: { reviewers: input.reviewers }),
 // Null is forwarded, not dropped: it is how a human un-chooses a root, which
 // absent deliberately does not mean.
...(input.orchestratorId === undefined ? {}: { orchestratorId: input.orchestratorId }),
 }),
),
),

 delegationMatrix: os.personaGroup.delegationMatrix.handler(({ context }) =>
 guard( =>
 delegationMatrixForWorkspace(context.deps, { workspaceId: context.principal.workspaceId }),
),
),

 delete: os.personaGroup.delete.handler(({ context, input }) =>
 guard(async => {
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
 guard( =>
 startAgentRun(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 threadId: asThreadId(input.threadId),
 repositoryId: asRepositoryId(input.repositoryId),
 personaId: asAgentPersonaId(input.personaId),
...(input.task === undefined ? {}: { task: input.task }),
...(input.responseStyle === undefined ? {}: { responseStyle: input.responseStyle }),
...(input.model === undefined ? {}: { model: input.model }),
...(input.budgetCapUsd === undefined ? {}: { budgetCapUsd: input.budgetCapUsd }),
 }),
),
),

 get: os.agentRun.get.handler(({ context, input }) =>
 guard( =>
 getAgentRun(context.deps, {
 workspaceId: context.principal.workspaceId,
 agentRunId: asAgentRunId(input.agentRunId),
 }),
),
),

 getActive: os.agentRun.getActive.handler(({ context }) =>
 guard( => getActiveAgentRun(context.deps, { workspaceId: context.principal.workspaceId })),
),

 listActive: os.agentRun.listActive.handler(({ context }) =>
 guard( => listActiveAgentRuns(context.deps, { workspaceId: context.principal.workspaceId })),
),

 listChildren: os.agentRun.listChildren.handler(({ context, input }) =>
 guard( =>
 listChildAgentRuns(context.deps, {
 workspaceId: context.principal.workspaceId,
 agentRunId: asAgentRunId(input.agentRunId),
 }),
),
),

 getDiff: os.agentRun.getDiff.handler(({ context, input }) =>
 guard(async => ({
 diff: await getAgentRunDiff(context.deps, {
 workspaceId: context.principal.workspaceId,
 agentRunId: asAgentRunId(input.agentRunId),
 }),
 })),
),

 getRawTranscript: os.agentRun.getRawTranscript.handler(({ context, input }) =>
 guard( =>
 getRawTranscript(context.deps, {
 workspaceId: context.principal.workspaceId,
 agentRunId: asAgentRunId(input.agentRunId),
 }),
),
),

 keep: os.agentRun.keep.handler(({ context, input }) =>
 guard( =>
 keepAgentRun(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 agentRunId: asAgentRunId(input.agentRunId),
 }),
),
),

 discard: os.agentRun.discard.handler(({ context, input }) =>
 guard( =>
 discardAgentRun(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 agentRunId: asAgentRunId(input.agentRunId),
 }),
),
),

 push: os.agentRun.push.handler(({ context, input }) =>
 guard( =>
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
 guard( =>
 steerSwarm(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 agentRunId: asAgentRunId(input.agentRunId),
 message: input.message,
 }),
),
),

 listNeedsAttention: os.agentRun.listNeedsAttention.handler(({ context }) =>
 guard( => listRunsNeedingAttention(context.deps, { workspaceId: context.principal.workspaceId })),
),
 },

 runControl: {
 get: os.runControl.get.handler(({ context }) =>
 guard( => getRunControl(context.deps, { workspaceId: context.principal.workspaceId })),
),

 pauseAll: os.runControl.pauseAll.handler(({ context }) =>
 guard( =>
 pauseAllRuns(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 }),
),
),

 resume: os.runControl.resume.handler(({ context }) =>
 guard( =>
 resumeAllRuns(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 }),
),
),

 /** When the platform *suggests* a handoff. It never swaps an agent on its own. */
 setHandoffPolicy: os.runControl.setHandoffPolicy.handler(({ context, input }) =>
 guard( =>
 setHandoffPolicy(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 threshold: input.threshold,
 capPerTree: input.capPerTree,
 }),
),
),
 },

 notification: {
 config: os.notification.config.handler(({ context }) =>
 getNotificationConfig(context.deps),
),

 subscribe: os.notification.subscribe.handler(({ context, input }) =>
 guard(async => {
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
 guard(async => {
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
 guard( =>
 listPendingApprovals(context.deps, {
 workspaceId: context.principal.workspaceId,
 agentRunId: asAgentRunId(input.agentRunId),
 }),
),
),

 decide: os.approval.decide.handler(({ context, input }) =>
 guard( =>
 decideApproval(context.deps, {
 workspaceId: context.principal.workspaceId,
 actor: context.principal.actor,
 approvalRequestId: asApprovalRequestId(input.approvalRequestId),
 decision: input.decision,
...(input.answer === undefined ? {}: { answer: input.answer }),
 }),
),
),
 },
})

export type Router = typeof router
