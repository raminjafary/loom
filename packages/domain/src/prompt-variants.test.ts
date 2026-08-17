import { describe, expect, it } from 'vitest'
import { MIN_DECIDED_RUNS_PER_ARM } from './expertise-trial.js'
import { asPersonaVariantId, type PersonaVariantId } from './ids.js'
import {
 MAX_VARIANTS_PER_SET,
 nextVariantArm,
 proposeVariantSet,
 summarizeVariantSearch,
 type VariantArmTally,
} from './prompt-variants.js'

/**
 * The searching half of the self-improvement loop — variants.
 *
 * The tests worth having are about the three things a search can get wrong in a way no
 * typecheck would notice: a candidate that reached past what tier 1 allows, an arm that
 * never accumulates because assignment is not balanced, and a leader announced before the
 * evidence exists.
 */

const PERSONA = [
 '---',
 'name: worker',
 'description: Does the work.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read]',
 'envelope:',
 ' tools: [Read]',
 '---',
 '',
 'The prompt it has now.',
].join('\n')

const NO_ENVELOPE = PERSONA.replace('envelope:\n tools: [Read]\n', '')

const proposals = (...bodies: string[]) =>
 bodies.map((body, i) => ({ body, rationale: `reason ${i + 1}` }))

const A = asPersonaVariantId('v-a')
const B = asPersonaVariantId('v-b')

const tally = (
 variantId: PersonaVariantId | null,
 over: Partial<VariantArmTally> = {},
): VariantArmTally => ({
 variantId,
 decided: MIN_DECIDED_RUNS_PER_ARM,
 merged: 0,
 discarded: 0,
 failed: 0,
 costUsdTotal: MIN_DECIDED_RUNS_PER_ARM * 0.1,
 verificationFailed: 0,
 failingCheck: null,
...over,
})

describe('proposeVariantSet', => {
 it('accepts two genuinely different candidates and hands back promotable documents', => {
 const verdict = proposeVariantSet({
 currentMarkdown: PERSONA,
 proposals: proposals('Try being terse.', 'Try reading the tests first.'),
 revisionsThisRun: 0,
 measurementOpen: false,
 })
 expect(verdict.ok).toBe(true)
 if (!verdict.ok) return
 expect(verdict.candidates).toHaveLength(2)
 // A complete document, so promoting one is a write of something already validated.
 expect(verdict.candidates[0]?.markdown).toContain('name: worker')
 expect(verdict.candidates[0]?.markdown).toContain('Try being terse.')
 expect(verdict.candidates[0]?.rationale).toBe('reason 1')
 })

 /**
 * The whole safety argument of this file: a variant is a tier-1 edit that has not been
 * made, so tier 1's refusals are its refusals. A persona with no envelope may not reach
 * this by a different door.
 */
 it('refuses every candidate a tier-1 edit would be refused', => {
 const noEnvelope = proposeVariantSet({
 currentMarkdown: NO_ENVELOPE,
 proposals: proposals('One.', 'Two.'),
 revisionsThisRun: 0,
 measurementOpen: false,
 })
 expect(noEnvelope.ok).toBe(false)
 if (noEnvelope.ok) return
 expect(noEnvelope.rule).toBe('candidate-refused')
 expect(noEnvelope.reason).toContain('no self-modification envelope')

 const frontmatter = proposeVariantSet({
 currentMarkdown: PERSONA,
 proposals: proposals('Fine.', '---\ntools: [Bash]\n---\n\nSneaky.'),
 revisionsThisRun: 0,
 measurementOpen: false,
 })
 expect(frontmatter.ok).toBe(false)
 if (frontmatter.ok) return
 // Named by position, so a human reading the refusal knows which one it was.
 expect(frontmatter.reason).toContain('Candidate 2 of 2')
 })

 it('refuses a set that is really one edit, and one that is too wide to converge', => {
 const one = proposeVariantSet({
 currentMarkdown: PERSONA,
 proposals: proposals('Only idea.'),
 revisionsThisRun: 0,
 measurementOpen: false,
 })
 expect(one.ok).toBe(false)
 if (!one.ok) expect(one.rule).toBe('too-few')

 const many = proposeVariantSet({
 currentMarkdown: PERSONA,
 proposals: proposals(...Array.from({ length: MAX_VARIANTS_PER_SET + 1 }, (_, i) => `Idea ${i}.`)),
 revisionsThisRun: 0,
 measurementOpen: false,
 })
 expect(many.ok).toBe(false)
 if (!many.ok) expect(many.rule).toBe('too-many')
 })

 it('refuses two identical candidates, which would be one arm charged twice', => {
 const verdict = proposeVariantSet({
 currentMarkdown: PERSONA,
 proposals: proposals('Same words.', 'Same words.'),
 revisionsThisRun: 0,
 measurementOpen: false,
 })
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.rule).toBe('duplicate')
 })

 /**
 * Two measurements on one persona means neither converges — the arms would be split
 * across more sides than a workspace fills.
 */
 it('refuses a search while something is already being measured', => {
 const verdict = proposeVariantSet({
 currentMarkdown: PERSONA,
 proposals: proposals('One.', 'Two.'),
 revisionsThisRun: 0,
 measurementOpen: true,
 })
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) {
 expect(verdict.rule).toBe('already-measuring')
 // A refusal a human could grant, which is what continuity mode requires of one.
 expect(verdict.reason).toContain('A human settles the open one')
 }
 })

 /**
 * The archive, forwarded to tier 1's validator.
 *
 * This is where the check earns its keep: a re-proposed *candidate* would occupy the one
 * measurement slot a persona has for as long as five decided runs an arm takes, to reach a
 * verdict the revision history already holds. The whole set is refused rather than the one
 * candidate dropped, because a set is what the agent proposed and silently measuring two
 * arms where it asked for three is a search it never designed.
 */
 it('refuses a candidate the persona already had, and says which of them it was', => {
 const verdict = proposeVariantSet({
 currentMarkdown: PERSONA,
 proposals: proposals('A new idea.', 'A prompt from before.'),
 revisionsThisRun: 0,
 measurementOpen: false,
 supersededPrompts: [{ body: 'A prompt from before.', replacedByKind: 'agent_run' }],
 })
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) {
 expect(verdict.rule).toBe('candidate-refused')
 expect(verdict.reason).toContain('Candidate 2 of 2')
 expect(verdict.reason).toContain('already had')
 }
 })

 it('accepts a set when the archive holds none of the candidates', => {
 const verdict = proposeVariantSet({
 currentMarkdown: PERSONA,
 proposals: proposals('One idea.', 'Another idea.'),
 revisionsThisRun: 0,
 measurementOpen: false,
 supersededPrompts: [{ body: 'Something else entirely.', replacedByKind: 'human' }],
 })
 expect(verdict.ok).toBe(true)
 })

 it('applies tier 1"s per-run cap, so a run proposes a set or makes an edit', => {
 const verdict = proposeVariantSet({
 currentMarkdown: PERSONA,
 proposals: proposals('One.', 'Two.'),
 revisionsThisRun: 1,
 measurementOpen: false,
 })
 expect(verdict.ok).toBe(false)
 if (!verdict.ok) expect(verdict.reason).toContain('already rewritten')
 })
})

describe('nextVariantArm', => {
 /**
 * The rule rather than the self-improvement loop's, and the asymmetry is the point: nothing is live
 * yet, so the honest first sample is the prompt the workspace actually has.
 */
 it('gives the first run to the prompt in use', => {
 expect(nextVariantArm([], [A, B])).toBeNull
 })

 it('spreads across every arm before revisiting one', => {
 expect(nextVariantArm([{ variantId: null, count: 1 }], [A, B])).toBe(A)
 expect(
 nextVariantArm([{ variantId: null, count: 1 }, { variantId: A, count: 1 }], [A, B]),
).toBe(B)
 expect(
 nextVariantArm(
 [
 { variantId: null, count: 1 },
 { variantId: A, count: 1 },
 { variantId: B, count: 1 },
 ],
 [A, B],
),
).toBeNull
 })

 it('sends the next run to whichever arm is furthest behind', => {
 expect(
 nextVariantArm(
 [
 { variantId: null, count: 4 },
 { variantId: A, count: 4 },
 { variantId: B, count: 1 },
 ],
 [A, B],
),
).toBe(B)
 })
})

describe('summarizeVariantSearch', => {
 it('names no leader until every arm has enough finished runs', => {
 const effect = summarizeVariantSearch(
 [
 tally(null, { merged: 1 }),
 tally(A, { merged: 5 }),
 tally(B, { decided: 1, merged: 1, costUsdTotal: 0.1 }),
 ],
 [A, B],
)
 expect(effect.leader).toBeNull
 expect(effect.detail).toContain('Still measuring')
 // The incumbent is an arm and is reported as one, so a human can see what it did.
 expect(effect.arms).toHaveLength(3)
 expect(effect.arms[0]?.variantId).toBeNull
 })

 it('marks each candidate against the prompt in use, not against each other', => {
 const effect = summarizeVariantSearch(
 [
 tally(null, { merged: 1, discarded: 4 }),
 tally(A, { merged: 5 }),
 tally(B, { merged: 1, discarded: 4 }),
 ],
 [A, B],
)
 const standings = Object.fromEntries(
 effect.arms.map((arm) => [arm.variantId ?? 'incumbent', arm.standing]),
)
 expect(standings[A]).toBe('better')
 expect(standings[B]).toBe('no-better')
 // An arm cannot be better than the thing it is.
 expect(standings.incumbent).toBe('undecided')
 expect(effect.leader).toBe(A)
 expect(effect.detail).toContain("Promoting it is a human's act")
 })

 /**
 * Outcomes outrank cost when picking between winners, because that is what the order of
 * the terms means — a cheaper prompt does not lead a search over one that lands more work.
 */
 it('prefers the winner that leads on the earlier term', => {
 const effect = summarizeVariantSearch(
 [
 tally(null, { merged: 1, discarded: 4 }),
 tally(A, { merged: 1, discarded: 4, costUsdTotal: 0.01 }),
 tally(B, { merged: 5, costUsdTotal: MIN_DECIDED_RUNS_PER_ARM * 0.1 }),
 ],
 [A, B],
)
 expect(effect.leader).toBe(B)
 expect(effect.detail).toContain('got work merged')
 })

 it('says plainly when the prompt in use won', => {
 const effect = summarizeVariantSearch(
 [tally(null, { merged: 5 }), tally(A, { merged: 0, discarded: 5 }), tally(B, { merged: 0, discarded: 5 })],
 [A, B],
)
 expect(effect.leader).toBeNull
 expect(effect.detail).toContain('none of the candidates beat the prompt')
 // The losers stay on the record — the archive rule, phrased for the human.
 expect(effect.detail).toContain('keeps every candidate on the record')
 })

 /** A failing check counts against a candidate here exactly as it does in a prompt trial. */
 it('separates level candidates by the repository"s definition of done', => {
 const effect = summarizeVariantSearch(
 [
 tally(null, { merged: 2, discarded: 3 }),
 tally(A, { merged: 2, discarded: 3, verificationFailed: 5, failingCheck: 'build' }),
 ],
 [A],
)
 expect(effect.arms[1]?.standing).toBe('worse')
 expect(effect.leader).toBeNull
 expect(effect.detail).toContain('most often the build check')
 })

 it('handles a set nothing has run yet without dividing by zero', => {
 const effect = summarizeVariantSearch([], [A, B])
 expect(effect.leader).toBeNull
 expect(effect.arms.every((arm) => arm.meanCostUsd === 0)).toBe(true)
 })
})
