import {
 agentRunActor,
 asAgentPersonaId,
 asAgentRunId,
 asPersonaVariantId,
 asPersonaVariantSetId,
 asReplayItemId,
 asReplaySetId,
 asRepositoryId,
 asVariantScreenId,
 asWorkspaceId,
 type AgentRun,
 type ReplayCheckOutcome,
 type ScreenRunOutcome,
} from '@loom/domain'
import { describe, expect, it, vi } from 'vitest'
import { advanceScreenQueue, type AgentDeps } from './agent-use-cases.js'

/**
 * The held-out screen, at the layer where its mistakes are silent.
 *
 * The failure this sweep has to be tested against is not a wrong verdict — it is a screen
 * that never reaches one. `admittedVariantIds` then keeps returning an empty list, the search
 * deals nothing but its incumbent, and every surface reads that as a search that is merely
 * slow. So most of these assert that something *is* written off, and that a write-off admits.
 */

const WS = asWorkspaceId('ws_1')
const SET = asPersonaVariantSetId('set_1')
const REPLAY = asReplaySetId('replay_1')
const PERSONA = asAgentPersonaId('p_1')
const PROPOSER = asAgentRunId('run_proposer')
const CANDIDATE = asPersonaVariantId('variant_1')

const ITEMS = [0, 1, 2, 3].map((index) => ({
 id: asReplayItemId(`item_${index}`),
 replaySetId: REPLAY,
 position: index,
 sourceRunId: null,
 repositoryId: asRepositoryId('repo_1'),
 commitSha: `commit${index}`,
 task: `Task ${index}.`,
 observedOutcome: 'merged' as const,
}))

const PERSONA_MARKDOWN = `---
name: swe
description: A worker.
model: claude-haiku-4-5-20251001
---

The prompt in use.
`

const VARIANT_MARKDOWN = PERSONA_MARKDOWN.replace('The prompt in use.', 'A candidate prompt.')

const screenRun = (
 screenId: string,
 itemIndex: number,
 overrides: Partial<{
 claimedAt: Date | null
 agentRunId: ReturnType<typeof asAgentRunId> | null
 outcome: ScreenRunOutcome
 }> = {},
) => ({
 id: `${screenId}-${itemIndex}`,
 screenId: asVariantScreenId(screenId),
 replayItemId: ITEMS[itemIndex]!.id,
 claimedAt: null,
 agentRunId: null,
 outcome: 'pending' as ScreenRunOutcome,
 reason: null,
 finishedAt: null,
...overrides,
})

const screen = (
 id: string,
 variantId: ReturnType<typeof asPersonaVariantId> | null,
 decision: 'admitted' | 'rejected' | null = null,
) => ({
 id: asVariantScreenId(id),
 workspaceId: WS,
 setId: SET,
 replaySetId: REPLAY,
 variantId,
 decision,
 reason: null as string | null,
 decidedAt: null as Date | null,
 createdAt: new Date(0),
})

const run = (overrides: Partial<AgentRun> = {}): AgentRun =>
 ({
 id: asAgentRunId('run_screen'),
 workspaceId: WS,
 threadId: 'thread_1',
 repositoryId: asRepositoryId('repo_1'),
 status: 'completed',
 persona: { name: 'swe' },
...overrides,
 }) as unknown as AgentRun

const harness = (options: {
 screens: { screen: ReturnType<typeof screen>; runs: ReturnType<typeof screenRun>[] }[]
 verification?: { status: string } | null
 screenRunStatus?: AgentRun['status']
 proposerExists?: boolean
 personaExists?: boolean
 claimSucceeds?: boolean
 startThrows?: boolean
}) => {
 const recordScreenRunOutcome = vi.fn(async => {})
 const decideScreen = vi.fn(async => {})
 const claimScreenRun = vi.fn(async => options.claimSucceeds ?? true)
 const attachScreenRun = vi.fn(async => {})
 const releaseScreenRun = vi.fn(async => {})
 const settleSet = vi.fn(async => null)
 const append = vi.fn(async => ({ id: 'm1' }))

 const deps = {
 audit: { record: vi.fn(async => ({})) },
 messages: { append },
 events: { publish: vi.fn(async => {}) },
 limits: { maxConcurrentRunsPerWorkspace: 6, maxDelegationDepth: 2 },
 screens: {
 listSetsWithOpenScreens: vi.fn(async => [{ workspaceId: WS, setId: SET }]),
 screensForSet: vi.fn(async => options.screens),
 listReplayItems: vi.fn(async => ITEMS),
 claimScreenRun,
 attachScreenRun,
 releaseScreenRun,
 recordScreenRunOutcome,
 decideScreen,
 admittedVariantIds: vi.fn(async => []),
 },
 personaVariants: {
 findSet: vi.fn(async => ({
 set: {
 id: SET,
 personaId: PERSONA,
 proposedByRunId: options.proposerExists === false ? null: PROPOSER,
 status: 'open',
 },
 variants: [
 { id: CANDIDATE, markdownSource: VARIANT_MARKDOWN },
 ],
 })),
 settleSet,
 },
 personas: {
 findById: vi.fn(async =>
 options.personaExists === false
 ? null
: { id: PERSONA, name: 'swe', markdownSource: PERSONA_MARKDOWN },
),
 },
 agentRuns: {
 findById: vi.fn(async (_ws: unknown, id: unknown) =>
 id === PROPOSER
 ? run({ id: PROPOSER, status: 'completed' })
: run({ status: options.screenRunStatus ?? 'completed' }),
),
 },
 runVerifications: {
 listByRuns: vi.fn(async =>
 options.verification === undefined
 ? [{ status: 'passed' }]
: options.verification === null
 ? []
: [options.verification],
),
 },
 } as unknown as AgentDeps

 return { deps, recordScreenRunOutcome, decideScreen, claimScreenRun, releaseScreenRun, settleSet, append }
}

/** The mocks are declared without argument types, so a call is read positionally. */
const callsOf = (mock: ReturnType<typeof vi.fn>): unknown[][] =>
 mock.mock.calls as unknown as unknown[][]

const outcomesOf = (mock: ReturnType<typeof vi.fn>): ReplayCheckOutcome[] =>
 callsOf(mock).map((call) => (call[2] as { outcome: ReplayCheckOutcome }).outcome)

describe('advanceScreenQueue: scoring what finished', => {
 it('scores a finished run from the definition of done and not from the run alone', async => {
 const incumbent = screen('s_inc', null)
 const { deps, recordScreenRunOutcome } = harness({
 screens: [
 {
 screen: incumbent,
 runs: [screenRun('s_inc', 0, { agentRunId: asAgentRunId('r0'), claimedAt: new Date(0) })],
 },
 ],
 verification: { status: 'failed' },
 })
 await advanceScreenQueue(deps, { screenStuckMs: 60_000, maxStartsPerTick: 4 })
 expect(outcomesOf(recordScreenRunOutcome)).toEqual(['failed'])
 })

 it('leaves an item pending while its verification is still pending', async => {
 // Reading a pending verification would score every item unscored the moment its run
 // ended, which is a whole screen thrown away for being early.
 const { deps, recordScreenRunOutcome } = harness({
 screens: [
 {
 screen: screen('s_inc', null),
 runs: [screenRun('s_inc', 0, { agentRunId: asAgentRunId('r0'), claimedAt: new Date })],
 },
 ],
 verification: { status: 'pending' },
 })
 await advanceScreenQueue(deps, { screenStuckMs: 60_000, maxStartsPerTick: 4 })
 expect(recordScreenRunOutcome).not.toHaveBeenCalled
 })

 it('does not score a branch nothing ran against', async => {
 const { deps, recordScreenRunOutcome } = harness({
 screens: [
 {
 screen: screen('s_inc', null),
 runs: [screenRun('s_inc', 0, { agentRunId: asAgentRunId('r0'), claimedAt: new Date(0) })],
 },
 ],
 verification: null,
 })
 await advanceScreenQueue(deps, { screenStuckMs: 60_000, maxStartsPerTick: 4 })
 expect(outcomesOf(recordScreenRunOutcome)).toEqual(['not-scored'])
 })
})

describe('advanceScreenQueue: what stops a screen wedging', => {
 const stale = new Date(Date.now - 10 * 60_000)

 it('writes off a run that has been claimed too long, naming the timeout', async => {
 const { deps, recordScreenRunOutcome } = harness({
 screens: [
 { screen: screen('s_inc', null), runs: [screenRun('s_inc', 0, { claimedAt: stale })] },
 ],
 })
 await advanceScreenQueue(deps, { screenStuckMs: 60_000, maxStartsPerTick: 4 })
 expect(outcomesOf(recordScreenRunOutcome)).toEqual(['not-scored'])
 expect(callsOf(recordScreenRunOutcome)[0]?.[2]).toMatchObject({
 reason: expect.stringContaining('did not finish'),
 })
 })

 it('writes off every item when the run that proposed the search is gone', async => {
 // There is nothing left to hang a screening run off, so the items can never be scored —
 // and a screen that can never decide is one that gates a search forever.
 const { deps, recordScreenRunOutcome } = harness({
 screens: [
 {
 screen: screen('s_inc', null),
 runs: [screenRun('s_inc', 0), screenRun('s_inc', 1)],
 },
 ],
 proposerExists: false,
 })
 await advanceScreenQueue(deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 4 })
 expect(outcomesOf(recordScreenRunOutcome)).toEqual(['not-scored', 'not-scored'])
 })

 it('writes off every item when the persona being searched is gone', async => {
 const { deps, recordScreenRunOutcome } = harness({
 screens: [{ screen: screen('s_inc', null), runs: [screenRun('s_inc', 0)] }],
 personaExists: false,
 })
 await advanceScreenQueue(deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 4 })
 expect(outcomesOf(recordScreenRunOutcome)).toEqual(['not-scored'])
 })
})

describe('advanceScreenQueue: deciding', => {
 const scored = (screenId: string, outcomes: readonly ReplayCheckOutcome[]) =>
 outcomes.map((outcome, index) =>
 screenRun(screenId, index, { outcome, agentRunId: asAgentRunId(`r${index}`) }),
)

 it('decides a candidate against the incumbent screened on the same items', async => {
 const { deps, decideScreen } = harness({
 screens: [
 { screen: screen('s_inc', null), runs: scored('s_inc', ['passed', 'passed', 'passed', 'passed']) },
 { screen: screen('s_cand', CANDIDATE), runs: scored('s_cand', ['failed', 'failed', 'failed', 'failed']) },
 ],
 })
 await advanceScreenQueue(deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 4 })
 expect(decideScreen).toHaveBeenCalledTimes(1)
 expect(callsOf(decideScreen)[0]?.[2]).toMatchObject({ decision: 'rejected' })
 })

 it('does not decide anything until the incumbent has finished', async => {
 // A candidate compared against a half-finished control is compared against an unscored
 // baseline, which `screenGate` admits — early, and for the wrong reason.
 const { deps, decideScreen } = harness({
 screens: [
 {
 screen: screen('s_inc', null),
 runs: [
...scored('s_inc', ['passed']),
 screenRun('s_inc', 1, { agentRunId: asAgentRunId('r1'), claimedAt: new Date }),
 ],
 },
 { screen: screen('s_cand', CANDIDATE), runs: scored('s_cand', ['failed', 'failed', 'failed', 'failed']) },
 ],
 verification: { status: 'pending' },
 })
 await advanceScreenQueue(deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 4 })
 expect(decideScreen).not.toHaveBeenCalled
 })

 it('does not decide a candidate whose own items are still reporting', async => {
 const { deps, decideScreen } = harness({
 screens: [
 { screen: screen('s_inc', null), runs: scored('s_inc', ['passed', 'passed', 'passed', 'passed']) },
 {
 screen: screen('s_cand', CANDIDATE),
 runs: [
...scored('s_cand', ['failed']),
 screenRun('s_cand', 1, { agentRunId: asAgentRunId('r9'), claimedAt: new Date }),
 ],
 },
 ],
 verification: { status: 'pending' },
 })
 await advanceScreenQueue(deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 4 })
 expect(decideScreen).not.toHaveBeenCalled
 })

 it('closes a search in which the screen rejected everything, releasing the slot', async => {
 const rejected = screen('s_cand', CANDIDATE, 'rejected')
 const { deps, settleSet } = harness({
 screens: [
 { screen: screen('s_inc', null), runs: scored('s_inc', ['passed', 'passed', 'passed', 'passed']) },
 { screen: rejected, runs: scored('s_cand', ['failed', 'failed', 'failed', 'failed']) },
 ],
 })
 await advanceScreenQueue(deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 4 })
 expect(settleSet).toHaveBeenCalledWith(WS, SET, { promotedVariantId: null })
 })

 it('does not close a search in which something was admitted — a human settles that one', async => {
 const admitted = screen('s_cand', CANDIDATE, 'admitted')
 const { deps, settleSet } = harness({
 screens: [
 { screen: screen('s_inc', null), runs: scored('s_inc', ['passed', 'passed', 'passed', 'passed']) },
 { screen: admitted, runs: scored('s_cand', ['passed', 'passed', 'passed', 'passed']) },
 ],
 })
 await advanceScreenQueue(deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 4 })
 expect(settleSet).not.toHaveBeenCalled
 })
})

describe('advanceScreenQueue: starting', => {
 it('claims before starting, so two sweeps cannot both run one item', async => {
 const { deps, claimScreenRun } = harness({
 screens: [{ screen: screen('s_inc', null), runs: [screenRun('s_inc', 0)] }],
 claimSucceeds: false,
 })
 await advanceScreenQueue(deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 4 })
 expect(claimScreenRun).toHaveBeenCalledTimes(1)
 })

 it('releases a claim it could not start, rather than scoring the item', async => {
 // The ordinary cause is the workspace concurrency limit, and "not tried yet" is not a
 // verdict about a prompt. `startAgentRun` throws here because the stub deps have no
 // repository, which is the same shape of failure.
 const { deps, releaseScreenRun, recordScreenRunOutcome } = harness({
 screens: [{ screen: screen('s_inc', null), runs: [screenRun('s_inc', 0)] }],
 })
 await advanceScreenQueue(deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 4 })
 expect(releaseScreenRun).toHaveBeenCalledTimes(1)
 expect(recordScreenRunOutcome).not.toHaveBeenCalled
 })

 it('honours the per-tick start budget across a whole search', async => {
 const { deps, claimScreenRun } = harness({
 screens: [
 { screen: screen('s_inc', null), runs: [0, 1, 2, 3].map((i) => screenRun('s_inc', i)) },
 ],
 })
 await advanceScreenQueue(deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 2 })
 expect(callsOf(claimScreenRun).length).toBeLessThanOrEqual(2)
 })
})
