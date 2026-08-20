import { describe, expect, it } from 'vitest'
import {
  campaignMayStart,
  describeCampaign,
  type CampaignArmTally,
  type CampaignStatus,
} from './replay-campaign.js'

/**
 * The campaign's reporting rules.
 *
 * Every test here is about the same failure: a number that reads better than the evidence
 * behind it. A partial score that looks whole, a growth figure nothing supports, and a
 * cross-model difference reported as a difference of document.
 */

const arm = (over: Partial<CampaignArmTally> & { armId: string }): CampaignArmTally => ({
  label: over.armId,
  revisionId: null,
  scored: 8,
  passed: 4,
  failed: 4,
  notScored: 0,
  pending: 0,
  passRate: 0.5,
  models: ['claude-sonnet-5'],
  ...over,
})

const report = (
  status: CampaignStatus,
  arms: readonly CampaignArmTally[],
  haltReason: string | null = null,
) =>
  describeCampaign({
    status,
    arms,
    composition: ['merged', 'merged', 'merged', 'discarded', 'discarded', 'failed', 'merged', 'merged'],
    haltReason,
  })

describe('campaignMayStart', () => {
  it('allows a start while there is budget', () => {
    expect(campaignMayStart({ capUsd: 5, spentUsd: 4.99 }).ok).toBe(true)
  })

  it('refuses once the cap is reached, and says the score is partial', () => {
    const verdict = campaignMayStart({ capUsd: 5, spentUsd: 5 })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reason).toContain('$5.00')
    expect(verdict.reason).toContain('partial')
  })

  it('allows everything when a workspace declined to set a cap', () => {
    expect(campaignMayStart({ capUsd: null, spentUsd: 10_000 }).ok).toBe(true)
  })
})

describe('describeCampaign', () => {
  it('leads with partial for a halted campaign, so a rate cannot read as complete', () => {
    const detail = report(
      'halted',
      [arm({ armId: 'control' }), arm({ armId: 'old', revisionId: 'rev_1', scored: 3, passed: 1, passRate: 1 / 3 })],
      'The cap of $5.00 is reached.',
    )
    expect(detail.startsWith('**Partial.**')).toBe(true)
    expect(detail).toContain('The cap of $5.00 is reached.')
    expect(detail).toContain('over the items that were actually scored')
  })

  it('describes a difference and never reports growth', () => {
    const detail = report('finished', [
      arm({ armId: 'control', label: 'the document in use', passed: 6, passRate: 0.75 }),
      arm({ armId: 'old', label: 'vintage of 2026-01-04', revisionId: 'rev_1', passed: 2, passRate: 0.25 }),
    ])
    expect(detail).toContain('25% against 75%, behind the control')
    expect(detail).toContain('it does not report growth')
  })

  it('says a cross-model comparison is one, rather than reporting it as a document difference', () => {
    const detail = report('finished', [
      arm({ armId: 'control', label: 'the document in use', models: ['claude-opus-5'] }),
      arm({
        armId: 'small',
        label: 'the document in use on claude-haiku-4-5-20251001',
        passed: 2,
        passRate: 0.25,
        models: ['claude-haiku-4-5-20251001'],
      }),
    ])
    expect(detail).toContain('difference of model as much as of document')
  })

  it('refuses to compare an arm that produced no verdict at all', () => {
    const detail = report('finished', [
      arm({ armId: 'control' }),
      arm({ armId: 'broken', revisionId: 'rev_1', scored: 0, passed: 0, failed: 0, notScored: 8, passRate: 0 }),
    ])
    expect(detail).toContain('not comparable')
  })

  it('names the set it was measured on, because a pass rate is unreadable without it', () => {
    expect(report('finished', [arm({ armId: 'control' })])).toContain(
      '5 merged, 2 discarded, 1 failed',
    )
  })

  it('says how much is left while it is still running', () => {
    const detail = report('running', [arm({ armId: 'control', pending: 3 })])
    expect(detail).toContain('Still running: 3 of 8 runs have not reported')
  })
})
