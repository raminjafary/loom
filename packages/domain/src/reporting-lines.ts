/**
 * Who reports to whom on a team.
 *
 * **The question this answers, and why depth could not answer it.** The operator asked why
 * two planners draw on the same tier of the design canvas, and building the default teams
 * settled that the canvas was right: a sub-planner's envelope cannot be narrower than the
 * workers it must reach, and attenuation intersects it with its parent's — so a root wide
 * enough to empower a sub-planner is necessarily wide enough to start those workers itself.
 * Depth there is *reachability*, and reachability genuinely is flat.
 *
 * What a chain of command actually needs is a fact the platform did not hold: an assignment
 * of workers to planners. That is this file. It is not a security boundary and does not
 * pretend to be one — attenuation is still the only thing that decides what a child may
 * hold. It is an **organisational** fact, and its one reader is the roster a planner is
 * given at plan time.
 *
 * ## Three decisions
 *
 * **1. Keyed by the worker, not by the planner.** `reviewers` is keyed by reviewer because
 * "X reviews Y" is named and drawn in that direction; this is keyed the other way, and the
 * reason is a constraint rather than a convention: **a worker reports to at most one
 * planner.** One value per key gives that for free. Keyed by planner, the same worker could
 * appear under two of them, which is precisely the ambiguity that makes "whose work is
 * this" unanswerable — and an org chart that cannot answer that is a diagram.
 *
 * **2. A line only ever narrows.** A planner is offered the workers assigned to it, and a
 * worker with no line is offered to every planner — which is what every team does today, so
 * the field is additive and an empty map changes nothing. Crucially a line **cannot widen**:
 * a worker assigned to a planner whose envelope refuses it is still refused, because
 * `attenuateChildPersona` runs after this and is unchanged. Drawing a reporting line is
 * saying who *should* do this work, never granting permission to do it.
 *
 * **3. It is a tree, and cycles are refused.** A sub-planner reporting to a root planner is
 * the whole point — that is the chain of command the corporation describes. Two planners reporting
 * to each other is not a chain, and left unchecked it would make "which planner is this
 * worker's" depend on which one asked first.
 */

export type ReportingLines = Record<string, string>

/**
 * Whether this planner is offered this worker.
 *
 * Unassigned is `true`, and that is decision 2: the absence of a chain of command is every
 * team's current state, so absence has to mean "no narrowing" rather than "nobody".
 */
export const reportsToPlanner = (
 lines: ReportingLines,
 workerPersonaId: string,
 plannerPersonaId: string,
): boolean => {
 const assigned = lines[workerPersonaId]
 return assigned === undefined || assigned === plannerPersonaId
}

/**
 * The candidates one planner may be offered, narrowed by the chain of command.
 *
 * Generic over the candidate shape because the roster's candidate type belongs to the
 * roster: this file knows about ids and assignments and deliberately nothing else.
 */
export const scopeToReportingLines = <T extends { readonly id: string }>(
 candidates: readonly T[],
 lines: ReportingLines,
 plannerPersonaId: string,
): T[] => candidates.filter((candidate) => reportsToPlanner(lines, candidate.id, plannerPersonaId))

/** Whether any line is drawn at all — what tells "nobody assigned" from "assigned elsewhere". */
export const hasReportingLines = (lines: ReportingLines): boolean =>
 Object.keys(lines).length > 0

/**
 * What a save would refuse.
 *
 * Every problem here is something a human drew and can undraw, so they are returned as text
 * rather than thrown — the same shape `plannerToolProblems` uses, and for the same reason:
 * a canvas that reports one refusal at a time is the failure the roadmap describes.
 */
export const reportingLineProblems = (input: {
 /** The team's members. A line to or from a non-member is a line to nothing. */
 readonly memberIds: readonly string[]
 /** Which members are planners, by id. Only a planner can be reported *to*. */
 readonly plannerIds: readonly string[]
 readonly lines: ReportingLines
 /** For messages a human can act on — ids are not what they drew. */
 readonly nameOf?: (personaId: string) => string
}): string[] => {
 const problems: string[] = []
 const members = new Set(input.memberIds)
 const planners = new Set(input.plannerIds)
 const name = input.nameOf ?? ((id: string) => id)

 for (const [workerId, plannerId] of Object.entries(input.lines)) {
 if (!members.has(workerId)) {
 problems.push(`${name(workerId)} is not on this team, so it cannot report to anyone here.`)
 continue
 }
 if (!members.has(plannerId)) {
 problems.push(`${name(workerId)} reports to ${name(plannerId)}, who is not on this team.`)
 continue
 }
 if (workerId === plannerId) {
 problems.push(`${name(workerId)} cannot report to itself.`)
 continue
 }
 /**
 * Only a planner may be reported to, and this is the check that keeps a reporting line
 * from meaning something the runtime cannot do: a worker is never given a roster, so a
 * line into one would be an assignment nothing ever reads.
 */
 if (!planners.has(plannerId)) {
 problems.push(
 `${name(plannerId)} is not a planner, so nothing can report to it — only a planner is ` +
 'given a roster to delegate from.',
)
 }
 }

 /**
 * Cycles, walked from each assigned worker.
 *
 * A chain is legitimate and a loop is not — see decision 3. Walked rather than
 * depth-limited because the chain's length is bounded by the team's size and a
 * depth-limited check would call a long legitimate chain a cycle.
 */
 for (const start of Object.keys(input.lines)) {
 const seen = new Set<string>([start])
 let current = input.lines[start]
 while (current !== undefined) {
 if (seen.has(current)) {
 problems.push(
 `${name(start)}'s reporting line runs in a circle (through ${name(current)}). A chain ` +
 'of command has to end somewhere.',
)
 break
 }
 seen.add(current)
 current = input.lines[current]
 }
 }

 return [...new Set(problems)]
}

/**
 * What a planner is told about its own people, appended after the roster.
 *
 * Said out loud rather than left implicit in a shortened list, because the two situations
 * read identically to a model and mean opposite things: a roster narrowed to three people
 * looks exactly like a workspace that only has three, and a planner that believes the
 * second will report that it cannot do the work rather than delegating what it has.
 *
 * Returns empty when no line is drawn — a team with no chain of command is not told it has
 * one, which is every team today.
 */
export const describeReportingLines = (input: {
 readonly lines: ReportingLines
 readonly plannerPersonaId: string
 readonly assignedNames: readonly string[]
 readonly elsewhereNames: readonly string[]
}): string => {
 if (!hasReportingLines(input.lines)) return ''
 if (input.assignedNames.length === 0 && input.elsewhereNames.length === 0) return ''

 const parts: string[] = ['', '']
 if (input.assignedNames.length > 0) {
 parts.push(
 `On this team, ${input.assignedNames.join(', ')} report(s) to you. Those are your people ` +
 'and the work you decompose is theirs to do.',
)
 }
 /**
 * Naming who is *not* yours, and why that is worth the words: a planner that cannot see a
 * persona it knows exists will otherwise assign work to it and have the subtask refused,
 * or decide the goal is impossible. "Somebody else's" is a fact it can act on — by giving
 * that part of the goal to the planner who owns them.
 */
 if (input.elsewhereNames.length > 0) {
 parts.push(
 `${input.elsewhereNames.join(', ')} are on this team but report to another planner, so ` +
 'they are not yours to assign. If part of the goal belongs to them, give that part to ' +
 'the planner they report to instead of naming them directly.',
)
 }
 return parts.join('\n')
}
