import type { SwarmBoard } from '@loom/api-contract'

/**
 * Reading the live fields into the one line a board card has room for.
 *
 * In client-core because it is a reading of run state, not a rendering of it: the
 * same judgement — working, thinking, quiet, finished — has to come out the same in a
 * TUI, and the thresholds below are decisions rather than styling.
 */

export type BoardCard = SwarmBoard['cards'][number]

/**
 * When quiet becomes worth mentioning. Live swarm observability: "A run that has not emitted in four minutes
 * is either thinking hard or wedged." The platform genuinely cannot tell those apart, so
 * this threshold decides when to *show the silence*, and the label says how long it has
 * been rather than which of the two it is. Claiming "wedged" would be a guess presented
 * as a finding, and the dead-run reaper is the thing entitled to that conclusion.
 */
export const QUIET_THRESHOLD_SECONDS = 240

export type ActivityKind = 'working' | 'thinking' | 'quiet' | 'finished' | 'unstarted'

export interface CardActivity {
 readonly kind: ActivityKind
 /** The tool in flight, when there is one. */
 readonly toolName: string | null
 /** Its primary argument — the "which file is it in" answer. */
 readonly target: string | null
 /** Calls open beyond the one being shown, so a fan-out reads as a fan-out. */
 readonly otherOpenCalls: number
 /** Seconds since the last event of any kind; null for a run that has emitted none. */
 readonly quietForSeconds: number | null
 /**
 * Metered spend as a fraction of this run's own cap — 1 means it is at the ceiling
 * that will stop it. Null when the run is uncapped or nothing has been metered yet,
 * which are both "no ratio to show" rather than zero.
 */
 readonly capUsedRatio: number | null
 /**
 * The context pressure: how full the model's window is, 0–1. Null before the Runner
 * has sampled it, which is a real state and not zero — a run that has not had a turn
 * has no occupancy to report.
 *
 * "A worker at 90% of its context is about to compact and get worse, and that is
 * invisible today until it fails". This is the number that makes it visible, and
 * the trigger the warm handoff is defined against.
 */
 readonly contextUsedRatio: number | null
}

const secondsSince = (at: Date | null, now: Date): number | null =>
 at === null ? null: Math.max(Math.round((now.getTime - at.getTime) / 1000), 0)

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export const describeCardActivity = (card: BoardCard, now: Date = new Date): CardActivity => {
 const quietForSeconds = secondsSince(card.lastEventAt, now)

 const capUsedRatio =
 card.budgetCapUsd === null || card.budgetCapUsd <= 0 || card.totalCostUsd === null
 ? null
: card.totalCostUsd / card.budgetCapUsd

 const contextUsedRatio =
 card.contextTokens === null || card.contextMaxTokens === null || card.contextMaxTokens <= 0
 ? null
: card.contextTokens / card.contextMaxTokens

 const base = {
 toolName: card.currentToolName,
 target: card.currentToolTarget,
 // The card shows one call; the rest are counted. `openCallCount` is never negative,
 // but a payload from a future version might disagree, and a negative "+-1 more"
 // would be worse than showing nothing.
 otherOpenCalls: Math.max(card.openCallCount - 1, 0),
 quietForSeconds,
 capUsedRatio,
 contextUsedRatio,
 }

 if (TERMINAL.has(card.status)) return {...base, kind: 'finished' }
 if (card.currentToolName !== null) return {...base, kind: 'working' }
 if (quietForSeconds === null) return {...base, kind: 'unstarted' }
 return {...base, kind: quietForSeconds >= QUIET_THRESHOLD_SECONDS ? 'quiet': 'thinking' }
}

/** The one-line phrasing, so every client says the same thing about the same state. */
export const activityLabel = (activity: CardActivity): string => {
 switch (activity.kind) {
 case 'working': {
 const suffix = activity.otherOpenCalls > 0 ? ` +${activity.otherOpenCalls} more`: ''
 return `${activity.toolName ?? 'tool'}${suffix}`
 }
 case 'thinking':
 return 'thinking'
 case 'quiet':
 return 'no events'
 case 'unstarted':
 return 'not started'
 case 'finished':
 return ''
 }
}
