import {
 COST_TOLERANCE,
 MIN_DECIDED_RUNS_PER_ARM,
 SUCCESS_RATE_TOLERANCE,
} from './expertise-trial.js'

/**
 * Whether a self-edit was an **improvement**.
 *
 * Continuity mode gives an agent five tiers of self-*editing* and nothing that decides whether an edit
 * helped. This is the first half of what the self-improvement loop says is missing: a fitness that is not
 * self-reported. An agent rewrites its own prompt, and the platform then runs both
 * versions and counts what happened.
 *
 * ## Why this is a copy of the trial rather than a new idea
 *
 * The map trial already answers the same question about a different artifact — does a run
 * do better for having been given this? — and it answers it the same way: alternate the
 * arms, decide on outcomes first and cost second, and say "still measuring" until each
 * side has enough runs. Reusing its thresholds rather than inventing new ones is the point
 * of importing them: two tolerances for "materially better" would drift, and the first
 * time they disagreed nobody would know which one the platform meant.
 *
 * ## The three decisions this file makes that self-improvement loop leaves open
 *
 * **1. The arms are the revision and the version it replaced**, not the revision against
 * nothing. There is no "no prompt" arm because a persona with no prompt is not a persona;
 * the honest counterfactual for "was this edit an improvement" is the document that was
 * there before, which the history already holds. That is also why this needs no new
 * storage for the losing side — the archive is `persona_revision`, and the archive
 * is the control group.
 *
 * **2. A tie goes to the revision.** portable expertise sends the first run of a new expertise to the
 * *withheld* arm, because an unmeasured map should not be handed to anybody. The
 * asymmetry here runs the other way: the revision is already live — the agent wrote it and
 * the platform stored it — so putting the first run on the old prompt would mean silently
 * running a version the persona no longer has. The trial measures what is happening; it
 * does not get to quietly revert.
 *
 * **3. Only an agent's revision goes on trial.** A human's edit is a decision, not a
 * hypothesis. Measuring it would mean running an operator's deliberate change against the
 * thing they deliberately replaced, which is not a service anybody asked for.
 */

export type PromptArm = 'revised' | 'previous'

export const PROMPT_ARMS: readonly PromptArm[] = ['revised', 'previous']

export interface PromptArmTally {
 readonly arm: PromptArm
 /** Runs that reached a disposition — an undecided branch is not evidence yet. */
 readonly decided: number
 readonly merged: number
 readonly discarded: number
 readonly failed: number
 readonly costUsdTotal: number
}

export interface PromptArmSummary extends PromptArmTally {
 readonly successRate: number
 readonly meanCostUsd: number
}

export type PromptTrialVerdict =
 /** Not enough runs on one side or the other. The honest default, and the common one. */
 | 'undecided'
 /** The revision does better. */
 | 'better'
 /** The revision does worse — the case a human most needs to be told about. */
 | 'worse'
 /** Level on outcomes; cost breaks the tie, in whichever direction. */
 | 'no-better'

export interface PromptTrialEffect {
 readonly revised: PromptArmSummary
 readonly previous: PromptArmSummary
 readonly verdict: PromptTrialVerdict
 /** One sentence a human reads instead of doing the arithmetic. */
 readonly detail: string
}

const EMPTY = (arm: PromptArm): PromptArmTally => ({
 arm,
 decided: 0,
 merged: 0,
 discarded: 0,
 failed: 0,
 costUsdTotal: 0,
})

const summarizeArm = (tally: PromptArmTally): PromptArmSummary => ({
...tally,
 successRate: tally.decided === 0 ? 0: tally.merged / tally.decided,
 meanCostUsd: tally.decided === 0 ? 0: tally.costUsdTotal / tally.decided,
})

/**
 * Which prompt the next run of this persona gets.
 *
 * Alternating from the counts rather than sampling, so a trial converges in the fewest
 * runs a workspace will actually produce — the same reasoning `nextTrialArm` gives, and
 * the same reason neither is random: with five runs a side, a coin flip spends half its
 * evidence on an imbalance nobody wanted.
 */
export const nextPromptArm = (used: { revised: number; previous: number }): PromptArm =>
 used.revised > used.previous ? 'previous': used.revised < used.previous ? 'revised': 'revised'

const asPercent = (rate: number) => `${Math.round(rate * 100)}%`
const asMoney = (usd: number) => `$${usd.toFixed(4)}`

/**
 * What the runs so far say about an agent's edit.
 *
 * **Outcomes first, cost second, and the order is the whole judgement.** A prompt that
 * gets more work merged is better even if it costs more; a prompt that costs less and
 * merges less is worse. Cost only decides where outcomes are level — which is the common
 * case for a prompt edit, and the case where the economics has something real to say.
 */
export const summarizePromptEffect = (
 tallies: readonly PromptArmTally[],
): PromptTrialEffect => {
 const revised = summarizeArm(tallies.find((t) => t.arm === 'revised') ?? EMPTY('revised'))
 const previous = summarizeArm(tallies.find((t) => t.arm === 'previous') ?? EMPTY('previous'))

 if (revised.decided < MIN_DECIDED_RUNS_PER_ARM || previous.decided < MIN_DECIDED_RUNS_PER_ARM) {
 return {
 revised,
 previous,
 verdict: 'undecided',
 detail:
 `Still measuring: ${revised.decided} finished run(s) on the new prompt against ` +
 `${previous.decided} on the one it replaced. Each side needs ` +
 `${MIN_DECIDED_RUNS_PER_ARM} before this says anything — until then the edit is ` +
 'live and unproven, which is what an agent editing itself normally is.',
 }
 }

 const outcomeGap = revised.successRate - previous.successRate

 if (outcomeGap > SUCCESS_RATE_TOLERANCE) {
 return {
 revised,
 previous,
 verdict: 'better',
 detail:
 `The agent's version got work merged ${asPercent(revised.successRate)} of the time ` +
 `against ${asPercent(previous.successRate)} for the prompt it replaced.`,
 }
 }

 if (outcomeGap < -SUCCESS_RATE_TOLERANCE) {
 return {
 revised,
 previous,
 verdict: 'worse',
 detail:
 `The agent's version got work merged ${asPercent(revised.successRate)} of the time ` +
 `against ${asPercent(previous.successRate)} for the prompt it replaced — it is ` +
 'making things worse. Restoring the old one is the cheap fix.',
 }
 }

 /**
 * Level on outcomes. The cost model makes model choice the cost swing and this is the smaller
 * cousin: a prompt every future run pays for in context is a standing charge, so a
 * version that produces the same results for materially less money has earned its place
 * and one that costs materially more has not.
 */
 const costGap =
 previous.meanCostUsd === 0 ? 0: (revised.meanCostUsd - previous.meanCostUsd) / previous.meanCostUsd

 if (costGap < -COST_TOLERANCE) {
 return {
 revised,
 previous,
 verdict: 'better',
 detail:
 `Outcomes are level (${asPercent(revised.successRate)} against ` +
 `${asPercent(previous.successRate)}), and the agent's version is cheaper per run — ` +
 `${asMoney(revised.meanCostUsd)} against ${asMoney(previous.meanCostUsd)}.`,
 }
 }

 if (costGap > COST_TOLERANCE) {
 return {
 revised,
 previous,
 verdict: 'worse',
 detail:
 `Outcomes are level (${asPercent(revised.successRate)} against ` +
 `${asPercent(previous.successRate)}), and the agent's version costs more per run — ` +
 `${asMoney(revised.meanCostUsd)} against ${asMoney(previous.meanCostUsd)}. A prompt ` +
 'is charged to every future run, so that is a standing cost for no gain.',
 }
 }

 return {
 revised,
 previous,
 verdict: 'no-better',
 detail:
 `No measurable difference: ${asPercent(revised.successRate)} against ` +
 `${asPercent(previous.successRate)} merged, at ${asMoney(revised.meanCostUsd)} against ` +
 `${asMoney(previous.meanCostUsd)} a run. Keeping it is as defensible as reverting it.`,
 }
}
