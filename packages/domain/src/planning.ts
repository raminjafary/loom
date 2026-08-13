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
 /**
 * Which repository this subtask lands in, by **display name**.
 *
 * Null means the planner's own repository, which is what every subtask did before this
 * field and is still the overwhelming case. A name here is only honoured when the
 * planner's team declared that repository (`extraRepositoryIds`), and anything else is
 * refused where the child starts — the *validator* cannot know the team, so this parse
 * only establishes the shape.
 *
 * **By name, not id**, for the reason `personaName` is a name: a model is told which
 * repositories its team works in and names one of them back. A uuid is a thing it would
 * have to be handed and could invent.
 */
 readonly repository: string | null
 /**
 * Which other subtasks in this same plan must finish first, by index
 *.
 *
 * Turns the decomposition from a fan-out into a DAG. Empty means "start
 * immediately", which is what every subtask did before this field existed, so an
 * omitted `dependsOn` reproduces the old behaviour exactly.
 *
 * **By index, not by title.** A title is model-authored prose that the model also
 * has to reproduce byte-exactly to make an edge; an index is checkable against the
 * array it arrived in. Titles are already deduplicated, so index and title are
 * equally unambiguous — index is just the one a validator can be sure about.
 *
 * Note what this is *not*: dependency order is scheduling, not permission. A
 * dependent inherits nothing from its predecessor — not tools, not paths, not
 * trust — and the attenuation still measures it against the planner alone.
 */
 readonly dependsOn: readonly number[]
 /**
 * Which sibling subtask this one *reviews*, by index — the reviewing role, and
 * the only worker-to-worker edge the runtime can be made to execute.
 *
 * A reviewing role is deliberately not "a later task": the collaboration topology names three ways it
 * differs, and all three are enforced rather than described.
 *
 * 1. **It reads the reviewed branch.** A review run's clone is taken from the
 * reviewed run's clone with that branch checked out, so the reviewer sees the
 * real tree and can grep it, open it and run it — not a diff pasted into a
 * prompt.
 * 2. **It owns no paths.** A subtask that claims paths *and* reviews another is
 * refused rather than trimmed: a reviewer with a write scope is a second
 * author of the same area, and the merge queue would then serialize a branch
 * against its own review.
 * 3. **Its verdict is recordable as something other than "completed".** The
 * output is a `finding` or `blocker` note, and a blocker stops the reviewed
 * branch reaching the merge queue (`describeReviewBlockers`).
 *
 * `null` for every ordinary subtask, which is what every subtask was before this
 * field existed.
 *
 * **The scheduling edge is derived, not asked for.** A reviewer must obviously
 * wait for what it reviews, and `parsePlanSubtask` adds the reviewed index to
 * `dependsOn` itself rather than requiring the model to write it twice. One
 * scheduler then runs the whole plan: cycle detection, stage accounting, the
 * claim-before-start release and the skip cascade all see a review edge as the
 * dependency it is, and none of them needed a second case.
 */
 readonly reviews: number | null
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

/**
 * Parses one subtask's `dependsOn`.
 *
 * Range and self-reference are checked here; **cycles are not**, because a cycle is
 * a property of the whole plan and no single subtask can be shown to be the one at
 * fault. `detectDependencyCycle` runs once the array is complete.
 */
const parseSubtaskDependsOn = (
 value: unknown,
 index: number,
 title: unknown,
 subtaskCount: number,
): { ok: true; dependsOn: number[] } | { ok: false; reason: string } => {
 const where = `Subtask ${index} ("${String(title)}")`
 if (value === undefined || value === null) return { ok: true, dependsOn: [] }
 if (!Array.isArray(value)) return { ok: false, reason: `${where} has a non-array \`dependsOn\`` }

 const dependsOn: number[] = []
 for (const entry of value) {
 if (typeof entry !== 'number' || !Number.isInteger(entry)) {
 return { ok: false, reason: `${where} depends on "${String(entry)}", which is not a subtask index` }
 }
 if (entry < 0 || entry >= subtaskCount) {
 return {
 ok: false,
 reason: `${where} depends on subtask ${entry}, but this plan has ${subtaskCount} subtask(s) (0–${subtaskCount - 1})`,
 }
 }
 if (entry === index) {
 return { ok: false, reason: `${where} depends on itself` }
 }
 // Deduplicated rather than refused: naming the same predecessor twice is
 // redundant, not wrong, and refusing a plan over it would be pedantry.
 if (!dependsOn.includes(entry)) dependsOn.push(entry)
 }
 return { ok: true, dependsOn }
}

/**
 * Parses one subtask's `reviews`.
 *
 * Range and self-reference are checked here for the same reason `dependsOn`'s are.
 * What is *not* checked here is whether the target is itself a reviewer — that is a
 * fact about two subtasks, so `parseDecomposition` checks it once the array exists.
 */
const parseSubtaskReviews = (
 value: unknown,
 index: number,
 title: unknown,
 subtaskCount: number,
): { ok: true; reviews: number | null } | { ok: false; reason: string } => {
 const where = `Subtask ${index} ("${String(title)}")`
 if (value === undefined || value === null) return { ok: true, reviews: null }
 if (typeof value !== 'number' || !Number.isInteger(value)) {
 return { ok: false, reason: `${where} has a \`reviews\` that is not a subtask index` }
 }
 if (value < 0 || value >= subtaskCount) {
 return {
 ok: false,
 reason: `${where} reviews subtask ${value}, but this plan has ${subtaskCount} subtask(s) (0–${subtaskCount - 1})`,
 }
 }
 /**
 * The refusal names the off-by-one, because that is what this always is.
 *
 * Observed on the first live run: a planner wrote two subtasks, described the second
 * as "reviewing subtask 1" in its own prose, and sent `reviews: 1` — its own numbering
 * being 1-based, and there being only one plausible target. "Subtask 1 reviews itself"
 * is true and teaches nothing; naming the convention and the index it probably meant
 * is a message a model can act on in one edit.
 */
 if (value === index) {
 return {
 ok: false,
 reason: `${where} reviews itself. Indices are 0-based, so subtask ${index} is this one${
 index > 0 ? ` — did you mean ${index - 1}?`: ''
 }`,
 }
 }
 return { ok: true, reviews: value }
}

/**
 * The cycle check.
 *
 * Returns the cycle it found as a list of indices, so the refusal can name the loop
 * rather than assert that one exists. A Planner told "your plan has a cycle" learns
 * nothing it can act on; one told "3 → 5 → 3" can fix it in one edit.
 *
 * Iterative DFS with an explicit stack: a plan is capped at `MAX_SUBTASKS`, so
 * recursion would be safe, but the colour-marking version is the one whose
 * "on the current path" set is visible rather than implied by the call stack.
 */
export const detectDependencyCycle = (
 subtasks: readonly { readonly dependsOn: readonly number[] }[],
): number[] | null => {
 const UNVISITED = 0
 const IN_PROGRESS = 1
 const DONE = 2
 const state = new Array<number>(subtasks.length).fill(UNVISITED)
 const parent = new Array<number>(subtasks.length).fill(-1)

 for (let root = 0; root < subtasks.length; root += 1) {
 if (state[root] !== UNVISITED) continue
 const stack: { node: number; next: number }[] = [{ node: root, next: 0 }]
 state[root] = IN_PROGRESS

 while (stack.length > 0) {
 const frame = stack[stack.length - 1]
 if (!frame) break
 const edges = subtasks[frame.node]?.dependsOn ?? []
 if (frame.next >= edges.length) {
 state[frame.node] = DONE
 stack.pop
 continue
 }
 const child = edges[frame.next] as number
 frame.next += 1

 if (state[child] === IN_PROGRESS) {
 // Walk back up the parent chain to render the loop the way a reader
 // traverses it, rather than reporting only the edge that closed it.
 const cycle = [child]
 let cursor = frame.node
 while (cursor !== child && cursor !== -1) {
 cycle.push(cursor)
 cursor = parent[cursor] ?? -1
 }
 cycle.reverse
 return cycle
 }
 if (state[child] === UNVISITED) {
 state[child] = IN_PROGRESS
 parent[child] = frame.node
 stack.push({ node: child, next: 0 })
 }
 }
 }
 return null
}

/**
 * Groups subtasks into the waves they can actually run in — index 0 is everything
 * that starts immediately, index 1 is everything unblocked once wave 0 is done, and
 * so on.
 *
 * This is what makes the required "per-stage budget accounting visible before the
 * plan is approved" possible: a human approving a pipeline needs to know it is a
 * pipeline, and what each wave can cost, before the first token is spent. The collaboration topology is
 * explicit about why — "fan-out fails cheaply; a pipeline fails expensively, because
 * everything downstream inherits the mistake".
 *
 * Assumes an acyclic plan; `parseDecomposition` refuses cyclic ones before this runs.
 */
export const planStages = (
 subtasks: readonly { readonly dependsOn: readonly number[] }[],
): number[][] => {
 const depth = new Array<number>(subtasks.length).fill(-1)

 const resolve = (index: number, seen: Set<number>): number => {
 const known = depth[index]
 if (known !== undefined && known >= 0) return known
 // Defensive only — a cycle cannot reach here through `parseDecomposition`.
 if (seen.has(index)) return 0
 seen.add(index)
 const edges = subtasks[index]?.dependsOn ?? []
 const value =
 edges.length === 0 ? 0: Math.max(...edges.map((edge) => resolve(edge, seen))) + 1
 depth[index] = value
 seen.delete(index)
 return value
 }

 for (let index = 0; index < subtasks.length; index += 1) resolve(index, new Set)

 const stages: number[][] = []
 for (let index = 0; index < subtasks.length; index += 1) {
 const at = depth[index] ?? 0
 while (stages.length <= at) stages.push([])
 stages[at]?.push(index)
 }
 return stages
}

/** What one subtask could cost, for the pre-approval stage accounting. */
export interface StageCostInput {
 readonly title: string
 readonly personaName: string
 /** The persona's enforced cap, or null when that persona is uncapped. */
 readonly budgetCapUsd: number | null
}

/**
 * The required disclosure, in the plan summary a human reads.
 *
 * Null for a plan with no dependencies at all — a single-stage plan *is* the
 * fan-out that already existed, and printing "Stage 1 of 1" on every plan would
 * train people to skip the paragraph that matters when there are three.
 *
 * The figure is a **ceiling from the enforced caps**, never an estimate. The cost model refuses
 * a second arithmetic alongside the one budget caps are enforced against, and a
 * predicted cost that came in under would be worse than useless here: the number's
 * job is to let a human refuse a pipeline before it runs, and only the worst case
 * can do that. An uncapped persona in a stage makes that stage's ceiling unknown,
 * and it says so rather than quietly summing the rest.
 */
export const describePlanStages = (
 stages: readonly number[][],
 subtasks: readonly StageCostInput[],
): string | null => {
 if (stages.length <= 1) return null

 const lines = stages.map((indices, stage) => {
 const entries = indices.map((index) => subtasks[index]).filter((entry) => entry !== undefined)
 const uncapped = entries.filter((entry) => entry.budgetCapUsd === null)
 const ceiling = entries.reduce((sum, entry) => sum + (entry.budgetCapUsd ?? 0), 0)
 const cost =
 uncapped.length > 0
 ? `at least $${ceiling.toFixed(2)}, and ${uncapped.length} of them uncapped`
: `up to $${ceiling.toFixed(2)}`
 const titles = entries.map((entry) => entry.title).join(', ')
 return `• Stage ${stage + 1}: ${entries.length} subtask(s), ${cost} — ${titles}`
 })

 const total = subtasks.reduce((sum, entry) => sum + (entry.budgetCapUsd ?? 0), 0)
 const anyUncapped = subtasks.some((entry) => entry.budgetCapUsd === null)

 return [
 `This plan runs in ${stages.length} stages — each one starts only when the stage before it has finished.`,
...lines,
 anyUncapped
 ? 'Worst case across every stage is unbounded, because at least one persona is uncapped.'
: `Worst case across every stage is $${total.toFixed(2)}.`,
 'A stage that fails stops the stages after it rather than starting them against a broken base.',
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
export const parsePlanSubtask = (
 value: unknown,
 index: number,
 /**
 * How many subtasks the surrounding plan has, so `dependsOn` indices can be
 * range-checked. Defaults to 0, which makes any dependency out of range — correct
 * for the mid-flight steering re-planning path, where a subtask added mid-flight has no array of
 * peers to point into and edges are not expressible.
 */
 subtaskCount = 0,
): SubtaskVerdict => {
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

 /**
 * The repository, as a name and nothing more.
 *
 * Absent, null and empty all mean "the planner's own", which is the pre-field behaviour
 * and the case that must stay free. A non-string is refused rather than coerced: a
 * subtask whose repository silently became `"undefined"` would be refused at child start
 * with a message about a repository nobody named.
 */
 const rawRepository = value.repository
 if (
 rawRepository !== undefined &&
 rawRepository !== null &&
 (typeof rawRepository !== 'string' || rawRepository.length > 200)
) {
 return {
 ok: false,
 reason: `Subtask ${index} ("${String(value.title)}") has a repository that is not a name (1–200 characters)`,
 }
 }
 const repository =
 typeof rawRepository === 'string' && rawRepository.trim !== '' ? rawRepository.trim: null

 const dependsVerdict = parseSubtaskDependsOn(value.dependsOn, index, value.title, subtaskCount)
 if (!dependsVerdict.ok) return dependsVerdict

 const reviewsVerdict = parseSubtaskReviews(value.reviews, index, value.title, subtaskCount)
 if (!reviewsVerdict.ok) return reviewsVerdict

 /**
 * The "no path ownership of its own", as a refusal rather than a silent trim.
 *
 * Trimming would be worse than refusing: the model would go on believing it owns
 * those files, the ledger would say nobody does, and the sibling that actually owns
 * them would be reviewed by something editing them underneath it. Refusing says
 * which of the two roles the subtask has to pick.
 */
 if (reviewsVerdict.reviews !== null && pathsVerdict.paths.length > 0) {
 return {
 ok: false,
 reason: `Subtask ${index} ("${value.title.trim}") both reviews another subtask and claims paths (${pathsVerdict.paths.join(', ')}). A reviewer owns no paths — it reads the branch it reviews and reports findings. Drop the paths, or make it an ordinary subtask.`,
 }
 }

 return {
 ok: true,
 subtask: {
 title: value.title.trim,
 task: value.task.trim,
 personaName: value.personaName.trim,
 paths: pathsVerdict.paths,
 repository,
 /**
 * The derived edge (see `PlanSubtask.reviews`). Unioned rather than replaced: a
 * planner may legitimately want its reviewer to wait for a second subtask too —
 * "review the API once both halves of it are in" — and dropping that would run
 * the review against half the work.
 */
 dependsOn:
 reviewsVerdict.reviews !== null && !dependsVerdict.dependsOn.includes(reviewsVerdict.reviews)
 ? [...dependsVerdict.dependsOn, reviewsVerdict.reviews]
: dependsVerdict.dependsOn,
 reviews: reviewsVerdict.reviews,
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
 const verdict = parsePlanSubtask(entry, index, raw.length)
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

 /**
 * A reviewer may not review a reviewer.
 *
 * Not pedantry: a reviewer produces no branch of its own — it owns no paths and its
 * output is a note — so there is nothing for a second reviewer to read. The pair
 * would start, cost two runs, and the outer one would report on an empty tree. This
 * is checked across the plan rather than per subtask because it is a fact about the
 * target, which the single-subtask validator has not seen yet.
 */
 const reviewOfReview = subtasks.findIndex(
 (subtask) => subtask.reviews !== null && subtasks[subtask.reviews]?.reviews !== null,
)
 if (reviewOfReview !== -1) {
 const subtask = subtasks[reviewOfReview]
 const target = subtasks[subtask?.reviews ?? 0]
 return {
 ok: false,
 reason: `Subtask ${reviewOfReview} ("${subtask?.title}") reviews "${target?.title}", which is itself a review. A reviewer owns no paths and produces no branch, so there is nothing for a second reviewer to read — review the subtask that does the work instead.`,
 }
 }

 /**
 * The one refusal the collaboration topology asks for by name. Path overlap warns because it is a guess
 * about the future; a cycle is a statement about the plan itself, and a plan that
 * cannot be ordered cannot be run at all — so this is the one place a whole
 * decomposition is thrown away, and the message names the loop so it can be fixed
 * in one edit.
 */
 const cycle = detectDependencyCycle(subtasks)
 if (cycle !== null) {
 // Closed back to its start so the loop reads as one, rather than as a path that
 // happens to end near where it began.
 const loop = [...cycle, cycle[0] ?? 0]
.map((index) => `${index} ("${subtasks[index]?.title ?? '?'}")`)
.join(' → ')
 return {
 ok: false,
 reason: `This plan's dependencies form a cycle, so no subtask in it could ever start: ${loop}. Break the loop and resubmit.`,
 }
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
