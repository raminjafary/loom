import { usageCostUsd, type TokenUsage } from '@loom/domain'
import { createHash, randomBytes } from 'node:crypto'

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

/**
 * Lease tokens are shaped like a provider key on purpose. The Agent SDK's bundled
 * CLI validates `ANTHROPIC_API_KEY`'s format *locally* and refuses to make any
 * request at all if it does not match — so an arbitrary opaque token never reaches
 * the proxy, and the run fails with a bare "Invalid API key" that names nothing.
 * Found by watching the proxy receive no request whatsoever.
 *
 * This is still not a credential: it is random, per-run, revocable, and accepted by
 * nothing except this proxy. Only the shape is borrowed.
 *
 * The shape mimics a real key closely — `sk-ant-api03-` plus a 95-character body —
 * because the validator appears to check length as well as prefix, and a token that
 * merely starts with `sk-ant-` was accepted or rejected depending on its length. Hex
 * rather than base64url for the body, so no issued token can contain `-` or `_`:
 * with base64url the check passed or failed depending on the random draw, which made
 * a client-side format check look like an intermittent proxy bug.
 *
 * Do not "tidy" the prefix, alphabet, or length without re-running the sandbox smoke
 * check. The failure mode is a bare "Invalid API key" with no request ever leaving
 * the container, which points nowhere near the cause.
 */
const TOKEN_PREFIX = 'sk-ant-api03-'
/**
 * Total token length, and it is exact rather than approximate: the CLI truncates
 * anything longer to 108 characters, so a 109-character token arrives at the proxy
 * one character short and fails to match the value that was issued. Verified by
 * logging the presented length against the issued one.
 */
const TOKEN_LENGTH = 108

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
 token: `${TOKEN_PREFIX}${randomBytes(TOKEN_LENGTH)
.toString('hex')
.slice(0, TOKEN_LENGTH - TOKEN_PREFIX.length)}`,
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
 * Hashed identifiers of every live lease, for refusal logs. Hashes rather than
 * tokens so a log can answer "was this ever issued?" without being a place a
 * token leaks.
 */
 fingerprints: string[] {
 return [...byToken.entries].map(
 ([token, lease]) =>
 `${lease.runId}:${createHash('sha256').update(token).digest('hex').slice(0, 10)}`,
)
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
