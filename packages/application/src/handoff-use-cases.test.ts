import { describe, expect, it } from 'vitest'
import { asAgentRunId, asWorkspaceId, type AgentRunId, type WorkspaceId } from '@loom/domain'
import { suggestHandoffOnPressure, type SuggestHandoffDeps } from './handoff-use-cases.js'

/**
 * The nudge.
 *
 * `shouldSuggestHandoff` existed and nothing called it: an agent could hand over and the
 * platform never said a word. These tests are about the three things that has to be —
 * measured, once, and advice.
 */

const workspaceId = asWorkspaceId('w1')
const runId = asAgentRunId('run-1')

const run = (over: Partial<Parameters<typeof suggestHandoffOnPressure>[1]> = {}) => ({
  id: runId,
  workspaceId,
  runnerId: 'runner-1',
  status: 'running',
  contextTokens: 90_000,
  contextMaxTokens: 100_000,
  ...over,
})

const harness = (
  options: { tree?: { relation: string | null }[]; alreadySuggested?: boolean } = {},
) => {
  const delivered: { runId: AgentRunId; text: string }[] = []
  const announced: string[] = []
  let stamped = options.alreadySuggested ?? false
  let treeReads = 0

  const deps: SuggestHandoffDeps = {
    agentRuns: {
      markHandoffSuggested: async (_workspaceId: WorkspaceId, _id: AgentRunId) => {
        if (stamped) return false
        stamped = true
        return true
      },
      listTree: async () => {
        treeReads += 1
        return options.tree ?? []
      },
    },
    resolveTreeRunId: async (_workspaceId, id) => id,
    deliver: async ({ runId: id, text }) => {
      delivered.push({ runId: id, text })
    },
    announce: async ({ text }) => {
      announced.push(text)
    },
    limits: {},
  }

  return { deps, delivered, announced, treeReads: () => treeReads }
}

describe('suggestHandoffOnPressure', () => {
  it('tells a run under pressure its own number, and says it where a human reads too', async () => {
    const h = harness()
    expect(await suggestHandoffOnPressure(h.deps, run())).toBe(true)

    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]?.text).toContain('90%')
    expect(h.delivered[0]?.text).toContain('mcp__loom_handoff__hand_over')
    expect(h.announced[0]).toContain('90% full')
  })

  /**
   * It nudges; it does not hand over. Acting on the ratio alone would retire an agent
   * mid-thought on a number, and the agent is the one that knows whether it is still
   * getting better at the task.
   */
  it('never retires anything — the delivery is advice the run may ignore', async () => {
    const h = harness()
    await suggestHandoffOnPressure(h.deps, run())
    expect(h.delivered[0]?.text).toContain('nobody is stopping you')
  })

  /** A nudge repeated every heartbeat is a nudge ignored, in a window with no room to spare. */
  it('fires once per run, however many heartbeats cross the threshold', async () => {
    const h = harness()
    expect(await suggestHandoffOnPressure(h.deps, run())).toBe(true)
    expect(await suggestHandoffOnPressure(h.deps, run())).toBe(false)
    expect(await suggestHandoffOnPressure(h.deps, run({ contextTokens: 99_000 }))).toBe(false)
    expect(h.delivered).toHaveLength(1)
  })

  it('says nothing below the threshold', async () => {
    const h = harness()
    expect(await suggestHandoffOnPressure(h.deps, run({ contextTokens: 50_000 }))).toBe(false)
    expect(h.delivered).toHaveLength(0)
  })

  /** An unsampled window is not an empty one. No sample means no decision. */
  it('says nothing when the window was never sampled', async () => {
    const h = harness()
    expect(
      await suggestHandoffOnPressure(h.deps, run({ contextTokens: null, contextMaxTokens: null })),
    ).toBe(false)
    expect(h.delivered).toHaveLength(0)
  })

  it('says nothing to a run that is not working — there is nothing to carry', async () => {
    const h = harness()
    expect(await suggestHandoffOnPressure(h.deps, run({ status: 'awaiting_approval' }))).toBe(false)
    expect(h.delivered).toHaveLength(0)
  })

  /**
   * The cap is the one part that refuses. Past it nobody takes over, so suggesting it
   * would be advice the platform is about to reject.
   */
  it('says nothing once the tree has spent its handoffs', async () => {
    const h = harness({ tree: [{ relation: 'handoff' }, { relation: 'handoff' }] })
    expect(await suggestHandoffOnPressure(h.deps, run())).toBe(false)
    expect(h.delivered).toHaveLength(0)
  })

  it('names how many the tree has left when it has used one', async () => {
    const h = harness({ tree: [{ relation: 'handoff' }, { relation: 'delegation' }] })
    expect(await suggestHandoffOnPressure(h.deps, run())).toBe(true)
    expect(h.delivered[0]?.text).toContain('handed off 1 time(s) already')
  })

  /**
   * Every run in the workspace heartbeats every few seconds. Reading the tree before
   * deciding would be a query per run per tick for a condition almost no run is in.
   */
  it('does not read the tree for a run that is nowhere near the threshold', async () => {
    const h = harness()
    await suggestHandoffOnPressure(h.deps, run({ contextTokens: 10_000 }))
    expect(h.treeReads()).toBe(0)
  })
})
