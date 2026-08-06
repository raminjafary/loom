import { usageCostUsd, type TokenUsage } from '@loom/domain'
import { randomBytes } from 'node:crypto'

/**
 * The credential broker's bookkeeping. A *lease* is what makes
 * "the sandbox gets zero long-lived credentials" true: the Runner asks for one
 * per run over the host-only control plane, the sandbox is handed the opaque
 * token, and the proxy is the only process that ever sees the real secret.
 *
 * In memory on purpose. A lease is meaningless once the run it belongs to is
 * gone, so surviving a proxy restart would be a liability rather than a feature:
 * a token that outlives the process that issued it is a token nobody revoked.
 * A restart invalidates every lease, and the Runner re-leases on the next run.
 */

export interface Lease {
 readonly runId: string
 readonly token: string
 /** Null means unmetered — no cap to enforce. */
 readonly budgetCapUsd: number | null
 spentUsd: number
 /**
 * Set once a cap is breached. Latched rather than recomputed so that a run
 * cannot slip another request through while its abort is still in flight.
 */
 exhausted: boolean
 readonly createdAt: number
}

export interface UsageRecord {
 readonly runId: string
 readonly model: string
 readonly usage: TokenUsage
 /** Null when the model has no price entry — see usageCostUsd. */
 readonly costUsd: number | null
 readonly spentUsd: number
 readonly capUsd: number | null
 /** True on the request that pushed this run over its cap. */
 readonly exhausted: boolean
}

export const createLeaseRegistry = (options: {
 onUsage?: (record: UsageRecord) => void
} = {}) => {
 const byToken = new Map<string, Lease>
 const byRunId = new Map<string, Lease>

 return {
 issue(input: { runId: string; budgetCapUsd: number | null }): Lease {
 // Re-leasing the same run replaces the old token rather than adding a
 // second one, so a Runner restart cannot leave a live orphan token behind.
 const existing = byRunId.get(input.runId)
 if (existing) byToken.delete(existing.token)

 const lease: Lease = {
 runId: input.runId,
 token: randomBytes(32).toString('base64url'),
 budgetCapUsd: input.budgetCapUsd,
 // Spend carries over across a re-lease: a run must not get a fresh
 // budget by reconnecting.
 spentUsd: existing?.spentUsd ?? 0,
 exhausted: existing?.exhausted ?? false,
 createdAt: Date.now,
 }
 byToken.set(lease.token, lease)
 byRunId.set(lease.runId, lease)
 return lease
 },

 revoke(runId: string): boolean {
 const lease = byRunId.get(runId)
 if (!lease) return false
 byToken.delete(lease.token)
 byRunId.delete(runId)
 return true
 },

 resolve(token: string | null): Lease | null {
 if (!token) return null
 return byToken.get(token) ?? null
 },

 findByRunId(runId: string): Lease | null {
 return byRunId.get(runId) ?? null
 },

 /**
 * Records one metered call and reports whether the run has now exhausted its
 * cap. An unpriced model contributes nothing to `spentUsd` — the alternative,
 * guessing a price, would enforce a cap against a number nobody can audit —
 * and `costUsd: null` in the record is what makes that visible upstream
 * rather than silent.
 */
 meter(lease: Lease, model: string, usage: TokenUsage): UsageRecord {
 const costUsd = usageCostUsd(model, usage)
 if (costUsd !== null) lease.spentUsd += costUsd
 if (lease.budgetCapUsd !== null && lease.spentUsd >= lease.budgetCapUsd) {
 lease.exhausted = true
 }

 const record: UsageRecord = {
 runId: lease.runId,
 model,
 usage,
 costUsd,
 spentUsd: lease.spentUsd,
 capUsd: lease.budgetCapUsd,
 exhausted: lease.exhausted,
 }
 options.onUsage?.(record)
 return record
 },
 }
}

export type LeaseRegistry = ReturnType<typeof createLeaseRegistry>
