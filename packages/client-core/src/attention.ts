import type { AgentRun } from '@loom/api-contract'

/**
 * Why a run is in the Inbox, and what the human is being asked to do about it.
 *
 * Here rather than in the component because it is a reading of run state, not a
 * rendering of it — a TUI must reach the same conclusion from the same fields —
 * and because the previous version was a one-line conditional that got it wrong: every
 * run that was not awaiting approval was described as "branch ready to review",
 * including runs that had *failed*. A failed run is in this list for a different
 * reason, and telling a human its branch is ready is telling them the opposite of what
 * happened.
 */

export type AttentionKind = 'approval' | 'failed-branch' | 'review-branch' | 'unknown'

export interface AttentionReason {
  readonly kind: AttentionKind
  /** One line, in the imperative: what this run is waiting for a human to do. */
  readonly summary: string
}

/**
 * Mirrors the server's `listNeedsAttention`: a run qualifies by awaiting an approval,
 * or by being finished with a branch nobody has decided about yet. Anything else here
 * is a disagreement between client and server about what "needs attention" means, and
 * says so rather than inventing a reason.
 */
export const attentionReason = (run: AgentRun): AttentionReason => {
  if (run.status === 'awaiting_approval') {
    return { kind: 'approval', summary: 'waiting on your approval to continue' }
  }

  if (run.branchDisposition === null && run.branchName !== null) {
    return run.status === 'failed' || run.status === 'cancelled'
      ? {
          kind: 'failed-branch',
          // The work stopped early, so what is on the branch is partial by definition.
          // "Ready to review" would promise a finished change.
          summary: `${run.status} part-way — decide what to do with the branch it left`,
        }
      : { kind: 'review-branch', summary: 'branch ready to review' }
  }

  return { kind: 'unknown', summary: run.status }
}

/**
 * How long ago, in the coarsest unit that still says something useful.
 *
 * The Inbox is ordered oldest-first because the approval SLA means the longest wait is
 * the closest to being auto-denied, and a list of five identical rows cannot show that
 * ordering is meaningful unless it also shows the ages.
 */
export const describeAge = (at: Date, now: Date = new Date()): string => {
  const seconds = Math.max(Math.round((now.getTime() - at.getTime()) / 1000), 0)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
