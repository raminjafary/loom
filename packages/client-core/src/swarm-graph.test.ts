import type { SwarmBoard } from '@loom/api-contract'
import { describe, expect, it } from 'vitest'
import { buildSwarmGraph } from './swarm-graph.js'
import type { BoardCard } from './board-activity.js'

const card = (over: Partial<BoardCard> & { runId: string }): BoardCard =>
 ({
 parentRunId: null,
 personaName: 'swe',
 title: over.runId,
 status: 'running',
 relation: null,
 branchName: null,
 branchDisposition: null,
 totalCostUsd: null,
 ownedPaths: [],
 noteCount: 0,
 latestNoteTitle: null,
 blockerCount: 0,
 currentToolName: null,
 currentToolTarget: null,
 openCallCount: 0,
 lastEventAt: null,
 budgetCapUsd: null,
 contextTokens: null,
 contextMaxTokens: null,
...over,
 }) as BoardCard

const board = (
 cards: BoardCard[],
 pathCollisions: SwarmBoard['pathCollisions'] = [],
): SwarmBoard => ({ treeRunId: cards[0]?.runId ?? 'root', cards, pathCollisions }) as SwarmBoard

describe('buildSwarmGraph', => {
 it('layers a planner and its workers', => {
 const graph = buildSwarmGraph(
 board([
 card({ runId: 'planner' }),
 card({ runId: 'w1', parentRunId: 'planner' }),
 card({ runId: 'w2', parentRunId: 'planner' }),
 ]),
)

 expect(graph.depth).toBe(2)
 expect(graph.width).toBe(2)
 expect(graph.nodes.find((n) => n.card.runId === 'planner')?.depth).toBe(0)
 expect(graph.nodes.filter((n) => n.depth === 1).map((n) => n.order)).toEqual([0, 1])
 expect(graph.edges).toHaveLength(2)
 expect(graph.edges.every((e) => e.from === 'planner' && e.kind === 'delegation')).toBe(true)
 })

 /**
 * A reconciler is not a worker the planner asked for, and a reviewer's finding can
 * gate a branch. Flattening the three into one edge would erase the only
 * structural distinction the payload carries.
 */
 it('keeps delegation, review and reconcile as distinct edges', => {
 const graph = buildSwarmGraph(
 board([
 card({ runId: 'planner' }),
 card({ runId: 'worker', parentRunId: 'planner', relation: 'delegation' }),
 card({ runId: 'reviewer', parentRunId: 'planner', relation: 'review' }),
 card({ runId: 'fixer', parentRunId: 'planner', relation: 'reconcile' }),
 ]),
)

 const kinds = new Map(graph.edges.map((e) => [e.to, e.kind]))
 expect(kinds.get('worker')).toBe('delegation')
 expect(kinds.get('reviewer')).toBe('review')
 expect(kinds.get('fixer')).toBe('reconcile')
 })

 it('orders a layer stably, so a refresh mid-swarm does not reshuffle it', => {
 const cards = [
 card({ runId: 'planner' }),
 card({ runId: 'bbb', parentRunId: 'planner' }),
 card({ runId: 'aaa', parentRunId: 'planner' }),
 ]
 const first = buildSwarmGraph(board(cards)).nodes.map((n) => n.card.runId)
 const shuffled = buildSwarmGraph(board([cards[2]!, cards[0]!, cards[1]!])).nodes.map(
 (n) => n.card.runId,
)
 expect(first).toEqual(shuffled)
 })

 describe('collision edges', => {
 /** Live swarm observability: collisions "are an edge and should be drawn as one". */
 it('draws a collision between the two runs that claim the paths', => {
 const graph = buildSwarmGraph(
 board(
 [
 card({ runId: 'planner' }),
 card({ runId: 'w1', parentRunId: 'planner', title: 'Frontend' }),
 card({ runId: 'w2', parentRunId: 'planner', title: 'Backend' }),
 ],
 [{ titles: ['Frontend', 'Backend'], paths: ['apps/web'] }],
),
)

 const collision = graph.edges.find((e) => e.kind === 'collision')
 expect(collision?.from).toBe('w1')
 expect(collision?.to).toBe('w2')
 expect(collision?.detail).toBe('apps/web')
 })

 /**
 * The board names collisions by title, and nothing makes a title unique. Guessing
 * would point a human at the wrong branch to rebase, so an ambiguous pair is
 * dropped instead.
 */
 it('skips a collision whose title matches more than one card', => {
 const graph = buildSwarmGraph(
 board(
 [
 card({ runId: 'w1', title: 'Docs' }),
 card({ runId: 'w2', title: 'Docs' }),
 card({ runId: 'w3', title: 'Other' }),
 ],
 [{ titles: ['Docs', 'Other'], paths: ['docs'] }],
),
)
 expect(graph.edges.filter((e) => e.kind === 'collision')).toHaveLength(0)
 })

 it('skips a collision naming a card that is not on the board', => {
 const graph = buildSwarmGraph(
 board([card({ runId: 'w1', title: 'Here' })], [
 { titles: ['Here', 'Gone'], paths: ['src'] },
 ]),
)
 expect(graph.edges.filter((e) => e.kind === 'collision')).toHaveLength(0)
 })
 })

 describe('structures that should degrade rather than break', => {
 it('treats a card whose parent is off the board as a root', => {
 const graph = buildSwarmGraph(board([card({ runId: 'orphan', parentRunId: 'elsewhere' })]))
 expect(graph.nodes[0]?.depth).toBe(0)
 // No edge to a node that is not there.
 expect(graph.edges).toHaveLength(0)
 })

 it('survives a parent cycle instead of hanging the tab', => {
 const graph = buildSwarmGraph(
 board([
 card({ runId: 'a', parentRunId: 'b' }),
 card({ runId: 'b', parentRunId: 'a' }),
 ]),
)
 expect(graph.nodes).toHaveLength(2)
 expect(graph.nodes.every((n) => Number.isFinite(n.depth))).toBe(true)
 })

 it('is empty for no board at all', => {
 const graph = buildSwarmGraph(null)
 expect(graph.nodes).toEqual([])
 expect(graph.edges).toEqual([])
 expect(graph.width).toBe(0)
 expect(graph.depth).toBe(0)
 })
 })

 it('carries each node\'s live activity, so the canvas needs no second reading of it', => {
 const graph = buildSwarmGraph(
 board([card({ runId: 'w1', currentToolName: 'Bash', currentToolTarget: 'pnpm test', openCallCount: 1 })]),
)
 expect(graph.nodes[0]?.activity.kind).toBe('working')
 expect(graph.nodes[0]?.activity.toolName).toBe('Bash')
 })
})
