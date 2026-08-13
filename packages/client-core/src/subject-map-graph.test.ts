import type { MapEdge, MapNode, MasteryView } from '@loom/api-contract'
import { describe, expect, it } from 'vitest'

import {
 buildMapGraph,
 coveragePercent,
 describeMasteryState,
 MAX_GRAPH_NODES,
 undrawnNodeCount,
} from './subject-map-graph.js'

const node = (over: Partial<MapNode> & Pick<MapNode, 'key'>): MapNode => ({
 id: over.key,
 kind: 'file',
 label: over.key,
 summary: '',
 provenance: 'extracted',
 paths: [],
 observationCount: 1,
 derivedAtRevision: 'abc123',
 createdAt: new Date('2026-08-01T00:00:00Z'),
 invalidatedAt: null,
 invalidatedReason: null,
 retirementProposedAt: null,
 retirementReason: null,
...over,
})

const edge = (over: Partial<MapEdge> & Pick<MapEdge, 'id' | 'fromKey' | 'toKey'>): MapEdge => ({
 kind: 'imports',
 provenance: 'extracted',
 derivedAtRevision: 'abc123',
 createdAt: new Date('2026-08-01T00:00:00Z'),
 invalidatedAt: null,
 invalidatedReason: null,
...over,
})

const view = (over: Partial<MasteryView> = {}): MasteryView => ({
 map: {
 id: 'm1',
 workspaceId: 'w1',
 personaId: 'p1',
 subjectKind: 'repository',
 repositoryId: 'r1',
 subjectRef: 'flight-api',
 revision: 'abc1234567',
 status: 'ready',
 retrievalOverride: null,
 masteryRunId: 'run1',
 createdAt: new Date('2026-08-01T00:00:00Z'),
 updatedAt: new Date('2026-08-01T00:00:00Z'),
 },
 nodes: [],
 edges: [],
 progress: null,
 hubs: [],
 effect: {
 retrieved: {
 arm: 'retrieved',
 decided: 0,
 merged: 0,
 discarded: 0,
 failed: 0,
 costUsdTotal: 0,
 successRate: 0,
 meanCostUsd: 0,
 },
 withheld: {
 arm: 'withheld',
 decided: 0,
 merged: 0,
 discarded: 0,
 failed: 0,
 costUsdTotal: 0,
 successRate: 0,
 meanCostUsd: 0,
 },
 verdict: 'undecided',
 detail: 'Still measuring.',
 },
 retrievalState: 'trial',
...over,
})

describe('buildMapGraph — provenance survives to the picture', => {
 it('carries each node and edge provenance through, so a renderer can tell them apart', => {
 const graph = buildMapGraph(
 view({
 nodes: [node({ key: 'a' }), node({ key: 'b', provenance: 'inferred', kind: 'concept' })],
 edges: [edge({ id: 'e1', fromKey: 'b', toKey: 'a', provenance: 'inferred' })],
 }),
)

 expect(graph.nodes.find((n) => n.key === 'a')?.provenance).toBe('extracted')
 expect(graph.nodes.find((n) => n.key === 'b')?.provenance).toBe('inferred')
 expect(graph.edges[0]?.provenance).toBe('inferred')
 })

 it('counts live claims by provenance — how much of this is checkable', => {
 const graph = buildMapGraph(
 view({
 nodes: [
 node({ key: 'a' }),
 node({ key: 'b', provenance: 'inferred' }),
 node({ key: 'c', provenance: 'ambiguous' }),
 ],
 }),
)

 expect(graph.counts).toEqual({ extracted: 1, inferred: 1, ambiguous: 1 })
 })

 it('draws nothing invalidated, and reports how many were retired', => {
 const graph = buildMapGraph(
 view({
 nodes: [
 node({ key: 'live' }),
 node({ key: 'gone', invalidatedAt: new Date('2026-08-02T00:00:00Z') }),
 ],
 }),
)

 expect(graph.nodes.map((n) => n.key)).toEqual(['live'])
 expect(graph.invalidated).toBe(1)
 })

 it('puts concepts on the inner ring and code on the outer one', => {
 const graph = buildMapGraph(
 view({
 nodes: [
 node({ key: 'checkout', kind: 'concept' }),
 node({ key: 'rules', kind: 'convention' }),
 node({ key: 'a.ts' }),
 ],
 }),
)

 expect(graph.nodes.find((n) => n.key === 'checkout')?.ring).toBe('concept')
 expect(graph.nodes.find((n) => n.key === 'rules')?.ring).toBe('concept')
 expect(graph.nodes.find((n) => n.key === 'a.ts')?.ring).toBe('code')
 })

 it('drops an edge whose endpoint was retired rather than drawing it to nowhere', => {
 // The real dangling case: an edge outlives the node it points at, because
 // invalidation is a write and the edge's own row is untouched by it.
 const graph = buildMapGraph(
 view({
 nodes: [
 node({ key: 'live' }),
 node({ key: 'gone', invalidatedAt: new Date('2026-08-02T00:00:00Z') }),
 ],
 edges: [edge({ id: 'e1', fromKey: 'live', toKey: 'gone' })],
 }),
)

 expect(graph.nodes.map((n) => n.key)).toEqual(['live'])
 expect(graph.edges).toHaveLength(0)
 })

 it('never draws more than the cap, and keeps the connected nodes when it cuts', => {
 const many = Array.from({ length: MAX_GRAPH_NODES + 20 }, (_, i) => node({ key: `n${i}` }))
 const graph = buildMapGraph(
 view({
 nodes: many,
 edges: [edge({ id: 'e1', fromKey: 'n0', toKey: `n${MAX_GRAPH_NODES + 19}` })],
 }),
)

 expect(graph.nodes).toHaveLength(MAX_GRAPH_NODES)
 // Both endpoints have a degree, so degree ranking keeps them and the edge survives
 // the cut — which is the behaviour worth having: an isolated node is the cheapest
 // thing to drop and a connected one is the most expensive.
 expect(graph.edges).toHaveLength(1)
 })

 it('caps a hub\'s radius, so one god node cannot cover the graph it is a feature of', => {
 const nodes = [node({ key: 'hub' }),...Array.from({ length: 40 }, (_, i) => node({ key: `n${i}` }))]
 const edges = Array.from({ length: 40 }, (_, i) =>
 edge({ id: `e${i}`, fromKey: `n${i}`, toKey: 'hub' }),
)

 const graph = buildMapGraph(view({ nodes, edges, hubs: [{ key: 'hub', degree: 40 }] }))
 const hub = graph.nodes.find((n) => n.key === 'hub')

 expect(hub?.hub).toBe(true)
 expect(hub?.radius).toBeLessThanOrEqual(26)
 })

 it('centres a lone concept rather than pushing it out to a ring of one', => {
 const graph = buildMapGraph(view({ nodes: [node({ key: 'only', kind: 'concept' })] }))

 expect(graph.nodes[0]?.x).toBe(graph.width / 2)
 expect(graph.nodes[0]?.y).toBe(graph.height / 2)
 })
})

describe('undrawnNodeCount — truncation is stated, never implied', => {
 it('is zero for a map that fits', => {
 expect(undrawnNodeCount(view({ nodes: [node({ key: 'a' })] }))).toBe(0)
 })

 it('counts what the picture left out', => {
 const nodes = Array.from({ length: MAX_GRAPH_NODES + 7 }, (_, i) => node({ key: `n${i}` }))
 expect(undrawnNodeCount(view({ nodes }))).toBe(7)
 })
})

describe('coveragePercent — an unmeasured quantity is not a measured zero', => {
 it('is null before any checkpoint', => {
 expect(coveragePercent(view)).toBeNull
 })

 it('rounds a measured coverage', => {
 expect(
 coveragePercent(
 view({
 progress: {
 coverage: 0.256,
 nodeCount: 1,
 edgeCount: 0,
 yield: 1,
 yieldFlat: false,
 spendUsd: 0.01,
 },
 }),
),
).toBe(26)
 })
})

describe('describeMasteryState — what a human needs in one line', => {
 it('says a flat yield out loud, because it is the state worth interrupting', => {
 const text = describeMasteryState(
 view({
 map: {...view.map, status: 'mastering' },
 progress: {
 coverage: 0.6,
 nodeCount: 20,
 edgeCount: 5,
 yield: 0,
 yieldFlat: true,
 spendUsd: 0.2,
 },
 }),
)

 expect(text).toContain('stopped concluding')
 })

 it('names the unresolved-revision failure specifically, since it is not an ordinary one', => {
 const text = describeMasteryState(
 view({ map: {...view.map, status: 'failed', revision: 'pending' } }),
)

 expect(text).toContain('which commit it was reading')
 })
})
