import { describe, expect, it } from 'vitest'
import { attenuateChildPersona } from './attenuation.js'
import { BUILTIN_PERSONAS, type BuiltinPersona } from './builtin-personas.js'
import { parsePersonaMarkdown } from './persona-markdown.js'
import type { PersonaSpec } from './agents.js'

/** The spec `startAgentRun` snapshots onto a run, built from the seeded row. */
const asSpec = (persona: BuiltinPersona): PersonaSpec => ({
 name: persona.name,
 systemPrompt: persona.systemPrompt,
 model: persona.model,
 tools: persona.tools,
 autoApprove: persona.harnessAutoApprove,
 budgetCapUsd: persona.harnessBudgetCapUsd,
 planner: persona.harnessPlanner,
 delegates: persona.harnessDelegates,
 capabilities: [],
})

describe('BUILTIN_PERSONAS', => {
 it('has exactly nine roles with unique names', => {
 expect(BUILTIN_PERSONAS).toHaveLength(9)
 expect(new Set(BUILTIN_PERSONAS.map((p) => p.name)).size).toBe(9)
 })

 /**
 * The `tools: []` is the Planner's trust boundary, not a scope cut —
 * The attenuation measures every child against what the parent holds, so a
 * Planner with tools would make every check below it meaningless.
 */
 it('ships the planner with no tools at all', => {
 const planner = BUILTIN_PERSONAS.find((p) => p.name === 'planner')
 expect(planner?.harnessPlanner).toBe(true)
 expect(planner?.tools).toEqual([])
 })

 it.each(BUILTIN_PERSONAS.map((p) => [p.name, p] as const))(
 '%s: markdownSource round-trips through parsePersonaMarkdown',
 (_name, persona) => {
 const parsed = parsePersonaMarkdown(persona.markdownSource)
 expect(parsed).toEqual({
 name: persona.name,
 description: persona.description,
 model: persona.model,
 tools: persona.tools,
 harnessEffort: persona.harnessEffort,
 harnessMaxTurns: persona.harnessMaxTurns,
 harnessAutoApprove: persona.harnessAutoApprove,
 harnessPlanner: persona.harnessPlanner,
 harnessDelegates: persona.harnessDelegates,
 harnessBudgetCapUsd: persona.harnessBudgetCapUsd,
 systemPrompt: persona.systemPrompt,
 })
 },
)

 it('ships every built-in with an enforced budget cap', => {
 // The seeded personas are the ones most likely to be @mentioned before anyone
 // has thought about spend, so an uncapped built-in would make the
 // out-of-the-box path the only uncapped one.
 for (const persona of BUILTIN_PERSONAS) {
 expect(persona.harnessBudgetCapUsd).toBeGreaterThan(0)
 }
 })

 /**
 * The shipped defaults must compose into a swarm that can actually do the job.
 *
 * Three refusals, each individually correct, once combined into a Planner that
 * could delegate only to read-only reviewers: the envelope excluded `Bash`, which
 * is carried by every built-in that implements or verifies anything. Nothing failed
 * — `attenuation.test.ts` proved the rule on personas it invented, and this file
 * proved the seed one persona at a time. Neither asked whether the seed satisfies
 * the rule, which is the only question a user hits on their first run.
 */
 it('lets the built-in planner delegate to every built-in worker', => {
 const planner = asSpec(BUILTIN_PERSONAS.find((p) => p.name === 'planner')!)
 const refusals = BUILTIN_PERSONAS.filter(
 // The reconciler is exempt by design, not by oversight: it is platform-initiated
 // from the merge queue, and `startAgentRun` skips attenuation for
 // `relation: 'reconcile'` precisely so a narrow worker's branch stays fixable.
 // A Planner cannot ask for one — `reconcile` is not reachable from the contract.
 (persona) => persona.name !== 'planner' && persona.name !== 'reconciler',
)
.map((persona) => [persona.name, attenuateChildPersona(planner, asSpec(persona))] as const)
.filter(([, verdict]) => !verdict.ok)
.map(([name, verdict]) => `${name}: ${verdict.ok ? '': verdict.reason}`)

 expect(refusals).toEqual([])
 })

 it('keeps the planner envelope to exactly what the built-in workers hold', => {
 // The other half of the check above, and the one that catches the opposite drift:
 // an envelope wider than any shipped worker is granting reach nothing asked for.
 const planner = BUILTIN_PERSONAS.find((p) => p.name === 'planner')!
 const held = new Set(
 BUILTIN_PERSONAS.filter((p) => p.name !== 'planner').flatMap((p) => p.tools),
)
 expect([...planner.harnessDelegates].sort).toEqual([...held].sort)
 })

 it('security-reviewer is read-only', => {
 const reviewer = BUILTIN_PERSONAS.find((p) => p.name === 'security-reviewer')
 expect(reviewer?.tools).toEqual(['Read', 'Grep', 'Glob'])
 })

 /**
 * The reconciler runs on the merge path, where a plausible-looking wrong answer is
 * worse than a refusal. A shell is the specific danger: `git
 * rebase --skip`, `checkout --theirs` and `reset` all make the conflict disappear by
 * discarding a worker's work, and all of them look like success to the queue.
 */
 it('gives the reconciler no shell', => {
 const reconciler = BUILTIN_PERSONAS.find((p) => p.name === 'reconciler')
 expect(reconciler?.tools).toEqual(['Read', 'Edit', 'Grep', 'Glob'])
 expect(reconciler?.tools).not.toContain('Bash')
 })

 it('auto-approves only the reconciler, which nobody is watching', => {
 // Started by the merge queue rather than a human, so an approval gate leaves it in
 // `awaiting_approval` until the SLA auto-denies — found by a live run stalling
 // there. Every other built-in is @mentioned by someone who is present.
 for (const persona of BUILTIN_PERSONAS) {
 expect(persona.harnessAutoApprove).toBe(persona.name === 'reconciler')
 }
 })

 it('tells the reconciler it is queue-started, not @mentioned', => {
 // It is seeded like every other built-in, so it appears in the persona picker even
 // with LOOM_RECONCILER_ENABLED off. Started by hand it gets an ordinary run on a
 // fresh branch with no conflict markers anywhere — `reconcile` is not reachable
 // from the contract, deliberately. Cheaper to say so than to special-case the UI.
 const reconciler = BUILTIN_PERSONAS.find((p) => p.name === 'reconciler')
 expect(reconciler?.systemPrompt).toMatch(/not meant to be invoked by hand/i)
 })

 it('tells the reconciler that refusing is a correct outcome', => {
 // The parallel-branch measurement measured the population as mechanical, but the tail is conflicts that
 // encode a real disagreement. An agent that always resolves would silently drop
 // one side's intent on exactly those.
 const reconciler = BUILTIN_PERSONAS.find((p) => p.name === 'reconciler')
 expect(reconciler?.systemPrompt).toMatch(/refus/i)
 })
})
