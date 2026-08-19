import { describe, expect, it } from 'vitest'
import {
 MAX_REPLAY_ITEMS,
 MIN_REPLAY_ITEMS,
 assembleReplaySet,
 describeReplaySet,
 screenGate,
 screenOutcomeFor,
 tallyScreenScore,
 type DecidedRunRecord,
 type ReplayCheckOutcome,
} from './replay-set.js'

/**
 * The held-out screen.
 *
 * The tests that matter are about the ways a gate becomes something it must not be: a proxy
 * that rejects on a baseline nobody measured, a set that silently drops what it could not
 * use, and an infrastructure failure that reads as a verdict about a prompt.
 */

const run = (overrides: Partial<DecidedRunRecord> & { runId: string }): DecidedRunRecord => ({
 repositoryId: 'repo-1',
 baseCommitSha: 'commit-1',
 task: 'Do the thing.',
 wasMeasured: false,
 outcome: 'merged',
 decidedAt: new Date(1_000),
...overrides,
})

const tally = (variantId: string | null, outcomes: readonly ReplayCheckOutcome[]) =>
 tallyScreenScore({ variantId, outcomes })

describe('assembleReplaySet', => {
 it('takes the most recent eligible runs, newest first', => {
 const draft = assembleReplaySet([
 run({ runId: 'old', decidedAt: new Date(1_000) }),
 run({ runId: 'new', decidedAt: new Date(3_000) }),
 run({ runId: 'mid', decidedAt: new Date(2_000) }),
 ])
 expect(draft.items.map((item) => item.sourceRunId)).toEqual(['new', 'mid', 'old'])
 })

 it('breaks a tie by run id, so two assemblies of one history agree', => {
 const same = new Date(5_000)
 const first = assembleReplaySet([run({ runId: 'b', decidedAt: same }), run({ runId: 'a', decidedAt: same })])
 const second = assembleReplaySet([run({ runId: 'a', decidedAt: same }), run({ runId: 'b', decidedAt: same })])
 expect(first.items.map((i) => i.sourceRunId)).toEqual(second.items.map((i) => i.sourceRunId))
 })

 it('excludes a run with no commit, and says so rather than replaying it at head', => {
 const draft = assembleReplaySet([run({ runId: 'r1', baseCommitSha: null })])
 expect(draft.items).toHaveLength(0)
 expect(draft.excluded).toEqual([{ runId: 'r1', reason: 'no-commit' }])
 })

 it('excludes a run with no task, and one whose task is only whitespace', => {
 const draft = assembleReplaySet([
 run({ runId: 'r1', task: null }),
 run({ runId: 'r2', task: ' \n ' }),
 ])
 expect(draft.items).toHaveLength(0)
 expect(draft.excluded.map((e) => e.reason)).toEqual(['no-task', 'no-task'])
 })

 it('excludes a run that was itself an arm — a set built from other prompts is held out from nothing', => {
 const draft = assembleReplaySet([run({ runId: 'r1', wasMeasured: true })])
 expect(draft.excluded).toEqual([{ runId: 'r1', reason: 'was-an-arm' }])
 })

 it('checks the arm exclusion before the gaps, so one run is counted once', => {
 const draft = assembleReplaySet([run({ runId: 'r1', wasMeasured: true, baseCommitSha: null })])
 expect(draft.excluded).toHaveLength(1)
 })

 it('reports what the cap left out instead of truncating quietly', => {
 const many = Array.from({ length: MAX_REPLAY_ITEMS + 3 }, (_, index) =>
 run({ runId: `r${index}`, decidedAt: new Date(10_000 - index) }),
)
 const draft = assembleReplaySet(many)
 expect(draft.items).toHaveLength(MAX_REPLAY_ITEMS)
 expect(draft.excluded.filter((e) => e.reason === 'over-cap')).toHaveLength(3)
 // Every offered run is accounted for, as an item or as an exclusion.
 expect(draft.items.length + draft.excluded.length).toBe(many.length)
 expect(draft.eligible).toBe(many.length)
 expect(draft.considered).toBe(many.length)
 })

 it('trims the task, because the replayed instruction is the item', => {
 const draft = assembleReplaySet([run({ runId: 'r1', task: ' Fix the parser.\n' })])
 expect(draft.items[0]?.task).toBe('Fix the parser.')
 })

 it('carries the observed outcome without letting it decide eligibility', => {
 const draft = assembleReplaySet([
 run({ runId: 'a', outcome: 'merged', decidedAt: new Date(3) }),
 run({ runId: 'b', outcome: 'discarded', decidedAt: new Date(2) }),
 run({ runId: 'c', outcome: 'failed', decidedAt: new Date(1) }),
 ])
 expect(draft.items.map((item) => item.observedOutcome)).toEqual(['merged', 'discarded', 'failed'])
 })
})

describe('describeReplaySet', => {
 it('names the counts a reader can check, including every reason', => {
 const detail = describeReplaySet(
 assembleReplaySet([
 run({ runId: 'a', decidedAt: new Date(3) }),
 run({ runId: 'b', outcome: 'discarded', decidedAt: new Date(2) }),
 run({ runId: 'c', wasMeasured: true }),
 run({ runId: 'd', wasMeasured: true }),
 run({ runId: 'e', baseCommitSha: null }),
 ]),
)
 expect(detail).toContain('2 held-out items')
 expect(detail).toContain('1 merged')
 expect(detail).toContain('1 discarded')
 expect(detail).toContain('5 decided runs considered')
 expect(detail).toContain('2 were arms of an earlier measurement')
 expect(detail).toContain('1 did not record the commit they opened at')
 })

 it('says plainly that there is no set, rather than describing an empty one', => {
 expect(describeReplaySet(assembleReplaySet([run({ runId: 'a', task: null })]))).toContain(
 'No held-out items',
)
 })
})

describe('tallyScreenScore', => {
 it('counts only scored items in the rate — an unscored item is not a failure', => {
 const result = tally('v1', ['passed', 'failed', 'not-scored', 'not-scored'])
 expect(result).toMatchObject({ scored: 2, passed: 1, failed: 1, notScored: 2, passRate: 0.5 })
 })

 it('reports a zero rate for nothing scored, which is why callers read `scored` first', => {
 expect(tally('v1', ['not-scored']).passRate).toBe(0)
 })
})

describe('screenGate', => {
 const items = MAX_REPLAY_ITEMS
 const passes = (n: number, of: number): ReplayCheckOutcome[] => [
...Array.from({ length: n }, => 'passed' as const),
...Array.from({ length: of - n }, => 'failed' as const),
 ]

 it('rejects a candidate that is strictly worse than the prompt in use, and says the numbers', => {
 const verdict = screenGate({
 itemCount: items,
 candidate: tally('v1', passes(2, 6)),
 incumbent: tally(null, passes(5, 6)),
 })
 expect(verdict.decision).toBe('rejected')
 expect(verdict.reason).toContain('2 of 6')
 expect(verdict.reason).toContain('5 of 6')
 // The reason is what an archived rejection carries, and what a proposer reads.
 expect(verdict.reason).toContain('no live run was spent on it')
 })

 it('admits a tie, because refusing one would make the proxy the decider', => {
 const verdict = screenGate({
 itemCount: items,
 candidate: tally('v1', passes(4, 6)),
 incumbent: tally(null, passes(4, 6)),
 })
 expect(verdict.decision).toBe('admitted')
 })

 it('admits a better candidate and still says a person settles the search', => {
 const verdict = screenGate({
 itemCount: items,
 candidate: tally('v1', passes(6, 6)),
 incumbent: tally(null, passes(3, 6)),
 })
 expect(verdict.decision).toBe('admitted')
 expect(verdict.reason).toContain('never whether it is promoted')
 })

 it('abstains below the floor rather than gating on a set that is not one', => {
 const verdict = screenGate({
 itemCount: MIN_REPLAY_ITEMS - 1,
 candidate: tally('v1', passes(0, 3)),
 incumbent: tally(null, passes(3, 3)),
 })
 expect(verdict.decision).toBe('admitted')
 expect(verdict.reason).toContain('Not screened')
 })

 it('admits when the control could not be scored — a baseline nobody measured refuses nothing', => {
 const verdict = screenGate({
 itemCount: items,
 candidate: tally('v1', passes(0, 6)),
 incumbent: tally(null, ['not-scored', 'not-scored', 'not-scored', 'not-scored']),
 })
 expect(verdict.decision).toBe('admitted')
 expect(verdict.reason).toContain('no control')
 })

 it('admits when the candidate could not be scored, because that is about the runs', => {
 const verdict = screenGate({
 itemCount: items,
 candidate: tally('v1', ['not-scored', 'not-scored']),
 incumbent: tally(null, passes(6, 6)),
 })
 expect(verdict.decision).toBe('admitted')
 expect(verdict.reason).toContain('not about the prompt')
 })

 it('compares rates and not counts, so a candidate scored on fewer items is judged fairly', => {
 // Four of five beats six of nine. Comparing raw passes would have rejected it.
 const verdict = screenGate({
 itemCount: items,
 candidate: tally('v1', passes(4, 5)),
 incumbent: tally(null, passes(6, 9)),
 })
 expect(verdict.decision).toBe('admitted')
 })

 it('has exactly two decisions — a screen with a third answer would be deciding something else', => {
 const decisions = new Set(
 [
 screenGate({ itemCount: items, candidate: tally('v1', passes(0, 6)), incumbent: tally(null, passes(6, 6)) }),
 screenGate({ itemCount: items, candidate: tally('v1', passes(6, 6)), incumbent: tally(null, passes(0, 6)) }),
 screenGate({ itemCount: 1, candidate: tally('v1', passes(0, 1)), incumbent: tally(null, passes(1, 1)) }),
 ].map((verdict) => verdict.decision),
)
 expect([...decisions].sort).toEqual(['admitted', 'rejected'])
 })
})

describe('screenOutcomeFor', => {
 it('reads the definition of done and nothing else', => {
 expect(screenOutcomeFor({ runStatus: 'completed', verificationStatus: 'passed' })).toEqual({
 outcome: 'passed',
 reason: null,
 })
 expect(screenOutcomeFor({ runStatus: 'completed', verificationStatus: 'failed' })).toEqual({
 outcome: 'failed',
 reason: null,
 })
 })

 it.each(['skipped', 'refused', 'error'] as const)(
 'does not read %s as a failure, because it is a fact about the setup',
 (status) => {
 const result = screenOutcomeFor({ runStatus: 'completed', verificationStatus: status })
 expect(result.outcome).toBe('not-scored')
 expect(result.reason).toContain(status)
 },
)

 it('does not score a branch nothing ran against', => {
 const result = screenOutcomeFor({ runStatus: 'completed', verificationStatus: null })
 expect(result.outcome).toBe('not-scored')
 expect(result.reason).toContain('no definition of done')
 })

 it.each(['failed', 'cancelled'] as const)('does not score a run that %s', (runStatus) => {
 const result = screenOutcomeFor({ runStatus, verificationStatus: 'passed' })
 // A verification verdict on a run that did not finish is about whatever the run
 // happened to leave behind, not about what the prompt would have produced.
 expect(result.outcome).toBe('not-scored')
 expect(result.reason).toContain(runStatus)
 })
})
