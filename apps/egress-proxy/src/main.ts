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
  ANTHROPIC_API_KEY: z.string().min(1, 'the proxy holds the real model key; the sandbox never does'),
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

const dataPlane = createEgressProxy({
  leases,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
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
})

dataPlane.listen(env.EGRESS_DATA_PORT, env.EGRESS_DATA_HOST, () => {
  log(`data plane on ${env.EGRESS_DATA_HOST}:${env.EGRESS_DATA_PORT} (allowlist: ${allowedHosts.join(', ')})`)
})

controlPlane.listen(env.EGRESS_CONTROL_PORT, env.EGRESS_CONTROL_HOST, () => {
  log(`control plane on ${env.EGRESS_CONTROL_HOST}:${env.EGRESS_CONTROL_PORT}`)
})

const shutdown = () => {
  dataPlane.close()
  controlPlane.close()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
