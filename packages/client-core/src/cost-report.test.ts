import { describe, expect, it } from 'vitest'
import type { CostSummary } from '@loom/api-contract'
import { dominantModel, meanRunUsd, spendByModel, spendByPersona, spendByThread } from './cost-report.js'

const summary = (patch: Partial<CostSummary>): CostSummary => ({
  windowHours: null,
  totals: { runCount: 0, totalUsd: 0 },
  byPersona: [],
  byModel: [],
  byThread: [],
  topRuns: [],
  ...patch,
})

describe('cost report', () => {
  it('splits spend by model, largest first, as a share of the total', () => {
    const result = spendByModel(
      summary({
        totals: { runCount: 10, totalUsd: 100 },
        byModel: [
          { model: 'claude-haiku-4-5', runCount: 7, totalUsd: 20 },
          { model: 'claude-opus-5', runCount: 3, totalUsd: 80 },
        ],
      }),
    )
    expect(result.map((r) => r.label)).toEqual(['claude-opus-5', 'claude-haiku-4-5'])
    expect(result[0]?.share).toBeCloseTo(0.8)
    expect(result[1]?.share).toBeCloseTo(0.2)
  })

  it('carries the model each persona actually ran on', () => {
    const result = spendByPersona(
      summary({
        totals: { runCount: 2, totalUsd: 10 },
        byPersona: [
          { personaName: 'worker', model: 'claude-sonnet-5', runCount: 1, totalUsd: 4, maxUsd: 4 },
          { personaName: 'planner', model: 'claude-opus-5', runCount: 1, totalUsd: 6, maxUsd: 6 },
        ],
      }),
    )
    expect(result[0]).toMatchObject({ label: 'planner', sublabel: 'claude-opus-5' })
  })

  it('rolls up per thread, which is what the cost model asks for', () => {
    const result = spendByThread(
      summary({
        totals: { runCount: 3, totalUsd: 9 },
        byThread: [
          { threadId: 't1', channelName: 'general', runCount: 1, totalUsd: 3 },
          { threadId: 't2', channelName: 'migration', runCount: 2, totalUsd: 6 },
        ],
      }),
    )
    expect(result.map((r) => r.label)).toEqual(['migration', 'general'])
  })

  /**
   * A workspace where every run failed before reaching the proxy has runs and no spend.
   * Every ratio here divides by a total that is legitimately zero, and a dashboard
   * showing `NaN%` is worse than one showing nothing.
   */
  it('never divides by zero when nothing has been metered', () => {
    const empty = summary({
      totals: { runCount: 4, totalUsd: 0 },
      byModel: [{ model: 'claude-sonnet-5', runCount: 4, totalUsd: 0 }],
    })
    expect(spendByModel(empty)[0]?.share).toBe(0)
    expect(meanRunUsd(empty)).toBe(0)
    expect(dominantModel(empty)).toBeNull()
  })

  it('has no mean run cost before anything has run', () => {
    expect(meanRunUsd(summary({}))).toBeNull()
  })

  /**
   * The headline exists to be actionable, so it must stay silent when there is no
   * action — otherwise it becomes a line people learn to skip.
   */
  it('names a dominant model only when one genuinely dominates', () => {
    const lopsided = summary({
      totals: { runCount: 4, totalUsd: 100 },
      byModel: [
        { model: 'claude-opus-5', runCount: 1, totalUsd: 75 },
        { model: 'claude-haiku-4-5', runCount: 3, totalUsd: 25 },
      ],
    })
    expect(dominantModel(lopsided)?.label).toBe('claude-opus-5')

    const even = summary({
      totals: { runCount: 4, totalUsd: 100 },
      byModel: [
        { model: 'claude-opus-5', runCount: 2, totalUsd: 55 },
        { model: 'claude-sonnet-5', runCount: 2, totalUsd: 45 },
      ],
    })
    expect(dominantModel(even)).toBeNull()
  })
})
