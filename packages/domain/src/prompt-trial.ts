import {
 COST_TOLERANCE,
 MIN_DECIDED_RUNS_PER_ARM,
 SUCCESS_RATE_TOLERANCE,
 describeVerificationFailures,
 verificationFailureRate,
 type VerificationTally,
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
 *
 * **4. The repository's definition of done is a term in the fitness, between the human's
 * judgement and the money.** the self-improvement loop asks for "a fitness that is not the run's own report
 * of itself", and a disposition satisfies that only in the sense that a human supplied it:
 * it measures what a reviewer had time to look at, and it arrives days late. The * verification harness runs on every finished run, needs nobody, and answers the half of
 * the question a machine is entitled to answer — *this branch is not done*. So a branch
 * that failed its checks is a **decided** run even if nobody has ruled on it, and it is
 * not a success. A branch that passed is neither: passing is the floor, and only a human
 * merging says the work was wanted.
 */

export type PromptArm = 'revised' | 'previous'

export const PROMPT_ARMS: readonly PromptArm[] = ['revised', 'previous']

export interface PromptArmTally extends VerificationTally {
 readonly arm: PromptArm
 /**
 * Runs that reached a disposition, failed outright, or **failed their repository's
 * definition of done** — an undecided branch is not evidence yet, and a branch that
 * does not build is decided whether or not anybody has looked at it.
 */
 readonly decided: number
 readonly merged: number
 readonly discarded: number
 readonly failed: number
 readonly costUsdTotal: number
}

export interface PromptArmSummary extends PromptArmTally {
 readonly successRate: number
 readonly meanCostUsd: number
 readonly verificationFailureRate: number
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
 verificationFailed: 0,
 failingCheck: null,
})

const summarizeArm = (tally: PromptArmTally): PromptArmSummary => ({
...tally,
 successRate: tally.decided === 0 ? 0: tally.merged / tally.decided,
 meanCostUsd: tally.decided === 0 ? 0: tally.costUsdTotal / tally.decided,
 verificationFailureRate: verificationFailureRate(tally),
})

const REVISED_LABEL = "the agent's version"
const PREVIOUS_LABEL = 'the one it replaced'

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
 const verification = describeVerificationFailures(
 { label: REVISED_LABEL,...revised },
 { label: PREVIOUS_LABEL,...previous },
)

 if (revised.decided < MIN_DECIDED_RUNS_PER_ARM || previous.decided < MIN_DECIDED_RUNS_PER_ARM) {
 return {
 revised,
 previous,
 verdict: 'undecided',
 detail:
 `Still measuring: ${revised.decided} finished run(s) on the new prompt against ` +
 `${previous.decided} on the one it replaced. Each side needs ` +
 `${MIN_DECIDED_RUNS_PER_ARM} before this says anything — until then the edit is ` +
 'live and unproven, which is what an agent editing itself normally is.' +
 // The one thing worth saying before the verdict exists. A failing check is hard
 // evidence and it lands hours after the run, where a merge takes a human.
 verification,
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
 `against ${asPercent(previous.successRate)} for the prompt it replaced.${verification}`,
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
 `making things worse. Restoring the old one is the cheap fix.${verification}`,
 }
 }

 /**
 * Level on what a human decided, so the machine's check decides next.
 *
 * This term is why the fitness is no longer only a report of what happened to a branch
 * after somebody looked at it. Principle 6 says "'looks done' is not a stop
 * condition", and a merge rate has the same weakness on a longer timescale: it measures
 * what a reviewer had time for. A repository's definition of done runs on every finished
 * run, needs nobody, and can say *this branch is not done* — the one half of the
 * judgement a machine is entitled to make.
 *
 * Ordered behind the disposition and ahead of cost, and the order is the whole
 * judgement. A human merging is stronger evidence than a passing build; a failing build
 * is stronger evidence than a cheaper run. Without this term two prompts that merge
 * equally often would be separated by pennies while one of them was leaving branches
 * that do not compile.
 *
 * A merged branch that failed its checks stays a success here, because a human merged it
 * anyway and that was their call to make. It is counted in
 * `verificationFailed` all the same, so the sentence still says so.
 */
 const verificationGap = previous.verificationFailureRate - revised.verificationFailureRate

 if (verificationGap > SUCCESS_RATE_TOLERANCE) {
 return {
 revised,
 previous,
 verdict: 'better',
 detail:
 `Outcomes are level (${asPercent(revised.successRate)} against ` +
 `${asPercent(previous.successRate)} merged), and the agent's version leaves fewer ` +
 `branches failing this repository's definition of done.${verification}`,
 }
 }

 if (verificationGap < -SUCCESS_RATE_TOLERANCE) {
 return {
 revised,
 previous,
 verdict: 'worse',
 detail:
 `Outcomes are level (${asPercent(revised.successRate)} against ` +
 `${asPercent(previous.successRate)} merged), but the agent's version leaves more ` +
 `branches failing this repository's definition of done. Restoring the old one is ` +
 `the cheap fix.${verification}`,
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
 `${asMoney(previous.meanCostUsd)} a run, and their checks fail as often as each ` +
 `other's. Keeping it is as defensible as reverting it.${verification}`,
 }
}
