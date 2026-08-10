/**
 * The Planner.
 *
 * The risk register lists "vague delegation" as a named risk with a named mitigation:
 * "schema-validated decomposition, **both directions**". That is what this module
 * is — the schema going down (what a Planner is allowed to ask for) and the shape
 * coming back up (what its children reported). Prose in, prose out is the failure
 * mode; a subtask that cannot be validated is refused rather than guessed at.
 *
 * **A documented deviation from the nested-orchestration boundary.** the nested-orchestration boundary says to "build on the SDK's
 * `Workflow`/`SendMessage` rather than a hand-rolled scheduler". In the SDK
 * version this repository pins, those names are *settings flags* for Claude
 * Code's own interactive features — the Workflow tool and Remote Control peer
 * messaging — not a programmatic orchestration API a headless caller can drive.
 * So the delegation channel is an in-process SDK MCP tool whose input schema is
 * this decomposition, and the scheduling is the platform's existing child-run
 * path. That is deliberately *not* a hand-rolled scheduler: no queue, no
 * dependency graph, no retries — the Planner asks, the platform starts runs under
 * the same limits and attenuation as any other, and children are ordinary runs.
 */

import type { AgentRunId } from './ids.js'

/**
 * A hard ceiling on one decomposition. The cost model and the security model both care: a Planner that can
 * fan out without bound is how a runaway loop gets expensive, and the workspace
 * concurrency limit only bounds what runs *at once*, not what gets queued behind
 * it. Small on purpose — the own experiment is three workers.
 */
export const MAX_SUBTASKS = 8

export interface PlanSubtask {
 readonly title: string
 /** What the child run is actually told to do. */
 readonly task: string
 /** Which registered persona should do it, by name. */
 readonly personaName: string
}

export interface Decomposition {
 readonly subtasks: PlanSubtask[]
}

export type DecompositionVerdict =
 | { readonly ok: true; readonly decomposition: Decomposition }
 | { readonly ok: false; readonly reason: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
 typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown, max: number): value is string =>
 typeof value === 'string' && value.trim.length > 0 && value.length <= max

/**
 * Validates a decomposition a Planner submitted.
 *
 * Every rejection names the offending subtask by index. A Planner that gets back
 * "invalid plan" learns nothing and will produce the same thing again; the point
 * of validating is to be able to say what was wrong.
 */
export const parseDecomposition = (value: unknown): DecompositionVerdict => {
 if (!isRecord(value)) return { ok: false, reason: 'A plan must be an object with a `subtasks` array' }

 const raw = value.subtasks
 if (!Array.isArray(raw)) return { ok: false, reason: 'A plan must have a `subtasks` array' }
 if (raw.length === 0) return { ok: false, reason: 'A plan must contain at least one subtask' }
 if (raw.length > MAX_SUBTASKS) {
 return { ok: false, reason: `A plan may contain at most ${MAX_SUBTASKS} subtasks, got ${raw.length}` }
 }

 const subtasks: PlanSubtask[] = []
 for (const [index, entry] of raw.entries) {
 if (!isRecord(entry)) return { ok: false, reason: `Subtask ${index} is not an object` }
 if (!nonEmptyString(entry.title, 200)) {
 return { ok: false, reason: `Subtask ${index} needs a title (1–200 characters)` }
 }
 if (!nonEmptyString(entry.task, 4_000)) {
 return { ok: false, reason: `Subtask ${index} ("${String(entry.title)}") needs a task description` }
 }
 if (!nonEmptyString(entry.personaName, 100)) {
 return { ok: false, reason: `Subtask ${index} ("${String(entry.title)}") needs a personaName` }
 }
 subtasks.push({
 title: entry.title.trim,
 task: entry.task.trim,
 personaName: entry.personaName.trim,
 })
 }

 // Two subtasks with the same title are almost always the model repeating
 // itself, and they produce two branches doing the same work for the merge queue
 // to then conflict over.
 // Compared case-insensitively, but reported with the author's own casing —
 // echoing a lowercased title back makes the message look like a different
 // subtask than the one that caused it.
 const lowered = subtasks.map((subtask) => subtask.title.toLowerCase)
 const duplicateIndex = lowered.findIndex((title, index) => lowered.indexOf(title) !== index)
 if (duplicateIndex !== -1) {
 return { ok: false, reason: `Two subtasks share the title "${subtasks[duplicateIndex]?.title}"` }
 }

 return { ok: true, decomposition: { subtasks } }
}

/** One child's outcome, as the aggregation step sees it. */
export interface ChildOutcome {
 readonly runId: AgentRunId
 readonly personaName: string
 readonly title: string
 readonly status: string
 readonly branchName: string | null
 readonly totalCostUsd: number | null
 readonly errorMessage: string | null
}

/**
 * The other direction of the "both directions": what the Planner's thread is
 * told once its children are done.
 *
 * Deliberately factual and complete rather than a summary. This is the moment a
 * human decides whether the decomposition was any good, and a line per child —
 * including the ones that failed, and what each cost — is what that decision
 * needs. Summarizing here would hide exactly the failures worth seeing.
 */
export const summarizeChildOutcomes = (outcomes: readonly ChildOutcome[]): string => {
 if (outcomes.length === 0) return 'The plan produced no child runs.'

 const done = outcomes.filter((outcome) => outcome.status === 'completed')
 const cost = outcomes.reduce((sum, outcome) => sum + (outcome.totalCostUsd ?? 0), 0)

 const lines = outcomes.map((outcome) => {
 const branch = outcome.branchName ? ` → ${outcome.branchName}`: ''
 const why = outcome.errorMessage ? ` (${outcome.errorMessage})`: ''
 return `• ${outcome.title} [${outcome.personaName}] — ${outcome.status}${branch}${why}`
 })

 return [
 `Plan finished: ${done.length}/${outcomes.length} subtasks completed, $${cost.toFixed(4)} total.`,
...lines,
 done.length === outcomes.length
 ? 'Every branch is ready to review; queue them for merge in the order you want them applied.'
: 'Some subtasks did not complete — their work, if any, is still on their branches.',
 ].join('\n')
}
