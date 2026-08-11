import { describe, expect, it } from 'vitest'
import { BUILTIN_PERSONAS } from './builtin-personas.js'
import { describeDelegationRoster, selectDelegatablePersonas } from './delegation-roster.js'
import type { DelegationCandidate } from './delegation-roster.js'
import type { PersonaSpec } from './agents.js'

const planner = (over: Partial<PersonaSpec> = {}): PersonaSpec => ({
 name: 'planner',
 systemPrompt: 'plan',
 model: 'claude-opus-5',
 tools: [],
 autoApprove: false,
 budgetCapUsd: 5,
 planner: true,
 delegates: ['Read', 'Edit', 'Grep', 'Glob'],
 capabilities: [],
...over,
})

const candidate = (over: Partial<DelegationCandidate> = {}): DelegationCandidate => ({
 name: 'swe',
 description: 'Implements a scoped change.',
 model: 'claude-sonnet-5',
 tools: ['Read', 'Edit'],
 autoApprove: false,
 budgetCapUsd: 5,
 planner: false,
...over,
})

describe('selectDelegatablePersonas', => {
 it('keeps a persona inside the envelope', => {
 expect(selectDelegatablePersonas(planner, [candidate]).map((p) => p.name)).toEqual(['swe'])
 })

 it('drops a persona whose tools exceed the envelope', => {
 const outside = candidate({ name: 'qa', tools: ['Read', 'Bash'] })
 expect(selectDelegatablePersonas(planner, [candidate, outside]).map((p) => p.name)).toEqual([
 'swe',
 ])
 })

 it('drops a persona the child-start gate would refuse for budget or tier', => {
 const expensive = candidate({ name: 'rich', budgetCapUsd: 50 })
 const uncapped = candidate({ name: 'uncapped', budgetCapUsd: null })
 const higherTier = candidate({ name: 'opus', model: 'claude-opus-5' })
 const selected = selectDelegatablePersonas(planner({ model: 'claude-sonnet-5' }), [
 expensive,
 uncapped,
 higherTier,
 candidate,
 ])
 expect(selected.map((p) => p.name)).toEqual(['swe'])
 })

 it('drops an auto-approving persona under a planner that must ask', => {
 // The reconciler's shape. It is reachable only from the merge queue, which skips
 // attenuation for `relation: 'reconcile'` — so it self-excludes here with no
 // special case, and a Planner is never told it can start one.
 const auto = candidate({ name: 'reconciler', autoApprove: true })
 expect(selectDelegatablePersonas(planner, [auto])).toEqual([])
 })

 /**
 * The shipped seed has exactly one planner persona, so "a sub-planner may not be
 * the persona I am" would mean no sub-planner at all — the whole shape,
 * unreachable out of the box. Recursion into itself is the ordinary decomposition;
 * `remainingDepth` is what bounds it.
 */
 it('lets a planner delegate an area to another run of itself', => {
 const self = candidate({ name: 'planner', tools: [], planner: true })
 expect(selectDelegatablePersonas(planner, [self, candidate], 1).map((p) => p.name)).toEqual([
 'planner',
 'swe',
 ])
 })

 it('stops offering itself once no hop remains, so recursion terminates', => {
 const self = candidate({ name: 'planner', tools: [], planner: true })
 expect(selectDelegatablePersonas(planner, [self, candidate], 0).map((p) => p.name)).toEqual([
 'swe',
 ])
 })

 /**
 * A sub-planner is a first-class delegation target: a root that delegates areas,
 * sub-planners that decompose them, workers that do the units. The attenuation is
 * what makes the shape safe — a sub-planner's envelope is bounded by the one that
 * granted it, so authority only ever narrows down the chain.
 *
 * What bounds it instead is depth, and the roster reflects the *remaining* depth
 * rather than a fixed rule: offering a sub-planner with no hop left names a persona
 * whose every subtask `startAgentRun` would then refuse.
 */
 it('offers a sub-planner when a delegation hop remains', => {
 const sub = candidate({ name: 'sub-planner', tools: [], planner: true })
 expect(selectDelegatablePersonas(planner, [sub, candidate], 1).map((p) => p.name)).toEqual([
 'sub-planner',
 'swe',
 ])
 })

 it('drops a sub-planner when its children would be leaves', => {
 const sub = candidate({ name: 'sub-planner', tools: [], planner: true })
 expect(selectDelegatablePersonas(planner, [sub, candidate], 0).map((p) => p.name)).toEqual([
 'swe',
 ])
 })

 it('still bounds a sub-planner envelope by attenuation, not only by depth', => {
 // The escalation the depth bound does not address: a sub-planner whose own
 // envelope is wider than the one offering it work.
 const wide = candidate({
 name: 'wide-planner',
 tools: [],
 planner: true,
 delegates: ['Read', 'Bash'],
 })
 expect(selectDelegatablePersonas(planner({ delegates: ['Read'] }), [wide], 2)).toEqual([])

 const narrow = {...wide, name: 'narrow-planner', delegates: ['Read'] }
 expect(
 selectDelegatablePersonas(planner({ delegates: ['Read'] }), [narrow], 2).map((p) => p.name),
).toEqual(['narrow-planner'])
 })
})

describe('describeDelegationRoster', => {
 it('is null for a persona that is not a planner', => {
 expect(describeDelegationRoster(planner({ planner: false }), [candidate])).toBeNull
 })

 it('names each delegatable persona with its purpose and tools', => {
 const text = describeDelegationRoster(planner, [candidate])
 expect(text).toContain('swe')
 expect(text).toContain('Implements a scoped change.')
 expect(text).toContain('Read, Edit')
 })

 it('never names a persona outside the envelope', => {
 // The failure this exists to prevent, in reverse: putting a refused name in front
 // of the model is worse than telling it nothing, because it reads as permission.
 const text = describeDelegationRoster(planner, [
 candidate,
 candidate({ name: 'shell-worker', tools: ['Bash'] }),
 ])
 expect(text).not.toContain('shell-worker')
 })

 it('tells a planner with nobody to delegate to not to submit a plan', => {
 const text = describeDelegationRoster(planner, [candidate({ tools: ['Bash'] })])
 expect(text).toContain('Do not submit a plan')
 })

 it('offers the built-in planner every built-in worker', => {
 // End to end on the shipped seed: the roster a real first run receives.
 const builtinPlanner = BUILTIN_PERSONAS.find((p) => p.name === 'planner')!
 const spec = planner({
 delegates: builtinPlanner.harnessDelegates,
 budgetCapUsd: builtinPlanner.harnessBudgetCapUsd,
 model: builtinPlanner.model,
 })
 const candidates: DelegationCandidate[] = BUILTIN_PERSONAS.map((p) => ({
 name: p.name,
 description: p.description,
 model: p.model,
 tools: p.tools,
 autoApprove: p.harnessAutoApprove,
 budgetCapUsd: p.harnessBudgetCapUsd,
 planner: p.harnessPlanner,
 }))

 expect(selectDelegatablePersonas(spec, candidates).map((p) => p.name).sort).toEqual([
 'backend-engineer',
 'frontend-engineer',
 'product-manager',
 'qa',
 'security-reviewer',
 'solution-architect',
 'swe',
 ])
 })
})
