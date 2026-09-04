import {
  asAgentPersonaId,
  asReplayCampaignArmId,
  asReplayCampaignId,
  asReplayItemId,
  asReplaySetId,
  asRepositoryId,
  asUserId,
  asWorkspaceId,
  userActor,
  type ReplayCampaignId,
  type ScreenRunOutcome,
} from '@loom/domain'
import { describe, expect, it, vi } from 'vitest'
import { campaignReport, modelGapCurveFor, openReplayCampaign, type AgentDeps } from './agent-use-cases.js'

/**
 * The gap a campaign measures, where the report and the curve read it, and the set reuse that
 * makes two gaps comparable at all.
 *
 * The sweep's own behaviour is `campaign-queue.test.ts`; everything here is about the reading
 * side, and every test is a way the number could mislead: a gap where the document moved, a
 * closure across two different item sets, and a set borrowed from another persona.
 */

const WS = asWorkspaceId('ws_1')
const PERSONA = asAgentPersonaId('p_1')
const OTHER_PERSONA = asAgentPersonaId('p_2')
const SET = asReplaySetId('set_1')
const ACTOR = userActor(asUserId('user_1'))

const MARKDOWN = `---
name: swe
description: A worker.
model: claude-haiku-4-5-20251001
---

The document in use.
`

const SMALL = 'local/qwen2.5-coder-32b'

const items = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: asReplayItemId(`item_${index}`),
    replaySetId: SET,
    position: index,
    sourceRunId: null,
    repositoryId: asRepositoryId('repo_1'),
    commitSha: `commit${index}`,
    task: `Task ${index}.`,
    observedOutcome: 'merged' as const,
  }))

const arm = (input: {
  id: string
  model: string | null
  revisionId: string | null
  markdownSource?: string
  outcomes: readonly ScreenRunOutcome[]
  answeredBy: string | null
}) => ({
  arm: {
    id: asReplayCampaignArmId(input.id),
    campaignId: asReplayCampaignId('camp_1'),
    position: 0,
    revisionId: input.revisionId,
    markdownSource: input.markdownSource ?? MARKDOWN,
    label: input.model === null ? 'the document in use' : `the document in use on ${input.model}`,
    model: input.model,
  },
  runs: input.outcomes.map((outcome, index) => ({
    id: `${input.id}_run_${index}`,
    armId: asReplayCampaignArmId(input.id),
    replayItemId: asReplayItemId(`item_${index}`),
    claimedAt: null,
    agentRunId: null,
    outcome,
    reason: null,
    model: outcome === 'passed' || outcome === 'failed' ? input.answeredBy : null,
    costUsd: 0.1,
    finishedAt: null,
  })),
})

const campaign = (over: {
  id: string
  status?: 'running' | 'finished' | 'halted'
  replaySetId?: string
  createdAt?: Date
}) => ({
  id: asReplayCampaignId(over.id),
  workspaceId: WS,
  personaId: PERSONA,
  replaySetId: asReplaySetId(over.replaySetId ?? 'set_1'),
  label: over.id,
  status: over.status ?? 'finished',
  capUsd: 5,
  openedByUserId: 'user_1',
  haltReason: null,
  createdAt: over.createdAt ?? new Date('2026-09-01T00:00:00Z'),
  finishedAt: null,
})

/** The control on its own model, and the same document forced onto a small one. */
const gapArms = () => [
  arm({
    id: 'arm_control',
    model: null,
    revisionId: null,
    outcomes: ['passed', 'passed', 'passed', 'passed', 'failed', 'failed'],
    answeredBy: 'claude-haiku-4-5-20251001',
  }),
  arm({
    id: 'arm_small',
    model: SMALL,
    revisionId: null,
    outcomes: ['passed', 'failed', 'failed', 'failed', 'failed', 'failed'],
    answeredBy: SMALL,
  }),
]

const readingDeps = (options: {
  campaigns: ReturnType<typeof campaign>[]
  armsByCampaign: Record<string, ReturnType<typeof arm>[]>
}) =>
  ({
    campaigns: {
      findById: vi.fn(async (_ws: unknown, id: ReplayCampaignId) =>
        options.campaigns.find((entry) => (entry.id as string) === (id as string)) ?? null,
      ),
      listByPersona: vi.fn(async () => options.campaigns),
      armsForCampaign: vi.fn(async (_ws: unknown, id: ReplayCampaignId) =>
        options.armsByCampaign[id as string] ?? [],
      ),
      armsForCampaigns: vi.fn(async () =>
        Object.entries(options.armsByCampaign).flatMap(([id, arms]) =>
          arms.map((entry) => ({ campaignId: asReplayCampaignId(id), ...entry })),
        ),
      ),
      spentOnCampaign: vi.fn(async () => 1.2),
    },
    screens: { listReplayItems: vi.fn(async () => items(6)) },
  }) as unknown as AgentDeps

describe('campaignReport', () => {
  it('reports the gap when a campaign ran one document on two models', async () => {
    const deps = readingDeps({
      campaigns: [campaign({ id: 'camp_1' })],
      armsByCampaign: { camp_1: gapArms() },
    })
    const report = await campaignReport(deps, { workspaceId: WS, campaignId: asReplayCampaignId('camp_1') })
    expect(report?.gap?.report.gaps).toHaveLength(1)
    expect(report?.gap?.report.gaps[0]).toMatchObject({ subjectPassed: 1, referencePassed: 4, gapPoints: 50 })
    expect(report?.gap?.detail).toContain('not a closure')
  })

  it('reports no gap at all for a vintage campaign — there is nothing to be a gap of', async () => {
    const deps = readingDeps({
      campaigns: [campaign({ id: 'camp_1' })],
      armsByCampaign: {
        camp_1: [
          arm({
            id: 'arm_control',
            model: null,
            revisionId: null,
            outcomes: ['passed', 'failed'],
            answeredBy: 'claude-haiku-4-5-20251001',
          }),
          arm({
            id: 'arm_vintage',
            model: null,
            revisionId: 'rev_1',
            markdownSource: 'AN OLDER DOCUMENT',
            outcomes: ['failed', 'failed'],
            answeredBy: 'claude-haiku-4-5-20251001',
          }),
        ],
      },
    })
    const report = await campaignReport(deps, { workspaceId: WS, campaignId: asReplayCampaignId('camp_1') })
    expect(report?.gap).toBeNull()
    // The campaign's own paragraph still refuses a growth figure, which is the other half.
    expect(report?.detail).toContain('it does not report growth')
  })
})

describe('modelGapCurveFor', () => {
  it('joins two campaigns over the same set into one closure figure', async () => {
    const later = gapArms()
    // The later generation loses one fewer item: 3 of 6 against the control's 4.
    later[1] = arm({
      id: 'arm_small',
      model: SMALL,
      revisionId: null,
      outcomes: ['passed', 'passed', 'passed', 'failed', 'failed', 'failed'],
      answeredBy: SMALL,
    })
    const deps = readingDeps({
      campaigns: [
        campaign({ id: 'camp_2', createdAt: new Date('2026-10-01T00:00:00Z') }),
        campaign({ id: 'camp_1' }),
      ],
      armsByCampaign: { camp_1: gapArms(), camp_2: later },
    })
    const curve = await modelGapCurveFor(deps, { workspaceId: WS, personaId: PERSONA })
    expect(curve.points).toHaveLength(2)
    expect(curve.detail).toContain('closed by 33 points')
  })

  it('never subtracts gaps measured on different sets', async () => {
    const deps = readingDeps({
      campaigns: [
        campaign({ id: 'camp_2', replaySetId: 'set_2', createdAt: new Date('2026-10-01T00:00:00Z') }),
        campaign({ id: 'camp_1' }),
      ],
      armsByCampaign: { camp_1: gapArms(), camp_2: gapArms() },
    })
    const curve = await modelGapCurveFor(deps, { workspaceId: WS, personaId: PERSONA })
    expect(curve.detail).not.toContain('closed by')
    expect(curve.detail).toContain('a separate reading')
  })

  it('says what a baseline is when the persona has no campaign at all', async () => {
    const deps = readingDeps({ campaigns: [], armsByCampaign: {} })
    const curve = await modelGapCurveFor(deps, { workspaceId: WS, personaId: PERSONA })
    expect(curve.points).toHaveLength(0)
    expect(curve.detail).toContain('baseline')
  })
})

describe('openReplayCampaign, replaying an existing set', () => {
  const openDeps = (options: { setPersonaId?: typeof PERSONA; itemCount?: number } = {}) => {
    const openReplaySet = vi.fn(async () => ({ set: { id: SET }, items: items(6) }))
    /** The parameter is declared, or `mock.calls[0][0]` has type `never` and cannot be read. */
    const open = vi.fn(async (input: { itemIds: readonly unknown[] }) => {
      void input
      return { campaign: campaign({ id: 'camp_new', status: 'running' }), arms: [] }
    })
    const deps = {
      personas: {
        findById: vi.fn(async () => ({ id: PERSONA, name: 'swe', markdownSource: MARKDOWN })),
        listRevisions: vi.fn(async () => []),
      },
      campaigns: { listByPersona: vi.fn(async () => []), open },
      screens: {
        findReplaySet: vi.fn(async () => ({
          id: SET,
          workspaceId: WS,
          personaId: options.setPersonaId ?? PERSONA,
          version: 3,
          considered: 40,
          eligible: 12,
          detail: '6 held-out items (5 merged, 1 discarded), from 40 decided runs considered.',
          createdAt: new Date(0),
        })),
        listReplayItems: vi.fn(async () => items(options.itemCount ?? 6)),
        listDecidedRunsForPersona: vi.fn(async () => []),
        openReplaySet,
      },
      audit: { record: vi.fn(async () => ({})) },
    } as unknown as AgentDeps
    return { deps, openReplaySet, open }
  }

  it('replays the given set and assembles nothing — the items are the point', async () => {
    const { deps, openReplaySet, open } = openDeps()
    const result = await openReplayCampaign(deps, {
      workspaceId: WS,
      actor: ACTOR,
      personaId: PERSONA,
      label: 'generation 1',
      capUsd: 5,
      revisionIds: [],
      models: [SMALL],
      replaySetId: SET,
    })
    expect(result.ok).toBe(true)
    expect(openReplaySet).not.toHaveBeenCalled()
    expect(open.mock.calls[0]?.[0].itemIds).toHaveLength(6)
    if (!result.ok) return
    expect(result.detail).toContain('same items at the same commits')
  })

  /**
   * Without the field it assembles from history, and reaching for an existing set is never a
   * fallback for having none: this persona's history is empty here, so the campaign is refused
   * rather than quietly measuring somebody else's items.
   */
  it('assembles from history when no set is named, and refuses when there is none', async () => {
    const { deps, openReplaySet, open } = openDeps()
    const result = await openReplayCampaign(deps, {
      workspaceId: WS,
      actor: ACTOR,
      personaId: PERSONA,
      label: 'baseline',
      capUsd: 5,
      revisionIds: [],
    })
    expect(result.ok).toBe(false)
    expect(openReplaySet).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    if (result.ok) return
    expect(result.reason).toContain('not enough of this persona')
  })

  it('refuses a set belonging to another persona', async () => {
    const { deps } = openDeps({ setPersonaId: OTHER_PERSONA })
    const result = await openReplayCampaign(deps, {
      workspaceId: WS,
      actor: ACTOR,
      personaId: PERSONA,
      label: 'borrowed',
      capUsd: 5,
      revisionIds: [],
      replaySetId: SET,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('another persona')
  })

  it('refuses a set too small to measure anything', async () => {
    const { deps } = openDeps({ itemCount: 2 })
    const result = await openReplayCampaign(deps, {
      workspaceId: WS,
      actor: ACTOR,
      personaId: PERSONA,
      label: 'thin',
      capUsd: 5,
      revisionIds: [],
      replaySetId: SET,
    })
    expect(result.ok).toBe(false)
  })
})
