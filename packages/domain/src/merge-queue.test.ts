import { describe, expect, it } from 'vitest'
import {
 describeMergeFailure,
 describeReviewBlockers,
 isMergeQueueEntryTerminal,
 selectNextMergeEntry,
 type MergeQueueEntry,
 type MergeQueueEntryStatus,
} from './merge-queue.js'
import {
 asAgentRunId,
 asMergeQueueEntryId,
 asRepositoryId,
 asWorkspaceId,
} from './ids.js'

/**
 * The merge queue is "deterministic and cheap" — which is only true if
 * "in order" and "one at a time" hold under the conditions a swarm actually
 * produces: several entries created in the same millisecond, and a sweep that may
 * run while a merge is already in flight.
 */

const entry = (
 over: Omit<Partial<MergeQueueEntry>, 'position' | 'status'> & {
 position: number
 status: MergeQueueEntryStatus
 },
): MergeQueueEntry => ({
 id: asMergeQueueEntryId(`entry-${over.position}`),
 workspaceId: asWorkspaceId('ws'),
 repositoryId: asRepositoryId('repo'),
 agentRunId: asAgentRunId(`run-${over.position}`),
 branchName: `loom/run-${over.position}`,
 failureReason: null,
 detail: null,
 mergedCommitSha: null,
 verified: false,
 enqueuedByUserId: 'user-1',
 createdAt: new Date('2026-01-01T00:00:00Z'),
 startedAt: null,
 finishedAt: null,
...over,
 position: BigInt(over.position),
})

describe('selectNextMergeEntry', => {
 it('picks the lowest-position queued entry', => {
 const next = selectNextMergeEntry([
 entry({ position: 3, status: 'queued' }),
 entry({ position: 1, status: 'queued' }),
 entry({ position: 2, status: 'queued' }),
 ])
 expect(next?.position).toBe(1n)
 })

 // The serialization rule itself. Entry N+1 rebases onto the *result* of entry N,
 // so starting it while N is in flight rebases onto a tip that is about to move.
 it('picks nothing while another entry for the repository is merging', => {
 expect(
 selectNextMergeEntry([
 entry({ position: 1, status: 'merging' }),
 entry({ position: 2, status: 'queued' }),
 ]),
).toBeNull
 })

 it('resumes once the in-flight entry reaches a terminal status', => {
 const next = selectNextMergeEntry([
 entry({ position: 1, status: 'merged' }),
 entry({ position: 2, status: 'queued' }),
 ])
 expect(next?.position).toBe(2n)
 })

 // A failed entry hands its branch back to its owning run — it must not
 // block every sibling behind it forever.
 it('does not let a failed entry block the ones behind it', => {
 const next = selectNextMergeEntry([
 entry({ position: 1, status: 'failed', failureReason: 'conflict' }),
 entry({ position: 2, status: 'queued' }),
 ])
 expect(next?.position).toBe(2n)
 })

 it('skips cancelled entries', => {
 const next = selectNextMergeEntry([
 entry({ position: 1, status: 'cancelled' }),
 entry({ position: 2, status: 'queued' }),
 ])
 expect(next?.position).toBe(2n)
 })

 it('returns null for an empty or fully-resolved queue', => {
 expect(selectNextMergeEntry([])).toBeNull
 expect(selectNextMergeEntry([entry({ position: 1, status: 'merged' })])).toBeNull
 })

 // bigint ordering, not string ordering: a queue that reached three digits would
 // otherwise put position 100 before position 99.
 it('orders numerically past the point where string ordering diverges', => {
 const next = selectNextMergeEntry([
 entry({ position: 100, status: 'queued' }),
 entry({ position: 99, status: 'queued' }),
 ])
 expect(next?.position).toBe(99n)
 })
})

describe('isMergeQueueEntryTerminal', => {
 it('treats merged, failed and cancelled as terminal', => {
 expect(isMergeQueueEntryTerminal('merged')).toBe(true)
 expect(isMergeQueueEntryTerminal('failed')).toBe(true)
 expect(isMergeQueueEntryTerminal('cancelled')).toBe(true)
 expect(isMergeQueueEntryTerminal('queued')).toBe(false)
 expect(isMergeQueueEntryTerminal('merging')).toBe(false)
 })
})

describe('describeMergeFailure', => {
 it('says the branch went back to its run for the failures that are the run\'s to fix', => {
 expect(describeMergeFailure('conflict', 'loom/run-1', null)).toContain('back with its run')
 expect(describeMergeFailure('verification_failed', 'loom/run-1', 'exit 1')).toContain(
 'back with its run',
)
 })

 // A dirty working tree is the human's, not the agent's — the message has to point
 // at the thing they can actually do something about.
 it('points a dirty target at the human, not the run', => {
 const text = describeMergeFailure('dirty_target', 'loom/run-1', null)
 expect(text).toContain('uncommitted changes')
 expect(text).not.toContain('back with its run')
 })

 it('names the branch in every reason', => {
 const reasons = [
 'conflict',
 'verification_failed',
 'verification_refused',
 'dirty_target',
 'stale_target',
 'runner_error',
 ] as const
 for (const reason of reasons) {
 expect(describeMergeFailure(reason, 'loom/run-7', 'detail')).toContain('loom/run-7')
 }
 })
})

/**
 * The gate. The two properties worth pinning are the two halves of the
 * decision: nothing blocks by default, and what does block is quoted rather than
 * summarized — the human is deciding whether to overrule a *reviewer*, and they need
 * its words and its name.
 */
describe('describeReviewBlockers', => {
 const blocker = (reviewerPersonaName: string, title: string) => ({
 reviewerRunId: asAgentRunId('00000000-0000-0000-0000-00000000000a'),
 reviewerPersonaName,
 title,
 })

 it('is null with no blockers, so an unreviewed branch is unaffected', => {
 // An unreviewed branch and a reviewed-and-cleared branch are deliberately
 // indistinguishable here: requiring a review would be a different feature.
 expect(describeReviewBlockers('loom/run-1', [])).toBeNull
 })

 it('names the reviewer and quotes its objection', => {
 const text = describeReviewBlockers('loom/run-1', [
 blocker('security-reviewer', 'The token is logged in plaintext'),
 ])
 expect(text).toContain('loom/run-1')
 expect(text).toContain('security-reviewer')
 expect(text).toContain('The token is logged in plaintext')
 })

 it('says the override is the human\'s to make', => {
 // The gate has to be openable, or a model decides what a human may merge — see the
 // function's own comment. A refusal that does not say so reads as a dead end.
 const text = describeReviewBlockers('loom/run-1', [blocker('qa', 'Tests fail')])
 expect(text).toContain('overriding the blockers')
 expect(text).toContain('yours to do')
 })

 it('counts them when there is more than one', => {
 const text = describeReviewBlockers('loom/run-1', [
 blocker('qa', 'Tests fail'),
 blocker('solution-architect', 'Wrong layer'),
 ])
 expect(text).toContain('2 blockers')
 expect(text).toContain('Wrong layer')
 })
})
