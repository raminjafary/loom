import { describe, expect, it } from 'vitest'
import {
 activityLabel,
 describeCardActivity,
 QUIET_THRESHOLD_SECONDS,
 type BoardCard,
} from './board-activity.js'

const NOW = new Date('2026-08-11T12:00:00Z')
const ago = (seconds: number) => new Date(NOW.getTime - seconds * 1000)

const card = (over: Partial<BoardCard>): BoardCard =>
 ({
 runId: 'r1',
 parentRunId: null,
 personaName: 'swe',
 title: 'do the thing',
 status: 'running',
 relation: null,
 branchName: null,
 branchDisposition: null,
 totalCostUsd: null,
 ownedPaths: [],
 noteCount: 0,
 latestNoteTitle: null,
 blockerCount: 0,
 currentToolName: null,
 currentToolTarget: null,
 openCallCount: 0,
 lastEventAt: ago(5),
 budgetCapUsd: null,
 contextTokens: null,
 contextMaxTokens: null,
...over,
 }) as BoardCard

describe('describeCardActivity', => {
 it('names the call in flight and the file it is in', => {
 const activity = describeCardActivity(
 card({ currentToolName: 'Read', currentToolTarget: '/work/a.ts', openCallCount: 1 }),
 NOW,
)
 expect(activity.kind).toBe('working')
 expect(activityLabel(activity)).toBe('Read')
 expect(activity.target).toBe('/work/a.ts')
 expect(activity.otherOpenCalls).toBe(0)
 })

 /** A fan-out must not read as a single call — that is the whole reason for the count. */
 it('counts the calls it is not showing', => {
 const activity = describeCardActivity(
 card({ currentToolName: 'Read', currentToolTarget: '/work/n.ts', openCallCount: 14 }),
 NOW,
)
 expect(activity.otherOpenCalls).toBe(13)
 expect(activityLabel(activity)).toBe('Read +13 more')
 })

 it('distinguishes thinking from having gone quiet', => {
 expect(describeCardActivity(card({ lastEventAt: ago(30) }), NOW).kind).toBe('thinking')
 expect(
 describeCardActivity(card({ lastEventAt: ago(QUIET_THRESHOLD_SECONDS + 1) }), NOW).kind,
).toBe('quiet')
 })

 /**
 * The label says how long the silence has been, never what it means: live swarm observability names both
 * possibilities — thinking hard, or wedged — and the platform cannot tell them apart.
 */
 it('does not claim a quiet run is stuck', => {
 const activity = describeCardActivity(card({ lastEventAt: ago(900) }), NOW)
 expect(activity.quietForSeconds).toBe(900)
 expect(activityLabel(activity)).not.toMatch(/stuck|wedged|hung/i)
 })

 it('separates a run that has emitted nothing from one that has gone silent', => {
 expect(describeCardActivity(card({ lastEventAt: null }), NOW).kind).toBe('unstarted')
 })

 /**
 * A finished run has nothing in flight, whatever the projection says. The server
 * already blanks these, and agreeing here means a stale payload cannot animate a card
 * that stopped hours ago.
 */
 it.each(['completed', 'failed', 'cancelled'])('reports a %s run as finished', (status) => {
 const activity = describeCardActivity(
 card({ status, currentToolName: 'Bash', openCallCount: 2, lastEventAt: ago(10_000) }),
 NOW,
)
 expect(activity.kind).toBe('finished')
 expect(activityLabel(activity)).toBe('')
 })

 describe('cost against the cap', => {
 it('reports the fraction of its own cap a run has spent', => {
 expect(describeCardActivity(card({ totalCostUsd: 0.5, budgetCapUsd: 1 }), NOW).capUsedRatio)
.toBeCloseTo(0.5)
 })

 it('reports reaching the ceiling as reaching it, not as over-spending', => {
 const at = describeCardActivity(card({ totalCostUsd: 1, budgetCapUsd: 1 }), NOW)
 expect(at.capUsedRatio).toBeCloseTo(1)
 })

 /** No ratio to show is not the same as a ratio of zero. */
 it('has no ratio for an uncapped or unmetered run', => {
 expect(describeCardActivity(card({ totalCostUsd: 3, budgetCapUsd: null }), NOW).capUsedRatio)
.toBeNull
 expect(describeCardActivity(card({ totalCostUsd: null, budgetCapUsd: 1 }), NOW).capUsedRatio)
.toBeNull
 // A zero cap would otherwise divide by zero and render as Infinity.
 expect(describeCardActivity(card({ totalCostUsd: 1, budgetCapUsd: 0 }), NOW).capUsedRatio)
.toBeNull
 })
 })
})

/**
 * The context pressure. Reported even for a finished run: "how full was its window
 * when it stopped" is exactly the post-mortem question, and it is also the figure the * warm handoff triggers on.
 */
describe('context pressure', => {
 it('reports occupancy as a fraction of the model window', => {
 const activity = describeCardActivity(
 card({ contextTokens: 150_000, contextMaxTokens: 1_000_000 }),
 NOW,
)
 expect(activity.contextUsedRatio).toBeCloseTo(0.15)
 })

 it('has no ratio before the Runner has sampled — which is not the same as empty', => {
 expect(describeCardActivity(card({}), NOW).contextUsedRatio).toBeNull
 expect(
 describeCardActivity(card({ contextTokens: 100, contextMaxTokens: null }), NOW)
.contextUsedRatio,
).toBeNull
 // A zero window would divide by zero and render as Infinity.
 expect(
 describeCardActivity(card({ contextTokens: 100, contextMaxTokens: 0 }), NOW).contextUsedRatio,
).toBeNull
 })

 it('keeps reporting it for a finished run, since that is the post-mortem question', => {
 const activity = describeCardActivity(
 card({ status: 'completed', contextTokens: 900_000, contextMaxTokens: 1_000_000 }),
 NOW,
)
 expect(activity.kind).toBe('finished')
 expect(activity.contextUsedRatio).toBeCloseTo(0.9)
 })
})
