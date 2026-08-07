import { DEFAULT_ALLOWED_EGRESS_HOSTS } from '@loom/domain'
import { z } from 'zod'
import { createControlServer } from './control.js'
import { createLeaseRegistry, type UsageRecord } from './leases.js'
import { createEgressProxy } from './proxy.js'

/**
 * apps/egress-proxy — the credential-injecting, metering, allowlisting egress
 * boundary from PLAN.md §6 A6.
 *
 * Runs as a container (see docker-compose.yml) attached to two networks: an
 * internal one shared with sandboxes, which has no route off the host, and a
 * routable one. That asymmetry is what makes A5's "deny-by-default egress"
 * real — a sandbox cannot reach anything but this process.
 */

const EnvSchema = z.object({
  EGRESS_DATA_PORT: z.coerce.number().int().default(8080),
  EGRESS_CONTROL_PORT: z.coerce.number().int().default(8081),
  // Bound separately: the data plane must be reachable from the sandbox network,
  // the control plane must not be reachable from anywhere but the host.
  EGRESS_DATA_HOST: z.string().default('0.0.0.0'),
  EGRESS_CONTROL_HOST: z.string().default('0.0.0.0'),
  LOOM_EGRESS_CONTROL_SECRET: z.string().min(16, 'control secret must be at least 16 characters'),
  // Optional now: the preferred credential is an OAuth token pushed by the Runner at
  // runtime (see control.ts). An API key remains supported as a fallback.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_UPSTREAM_URL: z.string().default('https://api.anthropic.com'),
  /** Comma-separated override of the default allowlist (see egress-policy.ts). */
  EGRESS_ALLOWED_HOSTS: z.string().optional(),
})

const env = EnvSchema.parse(process.env)

const log = (message: string) => process.stdout.write(`[egress] ${message}\n`)

const usageQueue: UsageRecord[] = []
const leases = createLeaseRegistry({ onUsage: (record) => usageQueue.push(record) })

const allowedHosts = env.EGRESS_ALLOWED_HOSTS
  ? env.EGRESS_ALLOWED_HOSTS.split(',').map((host) => host.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_EGRESS_HOSTS

/**
 * Mutable because the Runner refreshes the OAuth token while the proxy runs — Claude
 * Code rotates it every few hours and the proxy must follow without a restart.
 */
const upstream = {
  oauthToken: null as string | null,
  apiKey: env.ANTHROPIC_API_KEY ?? null,
}

const dataPlane = createEgressProxy({
  leases,
  upstream,
  anthropicBaseUrl: env.ANTHROPIC_UPSTREAM_URL,
  allowedHosts,
  // The proxy can refuse further spend but cannot stop a run — it has no path to
  // a Runner. The exhaustion shows up in the drained usage records, which the
  // Runner acts on (PLAN.md §6 "hard kill, metered at the proxy").
  onBudgetExhausted: (runId) => log(`budget exhausted for run ${runId}`),
  log,
})

const controlPlane = createControlServer({
  leases,
  controlSecret: env.LOOM_EGRESS_CONTROL_SECRET,
  usageQueue,
  setOauthToken: (token) => {
    const changed = upstream.oauthToken !== token
    upstream.oauthToken = token
    if (changed) log(token ? 'upstream OAuth token updated' : 'upstream OAuth token cleared')
  },
})

dataPlane.listen(env.EGRESS_DATA_PORT, env.EGRESS_DATA_HOST, () => {
  log(`data plane on ${env.EGRESS_DATA_HOST}:${env.EGRESS_DATA_PORT} (allowlist: ${allowedHosts.join(', ')})`)
})

controlPlane.listen(env.EGRESS_CONTROL_PORT, env.EGRESS_CONTROL_HOST, () => {
  log(`control plane on ${env.EGRESS_CONTROL_HOST}:${env.EGRESS_CONTROL_PORT}`)
})

/**
 * Leases are in-memory (see leases.ts), so a crash does not merely drop one
 * request — it invalidates every live run's credential at once, and the runs then
 * fail with "no valid lease" pointing nowhere near the real cause. Logging and
 * staying up is strictly better than restarting for a socket error on one
 * connection.
 *
 * Not a substitute for handling errors where they happen — a refused CONNECT
 * attaches its own error listener for exactly this reason — this is the backstop
 * for the ones nobody anticipated.
 */
process.on('uncaughtException', (error) => {
  log(`uncaught exception (staying up): ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection (staying up): ${reason instanceof Error ? reason.message : String(reason)}`)
})

const shutdown = () => {
  dataPlane.close()
  controlPlane.close()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
