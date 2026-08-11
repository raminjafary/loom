import { describe, expect, it } from 'vitest'
import { buildRunTree, costByRelation, totalCostUsd, type RunTreeCard } from './run-tree.js'

const card = (over: Partial<RunTreeCard> & { runId: string }): RunTreeCard => ({
 parentRunId: null,
 personaName: 'swe',
 title: over.runId,
 status: 'completed',
 relation: null,
 branchName: null,
 branchDisposition: null,
 totalCostUsd: 0,
 ownedPaths: [],
 noteCount: 0,
 latestNoteTitle: null,
 blockerCount: 0,
 currentToolName: null,
 currentToolTarget: null,
 openCallCount: 0,
 lastEventAt: null,
 budgetCapUsd: null,
...over,
})

describe('buildRunTree', => {
 it('orders parents before their children, depth-first', => {
 const nodes = buildRunTree([
 card({ runId: 'w2', parentRunId: 'planner' }),
 card({ runId: 'planner' }),
 card({ runId: 'w1', parentRunId: 'planner' }),
 ])
 expect(nodes.map((n) => n.card.runId)).toEqual(['planner', 'w2', 'w1'])
 expect(nodes.map((n) => n.depth)).toEqual([0, 1, 1])
 })

 it('rolls a subtree cost up to its parent', => {
 // The number that answers "what did this goal cost". A Planner holds `tools: []`
 // and spends almost nothing itself, so its own cost says nothing useful.
 const nodes = buildRunTree([
 card({ runId: 'planner', totalCostUsd: 0.01 }),
 card({ runId: 'w1', parentRunId: 'planner', totalCostUsd: 0.5 }),
 card({ runId: 'w2', parentRunId: 'planner', totalCostUsd: 0.25 }),
 card({ runId: 'recon', parentRunId: 'w1', totalCostUsd: 0.04, relation: 'reconcile' }),
 ])
 const by = Object.fromEntries(nodes.map((n) => [n.card.runId, n.subtotalUsd]))
 expect(by.planner).toBeCloseTo(0.8)
 expect(by.w1).toBeCloseTo(0.54)
 expect(by.w2).toBeCloseTo(0.25)
 expect(by.recon).toBeCloseTo(0.04)
 })

 it('treats a card whose parent is off the board as a root', => {
 /**
 * The case that decides whether this renders at all. A board is a tree *slice* —
 * watch a worker rather than its planner and the parent is genuinely absent. Keying
 * roots on `parentRunId === null` alone would show nothing for exactly the run a
 * human asked to look at.
 */
 const nodes = buildRunTree([
 card({ runId: 'w1', parentRunId: 'planner-not-on-this-board' }),
 card({ runId: 'child', parentRunId: 'w1' }),
 ])
 expect(nodes.map((n) => n.card.runId)).toEqual(['w1', 'child'])
 expect(nodes.map((n) => n.depth)).toEqual([0, 1])
 })

 it('counts only direct children', => {
 const nodes = buildRunTree([
 card({ runId: 'planner' }),
 card({ runId: 'w1', parentRunId: 'planner' }),
 card({ runId: 'grandchild', parentRunId: 'w1' }),
 ])
 expect(nodes.find((n) => n.card.runId === 'planner')?.childCount).toBe(1)
 })

 it('terminates on a cycle rather than hanging the render', => {
 // Unreachable through the contract — a run may only spawn children of itself,
 // so parentage is fixed at creation. Guarded anyway: an infinite loop here is a
 // hung tab, which is a worse failure than a wrong number.
 const nodes = buildRunTree([
 card({ runId: 'a', parentRunId: 'b' }),
 card({ runId: 'b', parentRunId: 'a' }),
 ])
 expect(nodes.length).toBeLessThanOrEqual(2)
 })

 it('is empty for an empty board', => {
 expect(buildRunTree([])).toEqual([])
 })
})

describe('cost rollups', => {
 it('sums metered spend, treating an unmetered run as zero rather than skipping it', => {
 // A run still in flight has no cost yet; it must not make the total null.
 expect(
 totalCostUsd([
 card({ runId: 'a', totalCostUsd: 0.5 }),
 card({ runId: 'b', totalCostUsd: null }),
 ]),
).toBeCloseTo(0.5)
 })

 it('splits spend by relation, biggest first, with a null relation as root', => {
 // The real question is where the money goes, not what the total is.
 expect(
 costByRelation([
 card({ runId: 'p', totalCostUsd: 0.01 }),
 card({ runId: 'w1', relation: 'delegation', totalCostUsd: 0.5 }),
 card({ runId: 'w2', relation: 'delegation', totalCostUsd: 0.25 }),
 card({ runId: 'r', relation: 'reconcile', totalCostUsd: 0.04 }),
 ]),
).toEqual([
 ['delegation', 0.75],
 ['reconcile', 0.04],
 ['root', 0.01],
 ])
 })
})
