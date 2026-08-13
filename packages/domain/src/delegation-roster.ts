import type { ApprovalMode } from './approval-modes.js'
import { attenuateChildPersona } from './attenuation.js'
import { canPlannerRead } from './planner-tools.js'
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

/**
 * Personas the **platform** starts, which no planner may be offered.
 *
 * **[NEW — and it existed by accident until the operator asks removed the accident.]** The
 * reconciler never appeared on a roster, and not because anything said so: it was the only
 * built-in at `auto`, every planner was at `ask`, and the attenuation refused it. Making
 * the roster autonomous removed that side effect and revealed there was no rule underneath.
 *
 * There has to be one. A reconciler is started by the merge queue with a working tree that
 * is mid-rebase, and its own prompt says to stop if it was invoked any other way — so a
 * subtask assigned to it is a subtask that does nothing, reported after the plan is paid
 * for. That is exactly the "a listed name reads as permission" failure this module exists to
 * prevent, and it would have arrived as an accidental regression rather than as a decision.
 *
 * A name list rather than a column, for the reason `PLANNER_READABLE_TOOLS` is one: this is
 * a fact about personas the platform itself ships and starts, not a property an operator
 * sets. A hand-authored persona named `reconciler` is caught by the same list, which is the
 * conservative direction.
 */
export const PLATFORM_STARTED_PERSONAS: readonly string[] = ['reconciler']

export const isPlatformStartedPersona = (name: string): boolean =>
 PLATFORM_STARTED_PERSONAS.includes(name)

export interface DelegationCandidate {
 readonly name: string
 readonly description: string
 readonly model: string
 readonly tools: string[]
 readonly approvalMode: ApprovalMode
 readonly budgetCapUsd: number | null
 readonly planner: boolean
 /**
 * A sub-planner's own envelope, which attenuates against the offering Planner's
 * ceiling just as a worker's tools do. Omitting it would make every sub-planner
 * look harmless here — it holds `tools: []` like any Planner — and the roster
 * would offer one whose envelope the child-start gate then refuses.
 */
 readonly delegates?: string[]
 /**
 * How many of this persona the team is sized to run at once, or
 * undefined when it is unsized and the Planner decides.
 *
 * This is the first of the three places the count has to be read, and the
 * cheapest: "this team is sized for up to three concurrent `swe` workers" is a real
 * instruction to a real model, delivered where the model is choosing how wide to fan
 * out. Without it the other two places are a limit the Planner discovers by being
 * refused.
 */
 readonly fleet?: number | undefined
}

const asChildSpec = (candidate: DelegationCandidate): PersonaSpec => ({
 name: candidate.name,
 systemPrompt: '',
 model: candidate.model,
 tools: candidate.tools,
 approvalMode: candidate.approvalMode,
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
 /**
 * A Planner may delegate an area to *itself* — another run of the same persona,
 * one level down. That is not a special case, it is the ordinary recursive
 * decomposition, and excluding it made the shape unreachable with the
 * shipped seed: there is exactly one built-in planner persona, so "no sub-planner
 * may be the persona I am" means no sub-planner at all.
 *
 * Safe for the same two reasons any sub-planner is: its envelope equals this
 * one's, so attenuation is satisfied and nothing widens, and `remainingDepth`
 * bounds the recursion. Before the depth limit existed this exclusion was the
 * only thing standing between a Planner and unbounded self-delegation, which is
 * why it was written — the limit is the better answer and it now exists.
 */
 if (candidate.planner && remainingDepth < 1) return false
 // See `PLATFORM_STARTED_PERSONAS`: the merge queue starts these, and one on a roster is
 // a subtask that stops on its first turn.
 if (isPlatformStartedPersona(candidate.name)) return false
 return attenuateChildPersona(planner, asChildSpec(candidate)).ok
 })

/**
 * Appended to a Planner's system prompt at run start. Null when the persona is not
 * a Planner, so the caller has one condition rather than a rule to remember.
 */
/**
 * What a planner is told about the repositories its team works in.
 *
 * Empty when the team declared none, which is every team by default — and that silence is
 * correct rather than lazy: a planner told "you may name a repository" when there is only one
 * would spend a field on a choice it does not have, and a model handed an option tends to use
 * it.
 *
 * The planner's own repository is named too, because the useful sentence is the *set*: a
 * planner that knows it has two and only hears about one will put everything in the one it
 * was told about.
 */
export const describeTeamRepositories = (input: {
 readonly own: string | null
 readonly others: readonly string[]
}): string => {
 if (input.others.length === 0) return ''
 const all = [...(input.own === null ? []: [input.own]),...input.others]
 return [
 '',
 '',
 `This team works across more than one repository: ${all.join(', ')}. Each subtask lands ` +
 'in one of them, on its own branch. Put a subtask in a repository by naming it in the ' +
 '`repository` field, exactly as written above; leave the field out and it lands in ' +
 `${input.own ?? 'this run’s own repository'}.`,
 'Split by repository before you split by anything else — two subtasks in different ' +
 'repositories never conflict, and one subtask cannot span two. A name that is not on ' +
 'that list is refused and its work is simply not done.',
 ].join('\n')
}

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

 const lines = delegatable.map((candidate) => {
 const what = candidate.planner
 ? 'a planner: give it a whole area, and it will decompose that area itself'
: `tools: ${candidate.tools.length === 0 ? 'none': candidate.tools.join(', ')}`
 /**
 * The width clause. On the candidate's own line rather than in a
 * paragraph below, because the decision it changes — how many subtasks to give this
 * persona — is made while reading this line.
 */
 const width =
 candidate.fleet === undefined
 ? ''
: `; this team is sized for at most ${candidate.fleet} concurrent ${candidate.name} run(s)`
 return `- ${candidate.name} — ${candidate.description} (${what}${width})`
 })

 /**
 * Said once more in the imperative, because a parenthetical is a fact and this needs to
 * be an instruction: a model that reads "sized for 3" as a description will still write
 * five subtasks for it, and the extras are refused as they start.
 */
 const sized = delegatable.some((candidate) => candidate.fleet !== undefined)
 ? [
 '',
 'Some of these have a team size in brackets. Do not give a persona more concurrent ' +
 'subtasks than its size: the ones past it are refused when they try to start, so ' +
 'the work in them is simply not done. If a role genuinely needs more, give it ' +
 'fewer, larger subtasks instead.',
 ]
: []

 /**
 * Whether *every* offered planner can scope its own area. Any that cannot is
 * the case the paragraph below has to keep warning about, so this is `every`
 * rather than `some`: a roster mixing a reading planner with a `tools: []` one
 * must still say a file reference can stop a recipient.
 */
 const subPlannersCanRead = delegatable
.filter((candidate) => candidate.planner)
.every((candidate) => canPlannerRead(candidate.tools))

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
 /**
 * The sentence that has to track what a sub-planner can actually do.
 *
 * Observed live, before planners could read: a root that delegated
 * "decompose the docs area (docs-area.md)" produced two sub-planners that
 * each stopped and asked a human what was in the file, planned nothing, and
 * sat on the gate until the SLA denied them. Two prompt-level mitigations
 * were written against that and neither held with a Haiku planner, which is
 * what settled the read-only question (`planner-tools.ts`).
 *
 * A `tools: []` planner is still legal to author, so the old warning is not
 * deleted — it is now the branch that applies when one is on the roster.
 */
 subPlannersCanRead
 ? 'A planner reads the same way you do — Read, Grep and Glob — so pointing one at ' +
 'the files or directories its area covers is useful, not a dead end. Say what the ' +
 'area has to end up containing and where it lives; it will look before it decomposes.'
: 'A planner cannot read files — it has no tools at all. So write a subtask for a ' +
 'planner as a self-contained brief: say what that area has to end up containing and ' +
 'what constraints apply, in the task text itself. Naming a file it should go and ' +
 'read will stop it, because it cannot.',
 ]
: []

 return [
 '',
 '',
 'These are the personas you may delegate to, and the only names the platform will accept:',
...lines,
...nesting,
...sized,
 '',
 'Use one of these names exactly, in the personaName field. Any other name — including ' +
 'a persona that exists in this workspace but is not listed here — will be refused, and ' +
 'that subtask will not run. Choose by what each one is for and what tools it holds; if ' +
 'no listed persona fits a piece of the goal, say so in your plan rather than assigning ' +
 'it to one that does not fit.',
 ].join('\n')
}
