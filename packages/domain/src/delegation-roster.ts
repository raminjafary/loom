import { attenuateChildPersona } from './attenuation.js'
import type { PersonaSpec } from './agents.js'

/**
 * What a Planner is told it may delegate to.
 *
 * The Planner's shipped prompt says to "name a persona from the ones registered in
 * this workspace" and nothing ever told it which those are, so it guessed — and a
 * guessed name is a subtask that never starts, reported only after the run is over
 * and paid for. The same silence hid the envelope: a Planner naming a worker outside
 * its ceiling learned that from a refusal, at the one moment the plan can no longer
 * be changed.
 *
 * So the roster is filtered by the same `attenuateChildPersona` that gates the child
 * start, rather than by a second rule that could drift from it. The gate is unchanged
 * and still authoritative — this only moves the answer to where it is still useful.
 */

export interface DelegationCandidate {
 readonly name: string
 readonly description: string
 readonly model: string
 readonly tools: string[]
 readonly autoApprove: boolean
 readonly budgetCapUsd: number | null
 readonly planner: boolean
 /**
 * A sub-planner's own envelope, which attenuates against the offering Planner's
 * ceiling just as a worker's tools do. Omitting it would make every sub-planner
 * look harmless here — it holds `tools: []` like any Planner — and the roster
 * would offer one whose envelope the child-start gate then refuses.
 */
 readonly delegates?: string[]
}

const asChildSpec = (candidate: DelegationCandidate): PersonaSpec => ({
 name: candidate.name,
 systemPrompt: '',
 model: candidate.model,
 tools: candidate.tools,
 autoApprove: candidate.autoApprove,
 budgetCapUsd: candidate.budgetCapUsd,
 planner: candidate.planner,
 delegates: candidate.delegates ?? [],
 /**
 * Capabilities are deliberately not previewed here. Resolving them means a query
 * per candidate at every Planner start, and the child-start gate checks them
 * anyway — so a persona whose MCP surface escalates still gets refused, it just
 * is not filtered out of the roster first. The roster's job is the two failures
 * that are otherwise invisible until the run has ended (a name that does not
 * exist, a tool outside the envelope), not a second copy of the gate.
 */
 capabilities: [],
})

export const selectDelegatablePersonas = (
 planner: PersonaSpec,
 candidates: readonly DelegationCandidate[],
 /**
 * How many further delegation hops this Planner's children may still make. 0 means
 * its children are leaves, so a sub-planner is filtered out — offering one would
 * name a persona whose every subtask `startAgentRun` will refuse for depth, which
 * is the same "a listed name reads as permission" failure this module exists to
 * prevent, one level down.
 */
 remainingDepth = 0,
): DelegationCandidate[] =>
 candidates.filter((candidate) => {
 if (candidate.name === planner.name) return false
 if (candidate.planner && remainingDepth < 1) return false
 return attenuateChildPersona(planner, asChildSpec(candidate)).ok
 })

/**
 * Appended to a Planner's system prompt at run start. Null when the persona is not
 * a Planner, so the caller has one condition rather than a rule to remember.
 */
export const describeDelegationRoster = (
 planner: PersonaSpec,
 candidates: readonly DelegationCandidate[],
 remainingDepth = 0,
): string | null => {
 if (!planner.planner) return null

 const delegatable = selectDelegatablePersonas(planner, candidates, remainingDepth)
 if (delegatable.length === 0) {
 // Said out loud rather than left as an empty list. A Planner with nobody to
 // delegate to cannot produce a plan worth starting, and the useful outcome is
 // that it says so to the human instead of inventing a name that will be refused.
 return (
 '\n\nThere are no personas in this workspace you are allowed to delegate to. ' +
 'Do not submit a plan. Say that no worker persona is available within your ' +
 'delegation envelope, and stop.'
)
 }

 const lines = delegatable.map(
 (candidate) =>
 `- ${candidate.name} — ${candidate.description} (${
 candidate.planner
 ? 'a planner: give it a whole area, and it will decompose that area itself'
: `tools: ${candidate.tools.length === 0 ? 'none': candidate.tools.join(', ')}`
 })`,
)

 /**
 * A Planner that may delegate to a Planner is told what that is *for*, because the
 * decision it changes is the size of a subtask. Without it, the roster reads as a
 * longer list of workers and the model splits the goal into leaf-sized pieces
 * anyway — which is the flat fan-out, with an extra hop.
 */
 const nesting = delegatable.some((candidate) => candidate.planner)
 ? [
 '',
 'Some of these are planners. Give a planner an area that is still too large to be ' +
 'one unit of work and it will decompose that area itself; give a worker a piece ' +
 'small enough to finish on one branch. Prefer a planner when a part of the goal ' +
 'would otherwise need more subtasks than you can describe precisely.',
 ]
: []

 return [
 '',
 '',
 'These are the personas you may delegate to, and the only names the platform will accept:',
...lines,
...nesting,
 '',
 'Use one of these names exactly, in the personaName field. Any other name — including ' +
 'a persona that exists in this workspace but is not listed here — will be refused, and ' +
 'that subtask will not run. Choose by what each one is for and what tools it holds; if ' +
 'no listed persona fits a piece of the goal, say so in your plan rather than assigning ' +
 'it to one that does not fit.',
 ].join('\n')
}
