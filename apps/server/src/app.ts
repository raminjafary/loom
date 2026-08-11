import {
 advanceMergeQueue,
 expireStaleApprovals,
 reapStuckRuns,
 seedBuiltinPersonas,
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
 auditAdapter,
 channelRepository,
 clearAllRunnerConnections,
 createDatabase,
 ensureWorkspaceMembership,
 messageRepository,
 notificationTargetRepository,
 personaGroupRepository,
 personaRepository,
 repositoryRepository,
 runnerRepository,
 threadRepository,
 workerNoteRepository,
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
import { fileBlobStorage } from './blob-storage.js'
import { createRunnerGateway } from './runner-gateway.js'

export interface App {
 readonly fastify: FastifyInstance
 readonly deps: AgentDeps
 close: Promise<void>
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
 workerNotes: workerNoteRepository(db),
 capabilities: capabilityRepository(db),
 personas: personaRepository(db),
 personaGroups: personaGroupRepository(db),
 runControl: workspaceRunControlRepository(db),
 blobs: fileBlobStorage(config.BLOB_STORAGE_ROOT),
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
 const deps: AgentDeps = {...baseDeps, dispatch }

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
: setInterval( => {
 void (async => {
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
 await advanceMergeQueue(deps, { mergeStuckMs: config.MERGE_STUCK_TIMEOUT_MS })
 }).catch((error) => {
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

 const handler = new RPCHandler(router)

 // oRPC reads the raw request stream itself, so Fastify must not consume the
 // body first. Anchored regex: an unanchored /.*/ makes MIME essence detection
 // unreliable, which Fastify flags as a CORS risk.
 fastify.removeAllContentTypeParsers
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
 context: { principal, deps },
 })

 if (!matched) {
 await reply.code(404).send({ error: 'no matching procedure' })
 }
 })

 fastify.get('/healthz', async => ({ status: 'ok' }))

 return {
 fastify,
 deps,
 close: async => {
 if (reaperTimer) clearInterval(reaperTimer)
 await fastify.close
 await events.close
 await closeDb
 },
 }
}
