import type { AgentRun } from '@loom/api-contract'
import { describe, expect, it } from 'vitest'
import { attentionReason, describeAge } from './attention.js'

const run = (overrides: Partial<AgentRun>): AgentRun =>
  ({
    id: 'r1',
    status: 'completed',
    branchName: 'loom/run-1a2b3c4d',
    branchDisposition: null,
    persona: { name: 'swe' },
    ...overrides,
  }) as AgentRun

describe('attentionReason', () => {
  it('names an approval as an approval', () => {
    expect(attentionReason(run({ status: 'awaiting_approval' })).kind).toBe('approval')
  })

  it('calls a finished run\'s branch ready to review', () => {
    const reason = attentionReason(run({ status: 'completed' }))
    expect(reason.kind).toBe('review-branch')
    expect(reason.summary).toBe('branch ready to review')
  })

  /**
   * The bug this module was extracted to fix: the Inbox showed a run marked FAILED
   * alongside "branch ready to review", which is the opposite of what happened.
   */
  it.each(['failed', 'cancelled'] as const)(
    'does not call a %s run\'s partial branch ready',
    (status) => {
      const reason = attentionReason(run({ status }))
      expect(reason.kind).toBe('failed-branch')
      expect(reason.summary).not.toContain('ready')
      expect(reason.summary).toContain(status)
    },
  )

  /**
   * An approval outranks a branch: a run can be awaiting approval *and* have a branch,
   * and the approval is the thing with a clock on it (the SLA).
   */
  it('prefers the approval when a run has both', () => {
    expect(attentionReason(run({ status: 'awaiting_approval', branchName: 'loom/run-x' })).kind).toBe(
      'approval',
    )
  })

  it('says only what it knows when the run matches no reason it recognises', () => {
    const reason = attentionReason(run({ status: 'running', branchName: null }))
    expect(reason.kind).toBe('unknown')
    expect(reason.summary).toBe('running')
  })

  it('treats an already-decided branch as no longer a review', () => {
    expect(attentionReason(run({ branchDisposition: 'kept' })).kind).toBe('unknown')
  })
})

describe('describeAge', () => {
  const now = new Date('2026-08-11T12:00:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms)

  it('coarsens as it goes', () => {
    expect(describeAge(ago(5_000), now)).toBe('just now')
    expect(describeAge(ago(4 * 60_000), now)).toBe('4m ago')
    expect(describeAge(ago(3 * 3_600_000), now)).toBe('3h ago')
    expect(describeAge(ago(50 * 3_600_000), now)).toBe('2d ago')
  })

  it('never reports the future as a negative age', () => {
    expect(describeAge(new Date(now.getTime() + 60_000), now)).toBe('just now')
  })
})
