import type { CostSummary } from '@loom/api-contract'

/**
 * The workspace cost dashboard's shaping.
 *
 * Pure, and in client-core rather than in the component, for the same reason `run-tree.ts`
 * is: the contract-first rule means a TUI must be able to render the same dashboard without
 * reimplementing what a share is or which line is the one to look at.
 *
 * The server groups; this decides what the groups *mean*. That split is deliberate —
 * "which of these is worth a human's attention" is the question, not the database's,
 * and putting it here keeps it testable without a Postgres.
 */

export interface SpendShare {
  readonly label: string
  readonly sublabel: string | null
  readonly runCount: number
  readonly totalUsd: number
  /** 0–1 of the window's total. `0` when the total is zero, never `NaN`. */
  readonly share: number
}

const share = (totalUsd: number, of: number): number => (of <= 0 ? 0 : totalUsd / of)

/**
 * Spend by model, descending.
 *
 * The cost model names this specifically — "Cursor's 8x swing came from worker model
 * choice, so it must be visible, not buried in config" — and it is the one grouping that
 * answers it directly, because a persona can be re-pointed at a different model but a
 * model's price is a fact.
 */
export const spendByModel = (summary: CostSummary): SpendShare[] =>
  summary.byModel
    .map((row) => ({
      label: row.model,
      sublabel: null,
      runCount: row.runCount,
      totalUsd: row.totalUsd,
      share: share(row.totalUsd, summary.totals.totalUsd),
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd)

/** Spend by persona, descending, carrying the model each one actually ran on. */
export const spendByPersona = (summary: CostSummary): SpendShare[] =>
  summary.byPersona
    .map((row) => ({
      label: row.personaName,
      sublabel: row.model,
      runCount: row.runCount,
      totalUsd: row.totalUsd,
      share: share(row.totalUsd, summary.totals.totalUsd),
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd)

/** Spend by thread, descending — the "rolled up per thread". */
export const spendByThread = (summary: CostSummary): SpendShare[] =>
  summary.byThread
    .map((row) => ({
      label: row.channelName,
      sublabel: null,
      runCount: row.runCount,
      totalUsd: row.totalUsd,
      share: share(row.totalUsd, summary.totals.totalUsd),
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd)

/** Mean spend per run, or null when nothing has run — never a division by zero. */
export const meanRunUsd = (summary: CostSummary): number | null =>
  summary.totals.runCount === 0 ? null : summary.totals.totalUsd / summary.totals.runCount

/**
 * The one sentence a dashboard owes a human who is not going to read the tables.
 *
 * Returns null rather than a cheerful "all good" when there is nothing to say: a
 * workspace with no spend, or one where no single model dominates, has no finding, and
 * inventing one trains people to ignore the line.
 *
 * The 60% threshold is a judgement, not a measurement, and is written down as one. It
 * is set where a single model is clearly *the* cost rather than merely the largest of
 * several — below that, "biggest share" is noise a human should not be nudged to act on.
 */
export const dominantModel = (summary: CostSummary): SpendShare | null => {
  if (summary.totals.totalUsd <= 0) return null
  const [top] = spendByModel(summary)
  if (!top || top.share < 0.6) return null
  return top
}
