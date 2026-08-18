/**
 * The Runner's side of the credential broker. Talks to the egress
 * proxy's control plane, which is bound to loopback and reachable only from the
 * host — the Runner is the trusted host-side component, so it is the only caller.
 *
 * A lease is what lets a sandbox reach the model API without ever holding the
 * key. Metered spend comes back the same way, and the Runner forwards it over its
 * existing authenticated socket rather than the proxy growing a server session.
 */

export interface UsageRecord {
 readonly runId: string
 readonly model: string
 readonly costUsd: number | null
 readonly spentUsd: number
 readonly capUsd: number | null
 readonly exhausted: boolean
}

export interface EgressClientConfig {
 readonly controlUrl: string
 readonly dataUrl: string
 readonly controlSecret: string
}

export const egressConfigFromEnv = (
 env: NodeJS.ProcessEnv = process.env,
): EgressClientConfig | null => {
 const controlSecret = env.LOOM_EGRESS_CONTROL_SECRET
 // Absent config is not an error here: it means this Runner is configured to run
 // agents unsandboxed (LOOM_SANDBOX_ENABLED=0), where the SDK uses the host's own
 // credentials and there is no lease to take out.
 if (!controlSecret) return null
 return {
 controlUrl: env.LOOM_EGRESS_CONTROL_URL ?? 'http://127.0.0.1:8081',
 // What the *sandbox* uses, so it is a container-network name, not loopback.
 dataUrl: env.LOOM_EGRESS_DATA_URL ?? 'http://loom-egress:8080',
 controlSecret,
 }
}

const control = async (
 config: EgressClientConfig,
 path: string,
 init: { method: string; body?: unknown },
): Promise<unknown> => {
 const response = await fetch(`${config.controlUrl}${path}`, {
 method: init.method,
 headers: {
 'content-type': 'application/json',
 'x-loom-control-secret': config.controlSecret,
 },
...(init.body === undefined ? {}: { body: JSON.stringify(init.body) }),
 })
 if (!response.ok) {
 throw new Error(`egress control ${path} failed: ${response.status} ${await response.text}`)
 }
 return response.json
}

export const leaseEgressToken = async (
 config: EgressClientConfig,
 input: { runId: string; budgetCapUsd: number | null; egressHosts?: readonly string[] },
): Promise<string> => {
 const result = (await control(config, '/_control/lease', {
 method: 'POST',
 body: input,
 })) as { token?: unknown }
 if (typeof result.token !== 'string') throw new Error('egress control returned no lease token')
 return result.token
}

export const revokeEgressToken = async (
 config: EgressClientConfig,
 runId: string,
): Promise<void> => {
 await control(config, `/_control/lease/${encodeURIComponent(runId)}`, { method: 'DELETE' })
}

/**
 * Drains metered spend. Drain-on-read, so anything returned here has been handed
 * over exactly once — the Runner must therefore forward what it gets rather than
 * dropping it on a transient socket failure, or that spend is lost.
 */
export const drainUsage = async (config: EgressClientConfig): Promise<UsageRecord[]> => {
 const result = (await control(config, '/_control/usage', { method: 'GET' })) as {
 records?: unknown
 }
 return Array.isArray(result.records) ? (result.records as UsageRecord[]): []
}

/**
 * One recorded CONNECT decision, as it arrives over the control plane.
 *
 * `at` is a string here and a `Date` in the domain: it crossed JSON. Converted where it is
 * used rather than parsed on arrival, since what this Runner does with a decision is forward
 * it — and a Date that survives one hop only to be re-serialized is work nobody asked for.
 */
export interface EgressDecisionRecord {
 readonly runId: string
 readonly host: string
 readonly port: number
 readonly allowed: boolean
 readonly reason: string
 readonly at: string
}

/**
 * Drains recorded egress decisions.
 *
 * Drain-on-read like `drainUsage`, with the same obligation: what comes back has been handed
 * over once, so losing it loses the record. Unlike usage, losing one costs an audit entry
 * rather than money — which is why this is best-effort at the call site and spend is not.
 */
export const drainEgressDecisions = async (
 config: EgressClientConfig,
): Promise<EgressDecisionRecord[]> => {
 const result = (await control(config, '/_control/egress-decisions', { method: 'GET' })) as {
 decisions?: unknown
 }
 return Array.isArray(result.decisions) ? (result.decisions as EgressDecisionRecord[]): []
}

/**
 * Hands the proxy the operator's current upstream OAuth token. Called on
 * start and on an interval, because Claude Code rotates the token every few hours and the
 * proxy has no way to notice on its own.
 */
export const setUpstreamOauthToken = async (
 config: EgressClientConfig,
 oauthToken: string | null,
): Promise<void> => {
 await control(config, '/_control/upstream-auth', { method: 'PUT', body: { oauthToken } })
}
