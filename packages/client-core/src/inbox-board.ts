import type { AgentRun, MergeQueueEntry } from '@loom/api-contract'
import { attentionReason } from './attention.js'

/**
 * The Inbox as a board of what came out.
 *
 * The correction is that nobody watches a stream for long, so the Inbox is the retention
 * hook. It was a flat list ordered by age, which answers "what is waiting on me" and
 * nothing else — and the question anyone supervising a swarm actually has is *what came
 * out of it*: what landed, what was thrown away, what is stuck in the queue behind
 * something else.
 *
 * **Lanes are what a human does next, not what status a row is in.** That is the whole
 * design decision, and it is why this is a derivation rather than a `groupBy(status)`. A
 * run that failed with a branch and a run that completed with a branch have different
 * statuses and the same next action — decide what to do with what it left — while a run
 * that completed and merged and a run that completed and was discarded share a status and
 * have nothing left to do at all.
 *
 * Here rather than in the component for the reason: a TUI has to reach the same board
 * from the same fields, and a second implementation would eventually disagree about which
 * lane a run is in.
 */

export type InboxLaneId = 'needs-you' | 'review' | 'stopped' | 'queued' | 'landed' | 'dropped'

export interface InboxCard {
 readonly run: AgentRun
 /** One line, in the imperative where there is something to do. */
 readonly summary: string
 /** The queue entry holding this run's branch, when one does. */
 readonly queueEntry: MergeQueueEntry | null
}

export interface InboxLane {
 readonly id: InboxLaneId
 readonly title: string
 /** What the lane means, for the empty state — an empty column should still say something. */
 readonly empty: string
 readonly cards: InboxCard[]
}

const LANE_TITLES: Record<InboxLaneId, { title: string; empty: string }> = {
 'needs-you': {
 title: 'Needs you',
 empty: 'No agent is blocked on a decision.',
 },
 review: {
 title: 'Ready to review',
 empty: 'No branch is waiting to be looked at.',
 },
 stopped: {
 title: 'Stopped early',
 empty: 'Nothing stopped part-way.',
 },
 queued: {
 title: 'In the merge queue',
 empty: 'Nothing is queued.',
 },
 landed: {
 title: 'Landed',
 empty: 'Nothing has merged or been pushed yet.',
 },
 dropped: {
 title: 'Dropped',
 empty: 'Nothing has been thrown away.',
 },
}

const LANE_ORDER: readonly InboxLaneId[] = [
 'needs-you',
 'review',
 'stopped',
 'queued',
 'landed',
 'dropped',
]

/**
 * A queue entry is a *branch's* state, and it outranks the run's own.
 *
 * A run whose branch is queued has nothing for a human to do — the queue is working on it
 * — even though the run itself is terminal with an undecided branch, which is exactly the
 * shape "ready to review" is defined as. Showing it in both lanes would invite someone to
 * review a branch that is mid-rebase, and showing it only in review would hide the fact
 * that the platform already has it.
 */
const laneFor = (run: AgentRun, entry: MergeQueueEntry | null): InboxLaneId => {
 if (entry && (entry.status === 'queued' || entry.status === 'merging')) return 'queued'
 if (run.branchDisposition === 'merged' || run.branchDisposition === 'pushed') return 'landed'
 if (run.branchDisposition === 'discarded') return 'dropped'
 if (run.branchDisposition === 'kept') return 'landed'
 if (run.status === 'awaiting_approval') return 'needs-you'
 if (run.status === 'failed' || run.status === 'cancelled') return 'stopped'
 return 'review'
}

const summaryFor = (run: AgentRun, lane: InboxLaneId, entry: MergeQueueEntry | null): string => {
 switch (lane) {
 case 'queued':
 return entry?.status === 'merging'
 ? 'merging now — rebasing and verifying'
: 'waiting its turn in the queue'
 case 'landed':
 if (run.branchDisposition === 'merged') {
 // "Merged" and "merged with tests behind it" are different facts, and the queue
 // records which — claiming verification that did not run is the one lie a merge
 // surface can tell that costs something later.
 return entry?.verified === false ? 'merged, unverified': 'merged'
 }
 if (run.branchDisposition === 'pushed') return 'pushed to origin'
 return 'branch kept, not merged'
 case 'dropped':
 return 'branch thrown away'
 default:
 return attentionReason(run).summary
 }
}

/**
 * Builds the board from what the session already holds.
 *
 * Nothing here fetches. `needsAttention`, `settled` and the merge queue are three reads
 * the client already makes, and a board that fetched a fourth time would be a fourth
 * source of truth about what a run is doing — which is what the worker-notes design refuses.
 *
 * Deduplicated by run id, because a run can legitimately appear in both input lists: it
 * is settled the moment a disposition lands, and the attention list is re-read on a
 * schedule that will sometimes still be carrying it.
 */
export const buildInboxBoard = (input: {
 needsAttention: readonly AgentRun[]
 settled: readonly AgentRun[]
 mergeQueue: readonly MergeQueueEntry[]
}): InboxLane[] => {
 const entryByRun = new Map<string, MergeQueueEntry>
 for (const entry of input.mergeQueue) {
 const existing = entryByRun.get(entry.agentRunId)
 // A branch can be queued more than once over its life — a conflict hands it back and
 // a human re-queues it. The open one is the one that describes where it is now.
 if (!existing || entry.status === 'queued' || entry.status === 'merging') {
 entryByRun.set(entry.agentRunId, entry)
 }
 }

 const seen = new Set<string>
 const byLane = new Map<InboxLaneId, InboxCard[]>(LANE_ORDER.map((id) => [id, []]))

 for (const run of [...input.needsAttention,...input.settled]) {
 if (seen.has(run.id)) continue
 seen.add(run.id)

 const queueEntry = entryByRun.get(run.id) ?? null
 const lane = laneFor(run, queueEntry)
 byLane.get(lane)?.push({ run, summary: summaryFor(run, lane, queueEntry), queueEntry })
 }

 return LANE_ORDER.map((id) => ({
 id,
 title: LANE_TITLES[id].title,
 empty: LANE_TITLES[id].empty,
 cards: byLane.get(id) ?? [],
 }))
}

/**
 * How many runs are waiting on a human — the count worth putting on the Inbox button.
 *
 * The two acting lanes only. A landed branch is not a badge: a counter that included
 * everything the swarm ever produced would climb forever and stop meaning "look at this".
 */
export const waitingCount = (lanes: readonly InboxLane[]): number =>
 lanes
.filter((lane) => lane.id === 'needs-you' || lane.id === 'review' || lane.id === 'stopped')
.reduce((total, lane) => total + lane.cards.length, 0)
