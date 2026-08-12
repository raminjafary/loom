import { parsePersonaMarkdown, serializePersonaMarkdown } from '@loom/domain'
import {
 EMPTY_PERSONA_FORM,
 personaFormToMarkdown,
 type PersonaFormState,
} from '@loom/client-core'
import { describe, expect, it } from 'vitest'

/**
 * The guard on the one thing `client-core` duplicates about the persona format
 *.
 *
 * `persona-form.ts` writes the markdown a save sends. The server reads it back with
 * `parsePersonaMarkdown`. Those are two implementations of one format, and the way
 * that goes wrong is silent: a form field that serializes into something the parser
 * reads differently stores a persona nobody authored — most dangerously `tools` and
 * `harness.autoApprove`, where a mis-read widens what a run may do.
 *
 * So this test asserts the round trip *across the boundary*, with the real parser on
 * the far side. It lives in `apps/web` rather than in `client-core` for exactly the
 * reason the duplication exists: `client-core` may not depend on `@loom/domain`, and
 * a conformance test that could only see one side would prove nothing. `@loom/domain`
 * is a **devDependency of this app and is imported by no source file** — the shipped
 * client still knows nothing about the domain.
 */

const base: PersonaFormState = {
...EMPTY_PERSONA_FORM,
 name: 'swe',
 description: 'Writes code',
 systemPrompt: 'You write code.',
}

const CASES: ReadonlyArray<{ label: string; form: PersonaFormState }> = [
 { label: 'the minimum persona', form: base },
 { label: 'no tools at all', form: {...base, tools: [] } },
 {
 label: 'every acting tool',
 form: {...base, tools: ['Read', 'Edit', 'Write', 'Bash', 'NotebookEdit'] },
 },
 { label: 'auto-approve on', form: {...base, autoApprove: true } },
 { label: 'a capped budget', form: {...base, budgetCapUsd: 12.5 } },
 { label: 'a fractional cap', form: {...base, budgetCapUsd: 0.05 } },
 { label: 'max turns', form: {...base, maxTurns: 40 } },
 { label: 'an effort level', form: {...base, effort: 'high' } },
 {
 label: 'a planner with an envelope',
 form: {
...base,
 name: 'planner',
 tools: ['Read', 'Grep', 'Glob'],
 planner: true,
 delegates: ['Read', 'Edit', 'Write', 'Bash'],
 },
 },
 {
 label: 'every harness key at once',
 form: {
...base,
 name: 'planner',
 planner: true,
 delegates: ['Bash'],
 autoApprove: true,
 effort: 'low',
 maxTurns: 3,
 budgetCapUsd: 1,
 },
 },
 {
 label: 'a multi-paragraph prompt',
 form: {...base, systemPrompt: 'First line.\n\nSecond paragraph.\n- a bullet' },
 },
 {
 label: 'a prompt containing a --- rule',
 form: {...base, systemPrompt: 'Above.\n\n---\n\nBelow.' },
 },
 {
 label: 'a description containing a colon',
 form: {...base, description: 'Reviews code: security first' },
 },
]

describe('the persona form writes what the server reads', => {
 for (const { label, form } of CASES) {
 it(`round-trips ${label}`, => {
 const parsed = parsePersonaMarkdown(personaFormToMarkdown(form))
 expect(parsed.name).toBe(form.name)
 expect(parsed.description).toBe(form.description)
 expect(parsed.model).toBe(form.model)
 expect(parsed.tools).toEqual([...form.tools])
 expect(parsed.systemPrompt).toBe(form.systemPrompt)
 expect(parsed.harnessPlanner).toBe(form.planner)
 expect(parsed.harnessDelegates).toEqual([...form.delegates])
 expect(parsed.harnessAutoApprove).toBe(form.autoApprove)
 expect(parsed.harnessEffort).toBe(form.effort)
 expect(parsed.harnessMaxTurns).toBe(form.maxTurns)
 expect(parsed.harnessBudgetCapUsd).toBe(form.budgetCapUsd)
 })

 it(`writes byte-for-byte what the domain's own serializer writes for ${label}`, => {
 // Stronger than the round trip, and it is the one that catches a *future*
 // divergence: a new frontmatter key added to the domain serializer alone
 // still round-trips (the parser defaults it) while the form silently stops
 // being able to express it.
 expect(personaFormToMarkdown(form)).toBe(
 serializePersonaMarkdown({
 name: form.name,
 description: form.description,
 model: form.model,
 tools: [...form.tools],
 systemPrompt: form.systemPrompt,
 harnessEffort: form.effort,
 harnessMaxTurns: form.maxTurns,
 harnessAutoApprove: form.autoApprove,
 harnessPlanner: form.planner,
 harnessDelegates: [...form.delegates],
 harnessBudgetCapUsd: form.budgetCapUsd,
 }),
)
 })
 }
})
