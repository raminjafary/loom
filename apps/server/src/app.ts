import {
 expireStaleApprovals,
 reapStuckRuns,
 seedBuiltinPersonas,
 type AgentDeps,
} from '@loom/application'
import { asWorkspaceId } from '@loom/domain'
import {
 agentRunRepository,
 approvalRepository,
 auditAdapter,
 channelRepository,
 clearAllRunnerConnections,
 createDatabase,
 ensureWorkspaceMembership,
 messageRepository,
 personaGroupRepository,
 personaRepository,
 repositoryRepository,
 runnerRepository,
 threadRepository,
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
import { router } from './router.js'
import { createRunnerGateway } from './runner-gateway.js'

export interface App {
 readonly fastify: FastifyInstance
 readonly deps: AgentDeps
 close: Promise<void>
}

const DEFAULT_WORKSPACE = { slug: 'dev', name: 'Dev Workspace' }

export const buildApp = async (config: Config, authOverride?: AuthPort): Promise<App> => {
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const events = createEventPublisher(config.VALKEY_URL)

 const baseDeps = {
 channels: channelRepository(db),
 threads: threadRepository(db),
 messages: messageRepository(db),
 audit: auditAdapter(db),
 events,
 runners: runnerRepository(db),
 repositories: repositoryRepository(db),
 agentRuns: agentRunRepository(db),
 approvals: approvalRepository(db),
 personas: personaRepository(db),
 personaGroups: personaGroupRepository(db),
 runControl: workspaceRunControlRepository(db),
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
 if (result.created) {
 await seedBuiltinPersonas(deps, { workspaceId: asWorkspaceId(result.workspaceId) })
 }
 return result
 },
 })

 const fastify = Fastify({ logger: config.NODE_ENV !== 'test' })

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
