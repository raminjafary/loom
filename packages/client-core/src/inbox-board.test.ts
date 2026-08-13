import type { AgentRun, MergeQueueEntry } from '@loom/api-contract'
import { describe, expect, it } from 'vitest'
import { buildInboxBoard, waitingCount, type InboxLaneId } from './inbox-board.js'

/**
 * The Inbox as a board of what came out.
 *
 * Every test here is about the one decision the module makes: a lane is **what a human
 * does next**, not what status a row is in. A `groupBy(status)` would pass none of them.
 */

const run = (overrides: Partial<AgentRun>): AgentRun =>
 ({
 id: 'r1',
 status: 'completed',
 branchName: 'loom/run-1a2b3c4d',
 branchDisposition: null,
 totalCostUsd: 0.1,
 completedAt: new Date('2026-08-13T00:00:00Z'),
 createdAt: new Date('2026-08-13T00:00:00Z'),
 persona: { name: 'swe' },
...overrides,
 }) as AgentRun

const entry = (overrides: Partial<MergeQueueEntry>): MergeQueueEntry =>
 ({
 id: 'q1',
 agentRunId: 'r1',
 status: 'queued',
 verified: false,
...overrides,
 }) as MergeQueueEntry

const board = (input: {
 needsAttention?: AgentRun[]
 settled?: AgentRun[]
 mergeQueue?: MergeQueueEntry[]
}) =>
 buildInboxBoard({
 needsAttention: input.needsAttention ?? [],
 settled: input.settled ?? [],
 mergeQueue: input.mergeQueue ?? [],
 })

const laneOf = (lanes: ReturnType<typeof board>, runId: string): InboxLaneId | null =>
 lanes.find((lane) => lane.cards.some((card) => card.run.id === runId))?.id ?? null

describe('buildInboxBoard', => {
 it('always returns every lane, so an empty column can still say what it means', => {
 const lanes = board({})
 expect(lanes.map((lane) => lane.id)).toEqual([
 'needs-you',
 'review',
 'stopped',
 'queued',
 'landed',
 'dropped',
 ])
 expect(lanes.every((lane) => lane.empty.length > 0)).toBe(true)
 })

 /**
 * Different statuses, same next action. A `groupBy(status)` puts these in two columns
 * and asks a human to work out that both need the same decision.
 */
 it('separates a branch to review from one a stopped run left behind', => {
 const lanes = board({
 needsAttention: [
 run({ id: 'done', status: 'completed' }),
 run({ id: 'died', status: 'failed' }),
 run({ id: 'gated', status: 'awaiting_approval' }),
 ],
 })
 expect(laneOf(lanes, 'done')).toBe('review')
 expect(laneOf(lanes, 'died')).toBe('stopped')
 expect(laneOf(lanes, 'gated')).toBe('needs-you')
 })

 /**
 * Same status, nothing left to do — and two different things to say about it. A merged
 * branch and a thrown-away one are the two halves of "what came out".
 */
 it('splits what landed from what was dropped', => {
 const lanes = board({
 settled: [
 run({ id: 'merged', branchDisposition: 'merged' }),
 run({ id: 'pushed', branchDisposition: 'pushed' }),
 run({ id: 'binned', branchDisposition: 'discarded' }),
 ],
 })
 expect(laneOf(lanes, 'merged')).toBe('landed')
 expect(laneOf(lanes, 'pushed')).toBe('landed')
 expect(laneOf(lanes, 'binned')).toBe('dropped')
 })

 /**
 * The queue outranks the run's own state. A queued branch matches "terminal with an
 * undecided branch" exactly — the definition of ready-to-review — and inviting someone
 * to review a branch mid-rebase is the one thing this board must not do.
 */
 it('puts a queued branch in the queue, not in review', => {
 const lanes = board({
 needsAttention: [run({ id: 'r1' })],
 mergeQueue: [entry({ agentRunId: 'r1', status: 'merging' })],
 })
 expect(laneOf(lanes, 'r1')).toBe('queued')
 expect(lanes.find((lane) => lane.id === 'queued')?.cards[0]?.summary).toContain('merging now')
 })

 /**
 * "Merged" and "merged with tests behind it" are different facts, and the queue records
 * which. Claiming verification that did not run is the one lie a merge surface can tell
 * that costs something later.
 */
 it('never calls an unverified merge a verified one', => {
 const lanes = board({
 settled: [run({ id: 'r1', branchDisposition: 'merged' })],
 mergeQueue: [entry({ agentRunId: 'r1', status: 'merged', verified: false })],
 })
 expect(lanes.find((lane) => lane.id === 'landed')?.cards[0]?.summary).toBe('merged, unverified')
 })

 /**
 * A run is settled the moment a disposition lands, and the attention list is re-read on
 * a schedule that will sometimes still be carrying it. Shown twice it would be counted
 * twice, in two lanes that disagree.
 */
 it('shows a run once when both lists carry it', => {
 const settled = run({ id: 'r1', branchDisposition: 'merged' })
 const lanes = board({ needsAttention: [run({ id: 'r1' })], settled: [settled] })
 expect(lanes.flatMap((lane) => lane.cards)).toHaveLength(1)
 // The attention list is read first, so it wins — which is the honest answer while the
 // two disagree: the server said it needed a human more recently than it said it did not.
 expect(laneOf(lanes, 'r1')).toBe('review')
 })

 it('prefers the open queue entry when a branch has been queued more than once', => {
 const lanes = board({
 needsAttention: [run({ id: 'r1' })],
 mergeQueue: [
 entry({ id: 'old', agentRunId: 'r1', status: 'failed' }),
 entry({ id: 'new', agentRunId: 'r1', status: 'queued' }),
 ],
 })
 expect(laneOf(lanes, 'r1')).toBe('queued')
 })
})

describe('waitingCount', => {
 /**
 * A counter that included everything the swarm ever produced would climb forever and
 * stop meaning "look at this", which is the whole job of a badge.
 */
 it('counts only the lanes that are asking for something', => {
 const lanes = board({
 needsAttention: [
 run({ id: 'gated', status: 'awaiting_approval' }),
 run({ id: 'done' }),
 run({ id: 'died', status: 'failed' }),
 ],
 settled: [
 run({ id: 'merged', branchDisposition: 'merged' }),
 run({ id: 'binned', branchDisposition: 'discarded' }),
 ],
 })
 expect(waitingCount(lanes)).toBe(3)
 })
})
