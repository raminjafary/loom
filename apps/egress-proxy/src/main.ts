import { DEFAULT_ALLOWED_EGRESS_HOSTS, describeEgressRefusal, type EgressDecision } from '@loom/domain'
import { z } from 'zod'
import { createControlServer } from './control.js'
import { createRefusedNetworks, discoverRefusedNetworks } from './control-peers.js'
import { createLeaseRegistry, type UsageRecord } from './leases.js'
import { createEgressProxy } from './proxy.js'

/**
 * apps/egress-proxy — the credential-injecting, metering, allowlisting egress
 * boundary.
 *
 * Runs as a container (see docker-compose.yml) attached to two networks: an
 * internal one shared with sandboxes, which has no route off the host, and a
 * routable one. That asymmetry is what makes the sandbox spec's "deny-by-default egress"
 * real — a sandbox cannot reach anything but this process.
 */

const EnvSchema = z.object({
  EGRESS_DATA_PORT: z.coerce.number().int().default(8080),
  EGRESS_CONTROL_PORT: z.coerce.number().int().default(8081),
  EGRESS_DATA_HOST: z.string().default('0.0.0.0'),
  /**
   * **Bound to every interface, and refused on one of them.**
   *
   * It cannot be bound to `127.0.0.1`: that is the *container's* loopback, and Docker's
   * published `127.0.0.1:8081:8081` mapping connects to the container's network interface,
   * so loopback would take the control plane away from the Runner — the host process that
   * is its only legitimate caller. The container also sits on the internal `loom-sandbox`
   * network, where this port used to answer a sandbox with a 401 rather than a refused
   * connection, leaving the shared secret as the only barrier.
   *
   * So the listener stays open and the *peer* is checked: a connection from the sandbox
   * network is destroyed before a byte of it is parsed. See `control-peers.ts` for why
   * neither a Unix socket nor a second container was the answer here.
   */
  EGRESS_CONTROL_HOST: z.string().default('0.0.0.0'),
  /**
   * Networks the control plane will not accept a connection from, comma-separated CIDRs.
   *
   * Normally unset: the sandbox network's range is assigned by the daemon, so the proxy
   * discovers it by asking DNS for the alias sandboxes reach it by and reading the netmask
   * off the interface holding that address. An operator whose topology does not match —
   * a different alias, a proxy reached over a routed network — states it here instead.
   */
  EGRESS_CONTROL_REFUSED_NETWORKS: z.string().optional(),
  /**
   * The alias a sandbox reaches this container by. Compose sets it on the internal network,
   * and `apps/runner/src/egress-client.ts` hardcodes the same name — which is exactly what
   * makes it the right thing to resolve: it names the network to refuse.
   */
  EGRESS_SANDBOX_ALIAS: z.string().default('loom-egress'),
  /**
   * At least 32 characters, and never the value shipped in `.env.example`.
   *
   * The bar is higher than it looks because of the paragraph above: this secret is what stands
   * between a sandboxed agent and the ability to issue itself a lease with arbitrary egress
   * hosts and an arbitrary budget, revoke a sibling run's lease, or drain the usage and
   * egress-decision queues before the Runner reads them. A copied example value is not a
   * secret at all, and `${VAR:?}` in compose only checks that it is *set*.
   */
  LOOM_EGRESS_CONTROL_SECRET: z
    .string()
    .min(32, 'LOOM_EGRESS_CONTROL_SECRET must be at least 32 characters')
    .refine((secret) => !/change-me|changeme|your-secret|placeholder|example/i.test(secret), {
      message:
        'LOOM_EGRESS_CONTROL_SECRET still looks like the example value. It is the only thing ' +
        'standing in front of lease issuance from inside a sandbox — ' +
        'generate one with `openssl rand -base64 32`.',
    }),
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

/**
 * Egress decisions awaiting a drain, and the one thing this queue needs that
 * the usage queue does not: a bound.
 *
 * Usage records arrive at the rate a run spends money. Decisions arrive at the rate a
 * process opens sockets, which for a retry loop against a refused host is as fast as the
 * kernel allows — so an undrained queue is a memory leak with an attacker-adjacent trigger.
 * Oldest dropped rather than newest refused, because the recent decisions are the ones an
 * operator is looking at, and the count of what was dropped is logged rather than
 * swallowed: a bounded record that reads as complete is the failure the "no silent caps"
 * names.
 */
const MAX_QUEUED_EGRESS_DECISIONS = 1_000
let droppedEgressDecisions = 0
const egressDecisionQueue: EgressDecision[] = []
const queueEgressDecision = (decision: EgressDecision) => {
  egressDecisionQueue.push(decision)
  if (egressDecisionQueue.length > MAX_QUEUED_EGRESS_DECISIONS) {
    egressDecisionQueue.splice(0, egressDecisionQueue.length - MAX_QUEUED_EGRESS_DECISIONS)
    droppedEgressDecisions += 1
    // Every 100th, so a hot loop reports itself without becoming the log's whole content.
    if (droppedEgressDecisions % 100 === 1) {
      log(
        `egress decision queue full at ${MAX_QUEUED_EGRESS_DECISIONS}; dropped ${droppedEgressDecisions} oldest so far — is a Runner draining?`,
      )
    }
  }
}

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
  // Runner acts on.
  onBudgetExhausted: (runId) => log(`budget exhausted for run ${runId}`),
  /**
   * Queued for the Runner, and a refusal is also logged in the operator-facing wording
   *. Two audiences: the queue reaches the audit log through the server, and
   * the line reaches whoever is watching this process now — which until this existed was the
   * only place a refused host appeared at all.
   */
  onEgressDecision: (decision) => {
    queueEgressDecision(decision)
    if (!decision.allowed) log(`run ${decision.runId}: ${describeEgressRefusal(decision)}`)
  },
  log,
})

/**
 * Worked out before the listener opens, so there is never a window in which the control
 * plane is up and accepting the network it is meant to refuse.
 *
 * The boot-time answer is now only the *fallback*: a run gets a network of its own, this
 * container is attached to it while the process is already running, and a set discovered
 * once would omit every such network. `createRefusedNetworks` re-reads the interfaces per
 * connection and keeps the alias answer for a host whose route table it cannot read.
 */
const discovered = await discoverRefusedNetworks({
  explicit: env.EGRESS_CONTROL_REFUSED_NETWORKS,
  sandboxAlias: env.EGRESS_SANDBOX_ALIAS,
})
const refusedNetworks = createRefusedNetworks({
  explicit: discovered.source === 'explicit' ? discovered.cidrs : [],
  fallback: discovered.source === 'alias' ? discovered.cidrs : [],
  fallbackSource: discovered.source === 'alias' ? 'alias' : 'none',
})

const controlPlane = createControlServer({
  leases,
  controlSecret: env.LOOM_EGRESS_CONTROL_SECRET,
  usageQueue,
  egressDecisionQueue,
  refusedNetworks: refusedNetworks.current,
  // One line per attempt: a sandbox that found this port is the thing an operator most
  // wants to know about, and a silent `destroy` would make it the thing they never see.
  onRefusedPeer: (address) => log(`control connection refused from the sandbox network: ${address}`),
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
  // Said either way. "Refusing nothing" is a real deployment state — a proxy that is not on
  // a sandbox network at all — and it is also what a broken discovery looks like, so it is
  // printed rather than inferred from the absence of a line.
  log(refusedNetworks.describe())
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
