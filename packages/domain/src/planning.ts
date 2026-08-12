/**
 * The Planner.
 *
 * The risk register lists "vague delegation" as a named risk with a named mitigation:
 * "schema-validated decomposition, **both directions**". That is what this module
 * is — the schema going down (what a Planner is allowed to ask for) and the shape
 * coming back up (what its children reported). Prose in, prose out is the failure
 * mode; a subtask that cannot be validated is refused rather than guessed at.
 *
 * **A documented deviation from the nested-orchestration boundary — nested orchestration.** the nested-orchestration boundary says to "build on the SDK's
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

/** How many paths one subtask may claim. Generous — a subtask is a slice of a repository, not a file. */
export const MAX_SUBTASK_PATHS = 50

export interface PlanSubtask {
 readonly title: string
 /** What the child run is actually told to do. */
 readonly task: string
 /** Which registered persona should do it, by name. */
 readonly personaName: string
 /**
 * Repository-relative paths (files or directory prefixes) this subtask owns —
 * The "path ownership belongs in the decomposition".
 *
 * Optional, and empty means "unscoped", not "owns nothing": a Planner that names
 * no paths gets the behaviour that existed before this field, rather than having
 * its plan refused for omitting something the model may not know yet.
 */
 readonly paths: readonly string[]
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
 * Normalizes and checks one subtask's claimed paths.
 *
 * **Not a security boundary, and it must not be mistaken for one.** The write
 * boundary is the path-scoped check inside the run's clone; these paths come
 * from a *model*, and a boundary a model sets for itself is not a boundary. What
 * this rejects is claims that cannot be true of a repository-relative path, because
 * a claim like `/etc` or `../../elsewhere` rendered to a sibling as "worker A owns
 * this" is misinformation the platform would be vouching for.
 */
const parseSubtaskPaths = (
 value: unknown,
 index: number,
 title: unknown,
): { ok: true; paths: string[] } | { ok: false; reason: string } => {
 const where = `Subtask ${index} ("${String(title)}")`
 if (value === undefined || value === null) return { ok: true, paths: [] }
 if (!Array.isArray(value)) return { ok: false, reason: `${where} has a non-array \`paths\`` }
 if (value.length > MAX_SUBTASK_PATHS) {
 return { ok: false, reason: `${where} claims more than ${MAX_SUBTASK_PATHS} paths` }
 }

 const paths: string[] = []
 for (const entry of value) {
 if (typeof entry !== 'string' || entry.trim.length === 0) {
 return { ok: false, reason: `${where} has a path that is not a non-empty string` }
 }
 const path = normalizeOwnedPath(entry)
 if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
 return { ok: false, reason: `${where} claims an absolute path ("${entry}") — paths are repository-relative` }
 }
 if (path.split('/').includes('..')) {
 return { ok: false, reason: `${where} claims a path outside the repository ("${entry}")` }
 }
 if (!paths.includes(path)) paths.push(path)
 }
 return { ok: true, paths }
}

/** Strips `./` and trailing slashes so `src/`, `./src` and `src` are one claim. */
export const normalizeOwnedPath = (path: string): string =>
 path
.trim
.replace(/^\.\/+/, '')
.replace(/\/+$/, '')

/**
 * Whether two claimed paths refer to overlapping work — either the same path, or one
 * a directory prefix of the other.
 *
 * Prefix-aware because the interesting overlap is exactly the one a string equality
 * check misses: worker A claiming `packages/db` and worker B claiming
 * `packages/db/src/schema.ts` are going to conflict, and neither claim mentions the
 * other. Compared segment-wise so `packages/db` does not "contain" `packages/dbx`.
 */
export const pathsOverlap = (a: string, b: string): boolean => {
 if (a === b) return true
 const [shorter, longer] = a.length <= b.length ? [a, b]: [b, a]
 return longer.startsWith(`${shorter}/`)
}

/** One pair of subtasks that claimed overlapping paths, with the paths that collided. */
export interface PathOverlap {
 readonly firstTitle: string
 readonly secondTitle: string
 readonly paths: string[]
}

/**
 * Finds pairs of subtasks whose claimed paths collide — the "cheapest
 * available attack on the assumption": "the main cause of merge conflict is two
 * workers independently deciding to touch the same file", so let the platform say so
 * *before* tokens are spent rather than let the merge queue discover it after.
 *
 * **A warning, not a refusal**, and deliberately: two subtasks that share a file are
 * often legitimate (a shared export barrel, a migration list), the Planner is a
 * model and so its path claims are guesses, and a refusal would throw away a whole
 * plan over one guess. The merge queue is still the thing that catches a real
 * conflict.
 */
export const detectPathOverlaps = (subtasks: readonly PlanSubtask[]): PathOverlap[] => {
 const overlaps: PathOverlap[] = []
 for (let i = 0; i < subtasks.length; i += 1) {
 for (let j = i + 1; j < subtasks.length; j += 1) {
 const first = subtasks[i]
 const second = subtasks[j]
 if (!first || !second) continue
 const collided = first.paths.filter((path) =>
 second.paths.some((other) => pathsOverlap(path, other)),
)
 // Reported from the *second* claim's side too, so a prefix collision names both
 // sides' wording rather than only the shorter one.
 const collidedBack = second.paths.filter((path) =>
 first.paths.some((other) => pathsOverlap(path, other)),
)
 const paths = [...new Set([...collided,...collidedBack])].sort
 if (paths.length > 0) {
 overlaps.push({ firstTitle: first.title, secondTitle: second.title, paths })
 }
 }
 }
 return overlaps
}

/** A path claim already on the record — one prior subtask's title and the paths it owns. */
export interface PathClaim {
 readonly title: string
 readonly paths: readonly string[]
}

/**
 * The same collision check, across plans rather than within one.
 *
 * `detectPathOverlaps` compares a plan's subtasks against each other, which is the
 * whole story while a tree has one Planner in it. With a second planner node the
 * expensive collisions are precisely the ones it cannot see: sub-planner A and
 * sub-planner B decomposing different areas that turn out to share a file. Neither
 * plan is internally inconsistent, and the stated value — warning "*before*
 * tokens are spent" — is exactly what is lost, because the tree-wide board only
 * notices once both sides have branches.
 *
 * Existing claims are not compared against each other: they were checked when they
 * were made, and re-reporting them would bury the new collision in old news.
 */
export const detectClaimsAgainstExisting = (
 subtasks: readonly PlanSubtask[],
 existing: readonly PathClaim[],
): PathOverlap[] => {
 const overlaps: PathOverlap[] = []
 for (const subtask of subtasks) {
 for (const claim of existing) {
 const collided = subtask.paths.filter((path) =>
 claim.paths.some((other) => pathsOverlap(path, other)),
)
 const collidedBack = claim.paths.filter((path) =>
 subtask.paths.some((other) => pathsOverlap(path, other)),
)
 const paths = [...new Set([...collided,...collidedBack])].sort
 if (paths.length > 0) {
 overlaps.push({ firstTitle: subtask.title, secondTitle: claim.title, paths })
 }
 }
 }
 return overlaps
}

/**
 * The cross-plan warning. Worded differently from `describePathOverlaps` on purpose:
 * the reader can still change one of these plans but not the other, and the advice
 * that follows from that is different — coordinate with the run that got there
 * first, rather than re-split your own subtasks.
 */
export const describeCrossPlanOverlaps = (overlaps: readonly PathOverlap[]): string | null => {
 if (overlaps.length === 0) return null
 return [
 overlaps.length === 1
 ? 'A subtask in this plan claims a path another plan in this tree already claimed:'
: `${overlaps.length} subtasks in this plan claim paths other plans in this tree already claimed:`,
...overlaps.map(
 (overlap) =>
 `• "${overlap.firstTitle}" collides with "${overlap.secondTitle}" on ${overlap.paths.join(', ')}`,
),
 'The earlier claim stands. These will still run and the merge queue serializes them, ' +
 'but the work here should be scoped around the other claim rather than duplicating it.',
 ].join('\n')
}

/** The warning a human and the Planner both see. Plural-aware, because it is read a lot. */
export const describePathOverlaps = (overlaps: readonly PathOverlap[]): string | null => {
 if (overlaps.length === 0) return null
 return [
 overlaps.length === 1
 ? 'Two subtasks in this plan claim overlapping paths, which is the usual cause of a merge conflict:'
: `${overlaps.length} pairs of subtasks in this plan claim overlapping paths, which is the usual cause of a merge conflict:`,
...overlaps.map(
 (overlap) =>
 `• "${overlap.firstTitle}" and "${overlap.secondTitle}" both claim ${overlap.paths.join(', ')}`,
),
 'They will still run — the merge queue serializes them — but expect the second to rebase onto the first.',
 ].join('\n')
}

export type SubtaskVerdict =
 | { readonly ok: true; readonly subtask: PlanSubtask }
 | { readonly ok: false; readonly reason: string }

/**
 * Validates one subtask, wherever it came from.
 *
 * Extracted from `parseDecomposition` so that a subtask added by a re-planning turn
 * cannot be shaped differently from one that
 * arrived in the original decomposition. Two validators would drift, and the one that
 * drifted would be the rarely-exercised one.
 */
export const parsePlanSubtask = (value: unknown, index: number): SubtaskVerdict => {
 if (!isRecord(value)) return { ok: false, reason: `Subtask ${index} is not an object` }
 if (!nonEmptyString(value.title, 200)) {
 return { ok: false, reason: `Subtask ${index} needs a title (1–200 characters)` }
 }
 if (!nonEmptyString(value.task, 4_000)) {
 return { ok: false, reason: `Subtask ${index} ("${String(value.title)}") needs a task description` }
 }
 if (!nonEmptyString(value.personaName, 100)) {
 return { ok: false, reason: `Subtask ${index} ("${String(value.title)}") needs a personaName` }
 }

 const pathsVerdict = parseSubtaskPaths(value.paths, index, value.title)
 if (!pathsVerdict.ok) return pathsVerdict

 return {
 ok: true,
 subtask: {
 title: value.title.trim,
 task: value.task.trim,
 personaName: value.personaName.trim,
 paths: pathsVerdict.paths,
 },
 }
}

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
 const verdict = parsePlanSubtask(entry, index)
 if (!verdict.ok) return verdict
 subtasks.push(verdict.subtask)
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
