/**
 * The searching half of the self-improvement loop — **variants**.
 *
 * The self-improvement loop names four pieces an evolutionary loop needs: variants, a
 * fitness, an archive and a verifier. Three existed. This is the first: *more than one
 * candidate at a time*.
 *
 * Until now a persona could hold exactly two prompts — the live one and the one it
 * replaced — so the platform could ask "was that edit an improvement?" and never "which of
 * these is best?". One candidate per edit makes the loop a hill climb with a step size of
 * one and no way to compare siblings; the own evidence for the alternative is
 * EvoSkills, where breadth is what the 71.1%-against-53.5% result comes from.
 *
 * ## What a variant is, and the one decision that makes it safe
 *
 * **A variant is a self-edit that has not been made.** Every candidate body goes through
 * `revisePromptBody` and every candidate tool list through `reviseToolList` — the same
 * validators, the same envelope check, the same round trip, the same refusal to open with a
 * frontmatter delimiter. Nothing here re-implements any of that, and that is the whole
 * safety argument: a variant cannot reach a configuration a self-edit could not, because it
 * *is* one, held back from the persona row.
 *
 * So a variant carries a complete persona document rather than a body — which is what lets
 * the second component exist at all. Promotion is then a write of a document that was
 * already validated against the persona it belongs to, not a re-derivation at the moment a
 * human clicks.
 *
 * ## Why tool lists are arms and not merely permitted
 *
 * Tier 2 has always let an agent change its own tool list and nothing has ever measured one:
 * the prompt trial measures a prompt body, and a tool list is not one, so every such edit is
 * on the record reading "captured, and nothing measured it". The screen, the arms, the
 * verifier and the promotion gate are all written against a *document*, so making a tool list
 * an arm needs no new machinery and no new authority — only a validator dispatch and a set
 * that says which component it varies.
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
 * It does not promote. The self-improvement loop says the loop "needs no new human gate,
 * and that is a consequence rather than a choice" — every write it makes is a tier-1 write
 * the envelope already permits. That cuts the other way too: it takes no authority either,
 * so the platform never swaps a persona's prompt on a human's behalf however lopsided the
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
import { describeRevertedMerges } from './reverted-merges.js'
import {
  revisePromptBody,
  reviseToolList,
  type SelfEditVerdict,
  type SupersededPrompt,
} from './self-edit.js'

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

/**
 * Which part of the persona document a search varies.
 *
 * Two, because two tiers of self-editing exist: tier 1 writes a prompt body and tier 2 writes
 * a tool list. Anything else on the document is what the envelope bounds, and a tier that
 * could set those would be an agent moving inside its ceiling by moving the ceiling's axes —
 * so there is no third value to add here without first adding a tier that could reach it.
 */
export type VariantComponent = 'body' | 'tools'

export type VariantProposal =
  | {
      readonly kind: 'body'
      readonly body: string
      /** Why this candidate is different from its siblings — what it would make a run do. */
      readonly rationale: string
    }
  | {
      readonly kind: 'tools'
      /** The complete list this candidate would hold — not a delta, exactly as tier 2 takes it. */
      readonly tools: readonly string[]
      readonly rationale: string
    }

export type VariantSetRule =
  /** Fewer than `MIN_VARIANTS_PER_SET` — that is a tier-1 edit, not a search. */
  | 'too-few'
  | 'too-many'
  /** Two candidates in the same set produce the same document, so one arm measures nothing. */
  | 'duplicate'
  /** A measurement of this persona is already running (a trial, or another search). */
  | 'already-measuring'
  /** One of the candidates was refused by the tier that owns it — carries that reason. */
  | 'candidate-refused'
  /** Candidates in one set vary different components — see `proposeVariantSet`. */
  | 'mixed-components'

export type VariantSetVerdict =
  | {
      readonly ok: true
      /**
       * What every candidate in this set varies.
       *
       * Stored on the set rather than derived per candidate, because it is a property of the
       * *search*: it is what the verdict will be read as evidence about, and what the
       * provenance line a human reads before promoting has to name.
       */
      readonly component: VariantComponent
      /** In the order proposed, each with the complete document that would be promoted. */
      readonly candidates: readonly { readonly markdown: string; readonly body: string; readonly rationale: string }[]
    }
  | { readonly ok: false; readonly rule: VariantSetRule; readonly reason: string }

/**
 * Validates a set of candidates.
 *
 * `measurementOpen` is the caller's answer to "is anything already being measured for this
 * persona" — a prompt trial from tier 1, or an earlier search. Passed in rather than looked
 * up here because the domain has no storage, and refused rather than queued: continuity
 * mode is explicit that a refusal reaches the agent as a request a human could grant.
 *
 * ## Why a set varies one component and never two
 *
 * A search over three candidates where one rewrites the prompt and one swaps a tool spends
 * the single measurement slot a persona has on two questions and answers neither. Each arm
 * would still be compared against the incumbent honestly — that part survives — but the
 * *search* is what gets read afterwards, by the evolution walk, by the provenance line, and
 * by clause-level attribution across lineages, and none of those can say what a mixed set
 * was searching over.
 *
 * This is the same exclusivity rule the proposer's brief sources take, for the same reason:
 * a comparison needs something it is a comparison *against*, and a set carrying everything
 * leaves no arm to be that.
 */
export const proposeVariantSet = (input: {
  readonly currentMarkdown: string
  readonly proposals: readonly VariantProposal[]
  /** How many self-revisions this run has already made — tier 1's per-run cap applies. */
  readonly revisionsThisRun: number
  readonly measurementOpen: boolean
  /**
   * Every prompt this persona used to have, forwarded to tier 1's validator.
   *
   * A search is where this check pays most. A re-proposed tier-1 edit costs one refusal; a
   * re-proposed *candidate* opens an arm that needs five decided runs to reach a verdict the
   * revision history already holds, and it does so while occupying the one measurement slot
   * a persona has.
   */
  readonly supersededPrompts?: readonly SupersededPrompt[]
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

  const component = input.proposals[0]?.kind ?? 'body'
  if (input.proposals.some((proposal) => proposal.kind !== component)) {
    return {
      ok: false,
      rule: 'mixed-components',
      reason:
        'Those candidates do not vary the same thing — some change the prompt and some change ' +
        'the tool list. One search measures one question, because a persona is measured one ' +
        'way at a time and a mixed set spends that slot on two. Send the prompts, settle that ' +
        'search, then send the tool lists.',
    }
  }

  const seen = new Set<string>()
  const candidates: { markdown: string; body: string; rationale: string }[] = []

  for (const [index, proposal] of input.proposals.entries()) {
    /**
     * The validator of the tier that owns this component, per candidate — the reuse this
     * file exists to make. Each supplies the checks nobody would think to repeat here: the
     * envelope, the round trip, "identical to what you already have", and for a body the
     * refusal to open with `---`.
     *
     * `revisionsThisRun` is passed straight through so the per-run cap covers a search as
     * well: a run may propose one set or make one edit, never both. A model that has
     * already rewritten its prompt has learned nothing since.
     */
    const verdict: SelfEditVerdict =
      proposal.kind === 'body'
        ? revisePromptBody({
            currentMarkdown: input.currentMarkdown,
            body: proposal.body,
            revisionsThisRun: input.revisionsThisRun,
            ...(input.supersededPrompts ? { supersededPrompts: input.supersededPrompts } : {}),
          })
        : reviseToolList({
            currentMarkdown: input.currentMarkdown,
            tools: [...proposal.tools],
            revisionsThisRun: input.revisionsThisRun,
          })
    if (!verdict.ok) {
      return {
        ok: false,
        rule: 'candidate-refused',
        reason: `Candidate ${index + 1} of ${input.proposals.length} was refused, so nothing was recorded: ${verdict.reason}`,
      }
    }
    /**
     * Compared on what the component *means*, not on the document.
     *
     * A document comparison looks like the general rule and is wrong for tools: the
     * serializer preserves the order it is given, so `[Read, Grep]` and `[Grep, Read]` are
     * two different documents and one arm measured twice. What makes two tool lists the same
     * candidate is holding the same tools, so that is the key.
     */
    const key =
      proposal.kind === 'body'
        ? verdict.body
        : [...new Set(proposal.tools.map((tool) => tool.trim()).filter((t) => t.length > 0))]
            .sort()
            .join(' ')
    if (seen.has(key)) {
      return {
        ok: false,
        rule: 'duplicate',
        reason:
          component === 'body'
            ? `Candidate ${index + 1} is character-for-character one of the others. Two identical ` +
              'arms measure nothing and cost twice — send prompts that differ in what they would ' +
              'make a future run *do*, not in how they are worded.'
            : `Candidate ${index + 1} holds the same tools as one of the others. Order is not a ` +
              'difference — two arms with the same tools measure nothing and cost twice. Send ' +
              'lists that differ in what a future run could actually reach for.',
      }
    }
    seen.add(key)
    candidates.push({
      markdown: verdict.markdown,
      body: verdict.body,
      rationale: proposal.rationale.trim(),
    })
  }

  return { ok: true, component, candidates }
}

/**
 * Which arm the next run of this persona goes on — a candidate, or the prompt it has.
 *
 * `null` is the incumbent: the live prompt, which is the control group and needs no row of
 * its own to be run. Least-used first, deterministically, so a burst of concurrent starts
 * spreads instead of piling onto one arm.
 *
 * **Ties go to the incumbent**, which is the rule rather than the self-improvement loop's.
 * The prompt trial sends the first run to the *revision* because the agent's edit is
 * already live — running the old prompt would silently revert what the persona says. Here
 * nothing is live yet: every candidate is held back, so at zero-and-zero the honest first
 * sample is the prompt the workspace actually has, and a persona used only once has
 * measured its real behaviour rather than an untested candidate's.
 */
export const nextVariantArm = (
  used: readonly { readonly variantId: PersonaVariantId | null; readonly count: number }[],
  candidateIds: readonly PersonaVariantId[],
): PersonaVariantId | null => {
  const countOf = (id: PersonaVariantId | null) =>
    used.find((entry) => entry.variantId === id)?.count ?? 0
  // The incumbent first, so it wins every tie by being seen first.
  const arms: (PersonaVariantId | null)[] = [null, ...candidateIds]
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
  /** Merged branches on this arm a later merge took back out. Reported, never scored. */
  readonly reverted: number
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
  successRate: tally.decided === 0 ? 0 : tally.merged / tally.decided,
  meanCostUsd: tally.decided === 0 ? 0 : tally.costUsdTotal / tally.decided,
  verificationFailureRate: verificationFailureRate(tally),
  standing,
})

const EMPTY = (variantId: PersonaVariantId | null): VariantArmTally => ({
  variantId,
  decided: 0,
  merged: 0,
  reverted: 0,
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
 * one another would multiply the comparisons a five-run sample has to support, and portable
 * expertise is already candid that five is a compromise. The incumbent is the control
 * because it is the thing a promotion would displace.
 *
 * The leader is the candidate that beats the incumbent by the most on the term that
 * decided it — outcomes, then the definition of done, then cost, which is
 * `compareTrialArms`'s order and not a second opinion about it.
 */
export const summarizeVariantSearch = (
  tallies: readonly VariantArmTally[],
  candidateIds: readonly PersonaVariantId[],
  /**
   * What the search varies, which only the phrasing depends on — every threshold, every
   * comparison and the leader are identical either way, because a document is a document.
   * Defaulted so a caller that has not been taught about the second component says the thing
   * that was true when there was only one.
   */
  component: VariantComponent = 'body',
): VariantSearchEffect => {
  const incumbentNoun = component === 'tools' ? 'the tools it has now' : 'the prompt in use'
  const heldNoun =
    component === 'tools' ? 'the tools this persona actually holds' : 'the prompt this persona actually has'
  const alreadyNoun =
    component === 'tools' ? 'the tools this persona already holds' : 'the prompt this persona already has'
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
      favours === 'candidate' ? 'better' : favours === 'control' ? 'worse' : 'no-better',
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
          compareTrialArms(arm, best).favours === 'candidate' ? arm : best,
        ).variantId

  const arms = [incumbent, ...candidates]
  const undecided = arms.filter((arm) => arm.decided < MIN_DECIDED_RUNS_PER_ARM).length

  const asPercent = (rate: number) => `${Math.round(rate * 100)}%`
  const verification =
    describeVerificationFailures(
      { label: 'the candidates', ...aggregate(candidates) },
      { label: incumbentNoun, ...incumbentTally },
    ) +
    // See `describeRevertedMerges`: reported beside the merge rate, never scored against an arm.
    describeRevertedMerges(
      {
        label: 'the candidates',
        reverted: candidates.reduce((sum, arm) => sum + arm.reverted, 0),
        merged: candidates.reduce((sum, arm) => sum + arm.merged, 0),
      },
      {
        label: incumbentNoun,
        reverted: incumbentTally.reverted,
        merged: incumbentTally.merged,
      },
    )

  if (undecided > 0) {
    return {
      arms,
      leader: null,
      detail:
        `Still measuring: ${undecided} of ${arms.length} arms have fewer than ` +
        `${MIN_DECIDED_RUNS_PER_ARM} finished runs. Every candidate is compared against ` +
        `${heldNoun}, so the comparison waits for that arm too.` +
        verification,
    }
  }

  if (leader === null) {
    return {
      arms,
      leader: null,
      detail:
        `Measured, and none of the candidates beat ${alreadyNoun} ` +
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
        `${asPercent(incumbent.successRate)} for ${incumbentNoun}`
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
      `and never changes ${incumbentNoun} on your behalf.${verification}`,
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
