/**
 * The searching half of the self-improvement loop — **variants**.
 *
 * The self-improvement loop names four pieces an evolutionary loop needs: variants, a fitness, an archive and
 * a verifier. Three existed. This is the first: *more than one candidate at a time*.
 *
 * Until now a persona could hold exactly two prompts — the live one and the one it
 * replaced — so the platform could ask "was that edit an improvement?" and never "which of
 * these is best?". One candidate per edit makes the loop a hill climb with a step size of
 * one and no way to compare siblings; the own evidence for the alternative is
 * EvoSkills, where breadth is what the 71.1%-against-53.5% result comes from.
 *
 * ## What a variant is, and the one decision that makes it safe
 *
 * **A variant is a tier-1 edit that has not been made.** Every candidate body goes through
 * `revisePromptBody` — the same validator, the same envelope check, the same round trip,
 * the same refusal to open with a frontmatter delimiter. Nothing here re-implements any of
 * that, and that is the whole safety argument: a variant cannot reach a configuration a
 * tier-1 edit could not, because it *is* one, held back from the persona row.
 *
 * So a variant carries a complete persona document rather than a body. Promotion is then a
 * write of a document that was already validated against the persona it belongs to, not a
 * re-derivation at the moment a human clicks.
 *
 * ## Why the search is serialized per persona
 *
 * One open search per persona, enforced by a unique partial index rather than by a belief
 * (the merge queue's and the verification harness's pattern, for the same reason). Two
 * searches would split one workspace's runs across five or six arms, and the five
 * decided runs an arm — already a compromise against a real power calculation — would
 * become unreachable. A prompt trial on a revision blocks a search and vice versa: they
 * substitute the same field of the same snapshot, so running both means neither converges.
 *
 * ## What this file deliberately does not do
 *
 * It does not promote. The self-improvement loop says the loop "needs no new human gate, and that is a
 * consequence rather than a choice" — every write it makes is a tier-1 write the envelope
 * already permits. That cuts the other way too: it takes no authority either, so the
 * platform never swaps a persona's prompt on a human's behalf however lopsided the
 * evidence gets. The measurement ranks; a person decides. `promoteVariant` is human-only in
 * the use case, exactly as `keepPromptRevision` is.
 */

import {
 MIN_DECIDED_RUNS_PER_ARM,
 compareTrialArms,
 describeVerificationFailures,
 verificationFailureRate,
 type VerificationTally,
} from './expertise-trial.js'
import type { PersonaVariantId } from './ids.js'
import { revisePromptBody, type SelfEditVerdict } from './self-edit.js'

/**
 * How many candidates one search may hold, and why it is small.
 *
 * Every candidate is an arm, every arm needs `MIN_DECIDED_RUNS_PER_ARM` finished runs, and
 * the incumbent is an arm too — so three candidates is already twenty decided runs before
 * the search can say anything. The "cost is a term in the fitness, not an
 * externality" applies to the search itself: a wider search is not a better one if a
 * workspace never reaches its verdict.
 */
export const MAX_VARIANTS_PER_SET = 3

/**
 * And why there is a floor as well.
 *
 * A "search" over one candidate is a tier-1 edit with extra ceremony and a worse outcome —
 * the edit does not go live, so the persona keeps the prompt the agent thought was worse.
 * An agent with exactly one idea should call `revise_own_prompt`.
 */
export const MIN_VARIANTS_PER_SET = 2

export interface VariantProposal {
 readonly body: string
 /** Why this candidate is different from its siblings — what it would make a run do. */
 readonly rationale: string
}

export type VariantSetRule =
 /** Fewer than `MIN_VARIANTS_PER_SET` — that is a tier-1 edit, not a search. */
 | 'too-few'
 | 'too-many'
 /** Two candidates in the same set are byte-identical, so one arm measures nothing. */
 | 'duplicate'
 /** A measurement of this persona is already running (a trial, or another search). */
 | 'already-measuring'
 /** One of the candidates was refused by tier 1's own rules — carries that reason. */
 | 'candidate-refused'

export type VariantSetVerdict =
 | {
 readonly ok: true
 /** In the order proposed, each with the complete document that would be promoted. */
 readonly candidates: readonly { readonly markdown: string; readonly body: string; readonly rationale: string }[]
 }
 | { readonly ok: false; readonly rule: VariantSetRule; readonly reason: string }

/**
 * Validates a set of candidate prompts.
 *
 * `measurementOpen` is the caller's answer to "is anything already being measured for this
 * persona" — a prompt trial from tier 1, or an earlier search. Passed in rather than looked
 * up here because the domain has no storage, and refused rather than queued: continuity mode is
 * explicit that a refusal reaches the agent as a request a human could grant.
 */
export const proposeVariantSet = (input: {
 readonly currentMarkdown: string
 readonly proposals: readonly VariantProposal[]
 /** How many self-revisions this run has already made — tier 1's per-run cap applies. */
 readonly revisionsThisRun: number
 readonly measurementOpen: boolean
}): VariantSetVerdict => {
 if (input.measurementOpen) {
 return {
 ok: false,
 rule: 'already-measuring',
 reason:
 'A measurement of this persona is already running, and a second one would split the ' +
 'same runs across more arms than a workspace can fill — neither would ever reach a ' +
 'verdict. A human settles the open one (keep it, or put the old prompt back) and ' +
 'then a search can start. If you have something to record now, write a note: your ' +
 'siblings read those and nobody pays for them twice.',
 }
 }

 if (input.proposals.length < MIN_VARIANTS_PER_SET) {
 return {
 ok: false,
 rule: 'too-few',
 reason:
 `A search needs at least ${MIN_VARIANTS_PER_SET} candidates — with one there is ` +
 'nothing to compare it against except the prompt you already have, and that is ' +
 'revise_own_prompt, which also makes your version live instead of holding it back. ' +
 'Send two or three genuinely different prompts, or make the edit.',
 }
 }
 if (input.proposals.length > MAX_VARIANTS_PER_SET) {
 return {
 ok: false,
 rule: 'too-many',
 reason:
 `That is ${input.proposals.length} candidates and the limit is ${MAX_VARIANTS_PER_SET}. ` +
 `Each one is an arm needing ${MIN_DECIDED_RUNS_PER_ARM} finished runs before it says ` +
 'anything, and the prompt you already have is an arm too — a wider search is not a ' +
 'better one if this workspace never reaches its verdict.',
 }
 }

 const bodies = new Set<string>
 const candidates: { markdown: string; body: string; rationale: string }[] = []

 for (const [index, proposal] of input.proposals.entries) {
 /**
 * Tier 1's validator, per candidate — the reuse this file exists to make. It also
 * supplies the checks nobody would think to repeat here: the envelope, the round trip,
 * the refusal to open with `---`, and "identical to the prompt you already have".
 *
 * `revisionsThisRun` is passed straight through so the per-run cap covers a search as
 * well: a run may propose one set or make one edit, never both. A model that has
 * already rewritten its prompt has learned nothing since.
 */
 const verdict: SelfEditVerdict = revisePromptBody({
 currentMarkdown: input.currentMarkdown,
 body: proposal.body,
 revisionsThisRun: input.revisionsThisRun,
 })
 if (!verdict.ok) {
 return {
 ok: false,
 rule: 'candidate-refused',
 reason: `Candidate ${index + 1} of ${input.proposals.length} was refused, so nothing was recorded: ${verdict.reason}`,
 }
 }
 if (bodies.has(verdict.body)) {
 return {
 ok: false,
 rule: 'duplicate',
 reason:
 `Candidate ${index + 1} is character-for-character one of the others. Two identical ` +
 'arms measure nothing and cost twice — send prompts that differ in what they would ' +
 'make a future run *do*, not in how they are worded.',
 }
 }
 bodies.add(verdict.body)
 candidates.push({
 markdown: verdict.markdown,
 body: verdict.body,
 rationale: proposal.rationale.trim,
 })
 }

 return { ok: true, candidates }
}

/**
 * Which arm the next run of this persona goes on — a candidate, or the prompt it has.
 *
 * `null` is the incumbent: the live prompt, which is the control group and needs no row of
 * its own to be run. Least-used first, deterministically, so a burst of concurrent starts
 * spreads instead of piling onto one arm.
 *
 * **Ties go to the incumbent**, which is the rule rather than the self-improvement loop's. The prompt
 * trial sends the first run to the *revision* because the agent's edit is already live —
 * running the old prompt would silently revert what the persona says. Here nothing is
 * live yet: every candidate is held back, so at zero-and-zero the honest first sample is
 * the prompt the workspace actually has, and a persona used only once has measured its
 * real behaviour rather than an untested candidate's.
 */
export const nextVariantArm = (
 used: readonly { readonly variantId: PersonaVariantId | null; readonly count: number }[],
 candidateIds: readonly PersonaVariantId[],
): PersonaVariantId | null => {
 const countOf = (id: PersonaVariantId | null) =>
 used.find((entry) => entry.variantId === id)?.count ?? 0
 // The incumbent first, so it wins every tie by being seen first.
 const arms: (PersonaVariantId | null)[] = [null,...candidateIds]
 let best: PersonaVariantId | null = null
 let bestCount = Number.POSITIVE_INFINITY
 for (const arm of arms) {
 const count = countOf(arm)
 if (count < bestCount) {
 best = arm
 bestCount = count
 }
 }
 return best
}

export interface VariantArmTally extends VerificationTally {
 /** `null` is the incumbent — the prompt the persona actually has. */
 readonly variantId: PersonaVariantId | null
 readonly decided: number
 readonly merged: number
 readonly discarded: number
 readonly failed: number
 readonly costUsdTotal: number
}

export interface VariantArmSummary extends VariantArmTally {
 readonly successRate: number
 readonly meanCostUsd: number
 readonly verificationFailureRate: number
 /**
 * How this arm compares to the incumbent. `undecided` until both sides have
 * `MIN_DECIDED_RUNS_PER_ARM`, and always `undecided` on the incumbent itself — an arm
 * cannot be better than the thing it is.
 */
 readonly standing: 'undecided' | 'better' | 'worse' | 'no-better'
}

export interface VariantSearchEffect {
 readonly arms: readonly VariantArmSummary[]
 /**
 * The candidate a human should look at first, or null when nothing has separated itself.
 *
 * A recommendation and never an action. The loop takes no authority: it ranks, and
 * a person promotes.
 */
 readonly leader: PersonaVariantId | null
 readonly detail: string
}

const summarizeArm = (tally: VariantArmTally, standing: VariantArmSummary['standing']): VariantArmSummary => ({
...tally,
 successRate: tally.decided === 0 ? 0: tally.merged / tally.decided,
 meanCostUsd: tally.decided === 0 ? 0: tally.costUsdTotal / tally.decided,
 verificationFailureRate: verificationFailureRate(tally),
 standing,
})

const EMPTY = (variantId: PersonaVariantId | null): VariantArmTally => ({
 variantId,
 decided: 0,
 merged: 0,
 discarded: 0,
 failed: 0,
 costUsdTotal: 0,
 verificationFailed: 0,
 failingCheck: null,
})

/**
 * What the runs so far say about a search.
 *
 * **Every candidate is compared against the incumbent, never against each other.** Two
 * candidates that both beat the prompt in use are both worth having; ranking them against
 * one another would multiply the comparisons a five-run sample has to support, and portable expertise
 * is already candid that five is a compromise. The incumbent is the control because it is
 * the thing a promotion would displace.
 *
 * The leader is the candidate that beats the incumbent by the most on the term that
 * decided it — outcomes, then the definition of done, then cost, which is
 * `compareTrialArms`'s order and not a second opinion about it.
 */
export const summarizeVariantSearch = (
 tallies: readonly VariantArmTally[],
 candidateIds: readonly PersonaVariantId[],
): VariantSearchEffect => {
 const tallyFor = (id: PersonaVariantId | null) =>
 tallies.find((tally) => tally.variantId === id) ?? EMPTY(id)

 const incumbentTally = tallyFor(null)
 const incumbent = summarizeArm(incumbentTally, 'undecided')

 const candidates = candidateIds.map((id) => {
 const tally = tallyFor(id)
 const provisional = summarizeArm(tally, 'undecided')
 if (
 provisional.decided < MIN_DECIDED_RUNS_PER_ARM ||
 incumbent.decided < MIN_DECIDED_RUNS_PER_ARM
) {
 return provisional
 }
 const { favours } = compareTrialArms(provisional, incumbent)
 return summarizeArm(
 tally,
 favours === 'candidate' ? 'better': favours === 'control' ? 'worse': 'no-better',
)
 })

 const better = candidates.filter((arm) => arm.standing === 'better')
 /**
 * Ordered by the same terms in the same order, so the leader is the one
 * `compareTrialArms` would pick out of the winners rather than whichever happens to be
 * first. A candidate that beats the incumbent on outcomes outranks one that beats it on
 * cost, because that is what the order of the terms means.
 */
 const leader =
 better.length === 0
 ? null
: better.reduce((best, arm) =>
 compareTrialArms(arm, best).favours === 'candidate' ? arm: best,
).variantId

 const arms = [incumbent,...candidates]
 const undecided = arms.filter((arm) => arm.decided < MIN_DECIDED_RUNS_PER_ARM).length

 const asPercent = (rate: number) => `${Math.round(rate * 100)}%`
 const verification = describeVerificationFailures(
 { label: 'the candidates',...aggregate(candidates) },
 { label: 'the prompt in use',...incumbentTally },
)

 if (undecided > 0) {
 return {
 arms,
 leader: null,
 detail:
 `Still measuring: ${undecided} of ${arms.length} arms have fewer than ` +
 `${MIN_DECIDED_RUNS_PER_ARM} finished runs. Every candidate is compared against the ` +
 'prompt this persona actually has, so the comparison waits for that arm too.' +
 verification,
 }
 }

 if (leader === null) {
 return {
 arms,
 leader: null,
 detail:
 'Measured, and none of the candidates beat the prompt this persona already has ' +
 `(${arms.map((arm) => asPercent(arm.successRate)).join(' / ')} merged). Discarding ` +
 'the search keeps every candidate on the record, which is what stops the next one ' +
 `proposing a version this workspace already paid to reject.${verification}`,
 }
 }

 const winner = candidates.find((arm) => arm.variantId === leader)!
 const { term } = compareTrialArms(winner, incumbent)
 const because =
 term === 'outcomes'
 ? `it got work merged ${asPercent(winner.successRate)} of the time against ` +
 `${asPercent(incumbent.successRate)} for the prompt in use`
: term === 'verification'
 ? 'outcomes are level and it leaves fewer branches failing this repository\'s ' +
 'definition of done'
: `outcomes are level and it costs $${winner.meanCostUsd.toFixed(4)} a run against ` +
 `$${incumbent.meanCostUsd.toFixed(4)}`
 return {
 arms,
 leader,
 detail:
 `One candidate is ahead: ${because}. Promoting it is a human's act — the loop ranks ` +
 `and never swaps a prompt on your behalf.${verification}`,
 }
}

/** The candidates as one side, for the verification clause only. */
const aggregate = (
 candidates: readonly VariantArmSummary[],
): { decided: number } & VerificationTally => ({
 decided: candidates.reduce((sum, arm) => sum + arm.decided, 0),
 verificationFailed: candidates.reduce((sum, arm) => sum + arm.verificationFailed, 0),
 /** The check that failed most across the candidates, by count of arms naming it. */
 failingCheck:
 candidates
.filter((arm) => arm.failingCheck !== null)
.sort((a, b) => b.verificationFailed - a.verificationFailed)[0]?.failingCheck ?? null,
})
