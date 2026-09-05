/**
 * Whether a drawn harness beats one agent with a plan — measured, on the same work.
 *
 * A workflow is a shape frozen into a diagram, and the field's own caveat about harnesses is
 * that most tasks do not need one and that they cost significantly more tokens. That caveat
 * lands harder here than it does anywhere it was written, because this platform meters: a
 * harness that produces the same outcomes for twice the money is a harness this platform can
 * *prove* was not worth drawing. So the first claim a shape has to survive is the one the trial
 * machinery already knows how to settle — the same task class, planner-and-delegate against the
 * harness, dispositions first and cost second.
 *
 * ## Why the unit is a task and not a run
 *
 * Every other trial here counts runs, because every other trial varies something *inside* one
 * run: a prompt, a map, a distilled lesson. This one varies the number of runs. A harness that
 * splits work into six branches would, counted per run, be compared on how mergeable its
 * smallest branch was — and the arm that produces more trivially-mergeable branches would win a
 * question nobody asked.
 *
 * So an **entry** is one task dealt to one arm, and it is decided when the work it produced was
 * decided:
 *
 * - **merged** if any branch it produced was taken. Somebody wanted the work.
 * - **decided** if any of its runs reached a disposition, failed outright, or left a branch that
 *   failed the repository's definition of done — the shared definition every trial here counts
 *   with, applied to a set of runs rather than to one.
 * - **cost** is the whole of what the task spent, which is the number the caveat is about: a
 *   planner's tree and a harness's steps are both "what this task cost to attempt".
 *
 * ## What is deliberately not decided here
 *
 * **Ties go to the planner.** The harness is the candidate and planner-and-delegate is what this
 * platform already does; a shape that cannot be shown to beat it is a shape that costs more for
 * no measured reason. That is the same asymmetry the map trial keeps against an unaided baseline,
 * pointed the other way for the same reason: the default should be the cheaper thing.
 *
 * **Assignment alternates from the counts.** Never sampled — a random arm cannot be replayed
 * from the journal, and with five tasks a side a coin spends half its evidence on an imbalance
 * nobody wanted.
 */

import {
  compareTrialArms,
  describeVerificationFailures,
  MIN_DECIDED_RUNS_PER_ARM,
  verificationFailureRate,
} from './expertise-trial.js'

/** Which way one task of the class was done. */
export type WorkflowTrialArm = 'workflow' | 'planner'

export const WORKFLOW_TRIAL_ARMS: readonly WorkflowTrialArm[] = ['workflow', 'planner']

/**
 * One task, and what became of the work it produced.
 *
 * Assembled from the runs the entry actually started — a planner's whole tree, or a workflow's
 * steps — because the outcome of a task is a fact about all of them together. `costUsd` is the
 * sum over those runs, which is what makes the cost term a comparison of *task* prices.
 */
export interface WorkflowTrialEntryOutcome {
  readonly arm: WorkflowTrialArm
  /** True when any of its runs reached a disposition, failed, or failed its checks. */
  readonly decided: boolean
  /** True when any branch it produced was merged or pushed. */
  readonly merged: boolean
  /** True when a branch was discarded and none was taken. */
  readonly discarded: boolean
  /** True when the work failed outright and produced nothing to decide about. */
  readonly failed: boolean
  readonly verificationFailed: boolean
  readonly failingCheck: string | null
  readonly costUsd: number
  /** How many runs the task took, which is the thing the two arms differ in most. */
  readonly runs: number
}

export interface WorkflowTrialArmTally {
  readonly arm: WorkflowTrialArm
  /** Tasks dealt to this arm, decided or not. */
  readonly tasks: number
  readonly decided: number
  readonly merged: number
  readonly discarded: number
  readonly failed: number
  readonly verificationFailed: number
  readonly failingCheck: string | null
  readonly costUsdTotal: number
  readonly runsTotal: number
}

export interface WorkflowTrialArmSummary extends WorkflowTrialArmTally {
  readonly successRate: number
  readonly meanCostUsd: number
  readonly verificationFailureRate: number
  /** Runs per decided task — how much machinery this arm spent per task, not per branch. */
  readonly meanRuns: number
}

export type WorkflowTrialVerdict =
  /** Not enough decided tasks on one side or the other. The honest default, and the common one. */
  | 'undecided'
  /** The harness does better. It has earned the shape. */
  | 'harness'
  /** Planner-and-delegate does better — the case a person most needs to be told about. */
  | 'planner'
  /** Level. The harness costs more machinery for the same result, so it has not earned it. */
  | 'no-better'

export interface WorkflowTrialEffect {
  readonly workflow: WorkflowTrialArmSummary
  readonly planner: WorkflowTrialArmSummary
  readonly verdict: WorkflowTrialVerdict
  /** One paragraph a person reads instead of doing the arithmetic. */
  readonly detail: string
}

const EMPTY = (arm: WorkflowTrialArm): WorkflowTrialArmTally => ({
  arm,
  tasks: 0,
  decided: 0,
  merged: 0,
  discarded: 0,
  failed: 0,
  verificationFailed: 0,
  failingCheck: null,
  costUsdTotal: 0,
  runsTotal: 0,
})

/**
 * Folds the entries into two arm tallies.
 *
 * In the domain rather than in SQL, and that is a deliberate split: the *per-entry* aggregate is
 * a query, because it spans a tree of runs and a set of steps; the arithmetic over entries is a
 * rule about what a task's outcome means, and rules belong where they can be tested without a
 * database.
 */
export const tallyWorkflowTrial = (
  entries: readonly WorkflowTrialEntryOutcome[],
): WorkflowTrialArmTally[] =>
  WORKFLOW_TRIAL_ARMS.map((arm) => {
    const mine = entries.filter((entry) => entry.arm === arm)
    const decided = mine.filter((entry) => entry.decided)
    const checks = new Map<string, number>()
    for (const entry of mine) {
      if (entry.failingCheck === null) continue
      checks.set(entry.failingCheck, (checks.get(entry.failingCheck) ?? 0) + 1)
    }
    const modal = [...checks.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    return {
      ...EMPTY(arm),
      tasks: mine.length,
      decided: decided.length,
      merged: mine.filter((entry) => entry.merged).length,
      discarded: mine.filter((entry) => entry.discarded && !entry.merged).length,
      failed: mine.filter((entry) => entry.failed).length,
      verificationFailed: mine.filter((entry) => entry.verificationFailed).length,
      failingCheck: modal?.[0] ?? null,
      /**
       * Summed over decided tasks only, so the mean is on the same denominator as the success
       * rate. A task still in flight has spent something and produced no outcome, and counting
       * it would make an arm look more expensive the busier the workspace is.
       */
      costUsdTotal: decided.reduce((sum, entry) => sum + entry.costUsd, 0),
      runsTotal: decided.reduce((sum, entry) => sum + entry.runs, 0),
    }
  })

const summarize = (tally: WorkflowTrialArmTally): WorkflowTrialArmSummary => ({
  ...tally,
  successRate: tally.decided === 0 ? 0 : tally.merged / tally.decided,
  meanCostUsd: tally.decided === 0 ? 0 : tally.costUsdTotal / tally.decided,
  verificationFailureRate: verificationFailureRate(tally),
  meanRuns: tally.decided === 0 ? 0 : tally.runsTotal / tally.decided,
})

/**
 * Which arm the next task of this class goes to.
 *
 * Alternating from the counts, and **ties go to the planner**: the first task of a brand new
 * harness measures what this platform would have done anyway, so a class that is only ever run
 * once has measured the cheaper thing rather than having paid for a shape nobody compared.
 */
export const nextWorkflowTrialArm = (used: {
  workflow: number
  planner: number
}): WorkflowTrialArm =>
  used.workflow > used.planner ? 'planner' : used.workflow < used.planner ? 'workflow' : 'planner'

const asPercent = (rate: number) => `${Math.round(rate * 100)}%`
const money = (usd: number) => `$${usd.toFixed(4)}`

const HARNESS_LABEL = 'the harness'
const PLANNER_LABEL = 'a planner and its workers'

/**
 * What the two arms measured, and what it settles.
 *
 * The comparison is `compareTrialArms` — the same order of terms every trial here uses, so two
 * panels cannot report two verdicts about the same evidence. Only the sentences belong to this
 * file, and one clause of them is this trial's own: how many runs each arm spent per task, which
 * is the thing a person is deciding about when they decide whether to draw a shape at all.
 */
export const summarizeWorkflowTrial = (
  entries: readonly WorkflowTrialEntryOutcome[],
  /** The personas that stood in for "no harness". More than one is a caveat, not an error. */
  controls: readonly string[] = [],
): WorkflowTrialEffect => {
  const tallies = tallyWorkflowTrial(entries)
  const workflow = summarize(tallies.find((tally) => tally.arm === 'workflow') ?? EMPTY('workflow'))
  const planner = summarize(tallies.find((tally) => tally.arm === 'planner') ?? EMPTY('planner'))

  /**
   * Said wherever the verdict lands, because it is the caveat that would otherwise be invisible:
   * two different control personas is two different baselines averaged into one number.
   */
  const control =
    controls.length > 1
      ? ` The unaided arm was run by ${controls.length} different personas (${controls.join(', ')}), so its side of this is an average over two baselines.`
      : ''

  const machinery =
    workflow.decided === 0 || planner.decided === 0
      ? ''
      : ` It takes ${workflow.meanRuns.toFixed(1)} run(s) per task against ${planner.meanRuns.toFixed(1)}.`

  const verification = describeVerificationFailures(
    { label: HARNESS_LABEL, ...workflow },
    { label: PLANNER_LABEL, ...planner },
  )

  if (workflow.decided < MIN_DECIDED_RUNS_PER_ARM || planner.decided < MIN_DECIDED_RUNS_PER_ARM) {
    return {
      workflow,
      planner,
      verdict: 'undecided',
      detail:
        `Still measuring: ${workflow.decided} decided task(s) run through the harness against ` +
        `${planner.decided} given to a planner. Each side needs ${MIN_DECIDED_RUNS_PER_ARM} ` +
        `before the comparison says anything.${machinery}${verification}${control}`,
    }
  }

  const level = `${asPercent(workflow.successRate)} against ${asPercent(planner.successRate)}`
  const { favours, term } = compareTrialArms(workflow, planner)

  if (term === 'outcomes') {
    return favours === 'candidate'
      ? {
          workflow,
          planner,
          verdict: 'harness',
          detail:
            `Work run through the harness was taken ${asPercent(workflow.successRate)} of the ` +
            `time against ${asPercent(planner.successRate)} for the same class of task given to ` +
            `a planner.${machinery}${verification}${control}`,
        }
      : {
          workflow,
          planner,
          verdict: 'planner',
          detail:
            `A planner and its workers did better on this class: ${asPercent(planner.successRate)} ` +
            `taken against the harness's ${asPercent(workflow.successRate)}. The shape is ` +
            `costing outcomes, not just money.${machinery}${verification}${control}`,
        }
  }

  if (term === 'verification') {
    return favours === 'candidate'
      ? {
          workflow,
          planner,
          verdict: 'harness',
          detail:
            `Outcomes are level (${level}), and the harness leaves fewer branches failing their ` +
            `repository's checks.${machinery}${verification}${control}`,
        }
      : {
          workflow,
          planner,
          verdict: 'planner',
          detail:
            `Outcomes are level (${level}), and the harness leaves *more* branches failing their ` +
            `repository's checks.${machinery}${verification}${control}`,
        }
  }

  if (term === 'cost' && favours === 'candidate') {
    return {
      workflow,
      planner,
      verdict: 'harness',
      detail:
        `Outcomes are level (${level}), and the harness costs ${money(workflow.meanCostUsd)} a ` +
        `task against ${money(planner.meanCostUsd)} — it is paying for itself.` +
        `${machinery}${verification}${control}`,
    }
  }

  /**
   * Level on outcomes, and either dearer or the same. Both are `no-better` on purpose: the
   * harness is the thing that costs more to build, more to read and more to run, so "as good as
   * a planner" is not a result in its favour.
   */
  return {
    workflow,
    planner,
    verdict: 'no-better',
    detail:
      `Outcomes are level (${level}) and the harness costs ${money(workflow.meanCostUsd)} a task ` +
      `against ${money(planner.meanCostUsd)}. A shape that cannot be shown to beat a planner is ` +
      `a diagram this class of work does not need.${machinery}${verification}${control}`,
  }
}
