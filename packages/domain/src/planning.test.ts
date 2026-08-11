import { describe, expect, it } from 'vitest'
import { asAgentRunId } from './ids.js'
import {
 MAX_SUBTASKS,
 MAX_SUBTASK_PATHS,
 describeCrossPlanOverlaps,
 describePathOverlaps,
 detectClaimsAgainstExisting,
 detectPathOverlaps,
 parseDecomposition,
 pathsOverlap,
 summarizeChildOutcomes,
 type ChildOutcome,
 type PlanSubtask,
} from './planning.js'

/**
 * The risk register names "vague delegation" as a risk and "schema-validated
 * decomposition, both directions" as its mitigation. These cover both legs: what
 * a Planner is allowed to ask for, and what its children are reported to have
 * done.
 */

const subtask = (over: Record<string, unknown> = {}) => ({
 title: 'Add docs',
 task: 'Write docs/api.md describing the exported functions.',
 personaName: 'swe',
...over,
})

describe('parseDecomposition', => {
 it('accepts a well-formed plan and trims its fields', => {
 const verdict = parseDecomposition({ subtasks: [subtask({ title: ' Add docs ' })] })
 expect(verdict.ok).toBe(true)
 if (!verdict.ok) return
 expect(verdict.decomposition.subtasks[0]?.title).toBe('Add docs')
 })

 /**
 * Every rejection names the offending subtask. A Planner told only "invalid
 * plan" learns nothing and produces the same thing again — being able to say
 * what was wrong is the point of validating rather than guessing.
 */
 it('names the offending subtask in every rejection', => {
 const cases: [unknown, RegExp][] = [
 [{ subtasks: [subtask({ title: '' })] }, /Subtask 0/],
 [{ subtasks: [subtask, subtask({ task: '' })] }, /Subtask 1/],
 [{ subtasks: [subtask({ personaName: '' })] }, /personaName/],
 ]
 for (const [value, pattern] of cases) {
 const verdict = parseDecomposition(value)
 expect(verdict.ok).toBe(false)
 if (verdict.ok) continue
 expect(verdict.reason).toMatch(pattern)
 }
 })

 it('refuses a plan that is not a plan at all', => {
 for (const value of [null, 'a plan', 42, [], { subtasks: 'lots' }]) {
 expect(parseDecomposition(value).ok).toBe(false)
 }
 })

 it('refuses an empty plan', => {
 expect(parseDecomposition({ subtasks: [] }).ok).toBe(false)
 })

 /**
 * The cost model and the security model both care: a Planner that can fan out without bound is how a
 * runaway loop gets expensive, and the workspace concurrency limit only bounds
 * what runs at once, not what gets queued behind it.
 */
 it('refuses a plan past the subtask ceiling', => {
 const verdict = parseDecomposition({
 subtasks: Array.from({ length: MAX_SUBTASKS + 1 }, (_, i) => subtask({ title: `t${i}` })),
 })
 expect(verdict.ok).toBe(false)
 if (verdict.ok) return
 expect(verdict.reason).toContain(String(MAX_SUBTASKS))
 })

 // Two identical subtasks are the model repeating itself, and they produce two
 // branches doing the same work for the merge queue to then conflict over.
 it('refuses duplicate subtask titles', => {
 const verdict = parseDecomposition({ subtasks: [subtask, subtask] })
 expect(verdict.ok).toBe(false)
 if (verdict.ok) return
 expect(verdict.reason).toContain('Add docs')
 })
})

/**
 * The worker-notes design: "Path ownership belongs in the decomposition. A Planner
 * declaring which paths each subtask owns lets the platform warn about overlap
 * *before* tokens are spent, and lets the merge queue predict a conflict instead of
 * discovering it. This is the cheapest available attack on the assumption."
 */
describe('subtask path ownership', => {
 it('normalizes claimed paths and drops duplicates', => {
 const verdict = parseDecomposition({
 subtasks: [subtask({ paths: ['./src/', 'src', ' packages/db '] })],
 })
 expect(verdict.ok).toBe(true)
 if (!verdict.ok) return
 expect(verdict.decomposition.subtasks[0]?.paths).toEqual(['src', 'packages/db'])
 })

 /** Empty means unscoped, not "owns nothing" — a Planner omitting paths is not an error. */
 it('treats a plan with no paths as unscoped rather than invalid', => {
 const verdict = parseDecomposition({ subtasks: [subtask] })
 expect(verdict.ok).toBe(true)
 if (!verdict.ok) return
 expect(verdict.decomposition.subtasks[0]?.paths).toEqual([])
 })

 /**
 * Not a security boundary — the write boundary is the path check inside the
 * clone. What is refused here is a claim that cannot be true of a
 * repository-relative path, because the platform renders these claims to siblings
 * as fact.
 */
 it('refuses claims that cannot be repository-relative', => {
 const cases: [unknown, RegExp][] = [
 [{ subtasks: [subtask({ paths: ['/etc/passwd'] })] }, /absolute path/],
 [{ subtasks: [subtask({ paths: ['../../elsewhere'] })] }, /outside the repository/],
 [{ subtasks: [subtask({ paths: ['C:\\Windows'] })] }, /absolute path/],
 [{ subtasks: [subtask({ paths: 'src' })] }, /non-array/],
 [{ subtasks: [subtask({ paths: [''] })] }, /non-empty string/],
 [
 { subtasks: [subtask({ paths: Array.from({ length: MAX_SUBTASK_PATHS + 1 }, (_, i) => `f${i}`) })] },
 /more than 50 paths/,
 ],
 ]
 for (const [value, pattern] of cases) {
 const verdict = parseDecomposition(value)
 expect(verdict.ok).toBe(false)
 if (verdict.ok) continue
 expect(verdict.reason).toMatch(pattern)
 }
 })

 it('names the offending subtask in a path rejection, like every other rejection', => {
 const verdict = parseDecomposition({
 subtasks: [subtask, subtask({ title: 'Add tests', paths: ['/abs'] })],
 })
 expect(verdict.ok).toBe(false)
 if (verdict.ok) return
 expect(verdict.reason).toContain('Subtask 1')
 expect(verdict.reason).toContain('Add tests')
 })
})

describe('detectPathOverlaps', => {
 const claim = (title: string, paths: string[]): PlanSubtask => ({
 title,
 task: 'do the thing',
 personaName: 'swe',
 paths,
 })

 it('finds the same path claimed twice', => {
 const overlaps = detectPathOverlaps([
 claim('A', ['apps/server/src/router.ts']),
 claim('B', ['apps/server/src/router.ts']),
 ])
 expect(overlaps).toHaveLength(1)
 expect(overlaps[0]?.paths).toEqual(['apps/server/src/router.ts'])
 })

 /**
 * The overlap a string-equality check misses, and the one that actually happens:
 * one worker claims a directory, another claims a file inside it, and neither
 * claim mentions the other.
 */
 it('finds a directory claim containing another subtask’s file claim', => {
 const overlaps = detectPathOverlaps([
 claim('A', ['packages/db']),
 claim('B', ['packages/db/src/schema.ts']),
 ])
 expect(overlaps).toHaveLength(1)
 expect(overlaps[0]?.paths).toEqual(['packages/db', 'packages/db/src/schema.ts'])
 })

 it('does not treat a shared name prefix as a shared directory', => {
 expect(pathsOverlap('packages/db', 'packages/dbx')).toBe(false)
 expect(detectPathOverlaps([claim('A', ['packages/db']), claim('B', ['packages/dbx'])])).toEqual([])
 })

 it('reports nothing when subtasks are disjoint or unscoped', => {
 expect(detectPathOverlaps([claim('A', ['apps/web']), claim('B', ['apps/server'])])).toEqual([])
 expect(detectPathOverlaps([claim('A', []), claim('B', [])])).toEqual([])
 })

 it('reports every colliding pair, not just the first', => {
 const overlaps = detectPathOverlaps([
 claim('A', ['src/a.ts']),
 claim('B', ['src/a.ts']),
 claim('C', ['src/a.ts']),
 ])
 expect(overlaps.map((o) => [o.firstTitle, o.secondTitle])).toEqual([
 ['A', 'B'],
 ['A', 'C'],
 ['B', 'C'],
 ])
 })

 /** A warning, not a refusal — see detectPathOverlaps' comment for why. */
 it('describes overlaps as something that will still run', => {
 const text = describePathOverlaps(
 detectPathOverlaps([claim('A', ['src/a.ts']), claim('B', ['src/a.ts'])]),
)
 expect(text).toContain('"A" and "B"')
 expect(text).toContain('src/a.ts')
 expect(text).toContain('They will still run')
 })

 it('describes nothing when there is nothing to warn about', => {
 expect(describePathOverlaps([])).toBeNull
 })
})

/**
 * The collisions a multi-planner tree produces that no single plan can see. Two
 * sub-planners decomposing different areas that share a file are each internally
 * consistent, so the "warn *before* tokens are spent" is exactly what the
 * within-plan check loses — the tree-wide board only notices once both sides have
 * spent a branch getting there.
 */
describe('detectClaimsAgainstExisting', => {
 const claim = (title: string, paths: string[]): PlanSubtask => ({
 title,
 task: 'do the thing',
 personaName: 'swe',
 paths,
 })

 it('finds a new subtask colliding with a claim from another plan', => {
 const overlaps = detectClaimsAgainstExisting(
 [claim('B area work', ['packages/db/src/schema.ts'])],
 [{ title: 'A area work', paths: ['packages/db'] }],
)
 expect(overlaps).toHaveLength(1)
 expect(overlaps[0]?.firstTitle).toBe('B area work')
 expect(overlaps[0]?.secondTitle).toBe('A area work')
 expect(overlaps[0]?.paths).toEqual(['packages/db', 'packages/db/src/schema.ts'])
 })

 it('never reports existing claims against each other', => {
 // They were checked when they were made. Re-reporting them buries the new
 // collision — the only one the reader can still act on — in old news.
 expect(
 detectClaimsAgainstExisting(
 [claim('New', ['apps/web'])],
 [
 { title: 'Old A', paths: ['packages/db'] },
 { title: 'Old B', paths: ['packages/db'] },
 ],
),
).toEqual([])
 })

 it('reports nothing when there are no prior claims at all', => {
 // The first plan in a tree, which is every plan in a flat Phase 2 swarm.
 expect(detectClaimsAgainstExisting([claim('A', ['src/a.ts'])], [])).toEqual([])
 })

 it('tells the reader the earlier claim stands, since only one plan is still theirs', => {
 const text = describeCrossPlanOverlaps(
 detectClaimsAgainstExisting(
 [claim('Mine', ['src/a.ts'])],
 [{ title: 'Theirs', paths: ['src/a.ts'] }],
),
)
 expect(text).toContain('"Mine" collides with "Theirs"')
 expect(text).toContain('already claimed')
 expect(text).toContain('The earlier claim stands')
 })

 it('describes nothing when there is nothing to warn about', => {
 expect(describeCrossPlanOverlaps([])).toBeNull
 })
})

describe('summarizeChildOutcomes', => {
 const outcome = (over: Partial<ChildOutcome> = {}): ChildOutcome => ({
 runId: asAgentRunId('run-1'),
 personaName: 'swe',
 title: 'Add docs',
 status: 'completed',
 branchName: 'loom/run-1',
 totalCostUsd: 0.5,
 errorMessage: null,
...over,
 })

 it('reports every child, its branch and the total cost', => {
 const text = summarizeChildOutcomes([outcome, outcome({ title: 'Add tests' })])
 expect(text).toContain('2/2 subtasks completed')
 expect(text).toContain('$1.0000')
 expect(text).toContain('loom/run-1')
 })

 /**
 * The failures are the point. This is the moment a human judges whether the
 * decomposition was any good, and a summary that smoothed over a failed child
 * would hide exactly what they need to see.
 */
 it('shows failures rather than smoothing them over', => {
 const text = summarizeChildOutcomes([
 outcome,
 outcome({ title: 'Add tests', status: 'failed', errorMessage: 'budget cap reached' }),
 ])
 expect(text).toContain('1/2 subtasks completed')
 expect(text).toContain('failed')
 expect(text).toContain('budget cap reached')
 expect(text).toContain('did not complete')
 })

 it('says so when a plan produced nothing', => {
 expect(summarizeChildOutcomes([])).toContain('no child runs')
 })
})
