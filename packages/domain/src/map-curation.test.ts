import { describe, expect, it } from 'vitest'
import { proposeRetirements, splitProposals } from './map-curation.js'
import { asSubjectMapId, asWorkspaceId } from './ids.js'
import type { MapEdge, MapNode } from './subject-map.js'

/**
 * A map maintaining itself.
 *
 * The rule these are really about is the two-pass one: deleting memory is the one
 * self-modification with no diff to review, so a pass writes down what it means to drop
 * and drops it next time — unless something contradicted it in between.
 */

const mapId = asSubjectMapId('m1')
const workspaceId = asWorkspaceId('w1')

const node = (over: Partial<MapNode> & Pick<MapNode, 'id' | 'key'>): MapNode => ({
 mapId,
 workspaceId,
 kind: 'concept',
 label: over.key,
 summary: '',
 provenance: 'inferred',
 paths: [],
 observationCount: 1,
 derivedAtRevision: 'rev2',
 createdAt: new Date('2026-08-01T00:00:00Z'),
 invalidatedAt: null,
 invalidatedReason: null,
 retirementProposedAt: null,
 retirementReason: null,
...over,
})

const edge = (over: Partial<MapEdge> & Pick<MapEdge, 'id' | 'fromKey' | 'toKey' | 'kind'>): MapEdge => ({
 mapId,
 workspaceId,
 provenance: 'inferred',
 derivedAtRevision: 'rev2',
 createdAt: new Date('2026-08-01T00:00:00Z'),
 invalidatedAt: null,
 invalidatedReason: null,
...over,
})

describe('proposeRetirements', => {
 it('proposes a claim a live claim contradicts', => {
 const proposals = proposeRetirements(
 [node({ id: 'a', key: 'old-belief' }), node({ id: 'b', key: 'newer' })],
 [edge({ id: 'e1', fromKey: 'newer', toKey: 'old-belief', kind: 'contradicts' })],
 'rev2',
)
 expect(proposals.map((p) => p.key)).toEqual(['old-belief'])
 expect(proposals[0]?.reason).toBe('contradicted')
 })

 /**
 * The asymmetry is the point: a contradiction retires its *target*, never its author.
 * The author is the newer observation, and retiring both would leave the map holding
 * neither answer to a question it had answered.
 */
 it('never retires the claim that did the contradicting', => {
 const proposals = proposeRetirements(
 [node({ id: 'a', key: 'old' }), node({ id: 'b', key: 'new' })],
 [edge({ id: 'e1', fromKey: 'new', toKey: 'old', kind: 'contradicts' })],
 'rev2',
)
 expect(proposals.some((p) => p.key === 'new')).toBe(false)
 })

 it('proposes a claim a newer one explicitly replaced', => {
 const proposals = proposeRetirements(
 [node({ id: 'a', key: 'v1' }), node({ id: 'b', key: 'v2' })],
 [edge({ id: 'e1', fromKey: 'v2', toKey: 'v1', kind: 'supersedes' })],
 'rev2',
)
 expect(proposals[0]?.reason).toBe('superseded')
 })

 it('proposes a conclusion the latest re-mastering did not re-confirm', => {
 const proposals = proposeRetirements(
 [node({ id: 'a', key: 'stale', derivedAtRevision: 'rev1' })],
 [],
 'rev2',
)
 expect(proposals[0]?.reason).toBe('unconfirmed')
 })

 /**
 * A parser's output is invalidated by the merge queue observing the file change, which
 * is a fact rather than an inference — a mastery run that did not happen to re-derive a
 * parsed claim has not made it false.
 */
 it('exempts parsed structure from being retired for not being re-derived', => {
 const proposals = proposeRetirements(
 [node({ id: 'a', key: 'src/pay.ts', provenance: 'extracted', derivedAtRevision: 'rev1' })],
 [],
 'rev2',
)
 expect(proposals).toEqual([])
 })

 it('still proposes a parsed claim a live claim contradicts, which is a finding either way', => {
 const proposals = proposeRetirements(
 [
 node({ id: 'a', key: 'src/pay.ts', provenance: 'extracted' }),
 node({ id: 'b', key: 'hazard' }),
 ],
 [edge({ id: 'e1', fromKey: 'hazard', toKey: 'src/pay.ts', kind: 'contradicts' })],
 'rev2',
)
 expect(proposals.map((p) => p.key)).toEqual(['src/pay.ts'])
 })

 it('ignores an edge from a claim that has itself been retired', => {
 const proposals = proposeRetirements(
 [
 node({ id: 'a', key: 'old' }),
 node({ id: 'b', key: 'dead', invalidatedAt: new Date, invalidatedReason: 'x' }),
 ],
 [edge({ id: 'e1', fromKey: 'dead', toKey: 'old', kind: 'contradicts' })],
 'rev2',
)
 expect(proposals).toEqual([])
 })
})

describe('splitProposals — the two-pass rule', => {
 const proposal = (nodeId: string) => ({
 nodeId,
 key: nodeId,
 reason: 'unconfirmed' as const,
 detail: 'd',
 })

 it('proposes on the first pass and retires on the second', => {
 const first = splitProposals([proposal('a')], new Set)
 expect(first.propose.map((p) => p.nodeId)).toEqual(['a'])
 expect(first.retire).toEqual([])

 const second = splitProposals([proposal('a')], new Set(['a']))
 expect(second.retire.map((p) => p.nodeId)).toEqual(['a'])
 expect(second.propose).toEqual([])
 })

 /**
 * The half that makes the window real rather than ceremonial: a proposal that stopped
 * being true is taken back, not carried out. Without this, proposing first would only
 * delay every deletion by one pass.
 */
 it('withdraws a proposal that stopped being true', => {
 const result = splitProposals([], new Set(['a']))
 expect(result.withdraw).toEqual(['a'])
 expect(result.retire).toEqual([])
 })
})
