import { describe, expect, it } from 'vitest'
import { asAgentRunId, asUserId } from './ids.js'
import { agentRunActor, systemActor, userActor } from './actor.js'
import { messageInView, threadViewFilter } from './thread-views.js'

/**
 * What a thread shows.
 *
 * The test that matters most is the one about blocking: `headline` must never hide a run
 * that is waiting, because a run waiting on a question nobody saw is the failure mid-flight
 * steering exists to prevent — and it would be a bad trade to introduce it while fixing
 * noise.
 */

const fromSystem = { author: systemActor() }
const fromHuman = { author: userActor(asUserId('u1')) }
const fromRun = (id: string) => ({ author: agentRunActor(asAgentRunId(id)) })

describe('messageInView', () => {
  it('shows the platform"s voice and the humans" in the headline', () => {
    expect(messageInView(fromSystem, 'headline')).toBe(true)
    expect(messageInView(fromHuman, 'headline')).toBe(true)
  })

  it('keeps model prose and tool calls out of it', () => {
    expect(messageInView(fromRun('r1'), 'headline')).toBe(false)
  })

  /**
   * Every blocking thing posts a *system* line — `askClarifyingQuestion` and
   * `requestApproval` both do, deliberately keeping the model's own words out of it. So
   * this is the property that makes a quieter default safe.
   */
  it('cannot hide a blocked run, because a block is always system-authored', () => {
    expect(messageInView(fromSystem, 'headline')).toBe(true)
  })

  it('shows one run"s own stream in its view, and not a sibling"s', () => {
    expect(messageInView(fromRun('r1'), 'run', 'r1')).toBe(true)
    expect(messageInView(fromRun('r2'), 'run', 'r1')).toBe(false)
  })

  it('keeps a human"s message visible beside the run they were watching', () => {
    expect(messageInView(fromHuman, 'run', 'r1')).toBe(true)
  })

  /** An empty list is a visible mistake; an unfiltered firehose is the bug. */
  it('shows nothing rather than everything when a run view has no focus', () => {
    expect(messageInView(fromRun('r1'), 'run')).toBe(false)
    expect(messageInView(fromSystem, 'run')).toBe(false)
  })

  it('shows everything in the unfiltered view', () => {
    for (const message of [fromSystem, fromHuman, fromRun('r1')]) {
      expect(messageInView(message, 'all')).toBe(true)
    }
  })
})

describe('threadViewFilter', () => {
  it('describes the same rule a query can apply', () => {
    expect(threadViewFilter('all')).toEqual({ authorKinds: null, agentRunId: null })
    expect(threadViewFilter('headline')).toEqual({
      authorKinds: ['system', 'user'],
      agentRunId: null,
    })
    expect(threadViewFilter('run', 'r1').agentRunId).toBe('r1')
  })

  /** A focusless run view must not degrade into "every agent message". */
  it('cannot be widened by omitting the focus', () => {
    expect(threadViewFilter('run').agentRunId).toBe('')
  })
})
