/**
 * The surrogate verifier — the fourth piece of the self-improvement loop,
 * and the last one.
 *
 * The self-improvement loop: "**A surrogate verifier**, an independent session that writes
 * its own assertions and is denied the generator's context. *Does not exist,* and it is the
 * piece with the most evidence behind it: EvoSkills reports 71.1% against 53.5% for
 * human-curated skills using exactly this construction."
 *
 * ## What it is for, given that it may not touch the fitness
 *
 * The self-improvement loop is unambiguous that "fitness is run disposition, never the
 * model's own assessment", and this is a model's assessment. So the verdict is **recorded
 * beside the measurement and never inside it**. That is not a consolation prize — it buys
 * two things the measurement cannot:
 *
 * 1. **It arrives first.** A search needs five decided runs on every arm; a verdict needs
 *    one run. For most of a search's life the measurement says "still measuring", and a
 *    human deciding whether to leave it running has nothing else to read.
 * 2. **It sees what no run has hit yet.** A candidate that tells future runs to skip the
 *    tests, or that bakes in one task's specifics, may merge fine for a fortnight before the
 *    disposition catches it. A reader looking at the text catches it in one pass.
 *
 * ## Why it is blinded, and what "denied the generator's context" costs
 *
 * The own decision: "The verifier is a different session and a different persona. Not
 * merely a second call: The 'nothing is settled by vote' rests on measured stance
 * homogenization and factual attrition, worst exactly where agents share a model. A
 * verifier that inherits the generator's context agrees with it."
 *
 * So three things are withheld, each closing a specific way agreement gets manufactured:
 *
 * - **The rationales.** The generator said why each candidate is worth trying, and that
 *   argument is exactly what a second model with the same weights would find persuasive.
 * - **Which one is live.** Told, a verifier either defends the status quo or over-corrects
 *   against it; either way the answer is about incumbency rather than about the text.
 * - **Who wrote what**, and the shared worker-note ledger the generator's run wrote into
 *   (suppressed at dispatch, where the ledger is assembled).
 *
 * The order is **deterministic, never random**: a hash of the set and the option, so the
 * same search always blinds the same way. Randomness here would make a verdict
 * unreproducible from the journal and would make this file untestable — the same reason
 * every arm assignment in this platform alternates rather than sampling.
 */

import type { PersonaVariantId, PersonaVariantSetId } from './ids.js'

/**
 * One blinded option. `variantId` null is the prompt in use, and the verifier is not told
 * which one that is — the key is all it sees.
 */
export interface BlindedOption {
  readonly key: string
  readonly variantId: PersonaVariantId | null
  readonly body: string
}

/** The keys, in order. Two candidates plus the incumbent is the common case. */
const KEYS = ['A', 'B', 'C', 'D', 'E'] as const

/**
 * FNV-1a, 32-bit. A hash rather than an ordering by id so the blinding does not correlate
 * with the order candidates were proposed in — the first-proposed candidate must not
 * reliably be option A, or the shuffle is decoration.
 */
const hash = (value: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Assigns option keys to the candidates and the prompt in use, deterministically.
 *
 * The incumbent is in the list and unmarked, which is the whole point: a verifier that could
 * tell which prompt a workspace is already running would be answering a different question.
 */
export const blindVariantOptions = (input: {
  readonly setId: PersonaVariantSetId
  readonly incumbentBody: string
  readonly candidates: readonly { readonly id: PersonaVariantId; readonly body: string }[]
}): BlindedOption[] => {
  const entries = [
    { variantId: null as PersonaVariantId | null, body: input.incumbentBody, seed: 'incumbent' },
    ...input.candidates.map((candidate) => ({
      variantId: candidate.id as PersonaVariantId | null,
      body: candidate.body,
      seed: candidate.id as string,
    })),
  ]
  return entries
    .map((entry) => ({ ...entry, rank: hash(`${input.setId}:${entry.seed}`) }))
    .sort((a, b) => (a.rank === b.rank ? a.seed.localeCompare(b.seed) : a.rank - b.rank))
    .slice(0, KEYS.length)
    .map((entry, index) => ({
      key: KEYS[index] as string,
      variantId: entry.variantId,
      body: entry.body,
    }))
}

/**
 * What the verifier is asked, and it is the whole of its context.
 *
 * Platform-authored and assembled here rather than on the Runner, for the reason every other
 * pre-rendered prompt in this platform is: the *withholding* is the mitigation, and a second
 * formatter would be a second place to leak a rationale into it.
 *
 * "Write your own assertions" is the phrase and the last paragraph is it: a verdict
 * with no concrete failure attached to it is a preference, and a preference from a model
 * about a prompt another model wrote is the thing mastery refuses to settle anything by.
 */
export const renderVerifierTask = (input: {
  readonly personaDescription: string
  readonly options: readonly BlindedOption[]
}): string =>
  [
    `Below are ${input.options.length} candidate sets of standing instructions for an agent that`,
    `works in this repository. Its job: ${input.personaDescription}`,
    '',
    'One of them is the instructions it is running with today and the others are proposals.',
    'You are not told which is which, who wrote any of them, or what anybody said in their',
    'favour — deliberately, because the argument for a proposal is the easiest thing in the',
    'world for you to agree with, and this is worth nothing if you do.',
    '',
    ...input.options.flatMap((option) => [
      `--- OPTION ${option.key} ---`,
      option.body.trim(),
      '',
    ]),
    '--- END OF OPTIONS ---',
    '',
    'Read enough of this repository to have a real opinion — the conventions it actually',
    'enforces, how its tests are laid out, what a change here has to get right. Then pick the',
    'ONE option you would want every future run of this agent to be given, and call your',
    'submit_variant_verdict tool with its letter.',
    '',
    'Your reason must be an assertion, not a preference: name one concrete thing a run',
    'following an option you rejected would get wrong in THIS repository, and say how you',
    'would find out. "Clearer" and "more thorough" are not reasons. If two options are',
    'genuinely equivalent for this repository, say so and pick the shorter one — an',
    'instruction is charged to every future run, so length is a cost and not a virtue.',
  ].join('\n')

export type VerifierVerdictResult =
  | { readonly ok: true; readonly variantId: PersonaVariantId | null }
  | { readonly ok: false; readonly reason: string }

/**
 * Maps the letter a verifier answered back to what it chose.
 *
 * Refused rather than defaulted when the letter is not one that was offered. A verdict is a
 * single fact about a search, and guessing which option a model meant would write a
 * *fabricated* one — the shape of thing this platform refuses everywhere structure comes
 * from a model.
 */
export const resolveVerifierChoice = (
  options: readonly BlindedOption[],
  choice: string,
): VerifierVerdictResult => {
  const found = options.find((option) => option.key === choice.trim().toUpperCase())
  if (!found) {
    return {
      ok: false,
      reason:
        `"${choice}" is not one of the options. Answer with a single letter: ` +
        `${options.map((option) => option.key).join(', ')}.`,
    }
  }
  return { ok: true, variantId: found.variantId }
}

/**
 * One sentence a human reads, saying what the verifier chose and whether the runs agree.
 *
 * The disagreement is the interesting case and it is stated as a disagreement rather than
 * resolved: the self-improvement loop gives the measurement the last word on fitness and
 * gives a human the last word on the prompt, so a panel that reconciled the two would be
 * inventing an authority neither has.
 */
export const describeVerifierVerdict = (input: {
  readonly pickedVariantId: PersonaVariantId | null
  readonly leader: PersonaVariantId | null
  /** How the candidate it picked is doing, when it picked one. */
  readonly measured: boolean
}): string => {
  const picked = input.pickedVariantId === null ? 'the prompt already in use' : 'one of the candidates'
  if (!input.measured) {
    return (
      `A verifier that was shown the options unlabelled — no rationales, and not told which ` +
      `was live — would keep ${picked}. It is a second opinion and it counts for nothing in ` +
      `the measurement, which has not finished yet.`
    )
  }
  if (input.pickedVariantId === input.leader) {
    return (
      `The verifier and the runs agree: both point at ${picked}. The verdict counts for ` +
      `nothing in the measurement — it is the runs that decided — but agreement is worth ` +
      `knowing when you are the one clicking promote.`
    )
  }
  return (
    `The verifier disagrees with the runs: shown the options unlabelled it would keep ` +
    `${picked}, while the outcomes favour something else. The measurement decides the ` +
    `fitness and you decide the prompt; this is only worth reading before you do.`
  )
}
