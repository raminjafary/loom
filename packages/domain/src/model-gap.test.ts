import { describe, expect, it } from 'vitest'
import {
  describeGapCurve,
  describeModelGap,
  readModelGap,
  type GapArm,
  type GapPoint,
} from './model-gap.js'

/**
 * The gap's rules, and every test here is a way this number could lie: a difference taken
 * between two arms that answered different items, a model read off an override rather than
 * off what answered, a document that moved underneath a "same document" claim, and one
 * campaign's point read as closure.
 */

const SMALL = 'local/qwen2.5-coder-32b'
const BIG = 'claude-sonnet-5'

const items = (
  outcomes: readonly ('passed' | 'failed' | 'not-scored' | 'pending')[],
  model: string | null,
  offset = 0,
) =>
  outcomes.map((outcome, index) => ({
    itemId: `item-${index + offset}`,
    outcome,
    model: outcome === 'passed' || outcome === 'failed' ? model : null,
  }))

const control = (over: Partial<GapArm> = {}): GapArm => ({
  armId: 'control',
  label: 'the document in use',
  declaredModel: null,
  revisionId: null,
  markdownSource: 'THE DOCUMENT',
  items: items(['passed', 'passed', 'passed', 'passed', 'failed', 'failed'], BIG),
  ...over,
})

const subject = (over: Partial<GapArm> = {}): GapArm => ({
  armId: 'subject',
  label: `the document in use on ${SMALL}`,
  declaredModel: SMALL,
  revisionId: null,
  markdownSource: 'THE DOCUMENT',
  items: items(['passed', 'failed', 'failed', 'failed', 'failed', 'failed'], SMALL),
  ...over,
})

describe('readModelGap', () => {
  it('is null for a vintage campaign, which has no gap to report', () => {
    expect(
      readModelGap({
        status: 'finished',
        arms: [control(), { ...control(), armId: 'vintage', revisionId: 'rev-1' }],
      }),
    ).toBeNull()
  })

  it('pairs the same document on two models, and reports the gap in points', () => {
    const report = readModelGap({ status: 'finished', arms: [control(), subject()] })!
    expect(report.gaps).toHaveLength(1)
    const [gap] = report.gaps
    expect(gap).toMatchObject({
      subjectModel: SMALL,
      referenceModel: BIG,
      sharedItems: 6,
      subjectPassed: 1,
      referencePassed: 4,
      gapPoints: 50,
      unpairedItems: 0,
    })
  })

  it('takes the difference over the items both arms scored, not over each arm’s own set', () => {
    /**
     * The halted campaign's shape, and the reason the pairing is per item: the control reached
     * six verdicts and the subject three, and the subject's three are its *best* three. Raw
     * rates would read 4/6 against 2/3 — a gap of 0 — when over the items both actually
     * answered it is 2/3 against 2/3 on three items and the other three are not evidence
     * about the subject at all.
     */
    const report = readModelGap({
      status: 'halted',
      arms: [
        control(),
        subject({ items: items(['passed', 'passed', 'failed', 'pending', 'pending', 'pending'], SMALL) }),
      ],
    })!
    const [gap] = report.gaps
    expect(gap).toMatchObject({ sharedItems: 3, referencePassed: 3, subjectPassed: 2, unpairedItems: 3 })
    expect(report.partial).toBe(true)
  })

  it('refuses to pair arms that scored no item in common', () => {
    const report = readModelGap({
      status: 'finished',
      arms: [
        control({ items: items(['passed', 'failed'], BIG) }),
        subject({ items: items(['passed', 'failed'], SMALL, 100) }),
      ],
    })!
    expect(report.gaps).toHaveLength(0)
    expect(report.notes.join(' ')).toContain('no item in common')
  })

  it('reads the model from the rows, and refuses an arm answered by two of them', () => {
    const report = readModelGap({
      status: 'finished',
      arms: [
        control(),
        subject({
          items: [
            { itemId: 'item-0', outcome: 'passed', model: SMALL },
            { itemId: 'item-1', outcome: 'failed', model: 'local/other-model' },
          ],
        }),
      ],
    })!
    expect(report.gaps).toHaveLength(0)
    expect(report.notes.join(' ')).toContain('more than one model')
  })

  it('refuses an arm whose document is not the control’s, override or not', () => {
    const report = readModelGap({
      status: 'finished',
      arms: [control(), subject({ markdownSource: 'A DIFFERENT DOCUMENT' })],
    })!
    expect(report.gaps).toHaveLength(0)
    expect(report.notes.join(' ')).toContain('difference of document')
  })

  it('says so when the override changed nothing — the rows answered on the same model', () => {
    const report = readModelGap({
      status: 'finished',
      arms: [control(), subject({ items: items(['passed', 'failed'], BIG) })],
    })!
    expect(report.gaps).toHaveLength(0)
    expect(report.notes.join(' ')).toContain('the override changed nothing')
  })

  it('reports a reason rather than nothing when a gap was asked for and none exists', () => {
    const report = readModelGap({
      status: 'running',
      arms: [subject({ items: items(['pending', 'pending'], null) })],
    })!
    expect(report.gaps).toHaveLength(0)
    expect(report.notes).not.toHaveLength(0)
  })
})

describe('describeModelGap', () => {
  const sentence = (arms: readonly GapArm[], status: 'finished' | 'halted' = 'finished') =>
    describeModelGap(readModelGap({ status, arms })!)

  it('names both counts, the points, and that a gap is not a closure', () => {
    const detail = sentence([control(), subject()])
    expect(detail).toContain(`${SMALL} passed 1`)
    expect(detail).toContain(`${BIG} passed 4`)
    expect(detail).toContain('+50 points')
    expect(detail).toContain('not a closure')
  })

  it('leads with Partial. when the campaign stopped early', () => {
    expect(sentence([control(), subject()], 'halted').startsWith('**Partial.**')).toBe(true)
  })

  it('does not assume the frontier model wins', () => {
    const detail = sentence([
      control({ items: items(['failed', 'failed', 'passed'], BIG) }),
      subject({ items: items(['passed', 'passed', 'passed'], SMALL) }),
    ])
    expect(detail).toContain(`${SMALL} is **ahead**`)
    expect(detail).toContain('no gap to close in the expected direction')
  })

  it('explains the dropped verdicts rather than letting the counts disagree in silence', () => {
    const detail = sentence(
      [control(), subject({ items: items(['passed', 'failed', 'failed'], SMALL) })],
      'halted',
    )
    expect(detail).toContain('left out because only one of the two arms reached it')
  })
})

describe('describeGapCurve', () => {
  const point = (over: Partial<GapPoint> & { campaignId: string }): GapPoint => ({
    campaignLabel: over.campaignId,
    openedAt: new Date('2026-09-01T00:00:00Z'),
    replaySetId: 'set-1',
    subjectModel: SMALL,
    referenceModel: BIG,
    gapPoints: 50,
    sharedItems: 6,
    partial: false,
    ...over,
  })

  it('says what a baseline is when there is nothing yet', () => {
    expect(describeGapCurve([])).toContain('baseline')
  })

  it('gives no closure figure for a single campaign', () => {
    const detail = describeGapCurve([point({ campaignId: 'baseline' })])
    expect(detail).toContain('No closure figure yet')
  })

  it('closes the gap across two campaigns over the same set and model pair', () => {
    const detail = describeGapCurve([
      point({ campaignId: 'baseline', gapPoints: 50 }),
      point({
        campaignId: 'gen-1',
        gapPoints: 20,
        openedAt: new Date('2026-10-01T00:00:00Z'),
      }),
    ])
    expect(detail).toContain('from +50 points to +20 points')
    expect(detail).toContain('closed by 30 points')
    expect(detail).toContain('60% of the baseline gap')
  })

  it('reports a widening gap as widening', () => {
    const detail = describeGapCurve([
      point({ campaignId: 'baseline', gapPoints: 20 }),
      point({ campaignId: 'gen-1', gapPoints: 45, openedAt: new Date('2026-10-01T00:00:00Z') }),
    ])
    expect(detail).toContain('widened by 25 points')
  })

  it('never subtracts across item sets — a different set is a separate reading', () => {
    const detail = describeGapCurve([
      point({ campaignId: 'baseline', gapPoints: 50 }),
      point({
        campaignId: 'elsewhere',
        gapPoints: 10,
        replaySetId: 'set-2',
        openedAt: new Date('2026-10-01T00:00:00Z'),
      }),
    ])
    expect(detail).toContain('a separate reading')
    expect(detail).not.toContain('closed by')
  })

  it('never subtracts across model pairs either', () => {
    const detail = describeGapCurve([
      point({ campaignId: 'baseline' }),
      point({
        campaignId: 'other-model',
        subjectModel: 'local/another',
        openedAt: new Date('2026-10-01T00:00:00Z'),
      }),
    ])
    expect(detail).not.toContain('closed by')
  })

  it('shows a partial campaign and refuses it as a closure endpoint', () => {
    const detail = describeGapCurve([
      point({ campaignId: 'baseline', gapPoints: 50 }),
      point({
        campaignId: 'gen-1',
        gapPoints: 5,
        partial: true,
        openedAt: new Date('2026-10-01T00:00:00Z'),
      }),
    ])
    expect(detail).toContain('not used as a closure endpoint')
    expect(detail).toContain('No closure figure')
    expect(detail).not.toContain('closed by')
  })
})
