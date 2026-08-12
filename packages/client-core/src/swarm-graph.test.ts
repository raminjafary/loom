import type { MergeQueueEntry, SwarmBoard } from '@loom/api-contract'
import { describe, expect, it } from 'vitest'
import { buildSwarmGraph } from './swarm-graph.js'
import type { BoardCard } from './board-activity.js'

const card = (over: Partial<BoardCard> & { runId: string }): BoardCard =>
 ({
 parentRunId: null,
 personaName: 'swe',
 planner: false,
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

describe('buildSwarmGraph roles', => {
 /**
 * Depth used to answer "is this a planner" — layer 0 planned, everything below
 * worked. A three-level tree has planners on two layers, and every one of them is
 * an ordinary `delegation` child, so neither depth nor relation separates them.
 */
 it('marks a sub-planner as a planner even though it is a delegation child', => {
 const graph = buildSwarmGraph({
 treeRunId: 'root',
 cards: [
 card({ runId: 'root', planner: true }),
 card({ runId: 'area', parentRunId: 'root', relation: 'delegation', planner: true }),
 card({ runId: 'unit', parentRunId: 'area', relation: 'delegation' }),
 ],
 pathCollisions: [],
 }, [])
 const roleOf = (id: string) => graph.nodes.find((node) => node.card.runId === id)?.role
 expect(roleOf('root')).toBe('planner')
 expect(roleOf('area')).toBe('planner')
 expect(roleOf('unit')).toBe('worker')
 // The distinction the role carries is exactly the one the edge does not.
 expect(graph.edges.filter((edge) => edge.kind === 'delegation')).toHaveLength(2)
 })

 it('treats a card with no planner flag as a worker', => {
 // Runs predating the field have stored persona JSON without it; a missing flag
 // must read as "not a planner" rather than as unknown.
 const graph = buildSwarmGraph({
 treeRunId: 'root',
 cards: [card({ runId: 'root' })],
 pathCollisions: [],
 }, [])
 expect(graph.nodes[0]?.role).toBe('worker')
 })
})

describe('buildSwarmGraph', => {
 it('layers a planner and its workers', => {
 const graph = buildSwarmGraph(
 board([
 card({ runId: 'planner' }),
 card({ runId: 'w1', parentRunId: 'planner' }),
 card({ runId: 'w2', parentRunId: 'planner' }),
 ]),
 [],
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
 [],
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
 const first = buildSwarmGraph(board(cards), []).nodes.map((n) => n.card.runId)
 const shuffled = buildSwarmGraph(board([cards[2]!, cards[0]!, cards[1]!]), []).nodes.map(
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
 [],
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
 [],
)
 expect(graph.edges.filter((e) => e.kind === 'collision')).toHaveLength(0)
 })

 it('skips a collision naming a card that is not on the board', => {
 const graph = buildSwarmGraph(
 board([card({ runId: 'w1', title: 'Here' })], [
 { titles: ['Here', 'Gone'], paths: ['src'] },
 ]),
 [],
)
 expect(graph.edges.filter((e) => e.kind === 'collision')).toHaveLength(0)
 })
 })

 describe('structures that should degrade rather than break', => {
 it('treats a card whose parent is off the board as a root', => {
 const graph = buildSwarmGraph(board([card({ runId: 'orphan', parentRunId: 'elsewhere' })]), [])
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
 [],
)
 expect(graph.nodes).toHaveLength(2)
 expect(graph.nodes.every((n) => Number.isFinite(n.depth))).toBe(true)
 })

 it('is empty for no board at all', => {
 const graph = buildSwarmGraph(null, [])
 expect(graph.nodes).toEqual([])
 expect(graph.edges).toEqual([])
 expect(graph.width).toBe(0)
 expect(graph.depth).toBe(0)
 })
 })

 it('carries each node\'s live activity, so the canvas needs no second reading of it', => {
 const graph = buildSwarmGraph(
 board([card({ runId: 'w1', currentToolName: 'Bash', currentToolTarget: 'pnpm test', openCallCount: 1 })]),
 [],
)
 expect(graph.nodes[0]?.activity.kind).toBe('working')
 expect(graph.nodes[0]?.activity.toolName).toBe('Bash')
 })
})

/**
 * The merge-queue band. The argument for drawing it: the queue
 * "is the one part of the platform where *order* is the whole semantics — a list renders
 * order badly and a graph renders it naturally".
 *
 * The properties worth pinning are the ones a projection can get subtly wrong: which
 * entries belong to *this* tree, what "place in line" means when other trees are ahead,
 * and which of the two nodes each kind of failure belongs to.
 */
describe('buildSwarmGraph merge queue', => {
 const entry = (over: Partial<MergeQueueEntry> & { id: string; agentRunId: string }) =>
 ({
 workspaceId: 'ws',
 repositoryId: 'repo-1',
 branchName: `loom/run-${over.agentRunId}`,
 status: 'queued',
 position: '1',
 failureReason: null,
 detail: null,
 mergedCommitSha: null,
 verified: false,
 enqueuedByUserId: null,
 createdAt: new Date,
 startedAt: null,
 finishedAt: null,
...over,
 }) as unknown as MergeQueueEntry

 const tree = board([card({ runId: 'planner' }), card({ runId: 'w1', parentRunId: 'planner' })])

 it('draws a queued entry below the runs, edged from the run whose branch it holds', => {
 const graph = buildSwarmGraph(tree, [entry({ id: 'e1', agentRunId: 'w1' })])

 expect(graph.queue).toHaveLength(1)
 expect(graph.queue[0]?.kind).toBe('entry')
 expect(graph.queue[0]?.depth).toBe(2)
 expect(graph.edges.filter((e) => e.kind === 'queue')).toEqual([
 { from: 'w1', to: 'merge:e1', kind: 'queue', detail: '1 in line' },
 ])
 })

 it('keeps only the entries whose run is on this board', => {
 // The queue is workspace-scoped and this canvas is tree-scoped. An entry from
 // another swarm drawn here would attribute a stranger's branch to this tree.
 const graph = buildSwarmGraph(tree, [
 entry({ id: 'mine', agentRunId: 'w1' }),
 entry({ id: 'theirs', agentRunId: 'someone-else' }),
 ])
 expect(graph.queue.map((node) => node.entryId)).toEqual(['mine'])
 })

 it('counts place in line across the whole repository, not just this tree', => {
 // A branch from another tree ahead of this one really is ahead of it, and a
 // "#1 in line" that ignored it would be wrong in the one case a human is waiting on.
 const graph = buildSwarmGraph(tree, [
 entry({ id: 'ahead', agentRunId: 'stranger', position: '1' }),
 entry({ id: 'mine', agentRunId: 'w1', position: '2' }),
 ])
 expect(graph.queue.find((node) => node.entryId === 'mine')?.place).toBe(2)
 })

 it('counts each repository separately, since the queue is per repository', => {
 const graph = buildSwarmGraph(tree, [
 entry({ id: 'other-repo', agentRunId: 'stranger', repositoryId: 'repo-2', position: '1' }),
 entry({ id: 'mine', agentRunId: 'w1', repositoryId: 'repo-1', position: '2' }),
 ])
 expect(graph.queue.find((node) => node.entryId === 'mine')?.place).toBe(1)
 })

 it('drops a cancelled entry and keeps a merged one', => {
 // A human withdrew the cancelled one; "this landed" is the outcome the pipeline
 // exists to reach, so it stays.
 const graph = buildSwarmGraph(tree, [
 entry({ id: 'gone', agentRunId: 'w1', status: 'cancelled' }),
 entry({ id: 'landed', agentRunId: 'planner', status: 'merged', verified: true }),
 ])
 expect(graph.queue.filter((node) => node.kind === 'entry').map((node) => node.entryId)).toEqual([
 'landed',
 ])
 })

 it('draws no verification node while an entry is still queued', => {
 // Nothing is known about it yet, and a row of "pending" boxes under a long queue is
 // noise standing where information should be.
 const graph = buildSwarmGraph(tree, [entry({ id: 'e1', agentRunId: 'w1' })])
 expect(graph.queue.some((node) => node.kind === 'verification')).toBe(false)
 expect(graph.edges.some((e) => e.kind === 'verify')).toBe(false)
 })

 it('separates a merged-and-tested entry from a merged-unverified one', => {
 // The whole reason `verified` exists: "no tests vouched for this" is not
 // "tests passed", and a graph that drew them alike would erase the distinction.
 const tested = buildSwarmGraph(tree, [
 entry({ id: 'e1', agentRunId: 'w1', status: 'merged', verified: true }),
 ])
 const untested = buildSwarmGraph(tree, [
 entry({ id: 'e1', agentRunId: 'w1', status: 'merged', verified: false }),
 ])
 expect(tested.queue.find((node) => node.kind === 'verification')?.verification).toBe('passed')
 expect(untested.queue.find((node) => node.kind === 'verification')?.verification).toBe('skipped')
 })

 it("puts a conflict on the run's edge and a test failure on the verification node", => {
 /**
 * The canvas design is specific about the first half: the conflicted paths "belong on the edge
 * between the entry that failed and the run that owns the branch", because a conflict
 * is a fact about the pair and the run is the end that has to fix it. The mirror of
 * that is that a verification failure's output is *not* the run's — it is the
 * command's, and it belongs to the node that stands for the command.
 */
 const conflicted = buildSwarmGraph(tree, [
 entry({
 id: 'e1',
 agentRunId: 'w1',
 status: 'failed',
 failureReason: 'conflict',
 detail: 'CONFLICT in src/api.ts',
 }),
 ])
 expect(conflicted.edges.find((e) => e.kind === 'queue')?.detail).toBe('CONFLICT in src/api.ts')
 expect(conflicted.queue.find((node) => node.kind === 'verification')?.detail).toBeNull
 // A conflict failed *before* verification could say anything, so it is not drawn as a
 // verification failure — that would send someone to read test output that never ran.
 expect(conflicted.queue.find((node) => node.kind === 'verification')?.verification).toBe(
 'pending',
)

 const broken = buildSwarmGraph(tree, [
 entry({
 id: 'e1',
 agentRunId: 'w1',
 status: 'failed',
 failureReason: 'verification_failed',
 detail: '3 tests failed',
 }),
 ])
 expect(broken.queue.find((node) => node.kind === 'verification')?.detail).toBe('3 tests failed')
 expect(broken.queue.find((node) => node.kind === 'entry')?.detail).toBeNull
 expect(broken.edges.find((e) => e.kind === 'queue')?.detail).not.toContain('tests')
 })

 it('leaves the canvas dimensions alone when there is no queue', => {
 // A tree with nothing queued must render exactly as it did before this existed.
 const bare = buildSwarmGraph(tree, [])
 expect(bare.queue).toEqual([])
 expect(bare.depth).toBe(2)
 expect(bare.edges.every((e) => e.kind === 'delegation')).toBe(true)
 })

 it('grows the canvas to fit the band, so a wide queue is not clipped', => {
 const graph = buildSwarmGraph(tree, [
 entry({ id: 'a', agentRunId: 'w1', position: '1' }),
 entry({ id: 'b', agentRunId: 'planner', position: '2', status: 'merged', verified: true }),
 ])
 expect(graph.width).toBeGreaterThanOrEqual(2)
 // Two run layers, plus the entry band, plus the verification band under it.
 expect(graph.depth).toBe(4)
 })
})
