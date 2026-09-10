import { describe, expect, it } from 'vitest'
import { describeStuckLoop, repeatedTailCall, type ToolCallFingerprint } from './stuck-loop.js'

/**
 * The rule is narrow on purpose, and the tests are mostly about what it must *not* catch:
 * a run whose arguments change is working, and a run that alternates is exploring badly.
 * Only a tail with no variable in it is a loop.
 */

const call = (toolName: string, inputDigest = 'a'): ToolCallFingerprint => ({ toolName, inputDigest })

/** Newest first, as the port returns them. */
const tail = (...calls: ToolCallFingerprint[]) => calls

describe('repeatedTailCall', () => {
  it('counts the identical calls at the end of the history', () => {
    expect(repeatedTailCall(tail(call('Bash'), call('Bash'), call('Bash'), call('Read')), 3)).toEqual({
      toolName: 'Bash',
      count: 3,
    })
  })

  it('stops counting at the first call that differs', () => {
    // The same tool with different arguments is a run doing its job.
    expect(
      repeatedTailCall(tail(call('Read', 'a'), call('Read', 'b'), call('Read', 'a')), 2),
    ).toBeNull()
    expect(repeatedTailCall(tail(call('Bash'), call('Read'), call('Bash')), 2)).toBeNull()
  })

  it('does not reach back past work the run has since done', () => {
    // Eight identical calls an hour ago, and a different call since: not stuck now.
    const history = tail(call('Grep'), ...Array.from({ length: 8 }, () => call('Bash')))
    expect(repeatedTailCall(history, 3)).toBeNull()
  })

  it('is off at a limit of zero, and says nothing about an empty history', () => {
    expect(repeatedTailCall(tail(call('Bash'), call('Bash')), 0)).toBeNull()
    expect(repeatedTailCall(tail(), 3)).toBeNull()
  })

  it('names the tool and the count, because "stuck" is not a diagnosis', () => {
    expect(describeStuckLoop({ toolName: 'Bash', count: 12 })).toBe(
      'called Bash with the same input 12 times in a row',
    )
  })
})
