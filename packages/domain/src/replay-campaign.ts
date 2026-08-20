/**
 * A campaign: run *any* version of a persona against *any* set of its own past work, at the
 * commits that work opened at, and score it with the repository's definition of done.
 *
 * The held-out screen already does something shaped like this, and the difference is the
 * whole point of a separate concept. **A screen exists to refuse a measurement.** It compares
 * a candidate to the prompt in use on a handful of items, cheaply, so that a persona's one
 * live measurement slot is not spent on a candidate that was never going to be better. It has
 * exactly two answers and neither of them is a number anybody keeps.
 *
 * **A campaign exists to make a measurement.** Its arms are *vintages* — the documents this
 * persona used to have, which `persona_revision` has been storing all along — and its output
 * is a score per arm that is meant to be compared with another campaign's score months later.
 * It gates nothing, admits nothing, promotes nothing, and refuses nothing. It is the
 * instrument three questions need and none of them can ask today: whether a persona has
 * actually grown, how much of the small-versus-frontier gap a document recovers, and whether
 * an expertise map lifts a small model more than the model that built it.
 *
 * ## What it costs, said first
 *
 * The screen's runs are affordable because they replace something more expensive. A
 * campaign's runs replace nothing: they are new spend, deliberately incurred, and a campaign
 * over eight items and three vintages is twenty-four real runs of a real agent against a real
 * repository. So a campaign carries a **hard cap** rather than a budget note, and when the cap
 * is reached it **halts** rather than degrading — and a halted campaign's score is labelled
 * partial everywhere it is reported. A pass rate over half a set reads exactly like a pass
 * rate over all of it, which is how a cost overrun turns into a wrong conclusion.
 *
 * ## The confound, stated rather than discovered
 *
 * Vintage-versus-vintage is the fairest growth measurement available and it is not a clean
 * one. The item's commit is pinned, so the *problem* is the same; everything around it has
 * moved. The repository's checks may be stricter than they were, the model the arm runs on is
 * probably not the model that vintage was written for, and the harness itself has changed. A
 * campaign therefore reports **what it measured**, not "the persona improved 12%": the arms,
 * their scores, the model each ran on, and the fact that a difference between two vintages is
 * a difference in everything that moved between them. The alternative — a single growth number
 * — would be the most quotable and least defensible figure this platform could produce.
 */

import { describeOutcomeMix, type ReplayOutcome } from './replay-set.js'

/**
 * What one arm of a campaign *is*.
 *
 * A revision id is a vintage: the document this persona had at that point, replayed as it was
 * written. Null is the document it has now — the control, and the arm every growth question
 * is asked against.
 *
 * `model` overrides what the arm runs on, and it exists for one question: the same document on
 * a small model and on a frontier one, which is the raw gap before anything tries to close it.
 * Null runs the persona's own model, which is what a vintage comparison wants — two documents
 * on two different models is a comparison of nothing.
 */
export interface CampaignArmSpec {
  readonly revisionId: string | null
  readonly model: string | null
  /** What a reader should call this arm. Stored, because a revision id is not a label. */
  readonly label: string
}

/** One arm's score. Same shape the screen's tally has, because the scoring rule is the same. */
export interface CampaignArmTally {
  readonly armId: string
  readonly label: string
  readonly revisionId: string | null
  readonly scored: number
  readonly passed: number
  readonly failed: number
  readonly notScored: number
  readonly pending: number
  /** Passed over scored. Read `scored` first: zero here means nothing was measured. */
  readonly passRate: number
  /** The distinct models this arm's runs actually ran on, sorted, unknowns dropped. */
  readonly models: readonly string[]
}

export type CampaignStatus =
  /** Runs are still being dealt or scored. */
  | 'running'
  /** Every arm reported on every item. */
  | 'finished'
  /** The cap was reached first. The score stands, and it is partial. */
  | 'halted'
  /** A person stopped it. Same partial-score rule as `halted`. */
  | 'cancelled'

/**
 * Whether a campaign may start another run.
 *
 * Checked before *each* start rather than once, because the answer changes as the campaign
 * spends: the cap is a ceiling on the campaign's own total, and a run's cost is only known
 * after it finishes. That means the cap can be crossed by the last run it allows — a campaign
 * cannot know what a run will cost before starting it, and refusing to start until the
 * remaining budget covers the worst case would make a cap that is merely *tight* behave like
 * one that is zero.
 *
 * So the guarantee is honest and bounded: **at most one run is started after the cap is
 * reached in aggregate**, never a second, and the overshoot is one run's cost rather than a
 * campaign's. Stated here because the alternative reading — "the cap is never exceeded" — is
 * a promise this shape cannot keep.
 */
export const campaignMayStart = (input: {
  readonly capUsd: number | null
  readonly spentUsd: number
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  if (input.capUsd === null) return { ok: true }
  if (input.spentUsd < input.capUsd) return { ok: true }
  return {
    ok: false,
    reason:
      `The campaign's cap of $${input.capUsd.toFixed(2)} is reached — $${input.spentUsd.toFixed(2)} ` +
      'spent. It is halted with the score it has, which is partial and is reported as partial.',
  }
}

/**
 * One arm's score in a sentence, and the comparison against the control.
 *
 * `null` for the control's own line, because "the document in use scored the same as the
 * document in use" is not a sentence anybody needs.
 */
const compareToControl = (
  arm: CampaignArmTally,
  control: CampaignArmTally | null,
): string | null => {
  if (control === null || arm.armId === control.armId) return null
  if (arm.scored === 0 || control.scored === 0) {
    return 'not comparable — one of the two arms produced no verdict at all'
  }
  const percent = (rate: number) => `${Math.round(rate * 100)}%`
  const crossModel =
    arm.models.length === 1 && control.models.length === 1 && arm.models[0] !== control.models[0]
      ? ` — on ${arm.models[0]} against ${control.models[0]}, so this difference is a ` +
        'difference of model as much as of document'
      : arm.models.length > 1 || control.models.length > 1
        ? ' — across more than one model, so the figure mixes them'
        : ''
  const direction =
    arm.passRate > control.passRate
      ? 'ahead of'
      : arm.passRate < control.passRate
        ? 'behind'
        : 'level with'
  return `${percent(arm.passRate)} against ${percent(control.passRate)}, ${direction} the control${crossModel}`
}

/**
 * What a campaign has measured, in a paragraph a person can act on.
 *
 * Three rules it keeps, all of them about not producing a number that reads better than the
 * evidence behind it:
 *
 * 1. **A partial campaign says so first.** A halted or cancelled campaign's pass rates are
 *    over the items it managed, and that sentence leads.
 * 2. **No growth figure.** The arms and their scores are reported; the *difference* is
 *    described as what it is — a difference in the document and in everything else that moved
 *    between the two vintages.
 * 3. **The set's own composition is named**, as `screenGate` names it, because a pass rate is
 *    only readable against the work it was measured on.
 */
export const describeCampaign = (input: {
  readonly status: CampaignStatus
  readonly arms: readonly CampaignArmTally[]
  readonly composition: readonly ReplayOutcome[]
  readonly haltReason: string | null
}): string => {
  const control = input.arms.find((arm) => arm.revisionId === null) ?? null
  const pending = input.arms.reduce((sum, arm) => sum + arm.pending, 0)

  if (input.arms.length === 0) {
    return 'This campaign has no arms, so there is nothing for it to have measured.'
  }

  const head =
    input.status === 'running'
      ? pending === 0
        ? 'Every arm has reported; the campaign is being closed.'
        : `Still running: ${pending} of ${input.arms.length * input.composition.length} runs ` +
          'have not reported.'
      : input.status === 'finished'
        ? 'Finished: every arm ran every item.'
        : `**Partial.** ${input.haltReason ?? 'The campaign was stopped before every arm ran every item.'} ` +
          'Every rate below is over the items that were actually scored, and is not a score ' +
          'for the whole set.'

  const lines = input.arms.map((arm) => {
    const against = compareToControl(arm, control)
    const on = arm.models.length === 0 ? '' : ` on ${arm.models.join(' and ')}`
    return (
      `- ${arm.label}${on}: passed ${arm.passed} of ${arm.scored} scored` +
      (arm.notScored === 0 ? '' : `, ${arm.notScored} produced no verdict`) +
      (arm.pending === 0 ? '' : `, ${arm.pending} still running`) +
      (against === null ? ' (the control)' : ` — ${against}`)
    )
  })

  const composition = describeOutcomeMix(input.composition)
  return [
    head,
    ...lines,
    `The set was ${input.composition.length} items (${composition} when the work was ` +
      'originally run), replayed at the commits those runs opened at.',
    'A difference between two vintages is a difference in the document **and** in everything ' +
      'that moved between them — the checks, the model, the harness. This reports what was ' +
      'measured; it does not report growth.',
  ].join('\n')
}

/**
 * The scoring rule is `screenOutcomeFor`, imported by the caller rather than re-exported
 * here. One rule, one home: a campaign that scored `not-scored` differently from a screen
 * would make two kinds of number that look alike, which is the mistake this whole file is
 * arranged to avoid.
 */
