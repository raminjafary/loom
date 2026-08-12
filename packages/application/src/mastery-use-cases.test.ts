import {
 asAgentPersonaId,
 asAgentRunId,
 asRepositoryId,
 asSubjectMapId,
 asWorkspaceId,
 MAX_NODES_PER_MAP,
 UNTRUSTED_MAP_OPEN,
 type MapEdge,
 type MapNode,
 type MasteryCheckpoint,
 type SubjectMap,
} from '@loom/domain'
import { beforeEach, describe, expect, it } from 'vitest'

import type { SubjectMapRepositoryPort } from './agent-ports.js'
import {
 buildMapContext,
 closeMap,
 invalidateMapsForMerge,
 openMap,
 PENDING_REVISION,
 recordMapFragment,
 resolveMapRevision,
 type MasteryDeps,
} from './mastery-use-cases.js'

const workspaceId = asWorkspaceId('w1')
const personaId = asAgentPersonaId('p1')
const repositoryId = asRepositoryId('r1')
const runId = asAgentRunId('run1')

/**
 * An in-memory `SubjectMapRepositoryPort` — same reasoning as `FakeStore`:
 * the application layer is testable with no Postgres. It reproduces the one behaviour
 * the real one is careful about, the bi-temporal write, because that is what these tests
 * are about.
 */
class FakeMaps implements SubjectMapRepositoryPort {
 maps: SubjectMap[] = []
 nodes: MapNode[] = []
 edges: MapEdge[] = []
 checkpoints: (MasteryCheckpoint & { mapId: string })[] = []
 private seq = 0

 private id(prefix: string): string {
 this.seq += 1
 return `${prefix}-${this.seq}`
 }

 async upsertMap(input: Parameters<SubjectMapRepositoryPort['upsertMap']>[0]) {
 const existing = this.maps.find(
 (map) =>
 map.personaId === input.personaId &&
 map.subjectKind === input.subjectKind &&
 map.subjectRef === input.subjectRef,
)
 const next: SubjectMap = {
 id: existing?.id ?? asSubjectMapId(this.id('map')),
 workspaceId: input.workspaceId,
 personaId: input.personaId,
 subjectKind: input.subjectKind,
 repositoryId: input.repositoryId,
 subjectRef: input.subjectRef,
 revision: input.revision,
 status: input.status,
 masteryRunId: input.masteryRunId,
 createdAt: existing?.createdAt ?? new Date('2026-08-01T00:00:00Z'),
 updatedAt: new Date('2026-08-01T01:00:00Z'),
 }
 this.maps = [...this.maps.filter((map) => map.id !== next.id), next]
 return next
 }

 async setStatus(_w: typeof workspaceId, mapId: SubjectMap['id'], status: SubjectMap['status']) {
 const map = this.maps.find((entry) => entry.id === mapId)
 if (!map) return null
 const next = {...map, status }
 this.maps = this.maps.map((entry) => (entry.id === mapId ? next: entry))
 return next
 }

 async getMap(_w: typeof workspaceId, mapId: SubjectMap['id']) {
 return this.maps.find((map) => map.id === mapId) ?? null
 }

 async findMapByRun(_w: typeof workspaceId, masteryRunId: SubjectMap['masteryRunId']) {
 return this.maps.find((map) => map.masteryRunId === masteryRunId) ?? null
 }

 async listMapsForPersona(_w: typeof workspaceId, id: SubjectMap['personaId']) {
 return this.maps.filter((map) => map.personaId === id)
 }

 async listMapsForRepository(_w: typeof workspaceId, id: SubjectMap['repositoryId']) {
 return this.maps.filter((map) => map.repositoryId === id)
 }

 async writeFragment(input: Parameters<SubjectMapRepositoryPort['writeFragment']>[0]) {
 let nodesWritten = 0
 let superseded = 0
 for (const node of input.nodes) {
 const live = this.nodes.find(
 (entry) =>
 entry.mapId === input.mapId && entry.key === node.key && entry.invalidatedAt === null,
)
 if (live) {
 this.nodes = this.nodes.map((entry) =>
 entry.id === live.id
 ? {...entry, invalidatedAt: new Date, invalidatedReason: 'superseded' }
: entry,
)
 superseded += 1
 }
 this.nodes.push({
 id: this.id('node'),
 mapId: input.mapId,
 workspaceId: input.workspaceId,
 key: node.key,
 kind: node.kind,
 label: node.label,
 summary: node.summary,
 provenance: node.provenance,
 paths: node.paths,
 observationCount: node.observationCount,
 derivedAtRevision: input.revision,
 createdAt: new Date,
 invalidatedAt: null,
 invalidatedReason: null,
 })
 nodesWritten += 1
 }
 return { nodesWritten, edgesWritten: input.edges.length, superseded }
 }

 async listNodes(_w: typeof workspaceId, mapId: SubjectMap['id']) {
 return this.nodes.filter((node) => node.mapId === mapId)
 }

 async listEdges(_w: typeof workspaceId, mapId: SubjectMap['id']) {
 return this.edges.filter((edge) => edge.mapId === mapId)
 }

 async countLive(_w: typeof workspaceId, mapId: SubjectMap['id']) {
 return {
 nodes: this.nodes.filter((node) => node.mapId === mapId && node.invalidatedAt === null)
.length,
 edges: this.edges.filter((edge) => edge.mapId === mapId && edge.invalidatedAt === null)
.length,
 }
 }

 async invalidateNodes(_w: typeof workspaceId, nodeIds: readonly string[], reason: string) {
 let count = 0
 this.nodes = this.nodes.map((node) => {
 if (!nodeIds.includes(node.id) || node.invalidatedAt !== null) return node
 count += 1
 return {...node, invalidatedAt: new Date, invalidatedReason: reason }
 })
 return count
 }

 async appendCheckpoint(input: Parameters<SubjectMapRepositoryPort['appendCheckpoint']>[0]) {
 const checkpoint = {
 mapId: input.mapId as string,
 at: new Date(Date.UTC(2026, 7, 1, 0, this.checkpoints.length)),
 filesRead: input.filesRead,
 filesInScope: input.filesInScope,
 nodeCount: input.nodeCount,
 edgeCount: input.edgeCount,
 spendUsd: input.spendUsd,
 }
 this.checkpoints.push(checkpoint)
 return checkpoint
 }

 async listCheckpoints(_w: typeof workspaceId, mapId: SubjectMap['id']) {
 return this.checkpoints.filter((entry) => entry.mapId === mapId)
 }
}

let maps: FakeMaps
let deps: MasteryDeps

beforeEach( => {
 maps = new FakeMaps
 deps = { subjectMaps: maps, agentRuns: {} as MasteryDeps['agentRuns'] }
})

const open = (over: { revision?: string } = {}) =>
 openMap(deps, {
 workspaceId,
 personaId,
 subjectKind: 'repository',
 repositoryId,
 subjectRef: 'flight-api',
 revision: over.revision ?? 'abc123',
 masteryRunId: runId,
 })

describe('openMap — a map with no revision is a rumour', => {
 it('refuses an empty revision', async => {
 await expect(open({ revision: ' ' })).rejects.toThrow(/revision/)
 })

 it('re-opens the same map rather than making a second one for the same subject', async => {
 const first = await open
 const second = await open({ revision: 'def456' })

 expect(second.id).toBe(first.id)
 expect(second.revision).toBe('def456')
 expect(maps.maps).toHaveLength(1)
 })
})

describe('recordMapFragment — the model may not write trusted structure', => {
 it('refuses a run with no map, and says what to do instead', async => {
 const result = await recordMapFragment(deps, {
 workspaceId,
 agentRunId: asAgentRunId('other'),
 fragment: { nodes: [{ key: 'a', kind: 'file', label: 'a' }] },
 })

 expect(result.ok).toBe(false)
 if (!result.ok) expect(result.reason).toContain('note instead')
 })

 it('refuses a fragment claiming extracted provenance', async => {
 await open
 const result = await recordMapFragment(deps, {
 workspaceId,
 agentRunId: runId,
 fragment: { nodes: [{ key: 'a', kind: 'file', label: 'a', provenance: 'extracted' }] },
 })

 expect(result.ok).toBe(false)
 expect(maps.nodes).toHaveLength(0)
 })

 it('records an inferred fragment and reports what it replaced', async => {
 await open
 await recordMapFragment(deps, {
 workspaceId,
 agentRunId: runId,
 fragment: { nodes: [{ key: 'checkout', kind: 'concept', label: 'Checkout' }] },
 })
 const second = await recordMapFragment(deps, {
 workspaceId,
 agentRunId: runId,
 fragment: { nodes: [{ key: 'checkout', kind: 'concept', label: 'Checkout, revised' }] },
 })

 expect(second.ok).toBe(true)
 if (second.ok) expect(second.superseded).toBe(1)
 })

 it('bounds a map against its live count, not its history', async => {
 await open
 const map = maps.maps[0]!
 // One live node and a great many invalidated ones: the budget is about what a
 // reader would be shown, so retired claims must not consume it.
 for (let i = 0; i < MAX_NODES_PER_MAP; i += 1) {
 maps.nodes.push({
 id: `old-${i}`,
 mapId: map.id,
 workspaceId,
 key: `old-${i}`,
 kind: 'file',
 label: 'old',
 summary: '',
 provenance: 'inferred',
 paths: [],
 observationCount: 1,
 derivedAtRevision: 'abc123',
 createdAt: new Date,
 invalidatedAt: new Date,
 invalidatedReason: 'superseded',
 })
 }

 const result = await recordMapFragment(deps, {
 workspaceId,
 agentRunId: runId,
 fragment: { nodes: [{ key: 'new', kind: 'concept', label: 'new' }] },
 })

 expect(result.ok).toBe(true)
 })
})

describe('the pending revision', => {
 it('marks a map failed when its revision never resolved, however much it recorded', async => {
 await open({ revision: PENDING_REVISION })
 await recordMapFragment(deps, {
 workspaceId,
 agentRunId: runId,
 fragment: { nodes: [{ key: 'a', kind: 'concept', label: 'a' }] },
 })

 await closeMap(deps, { workspaceId, agentRunId: runId, ok: true })

 expect(maps.maps[0]?.status).toBe('failed')
 })

 it('is fixed by the Runner reporting the clone HEAD, and then the map is ready', async => {
 await open({ revision: PENDING_REVISION })
 await resolveMapRevision(deps, { workspaceId, agentRunId: runId, revision: 'abc123' })
 await recordMapFragment(deps, {
 workspaceId,
 agentRunId: runId,
 fragment: { nodes: [{ key: 'a', kind: 'concept', label: 'a' }] },
 })

 await closeMap(deps, { workspaceId, agentRunId: runId, ok: true })

 expect(maps.maps[0]?.revision).toBe('abc123')
 expect(maps.maps[0]?.status).toBe('ready')
 })

 it('keeps a killed run\'s partial map, because that is why it was written incrementally', async => {
 await open
 await recordMapFragment(deps, {
 workspaceId,
 agentRunId: runId,
 fragment: { nodes: [{ key: 'a', kind: 'concept', label: 'a' }] },
 })

 await closeMap(deps, { workspaceId, agentRunId: runId, ok: false })

 expect(maps.maps[0]?.status).toBe('ready')
 })

 it('fails a map that learned nothing', async => {
 await open
 await closeMap(deps, { workspaceId, agentRunId: runId, ok: false })

 expect(maps.maps[0]?.status).toBe('failed')
 })
})

describe('buildMapContext — what a working run is handed', => {
 const readyMapWithNode = async (over: { repositoryId?: typeof repositoryId | null } = {}) => {
 const map = await openMap(deps, {
 workspaceId,
 personaId,
 subjectKind: 'repository',
 repositoryId: over.repositoryId === undefined ? repositoryId: over.repositoryId,
 subjectRef: 'flight-api',
 revision: 'abc123',
 masteryRunId: runId,
 })
 await recordMapFragment(deps, {
 workspaceId,
 agentRunId: runId,
 fragment: { nodes: [{ key: 'checkout', kind: 'concept', label: 'Checkout flow' }] },
 })
 await maps.setStatus(workspaceId, map.id, 'ready')
 return map
 }

 it('renders a ready map inside the untrusted fence', async => {
 await readyMapWithNode

 const context = await buildMapContext(deps, { workspaceId, personaId, repositoryId })

 expect(context).toContain('Checkout flow')
 expect(context).toContain(UNTRUSTED_MAP_OPEN)
 })

 it('withholds a map of another repository — an expert on the wrong codebase is worse than none', async => {
 await readyMapWithNode

 const context = await buildMapContext(deps, {
 workspaceId,
 personaId,
 repositoryId: asRepositoryId('hotel'),
 })

 expect(context).toBe('')
 })

 it('withholds a map still being mastered', async => {
 const map = await readyMapWithNode
 await maps.setStatus(workspaceId, map.id, 'mastering')

 expect(await buildMapContext(deps, { workspaceId, personaId, repositoryId })).toBe('')
 })

 it("never hands a mastery run its own in-progress map back", async => {
 await readyMapWithNode

 const context = await buildMapContext(deps, {
 workspaceId,
 personaId,
 repositoryId,
 excludeRunId: runId,
 })

 expect(context).toBe('')
 })
})

describe('invalidateMapsForMerge — the merge queue keeps a map honest', => {
 it('retires every persona\'s claim about a changed file, not just the merging one', async => {
 for (const persona of ['p1', 'p2']) {
 await openMap(deps, {
 workspaceId,
 personaId: asAgentPersonaId(persona),
 subjectKind: 'repository',
 repositoryId,
 subjectRef: 'flight-api',
 revision: 'abc123',
 masteryRunId: asAgentRunId(`run-${persona}`),
 })
 await recordMapFragment(deps, {
 workspaceId,
 agentRunId: asAgentRunId(`run-${persona}`),
 fragment: {
 nodes: [
 { key: 'src/pay.ts', kind: 'file', label: 'pay', paths: ['src/pay.ts'] },
 ],
 },
 })
 }

 const result = await invalidateMapsForMerge(deps, {
 workspaceId,
 repositoryId,
 changedPaths: ['src/pay.ts'],
 revision: 'def456',
 })

 expect(result.invalidated).toBe(2)
 expect(maps.nodes.every((node) => node.invalidatedAt !== null)).toBe(true)
 })

 it('does nothing when a merge changed nothing it has a claim about', async => {
 await open
 await recordMapFragment(deps, {
 workspaceId,
 agentRunId: runId,
 fragment: { nodes: [{ key: 'src/pay.ts', kind: 'file', label: 'pay', paths: ['src/pay.ts'] }] },
 })

 const result = await invalidateMapsForMerge(deps, {
 workspaceId,
 repositoryId,
 changedPaths: ['docs/readme.md'],
 revision: 'def456',
 })

 expect(result.invalidated).toBe(0)
 })
})
