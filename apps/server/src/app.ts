import {
  advanceMergeQueue,
  advanceCampaignQueue,
  advanceScreenQueue,
  advanceVerificationQueue,
  curateIdleWorkspaces,
  expireStaleApprovals,
  reapStuckRuns,
  seedBuiltinPersonas,
  seedBuiltinTeams,
  type AgentDeps,
  type NotificationPort,
} from '@loom/application'
import { asWorkspaceId } from '@loom/domain'
import {
  agentRunEventRepository,
  agentRunRepository,
  approvalRepository,
  capabilityRepository,
  mergeQueueRepository,
  runVerificationRepository,
  auditAdapter,
  channelRepository,
  clearAllRunnerConnections,
  createDatabase,
  schemaStatus,
  ensureWorkspaceMembership,
  messageRepository,
  notificationTargetRepository,
  personaGroupRepository,
  personaRepository,
  personaVariantRepository,
  campaignRepository,
  screenRepository,
  repositoryRepository,
  runnerRepository,
  threadRepository,
  noteReadRepository,
  subjectMapRepository,
  atlasRepository,
  colosseumRepository,
  workerNoteRepository,
  planSubtaskRepository,
  workspaceRunControlRepository,
} from '@loom/db'
import { RPCHandler } from '@orpc/server/node'
import cors from '@fastify/cors'
import { toNodeHandler } from 'better-auth/node'
import Fastify, { type FastifyInstance } from 'fastify'
import { betterAuthPort, type AuthPort } from './auth.js'
import { createBetterAuth } from './better-auth.js'
import type { Config } from './config.js'
import { createEventPublisher } from './events.js'
import { webPushNotificationPort } from './notifications.js'
import { router } from './router.js'
import { subscriptionTokenMinter } from './subscription-token.js'
import { fileBlobStorage } from './blob-storage.js'
import { fileSelfDeploymentStore } from './self-deployment-store.js'
import { createRunnerGateway } from './runner-gateway.js'

export interface App {
  readonly fastify: FastifyInstance
  readonly deps: AgentDeps
  close(): Promise<void>
}

const DEFAULT_WORKSPACE = { slug: 'dev', name: 'Dev Workspace' }

/**
 * Test seams, not configuration. A notification is delivered to a push service
 * outside this process, so an integration test proving the *fan-out* — that a
 * requested approval reaches a human — has nothing to assert against unless it
 * can substitute the port. Same reason `authOverride` exists.
 */
export interface AppOverrides {
  readonly notifications?: NotificationPort
}

export const buildApp = async (
  config: Config,
  authOverride?: AuthPort,
  overrides: AppOverrides = {},
): Promise<App> => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const events = createEventPublisher(config.VALKEY_URL)

  const fastify = Fastify({ logger: config.NODE_ENV !== 'test' })

  const notificationTargets = notificationTargetRepository(db)
  const notifications =
    overrides.notifications ??
    webPushNotificationPort({
      targets: notificationTargets,
      keys:
        config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
          ? {
              publicKey: config.VAPID_PUBLIC_KEY,
              privateKey: config.VAPID_PRIVATE_KEY,
              subject: config.VAPID_SUBJECT,
            }
          : null,
      log: (event) => fastify.log.info(event),
    })

  const baseDeps = {
    channels: channelRepository(db),
    threads: threadRepository(db),
    messages: messageRepository(db),
    audit: auditAdapter(db),
    events,
    runners: runnerRepository(db),
    repositories: repositoryRepository(db),
    agentRuns: agentRunRepository(db),
    agentRunEvents: agentRunEventRepository(db),
    approvals: approvalRepository(db),
    mergeQueue: mergeQueueRepository(db),
    runVerifications: runVerificationRepository(db),
    workerNotes: workerNoteRepository(db),
    subjectMaps: subjectMapRepository(db),
    colosseum: colosseumRepository(db),
    atlas: atlasRepository(db),
    noteReads: noteReadRepository(db),
    planSubtasks: planSubtaskRepository(db),
    capabilities: capabilityRepository(db),
    personas: personaRepository(db),
    personaVariants: personaVariantRepository(db),
    screens: screenRepository(db),
    campaigns: campaignRepository(db),
    personaGroups: personaGroupRepository(db),
    runControl: workspaceRunControlRepository(db),
    blobs: fileBlobStorage(config.BLOB_STORAGE_ROOT),
    selfDeployment: fileSelfDeploymentStore(config.LOOM_DEPLOYMENT_STATE),
    notifications,
    notificationTargets,
    limits: {
      maxConcurrentRunsPerWorkspace: config.MAX_CONCURRENT_RUNS_PER_WORKSPACE,
      maxDelegationDepth: config.MAX_DELEGATION_DEPTH,
    },
  }

  // The Runner gateway produces `dispatch` — see runner-gateway.ts for why
  // AgentDeps can't be fully built before it exists.
  const { register: registerRunnerGateway, dispatch } = createRunnerGateway(db, baseDeps)
  const deps: AgentDeps = { ...baseDeps, dispatch }

  const betterAuth = createBetterAuth({
    db,
    secret: config.BETTER_AUTH_SECRET,
    baseUrl: config.BETTER_AUTH_URL,
    webOrigin: config.WEB_ORIGIN,
  })

  const auth =
    authOverride ??
    betterAuthPort(betterAuth, {
      ensureMembership: async (userId) => {
        const result = await ensureWorkspaceMembership(db, userId, DEFAULT_WORKSPACE)
        // Every time, not only on creation: `seedBuiltinPersonas` skips names that
        // already exist, and running it once meant a workspace never received any
        // built-in added after it was made — silently, since the reconciler is looked
        // up by name and simply does nothing when absent.
        await seedBuiltinPersonas(deps, { workspaceId: asWorkspaceId(result.workspaceId) })
        // After the personas, necessarily: a team is a roster of them, and a member
        // whose persona has not been seeded yet would simply be dropped.
        await seedBuiltinTeams(deps, { workspaceId: asWorkspaceId(result.workspaceId) })
        return result
      },
    })

  // Background safety sweeps — skipped under NODE_ENV=test so a
  // stray sweep never races a test's own DB assertions. Both share one interval:
  // they're cheap indexed scans, and coupling them keeps a single knob for how
  // often the platform checks itself.
  //
  // Order matters. The approval SLA runs first so a gate that just expired hands
  // its run back to `running` before the reaper looks at it — the other order
  // would let the reaper judge that same run on a heartbeat it is about to renew.
  const reaperTimer =
    config.NODE_ENV === 'test'
      ? null
      : setInterval(() => {
          void (async () => {
            await expireStaleApprovals(deps, { approvalSlaMs: config.APPROVAL_SLA_MS })
            await reapStuckRuns(deps, {
              heartbeatTimeoutMs: config.REAPER_HEARTBEAT_TIMEOUT_MS,
              noProgressTimeoutMs: config.REAPER_NO_PROGRESS_TIMEOUT_MS,
            })
            // Last, and deliberately not awaited *into* the two above: a merge
            // runs a test suite, so this call can outlive its own interval tick.
            // Overlapping ticks are safe — see advanceMergeQueue — and running it
            // after the reapers means a run this sweep just failed is already
            // terminal when the queue looks at its entry.
            /**
             * The verification harness, before the merge queue and
             * for the same reason the reapers run before both: a branch that just
             * failed its repository's definition of done should already say so by the
             * time a human is deciding whether to queue it.
             */
            await advanceVerificationQueue(deps, {
              verificationStuckMs: config.MERGE_STUCK_TIMEOUT_MS,
            })
            await advanceMergeQueue(deps, { mergeStuckMs: config.MERGE_STUCK_TIMEOUT_MS })
            /**
             * The held-out screen, after the verification harness because that is what it
             * reads: a screening run's item is scored from the definition-of-done verdict
             * on its branch, so a sweep that ran first would find every finished run
             * unscored and have to wait a whole tick to notice.
             */
            await advanceScreenQueue(deps, {
              screenStuckMs: config.SCREEN_STUCK_TIMEOUT_MS,
              maxStartsPerTick: config.SCREEN_MAX_STARTS_PER_TICK,
            })
            /**
             * Campaigns after screens, and with their own smaller start budget: a screen is
             * spend that replaces more expensive spend, while a campaign is money spent on
             * measuring the platform itself. Behind the screen in this sequence for the same
             * reason it is behind everything else — nothing a person is waiting for should
             * queue behind an experiment.
             */
            await advanceCampaignQueue(deps, {
              campaignStuckMs: config.CAMPAIGN_STUCK_TIMEOUT_MS,
              maxStartsPerTick: config.CAMPAIGN_MAX_STARTS_PER_TICK,
            })
            /**
             * Curation, last and only while nothing is running.
             *
             * Mastery is explicit that a curation pass "never competes with work a human is
             * waiting for", so the gate is the count of active runs — checked *after* the
             * reapers, which is what makes it meaningful: a run this sweep just failed is
             * already terminal by the time it is counted. `curateIdleMaps` re-checks the
             * kill switch itself, because a timer cannot be trusted to remember a safety
             * rule.
             */
            await curateIdleWorkspaces(deps)
          })().catch((error) => {
            fastify.log.error({ error }, 'background safety sweep failed')
          })
        }, config.REAPER_INTERVAL_MS)

  await fastify.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
  })

  // Before any Runner can reconnect: this process owns no live connections yet,
  // so any lingering `connected: true` is stale (see clearAllRunnerConnections).
  await clearAllRunnerConnections(db)

  await registerRunnerGateway(fastify)

  // Better Auth owns everything under /api/auth — sign-up, sign-in, session,
  // sign-out. Mounted before the oRPC body-parser override below so it keeps
  // Fastify's normal JSON parsing.
  //
  // toNodeHandler writes straight to `reply.raw` (the underlying Node
  // response), bypassing Fastify's send lifecycle entirely — so
  // @fastify/cors's onSend-based header injection never runs here, even
  // though it *did* run for the OPTIONS preflight (that's short-circuited
  // earlier, in cors's onRequest hook, before this handler executes). Set
  // the two headers the browser actually needs by hand.
  fastify.all('/api/auth/*', async (request, reply) => {
    reply.raw.setHeader('Access-Control-Allow-Origin', config.WEB_ORIGIN)
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true')
    await toNodeHandler(betterAuth.handler)(request.raw, reply.raw)
  })

  const mintSubscriptionToken = subscriptionTokenMinter(config.WS_SUBSCRIPTION_SECRET)

  const handler = new RPCHandler(router)

  // oRPC reads the raw request stream itself, so Fastify must not consume the
  // body first. Anchored regex: an unanchored /.*/ makes MIME essence detection
  // unreliable, which Fastify flags as a CORS risk.
  fastify.removeAllContentTypeParsers()
  fastify.addContentTypeParser(/^.*$/, (_req, _payload, done) => done(null, undefined))

  fastify.all('/rpc/*', async (request, reply) => {
    // Same reason as the /api/auth/* handler above: RPCHandler#handle writes
    // straight to `reply.raw`, bypassing Fastify's send lifecycle that
    // @fastify/cors hooks into — so these headers must be set by hand here too.
    reply.raw.setHeader('Access-Control-Allow-Origin', config.WEB_ORIGIN)
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true')

    const principal = await auth.resolve(request.headers)
    if (!principal) {
      await reply.code(401).send({ error: 'unauthenticated' })
      return
    }

    const { matched } = await handler.handle(request.raw, reply.raw, {
      prefix: '/rpc',
      context: { principal, deps, mintSubscriptionToken },
    })

    if (!matched) {
      await reply.code(404).send({ error: 'no matching procedure' })
    }
  })

  /**
   * Liveness *and* schema readiness, which is one endpoint on purpose.
   *
   * It used to answer `{ status: 'ok' }` unconditionally, which is a true statement about the
   * process and says nothing about the deployment. Tier 3 is what made the gap matter: a
   * promoted revision of Loom's own source can pass every check in the manifest, start, bind
   * and answer here, and then fail its first query because nobody ran the migration. A health
   * check that cannot see that is a health check a self-promotion walks straight past.
   *
   * 503 rather than 200-with-a-warning, because the caller is a supervisor or a promotion gate
   * and both of them act on the status code. A degraded platform that reports itself healthy is
   * how a bad revision becomes the running one.
   */
  fastify.get('/healthz', async (_request, reply) => {
    let schema: Awaited<ReturnType<typeof schemaStatus>>
    try {
      schema = await schemaStatus(db)
    } catch (error) {
      // An unreachable database is the other thing this endpoint is for, and it arrives as a
      // thrown query rather than as a false answer.
      await reply.code(503).send({
        status: 'degraded',
        reason: `The database could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    if (!schema.applied) {
      await reply.code(503).send({ status: 'degraded', reason: schema.detail })
      return
    }
    return { status: 'ok', migration: schema.expected }
  })

  return {
    fastify,
    deps,
    close: async () => {
      if (reaperTimer) clearInterval(reaperTimer)
      await fastify.close()
      await events.close()
      await closeDb()
    },
  }
}
