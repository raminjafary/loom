import { describe, expect, it } from 'vitest'
import { asPersonaVariantId, asPersonaVariantSetId } from './ids.js'
import {
 blindVariantOptions,
 describeVerifierVerdict,
 renderVerifierTask,
 resolveVerifierChoice,
} from './variant-verifier.js'

/**
 * The surrogate verifier.
 *
 * The tests that matter are about what the verifier is *not* told. A blinding that leaked the
 * rationale, or that reliably put the incumbent first, would produce a verdict that reads
 * exactly like a real one — which is the failure mode the self-improvement loop names when it says a verifier
 * inheriting the generator's context agrees with it.
 */

const SET = asPersonaVariantSetId('set-1')
const A = asPersonaVariantId('variant-a')
const B = asPersonaVariantId('variant-b')

const options = (setId = SET) =>
 blindVariantOptions({
 setId,
 incumbentBody: 'THE PROMPT IN USE.',
 candidates: [
 { id: A, body: 'CANDIDATE ALPHA.' },
 { id: B, body: 'CANDIDATE BETA.' },
 ],
 })

describe('blindVariantOptions', => {
 it('offers every option including the prompt in use, each with a letter', => {
 const blinded = options
 expect(blinded).toHaveLength(3)
 expect(blinded.map((option) => option.key)).toEqual(['A', 'B', 'C'])
 expect(blinded.map((option) => option.variantId).sort).toEqual([null, A, B].sort)
 })

 /** Same search, same blinding — a verdict has to be reproducible from the journal. */
 it('is deterministic for one search', => {
 expect(options).toEqual(options)
 })

 /**
 * And different across searches, which is what stops "option A" from being a synonym for
 * "the prompt in use" that a model could learn.
 */
 it('does not put the incumbent in the same place every time', => {
 const positions = new Set(
 ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => {
 const blinded = blindVariantOptions({
 setId: asPersonaVariantSetId(id),
 incumbentBody: 'THE PROMPT IN USE.',
 candidates: [
 { id: A, body: 'CANDIDATE ALPHA.' },
 { id: B, body: 'CANDIDATE BETA.' },
 ],
 })
 return blinded.find((option) => option.variantId === null)!.key
 }),
)
 expect(positions.size).toBeGreaterThan(1)
 })
})

describe('renderVerifierTask', => {
 const task = renderVerifierTask({
 personaDescription: 'Does the work.',
 options: options,
 })

 it('shows every option"s text and no rationale, no authorship, no incumbency', => {
 expect(task).toContain('CANDIDATE ALPHA.')
 expect(task).toContain('CANDIDATE BETA.')
 expect(task).toContain('THE PROMPT IN USE.')
 expect(task).toContain('You are not told which is which')
 // The three things the self-improvement loop withholds, asserted as absences.
 expect(task).not.toContain('rationale:')
 expect(task).not.toContain('proposed by')
 expect(task).not.toMatch(/option [ABC] is (the)?(current|live)/i)
 })

 /** The phrase: it writes its own assertions. A preference is not one. */
 it('asks for a concrete failure rather than a preference', => {
 expect(task).toContain('must be an assertion, not a preference')
 expect(task).toContain('"Clearer" and "more thorough" are not reasons')
 })
})

describe('resolveVerifierChoice', => {
 it('maps a letter back to what it stands for', => {
 const blinded = options
 const target = blinded[1]!
 expect(resolveVerifierChoice(blinded, target.key)).toEqual({
 ok: true,
 variantId: target.variantId,
 })
 // Case and whitespace are a model's formatting, not a different answer.
 expect(resolveVerifierChoice(blinded, ` ${target.key.toLowerCase} `)).toEqual({
 ok: true,
 variantId: target.variantId,
 })
 })

 /**
 * Refused rather than defaulted. Guessing which option a model meant would fabricate the
 * one fact this whole session exists to produce.
 */
 it('refuses a letter nobody offered, and says which were', => {
 const verdict = resolveVerifierChoice(options, 'Z')
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toContain('A, B, C')
 })
})

describe('describeVerifierVerdict', => {
 it('says it counts for nothing in the measurement, every time', => {
 const before = describeVerifierVerdict({ pickedVariantId: A, leader: null, measured: false })
 expect(before).toContain('counts for nothing in')

 const agrees = describeVerifierVerdict({ pickedVariantId: A, leader: A, measured: true })
 expect(agrees).toContain('agree')
 expect(agrees).toContain('counts for')

 const disagrees = describeVerifierVerdict({ pickedVariantId: B, leader: A, measured: true })
 expect(disagrees).toContain('disagrees')
 // Stated as a disagreement rather than resolved — neither side has that authority.
 expect(disagrees).toContain('you decide the prompt')
 })

 it('names the prompt in use when that is what it picked', => {
 expect(
 describeVerifierVerdict({ pickedVariantId: null, leader: null, measured: false }),
).toContain('the prompt already in use')
 })
})
