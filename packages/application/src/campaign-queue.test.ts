import {
  asAgentPersonaId,
  asAgentRunId,
  asReplayCampaignArmId,
  asReplayCampaignId,
  asReplayItemId,
  asReplaySetId,
  asRepositoryId,
  asWorkspaceId,
  type AgentRun,
  type ScreenRunOutcome,
} from '@loom/domain'
import { describe, expect, it, vi } from 'vitest'
import { advanceCampaignQueue, campaignReport, type AgentDeps } from './agent-use-cases.js'

/**
 * The campaign sweep.
 *
 * A campaign spends real money on measuring the platform's own behaviour, so the tests that
 * matter are the ones about spending: that the cap halts it, that a halt is recorded as a
 * halt rather than as a finish, that a run nobody can start is given back rather than scored,
 * and that a score carries the model and the cost that produced it.
 */

const WS = asWorkspaceId('ws_1')
const CAMPAIGN = asReplayCampaignId('camp_1')
const ARM = asReplayCampaignArmId('arm_1')
const PERSONA = asAgentPersonaId('p_1')
const REPLAY = asReplaySetId('replay_1')

const PERSONA_MARKDOWN = `---
name: swe
description: A worker.
model: claude-haiku-4-5-20251001
---

The document in use.
`

const ITEMS = [0, 1].map((index) => ({
  id: asReplayItemId(`item_${index}`),
  replaySetId: REPLAY,
  position: index,
  sourceRunId: null,
  repositoryId: asRepositoryId('repo_1'),
  commitSha: `commit${index}`,
  task: `Task ${index}.`,
  observedOutcome: 'merged' as const,
}))

const campaignRun = (
  index: number,
  over: Partial<{
    claimedAt: Date | null
    agentRunId: ReturnType<typeof asAgentRunId> | null
    outcome: ScreenRunOutcome
  }> = {},
) => ({
  id: `run_${index}`,
  armId: ARM,
  replayItemId: ITEMS[index]!.id,
  claimedAt: null,
  agentRunId: null,
  outcome: 'pending' as ScreenRunOutcome,
  reason: null,
  model: null,
  costUsd: null,
  finishedAt: null,
  ...over,
})

const run = (over: Partial<AgentRun> = {}): AgentRun =>
  ({
    id: asAgentRunId('run_campaign'),
    workspaceId: WS,
    threadId: 'thread_1',
    repositoryId: asRepositoryId('repo_1'),
    status: 'completed',
    totalCostUsd: 0.42,
    persona: { name: 'swe', model: 'claude-haiku-4-5-20251001' },
    ...over,
  }) as unknown as AgentRun

const harness = (options: {
  runs: ReturnType<typeof campaignRun>[]
  capUsd?: number | null
  spentUsd?: number
  status?: 'running' | 'halted'
  personaExists?: boolean
  claimSucceeds?: boolean
  verification?: { status: string } | null
}) => {
  const recordCampaignRunOutcome = vi.fn(async () => {})
  const close = vi.fn(async () => null)
  const claimCampaignRun = vi.fn(async () => options.claimSucceeds ?? true)
  const releaseCampaignRun = vi.fn(async () => {})
  const attachCampaignRun = vi.fn(async () => {})

  const campaign = {
    id: CAMPAIGN,
    workspaceId: WS,
    personaId: PERSONA,
    replaySetId: REPLAY,
    label: 'growth, august',
    status: options.status ?? 'running',
    capUsd: options.capUsd === undefined ? 5 : options.capUsd,
    openedByUserId: 'user_1',
    haltReason: null,
    createdAt: new Date(0),
    finishedAt: null,
  }

  const deps = {
    audit: { record: vi.fn(async () => ({})) },
    messages: { append: vi.fn(async () => ({ id: 'm1' })) },
    events: { publish: vi.fn(async () => {}) },
    limits: { maxConcurrentRunsPerWorkspace: 6, maxDelegationDepth: 2 },
    campaigns: {
      listRunning: vi.fn(async () => [{ workspaceId: WS, campaignId: CAMPAIGN }]),
      findById: vi.fn(async () => campaign),
      armsForCampaign: vi.fn(async () => [
        {
          arm: {
            id: ARM,
            campaignId: CAMPAIGN,
            position: 0,
            revisionId: null,
            markdownSource: PERSONA_MARKDOWN,
            label: 'the document in use',
            model: null,
          },
          runs: options.runs,
        },
      ]),
      spentOnCampaign: vi.fn(async () => options.spentUsd ?? 0),
      claimCampaignRun,
      attachCampaignRun,
      releaseCampaignRun,
      recordCampaignRunOutcome,
      close,
    },
    screens: {
      listReplayItems: vi.fn(async () => ITEMS),
      listDecidedRunsForPersona: vi.fn(async () => [
        { runId: 'run_source', repositoryId: 'repo_1' },
      ]),
    },
    personas: {
      findById: vi.fn(async () =>
        options.personaExists === false
          ? null
          : { id: PERSONA, name: 'swe', markdownSource: PERSONA_MARKDOWN },
      ),
    },
    agentRuns: {
      findById: vi.fn(async () => run()),
    },
    runVerifications: {
      listByRuns: vi.fn(async () =>
        options.verification === undefined
          ? [{ status: 'passed' }]
          : options.verification === null
            ? []
            : [options.verification],
      ),
    },
  } as unknown as AgentDeps

  return { deps, recordCampaignRunOutcome, close, claimCampaignRun, releaseCampaignRun, campaign }
}

const callsOf = (mock: ReturnType<typeof vi.fn>): unknown[][] =>
  mock.mock.calls as unknown as unknown[][]

describe('advanceCampaignQueue', () => {
  it('scores a finished run with the model that answered and what it cost', async () => {
    const { deps, recordCampaignRunOutcome } = harness({
      runs: [campaignRun(0, { agentRunId: asAgentRunId('r0'), claimedAt: new Date(0) })],
    })
    await advanceCampaignQueue(deps, { campaignStuckMs: 60_000, maxStartsPerTick: 1 })
    expect(callsOf(recordCampaignRunOutcome)[0]?.[2]).toMatchObject({
      outcome: 'passed',
      model: 'claude-haiku-4-5-20251001',
      costUsd: 0.42,
    })
  })

  it('halts on the cap rather than starting another run', async () => {
    const { deps, close, claimCampaignRun } = harness({
      runs: [campaignRun(0), campaignRun(1)],
      capUsd: 5,
      spentUsd: 5,
    })
    await advanceCampaignQueue(deps, { campaignStuckMs: 60_000, maxStartsPerTick: 4 })
    expect(claimCampaignRun).not.toHaveBeenCalled()
    expect(callsOf(close)[0]?.[2]).toMatchObject({
      status: 'halted',
      reason: expect.stringContaining('cap of $5.00'),
    })
  })

  it('gives a claim back when the run could not be started', async () => {
    // No `runControl` in this harness, so `startAgentRun` throws — which is the point: a
    // start that failed is not a measurement, and the row must be released rather than scored.
    const { deps, claimCampaignRun, releaseCampaignRun, recordCampaignRunOutcome } = harness({
      runs: [campaignRun(0)],
      spentUsd: 0,
    })
    await advanceCampaignQueue(deps, { campaignStuckMs: 60_000, maxStartsPerTick: 1 })
    expect(claimCampaignRun).toHaveBeenCalledTimes(1)
    expect(releaseCampaignRun).toHaveBeenCalledTimes(1)
    expect(recordCampaignRunOutcome).not.toHaveBeenCalled()
  })

  it('writes off a run claimed too long, naming the timeout', async () => {
    const stale = new Date(Date.now() - 10 * 60_000)
    const { deps, recordCampaignRunOutcome } = harness({
      runs: [campaignRun(0, { claimedAt: stale })],
    })
    await advanceCampaignQueue(deps, { campaignStuckMs: 60_000, maxStartsPerTick: 1 })
    expect(callsOf(recordCampaignRunOutcome)[0]?.[2]).toMatchObject({
      outcome: 'not-scored',
      reason: expect.stringContaining('did not finish'),
      costUsd: null,
    })
  })

  it('writes off every item when the persona being measured is gone', async () => {
    const { deps, recordCampaignRunOutcome } = harness({
      runs: [campaignRun(0), campaignRun(1)],
      personaExists: false,
    })
    await advanceCampaignQueue(deps, { campaignStuckMs: 3_600_000, maxStartsPerTick: 2 })
    expect(recordCampaignRunOutcome).toHaveBeenCalledTimes(2)
  })

  it('closes as finished — not halted — once every row has reported', async () => {
    const { deps, close } = harness({
      runs: [
        campaignRun(0, { outcome: 'passed', agentRunId: asAgentRunId('r0') }),
        campaignRun(1, { outcome: 'failed', agentRunId: asAgentRunId('r1') }),
      ],
    })
    await advanceCampaignQueue(deps, { campaignStuckMs: 60_000, maxStartsPerTick: 1 })
    expect(callsOf(close)[0]?.[2]).toMatchObject({ status: 'finished', reason: null })
  })

  it('does nothing to a campaign that is no longer running', async () => {
    const { deps, recordCampaignRunOutcome, close } = harness({
      runs: [campaignRun(0)],
      status: 'halted',
    })
    await advanceCampaignQueue(deps, { campaignStuckMs: 60_000, maxStartsPerTick: 1 })
    expect(recordCampaignRunOutcome).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })
})

describe('campaignReport', () => {
  it('reports a halted campaign as partial, with the spend beside the score', async () => {
    const { deps } = harness({
      runs: [
        campaignRun(0, { outcome: 'passed', agentRunId: asAgentRunId('r0') }),
        campaignRun(1, { outcome: 'pending' }),
      ],
      status: 'halted',
      spentUsd: 5.5,
    })
    const found = await campaignReport(deps, { workspaceId: WS, campaignId: CAMPAIGN })
    expect(found?.spentUsd).toBe(5.5)
    expect(found?.detail).toContain('**Partial.**')
    expect(found?.arms[0]).toMatchObject({ passed: 1, scored: 1, pending: 1 })
  })
})
