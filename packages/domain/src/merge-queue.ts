/**
 * The serialized merge queue.
 *
 * The roadmap is explicit about why this exists and why it is built *first*: the target is a
 * reconciler *agent*, but "a reconciler agent resolves conflicts" is a research
 * problem, so it ships behind a queue that is "always the fallback: rebase in
 * order, run tests, and on failure hand the branch back to its owning run". This
 * module is that queue's policy — deterministic, cheap, and with no model in it.
 *
 * Only the decisions live here. The git mechanics are the Runner's
 * (apps/runner/src/merge.ts), because the filesystem is the Runner's, and the
 * bookkeeping is the application layer's.
 */

import type { AgentRunId, MergeQueueEntryId, RepositoryId, WorkspaceId } from './ids.js'

export type MergeQueueEntryStatus = 'queued' | 'merging' | 'merged' | 'failed' | 'cancelled'

/**
 * Why a merge did not happen. A closed set rather than a free-text field, because
 * the entry's reason decides what a human should do next, and three of these are
 * *not* the run's fault — telling them apart is the difference between "your agent's
 * work conflicts" and "your repository has uncommitted changes".
 */
export type MergeFailureReason =
 /** The rebase hit a conflict. The branch goes back to its owning run. */
 | 'conflict'
 /** The rebase applied cleanly, but the verification command failed on the result. */
 | 'verification_failed'
 /** Verification would have executed agent-authored code on the host with no sandbox. */
 | 'verification_refused'
 /** The target branch has uncommitted changes; a human's working tree is not ours to move. */
 | 'dirty_target'
 /** The target moved between the rebase and the fast-forward — a human committed underneath. */
 | 'stale_target'
 /** The Runner was unreachable, or its git invocation failed for a reason not above. */
 | 'runner_error'

export interface MergeQueueEntry {
 readonly id: MergeQueueEntryId
 readonly workspaceId: WorkspaceId
 readonly repositoryId: RepositoryId
 readonly agentRunId: AgentRunId
 /** Snapshotted at enqueue time so a discarded run's entry still says what it was. */
 readonly branchName: string
 readonly status: MergeQueueEntryStatus
 /**
 * FIFO key. A database sequence, not a timestamp: a swarm enqueues its siblings
 * in the same millisecond, and "in order" has to mean something under that —
 * the same reason `message.seq` exists rather than ordering on `created_at`.
 */
 readonly position: bigint
 readonly failureReason: MergeFailureReason | null
 readonly detail: string | null
 /** The commit the target branch was fast-forwarded to. Null unless merged. */
 readonly mergedCommitSha: string | null
 /**
 * Whether a verification command actually ran and passed. A merge with no command
 * configured is still a merge, but it is not a verified one, and the row says which
 * — recording every merge as verified would make the column worthless.
 */
 readonly verified: boolean
 readonly enqueuedByUserId: string | null
 readonly createdAt: Date
 readonly startedAt: Date | null
 readonly finishedAt: Date | null
}

export const MERGE_QUEUE_TERMINAL_STATUSES: readonly MergeQueueEntryStatus[] = [
 'merged',
 'failed',
 'cancelled',
]

export const isMergeQueueEntryTerminal = (status: MergeQueueEntryStatus): boolean =>
 MERGE_QUEUE_TERMINAL_STATUSES.includes(status)

/**
 * The serialization rule, in one function: **at most one merge per repository at a
 * time, and queued entries go in `position` order.**
 *
 * `entries` must be one repository's entries — the queue is per repository, since
 * two repositories share no target branch and serializing across them would only
 * make merges wait on unrelated work.
 *
 * Returning null while something is `merging` is the whole point. Entry N+1 rebases
 * onto the *result* of entry N, so starting it early would rebase onto a tip that is
 * about to move and produce exactly the race repository binding says the queue replaces.
 *
 * This is advisory scheduling, not the safety boundary: the database's unique partial
 * index on (repository_id) where status = 'merging' is what actually makes a second
 * concurrent claim impossible. Two servers sweeping at once would both read the same
 * queued entry and both call this; only one insert survives.
 */
export const selectNextMergeEntry = (
 entries: readonly MergeQueueEntry[],
): MergeQueueEntry | null => {
 if (entries.some((entry) => entry.status === 'merging')) return null

 const queued = entries
.filter((entry) => entry.status === 'queued')
.sort((a, b) => (a.position < b.position ? -1: a.position > b.position ? 1: 0))

 return queued[0] ?? null
}

/**
 * Verification moved out of this module and generalized. `planMergeVerification` took one command and returned one
 * boolean; a definition of done is a named, ordered list, and it is the *same* list a
 * finished run is verified against. See `verification.ts`, and `runMergeEntry` for the
 * one distinction that survived: this queue asks whether the branch still passes after
 * being rebased onto the target, which is a different question from whether the run
 * that produced it was done.
 */

/**
 * A blocker a reviewer raised against the branch being queued.
 *
 * The reviewer's own words, carried verbatim: the human deciding whether to merge
 * anyway needs to read what was actually objected to, and a platform paraphrase of a
 * model's objection is the one summary that must not exist here.
 */
export interface ReviewBlocker {
 readonly reviewerRunId: AgentRunId
 readonly reviewerPersonaName: string
 readonly title: string
}

/**
 * **The first time the notes ledger gates an action rather than informing one**
 *.
 *
 * This is that decision, and it has two halves.
 *
 * **The default is refuse.** A reviewer that read the branch and said "do not merge
 * this" is the highest-value signal the ledger carries, and every other note in the
 * ledger only ever *informs* a reader who may ignore it. If a blocker did not stop
 * the merge, the reviewing role would be advisory, which is what the collaboration topology says it must
 * not be — "its verdict has to be recordable as something other than 'completed'".
 *
 * **But a human can always merge anyway**, and the override is not a compromise —
 * it is the boundary that makes the gate acceptable at all. The blocker is *model
 * output*: a reviewer that misread the diff, or was talked into an objection by the
 * code it was reading, would otherwise hold a branch shut with no key, and a
 * model deciding what a human may not merge inverts every trust rule in the security model. So the
 * platform refuses by default, names the objections, and lets a human overrule them
 * explicitly — never silently, and the override is audited.
 *
 * Returns null when nothing blocks, which is the ordinary case: an unreviewed branch
 * and a reviewed-and-cleared branch are indistinguishable here, deliberately.
 * Requiring a review would be a different feature — this one only enforces the
 * reviews a plan actually asked for.
 */
export const describeReviewBlockers = (
 branchName: string,
 blockers: readonly ReviewBlocker[],
): string | null => {
 if (blockers.length === 0) return null
 return [
 blockers.length === 1
 ? `${branchName} has a blocker from its reviewer:`
: `${branchName} has ${blockers.length} blockers from its reviewers:`,
...blockers.map((blocker) => `• ${blocker.reviewerPersonaName}: ${blocker.title}`),
 'Read them in the swarm ledger. Send the branch back to its run to fix them, or ' +
 'queue it again overriding the blockers if you disagree — a reviewer is a model, ' +
 'and overriding is yours to do.',
 ].join('\n')
}

/** One sentence for the thread and the notification body — never a raw git error dump. */
export const describeMergeFailure = (
 reason: MergeFailureReason,
 branchName: string,
 detail: string | null,
): string => {
 const suffix = detail ? ` (${detail})`: ''
 switch (reason) {
 case 'conflict':
 return `${branchName} could not be rebased onto the target branch — it conflicts with work merged before it${suffix}. The branch is back with its run.`
 case 'verification_failed':
 return `${branchName} rebased cleanly but failed verification${suffix}. The branch is back with its run.`
 case 'verification_refused':
 return `${branchName} was not merged: ${detail ?? 'verification could not run safely'}`
 case 'dirty_target':
 return `${branchName} was not merged: the repository has uncommitted changes on its target branch${suffix}. Commit or stash them, then re-queue.`
 case 'stale_target':
 return `${branchName} was not merged: the target branch moved while the merge was running${suffix}. Re-queue it.`
 case 'runner_error':
 return `${branchName} was not merged: ${detail ?? 'the Runner could not complete the merge'}.`
 }
}
