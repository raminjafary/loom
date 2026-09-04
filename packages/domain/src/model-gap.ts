/**
 * The raw gap between two models on **one** document, and the curve a later campaign draws
 * against it.
 *
 * A campaign deliberately reports no growth figure, and the reason is written into
 * `describeCampaign`: a difference between two vintages is a difference in the document *and*
 * in everything else that moved between them. That refusal is right, and it is about vintages.
 * This file is the one comparison a campaign can make where the refusal does not apply — the
 * **same document**, dealt the **same items** at the **same pinned commits**, differing only
 * in the model that answered. Everything that confounds a vintage comparison is held still, so
 * the difference is attributable to the model in a way nothing else in this platform's data is.
 *
 * That is the punch-up question's first leg, and it has to exist before anything tries to
 * close the gap: a document evolved for a small model cannot be said to have recovered a
 * fraction of the frontier gap unless the gap was measured *before* the evolution started.
 *
 * ## Three rules, and each one is a way this number could lie
 *
 * 1. **The pairing is per item, over the items both arms scored.** Two pass rates over two
 *    different subsets of a set is not a difference — it is two answers to two questions. It
 *    matters most exactly when the money ran out: a halted campaign leaves one arm scored on
 *    six items and another on three, and their raw rates then differ mostly in *which* work
 *    they were asked to do. Every figure here is over the intersection, and the items dropped
 *    to get there are counted and reported.
 *
 * 2. **The model comes from the rows, never from the arm.** An arm's `model` is an override,
 *    and null means "whatever this persona runs on" — a promise about a default, resolved at
 *    dispatch, months before anyone reads the campaign. `replay_campaign_run.model` is what
 *    actually answered. An arm whose scored rows disagree with each other is not one side of a
 *    controlled comparison at all, and it is refused by name rather than averaged.
 *
 * 3. **A gap is not a closure.** One campaign yields one point. Closure is a *difference of
 *    gaps* across campaigns, and it is only readable when the later campaign replayed the same
 *    item set against the same model pair — which is why a campaign may be opened against an
 *    existing set, and why a curve across sets is drawn as separate points rather than joined.
 */

import type { ReplayCheckOutcome } from './replay-set.js'
import type { CampaignStatus } from './replay-campaign.js'

/** One arm as this comparison needs it: its document, and what each item said about it. */
export interface GapArm {
  readonly armId: string
  readonly label: string
  /**
   * The arm's declared override. Null is the control — the document in use on the model the
   * persona actually runs on, which is the side every model arm is a gap *from*.
   */
  readonly declaredModel: string | null
  readonly revisionId: string | null
  /** The document this arm ran, snapshotted on the row. Equality here is what "same document" means. */
  readonly markdownSource: string
  readonly items: readonly {
    readonly itemId: string
    readonly outcome: ReplayCheckOutcome | 'pending'
    /** What answered this item. The model stamp; see rule 2. */
    readonly model: string | null
  }[]
}

/** One controlled comparison: the same document, two models, over the items both scored. */
export interface PairedGap {
  readonly referenceArmId: string
  readonly referenceLabel: string
  readonly referenceModel: string
  readonly subjectArmId: string
  readonly subjectLabel: string
  readonly subjectModel: string
  /** Items both arms produced a verdict on. Every count below is over these and only these. */
  readonly sharedItems: number
  readonly referencePassed: number
  readonly subjectPassed: number
  /**
   * Percentage points, reference minus subject, over the shared items. Positive means the
   * reference model is ahead — which is the expected direction and not an assumed one.
   */
  readonly gapPoints: number
  /**
   * Items one arm scored and the other did not. Reported because it is the whole explanation
   * for why these counts differ from either arm's own pass rate in the same report.
   */
  readonly unpairedItems: number
}

export interface ModelGapReport {
  readonly gaps: readonly PairedGap[]
  /** Why a model arm produced no gap, one sentence each. Never silent: see `readModelGap`. */
  readonly notes: readonly string[]
  /** A halted or cancelled campaign's gap is over what it managed, and says so first. */
  readonly partial: boolean
}

/** Items this arm produced a verdict on — `not-scored` and `pending` are not verdicts. */
const verdicts = (arm: GapArm) =>
  arm.items.filter((item) => item.outcome === 'passed' || item.outcome === 'failed')

/**
 * Which model answered this arm, from its own scored rows.
 *
 * More than one is a refusal rather than an average: an arm whose six items were answered by
 * two models is not a side of a controlled comparison, and the honest response is to name both
 * and decline. Zero is the ordinary "nothing scored yet" and is handled by the caller.
 */
const answeredBy = (arm: GapArm): readonly string[] => [
  ...new Set(verdicts(arm).flatMap((item) => (item.model === null ? [] : [item.model]))),
].sort()

/**
 * The gap this campaign measured, or null when it did not try to measure one.
 *
 * Null is reserved for a campaign with **no model arm at all** — a vintage comparison, which
 * has no gap to report and should not be shown an empty section claiming otherwise. Every
 * other outcome returns a report: a campaign that *was* opened to measure a gap and produced
 * none owes the person who paid for it the reason, and an absent panel is not a reason.
 */
export const readModelGap = (input: {
  readonly status: CampaignStatus
  readonly arms: readonly GapArm[]
}): ModelGapReport | null => {
  const subjects = input.arms.filter((arm) => arm.declaredModel !== null)
  if (subjects.length === 0) return null

  const partial = input.status === 'halted' || input.status === 'cancelled'
  const reference = input.arms.find(
    (arm) => arm.declaredModel === null && arm.revisionId === null,
  )
  if (!reference) {
    return {
      gaps: [],
      notes: [
        'This campaign has no control arm — the document in use on the model this persona ' +
          'runs on — so a model arm has nothing to be a gap from.',
      ],
      partial,
    }
  }

  const referenceModels = answeredBy(reference)
  const referenceVerdicts = verdicts(reference)
  const gaps: PairedGap[] = []
  const notes: string[] = []

  for (const subject of subjects) {
    if (subject.markdownSource !== reference.markdownSource) {
      notes.push(
        `"${subject.label}" ran a different document from the control, so the difference ` +
          'between them is a difference of document as much as of model. Only arms holding ' +
          'the control’s own document are paired.',
      )
      continue
    }
    const subjectModels = answeredBy(subject)
    if (referenceVerdicts.length === 0 || verdicts(subject).length === 0) {
      notes.push(
        `"${subject.label}" and the control did not both reach a verdict, so there is nothing ` +
          'to pair yet.',
      )
      continue
    }
    if (referenceModels.length !== 1 || subjectModels.length !== 1) {
      notes.push(
        `"${subject.label}" ran on ${subjectModels.join(' and ') || 'no recorded model'} and ` +
          `the control on ${referenceModels.join(' and ') || 'no recorded model'}. A score ` +
          'belongs to a (document, model) pair, so an arm answered by more than one model is ' +
          'not one side of this comparison.',
      )
      continue
    }
    const subjectModel = subjectModels[0]!
    const referenceModel = referenceModels[0]!
    if (subjectModel === referenceModel) {
      notes.push(
        `"${subject.label}" was answered by ${subjectModel}, which is what answered the ` +
          'control — the override changed nothing, so there is no gap between them.',
      )
      continue
    }

    const subjectByItem = new Map(verdicts(subject).map((item) => [item.itemId, item]))
    const shared = referenceVerdicts.flatMap((item) => {
      const other = subjectByItem.get(item.itemId)
      return other === undefined ? [] : [{ reference: item, subject: other }]
    })
    if (shared.length === 0) {
      notes.push(
        `"${subject.label}" and the control scored no item in common, so their rates are two ` +
          'answers to two questions rather than a difference. Nothing is reported.',
      )
      continue
    }

    const referencePassed = shared.filter((pair) => pair.reference.outcome === 'passed').length
    const subjectPassed = shared.filter((pair) => pair.subject.outcome === 'passed').length
    gaps.push({
      referenceArmId: reference.armId,
      referenceLabel: reference.label,
      referenceModel,
      subjectArmId: subject.armId,
      subjectLabel: subject.label,
      subjectModel,
      sharedItems: shared.length,
      referencePassed,
      subjectPassed,
      gapPoints: Math.round(((referencePassed - subjectPassed) / shared.length) * 100),
      unpairedItems:
        referenceVerdicts.length -
        shared.length +
        (verdicts(subject).length - shared.length),
    })
  }

  return { gaps, notes, partial }
}

const points = (value: number) => `${value > 0 ? '+' : ''}${value} points`

/**
 * The gap in a paragraph, with both things it is not.
 *
 * It is not a claim about the two models: it is this persona's own work, at the commits that
 * work opened at, judged by this repository's definition of done. And it is not a closure
 * figure — closure is a difference between this campaign and a later one over the same items,
 * which is `describeGapCurve`'s job and cannot be inferred from one point.
 */
export const describeModelGap = (report: ModelGapReport): string => {
  const head = report.partial
    ? '**Partial.** The campaign stopped before every arm ran every item, so each figure ' +
      'below is over the items both arms managed.'
    : null

  const lines = report.gaps.map((gap) => {
    const direction =
      gap.gapPoints > 0
        ? `${gap.referenceModel} is ahead by ${points(gap.gapPoints)}`
        : gap.gapPoints < 0
          ? `${gap.subjectModel} is **ahead** by ${points(-gap.gapPoints)} — there is no gap ` +
            'to close in the expected direction'
          : 'they are level — no gap at all'
    return (
      `- Over the ${gap.sharedItems} ${gap.sharedItems === 1 ? 'item' : 'items'} both arms ` +
      `scored: ${gap.subjectModel} passed ${gap.subjectPassed}, ${gap.referenceModel} passed ` +
      `${gap.referencePassed}. ${direction}.` +
      (gap.unpairedItems === 0
        ? ''
        : ` ${gap.unpairedItems} further ${gap.unpairedItems === 1 ? 'verdict' : 'verdicts'} ` +
          'was left out because only one of the two arms reached it, which is why these counts ' +
          'are smaller than the arms’ own scores above.')
    )
  })

  const tail =
    report.gaps.length === 0
      ? []
      : [
          'The document is the same on both sides and the items are the same items at the same ' +
            'commits, so unlike a vintage comparison this difference is attributable to the ' +
            'model. It is still a measurement of *this* persona’s work under *this* ' +
            'repository’s definition of done, not a ranking of the two models.',
          'This is a gap, not a closure. A closure figure is the difference between this gap ' +
            'and a later campaign’s over the same item set — open the next one against this ' +
            'set, or there is nothing to compare.',
        ]

  return [head, ...lines, ...report.notes.map((note) => `- ${note}`), ...tail]
    .filter((line): line is string => line !== null)
    .join('\n')
}

/** One campaign's gap, as a point on the punch-up curve. */
export interface GapPoint {
  readonly campaignId: string
  readonly campaignLabel: string
  readonly openedAt: Date
  /** The set replayed. Two points over different sets are not two readings of one gap. */
  readonly replaySetId: string
  readonly subjectModel: string
  readonly referenceModel: string
  readonly gapPoints: number
  readonly sharedItems: number
  /** From a halted or cancelled campaign. Shown, never used as a closure endpoint. */
  readonly partial: boolean
}

/**
 * The punch-up curve: what happened to a gap as generations of the document were promoted.
 *
 * A **leg** is `(item set, subject model, reference model)`, and a closure figure exists only
 * within one. Across sets it does not: two campaigns over two freshly-assembled sets differ in
 * which work they asked for, and subtracting their gaps would attribute that difference to the
 * document. So points outside the leg are listed rather than joined, with the reason.
 *
 * A partial point is shown and never used as an endpoint, for the same reason the pairing is
 * per item: its denominator is whatever the money reached.
 */
export const describeGapCurve = (input: readonly GapPoint[]): string => {
  if (input.length === 0) {
    return (
      'No cross-model campaign has reported a gap for this persona yet. The baseline is one ' +
      'campaign: the document in use, on its own model and on another, over the same items.'
    )
  }

  const key = (point: GapPoint) =>
    `${point.replaySetId}|${point.subjectModel}|${point.referenceModel}`
  const legs = new Map<string, GapPoint[]>()
  for (const point of input) {
    const existing = legs.get(key(point))
    if (existing) existing.push(point)
    else legs.set(key(point), [point])
  }

  const ordered = [...legs.values()].map((leg) =>
    [...leg].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime()),
  )
  ordered.sort((a, b) => b.length - a.length || a[0]!.openedAt.getTime() - b[0]!.openedAt.getTime())

  const sections = ordered.map((leg, index) => {
    const first = leg[0]!
    const head =
      `${first.subjectModel} against ${first.referenceModel}, over one fixed item set — ` +
      `${leg.length} ${leg.length === 1 ? 'campaign' : 'campaigns'}:`
    const rows = leg.map(
      (point) =>
        `  - ${point.openedAt.toISOString().slice(0, 10)} "${point.campaignLabel}": ` +
        `${points(point.gapPoints)} over ${point.sharedItems} paired items` +
        (point.partial ? ' (partial — not used as a closure endpoint)' : ''),
    )
    const usable = leg.filter((point) => !point.partial)
    const closure =
      usable.length < 2
        ? leg.length < 2
          ? '  No closure figure yet: one campaign is a baseline, and closure is a difference ' +
            'between two over the same items.'
          : '  No closure figure: fewer than two of these campaigns ran to completion, and a ' +
            'partial gap’s denominator is whatever the budget reached.'
        : (() => {
            const from = usable[0]!
            const to = usable[usable.length - 1]!
            const closed = from.gapPoints - to.gapPoints
            const share =
              from.gapPoints === 0
                ? null
                : Math.round((closed / Math.abs(from.gapPoints)) * 100)
            return (
              `  Closure: the gap moved from ${points(from.gapPoints)} to ` +
              `${points(to.gapPoints)}${closed === 0 ? ' — it did not move' : closed > 0 ? ` — closed by ${closed} points` : ` — widened by ${-closed} points`}` +
              (share === null ? '.' : `, ${share}% of the baseline gap.`)
            )
          })()
    const separated =
      index === 0
        ? null
        : '  A different item set or model pair from the leg above, so its gap is a separate ' +
          'reading and the two cannot be subtracted.'
    return [head, ...rows, closure, separated].filter((line): line is string => line !== null).join('\n')
  })

  return sections.join('\n')
}
