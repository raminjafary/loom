import type { AgentRun, MergeQueueEntry, Prosecution, RunVerification } from '@loom/api-contract'
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

const verification = (overrides: Partial<RunVerification>): RunVerification =>
  ({
    id: 'v1',
    agentRunId: 'r1',
    branchName: 'loom/run-1a2b3c4d',
    status: 'passed',
    commitSha: 'abc1234',
    checks: [],
    reason: null,
    ...overrides,
  }) as RunVerification

const prosecution = (overrides: Partial<Prosecution>): Prosecution =>
  ({
    id: 'p1',
    agentRunId: 'r1',
    prosecutorRunId: 'pr1',
    status: 'reported',
    observations: [],
    reason: null,
    createdAt: new Date('2026-08-13T00:00:00Z'),
    finishedAt: new Date('2026-08-13T00:01:00Z'),
    ...overrides,
  }) as Prosecution

const board = (input: {
  needsAttention?: AgentRun[]
  settled?: AgentRun[]
  mergeQueue?: MergeQueueEntry[]
  verifications?: RunVerification[]
  prosecutions?: Prosecution[]
}) =>
  buildInboxBoard({
    needsAttention: input.needsAttention ?? [],
    settled: input.settled ?? [],
    mergeQueue: input.mergeQueue ?? [],
    ...(input.verifications ? { verifications: input.verifications } : {}),
    ...(input.prosecutions ? { prosecutions: input.prosecutions } : {}),
  })

const cardFor = (lanes: ReturnType<typeof board>, runId: string) =>
  lanes.flatMap((lane) => lane.cards).find((card) => card.run.id === runId)

const laneOf = (lanes: ReturnType<typeof board>, runId: string): InboxLaneId | null =>
  lanes.find((lane) => lane.cards.some((card) => card.run.id === runId))?.id ?? null

describe('buildInboxBoard', () => {
  it('always returns every lane, so an empty column can still say what it means', () => {
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
  it('separates a branch to review from one a stopped run left behind', () => {
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
  it('splits what landed from what was dropped', () => {
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
  it('puts a queued branch in the queue, not in review', () => {
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
  it('never calls an unverified merge a verified one', () => {
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
  it('shows a run once when both lists carry it', () => {
    const settled = run({ id: 'r1', branchDisposition: 'merged' })
    const lanes = board({ needsAttention: [run({ id: 'r1' })], settled: [settled] })
    expect(lanes.flatMap((lane) => lane.cards)).toHaveLength(1)
    // The attention list is read first, so it wins — which is the honest answer while the
    // two disagree: the server said it needed a human more recently than it said it did not.
    expect(laneOf(lanes, 'r1')).toBe('review')
  })

  it('prefers the open queue entry when a branch has been queued more than once', () => {
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

describe('waitingCount', () => {
  /**
   * A counter that included everything the swarm ever produced would climb forever and
   * stop meaning "look at this", which is the whole job of a badge.
   */
  it('counts only the lanes that are asking for something', () => {
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

  /**
   * The reason the badge could not stay `needsAttention.length`. That list is a *fetch*
   * and the board is a *reading* of it: a run whose branch is already queued for merge is
   * in the fetch and is waiting on the queue, not on a human.
   */
  it('is smaller than the fetch it reads when a branch is already in the queue', () => {
    const needsAttention = [
      run({ id: 'gated', status: 'awaiting_approval' }),
      run({ id: 'queued-already' }),
    ]
    const lanes = board({
      needsAttention,
      mergeQueue: [entry({ id: 'q1', agentRunId: 'queued-already', status: 'queued' })],
    })
    expect(waitingCount(lanes)).toBe(1)
    expect(needsAttention.length).toBe(2)
  })
})

/**
 * The verification harness on the board.
 *
 * The decision under test is that a verdict does **not** move a card. A lane is what a
 * human does next; a branch that failed its checks still needs the same decision, and
 * putting it in "Stopped early" would say something false about the run.
 */
describe('buildInboxBoard and the runs nobody decides about', () => {
  /**
   * The lane filled with cards no human could act on the moment a prosecutor started on every
   * finished branch: two per branch, and the badge counted both. A reviewer's branch had the
   * same problem for longer and quieter, because a plan produces one reviewer, not one per run.
   */
  it.each(['review', 'prosecute', 'verify', 'screen'] as const)(
    'keeps a %s run off the board entirely — its branch is not a proposal',
    (relation) => {
      const lanes = board({ needsAttention: [run({ id: 'second-opinion', relation })] })
      expect(laneOf(lanes, 'second-opinion')).toBeNull()
      expect(waitingCount(lanes)).toBe(0)
    },
  )

  /** A reconciler's branch *is* the fix and does merge; an escalation is the same task retried. */
  it.each(['reconcile', 'escalate', 'delegation', null] as const)(
    'keeps a %s run on it — that branch is work',
    (relation) => {
      const lanes = board({ needsAttention: [run({ id: 'work', relation })] })
      expect(laneOf(lanes, 'work')).toBe('review')
    },
  )
})

describe('buildInboxBoard with prosecutions', () => {
  const broke = [{ name: 'a probe', outcome: 'broke' as const, detail: null }]
  const held = [{ name: 'a probe', outcome: 'held' as const, detail: null }]

  /**
   * The whole use of this evidence, and the only one it is allowed: which of thirty cards is
   * worth the next thirty seconds. `prosecutionWantsAttention` existed, was tested, and was
   * called by nothing — so the ordering its own doc described did not happen anywhere.
   */
  it('puts a branch whose diff broke a probe first in the review lane', () => {
    const lanes = board({
      needsAttention: [
        run({ id: 'quiet' }),
        run({ id: 'noisy', branchName: 'loom/run-2' }),
        run({ id: 'also-quiet', branchName: 'loom/run-3' }),
      ],
      prosecutions: [prosecution({ agentRunId: 'noisy', observations: broke })],
    })
    const review = lanes.find((lane) => lane.id === 'review')
    expect(review?.cards.map((card) => card.run.id)).toEqual(['noisy', 'quiet', 'also-quiet'])
  })

  it('leaves the order alone when nothing broke', () => {
    const lanes = board({
      needsAttention: [run({ id: 'first' }), run({ id: 'second', branchName: 'loom/run-2' })],
      prosecutions: [prosecution({ agentRunId: 'second', observations: held })],
    })
    const review = lanes.find((lane) => lane.id === 'review')
    expect(review?.cards.map((card) => card.run.id)).toEqual(['first', 'second'])
  })

  /** A prosecution still running has said nothing yet, so it is not a reason to look. */
  it('does not promote a prosecution that has not reported', () => {
    const lanes = board({
      needsAttention: [run({ id: 'first' }), run({ id: 'second', branchName: 'loom/run-2' })],
      prosecutions: [
        prosecution({ agentRunId: 'second', status: 'running', observations: broke }),
      ],
    })
    expect(lanes.find((lane) => lane.id === 'review')?.cards[0]?.run.id).toBe('first')
  })

  /**
   * Ordering, and only ordering. A card promoted out of `landed` or `queued` would invite
   * someone to act on a branch that is not theirs to touch.
   */
  it('never moves a card between lanes', () => {
    const lanes = board({
      settled: [run({ id: 'merged', branchDisposition: 'merged' })],
      prosecutions: [prosecution({ agentRunId: 'merged', observations: broke })],
    })
    expect(laneOf(lanes, 'merged')).toBe('landed')
    expect(cardFor(lanes, 'merged')?.prosecution?.observations).toHaveLength(1)
  })

  it('leaves the field null when nothing prosecuted a run', () => {
    expect(cardFor(board({ needsAttention: [run({ id: 'r1' })] }), 'r1')?.prosecution).toBeNull()
  })
})

describe('buildInboxBoard with verifications', () => {
  it('carries the verdict onto the card without changing its lane', () => {
    const failing = board({
      needsAttention: [run({ id: 'r1' })],
      verifications: [verification({ agentRunId: 'r1', status: 'failed' })],
    })
    const passing = board({
      needsAttention: [run({ id: 'r1' })],
      verifications: [verification({ agentRunId: 'r1', status: 'passed' })],
    })
    expect(laneOf(failing, 'r1')).toBe('review')
    expect(laneOf(passing, 'r1')).toBe(laneOf(failing, 'r1'))
    expect(cardFor(failing, 'r1')?.verification?.status).toBe('failed')
  })

  // A board built before the verifications arrive is still a correct board — the panel
  // fetches them in a second round trip that is allowed to fail.
  it('leaves the field null when nothing verified a run', () => {
    const lanes = board({ needsAttention: [run({ id: 'r1' })] })
    expect(cardFor(lanes, 'r1')?.verification).toBeNull()
  })

  it('does not attach one run\'s verdict to another run\'s card', () => {
    const lanes = board({
      needsAttention: [run({ id: 'r1' }), run({ id: 'r2', branchName: 'loom/run-2' })],
      verifications: [verification({ agentRunId: 'r2', status: 'failed' })],
    })
    expect(cardFor(lanes, 'r1')?.verification).toBeNull()
    expect(cardFor(lanes, 'r2')?.verification?.status).toBe('failed')
  })
})
