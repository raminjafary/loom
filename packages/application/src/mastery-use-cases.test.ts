import {
 CONCEPT_NODE_KINDS,
 asAgentPersonaId,
 asAgentRunId,
 asRepositoryId,
 asSubjectMapId,
 asWorkspaceId,
 MAX_NODES_PER_MAP,
 UNTRUSTED_MAP_OPEN,
 type MapEdge,
 type MapNode,
 type ExpertiseArmTally,
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
 curateIdleMaps,
 curateMap,
 getMastery,
 listExpertiseUsedByRuns,
 listPersonaMaps,
 setRetrievalOverride,
 type MasteryDeps,
} from './mastery-use-cases.js'

const workspaceId = asWorkspaceId('w1')
const personaId = asAgentPersonaId('p1')
const repositoryId = asRepositoryId('r1')
const runId = asAgentRunId('run1')
/** An ordinary run, distinct from the mastery run — the one retrieval is *for*. */
const otherRunId = asAgentRunId('run2')

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
 retrievalOverride: existing?.retrievalOverride ?? null,
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
 retirementProposedAt: null,
 retirementReason: null,
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

 /** The atlas's read side — concepts, live, from `ready` maps of other subjects. */
 async listConceptsAcrossSubjects(
 _w: typeof workspaceId,
 options: { excludeRepositoryId?: SubjectMap['repositoryId']; limit: number },
) {
 const mapById = new Map(this.maps.map((map) => [map.id as string, map]))
 return this.nodes
.filter((node) => node.invalidatedAt === null)
.filter((node) => CONCEPT_NODE_KINDS.includes(node.kind))
.flatMap((node) => {
 const map = mapById.get(node.mapId as string)
 if (!map || map.status !== 'ready') return []
 if (
 options.excludeRepositoryId !== undefined &&
 map.repositoryId === options.excludeRepositoryId
) {
 return []
 }
 return [
 {
 nodeId: node.id,
 mapId: map.id,
 label: node.label,
 summary: node.summary,
 subjectRef: map.subjectRef,
 personaName: `persona-${map.personaId}`,
 createdAt: node.createdAt,
 },
 ]
 })
.slice(0, options.limit)
 }

 async findConceptsByLabel(
 _w: typeof workspaceId,
 input: { label: string; repositoryId?: SubjectMap['repositoryId']; subjectRef?: string },
) {
 const mapById = new Map(this.maps.map((map) => [map.id as string, map]))
 return this.nodes
.filter((node) => node.invalidatedAt === null)
.filter((node) => CONCEPT_NODE_KINDS.includes(node.kind))
.filter((node) => node.label.toLowerCase === input.label.toLowerCase)
.flatMap((node) => {
 const map = mapById.get(node.mapId as string)
 if (!map || map.status !== 'ready') return []
 if (input.repositoryId !== undefined && map.repositoryId !== input.repositoryId) return []
 if (input.subjectRef !== undefined && map.subjectRef !== input.subjectRef) return []
 return [
 {
 nodeId: node.id,
 mapId: map.id,
 kind: node.kind,
 label: node.label,
 summary: node.summary,
 subjectRef: map.subjectRef,
 repositoryId: map.repositoryId,
 personaId: map.personaId,
 personaName: `persona-${map.personaId}`,
 },
 ]
 })
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

 async proposeRetirement(
 _w: typeof workspaceId,
 nodeIds: readonly string[],
 reason: string | null,
) {
 let touched = 0
 this.nodes = this.nodes.map((node) => {
 if (!nodeIds.includes(node.id) || node.invalidatedAt !== null) return node
 touched += 1
 return {
...node,
 retirementProposedAt: reason === null ? null: new Date,
 retirementReason: reason,
 }
 })
 return touched
 }

 async listAllMaps(_w: typeof workspaceId) {
 return this.maps
 }

 async listWorkspacesWithMaps {
 return [...new Set(this.maps.filter((map) => map.status === 'ready').map((m) => m.workspaceId))]
 }

 async listCheckpoints(_w: typeof workspaceId, mapId: SubjectMap['id']) {
 return this.checkpoints.filter((entry) => entry.mapId === mapId)
 }

 /** The trial. The rows *are* the measurement, so the fake keeps them all. */
 uses: {
 mapId: string
 agentRunId: string
 arm: 'retrieved' | 'withheld'
 nodesShown: number
 edgesShown: number
 nodeIds: readonly string[]
 }[] = []
 /** What `tallyNodeOutcomes` would return; set by a test that wants claims ranked. */
 nodeOutcomes: Record<string, { decided: number; merged: number; discarded: number; failed: number }> = {}
 /** What `tallyExpertiseOutcomes` would return; set by a test that wants a verdict. */
 tallies: Record<string, ExpertiseArmTally[]> = {}

 async setRetrievalOverride(
 _w: typeof workspaceId,
 mapId: SubjectMap['id'],
 override: SubjectMap['retrievalOverride'],
) {
 const map = this.maps.find((entry) => entry.id === mapId)
 if (!map) return null
 const next = {...map, retrievalOverride: override }
 this.maps = this.maps.map((entry) => (entry.id === mapId ? next: entry))
 return next
 }

 async recordExpertiseUse(input: {
 mapId: SubjectMap['id']
 agentRunId: string
 arm: 'retrieved' | 'withheld'
 nodesShown: number
 edgesShown: number
 nodeIds: readonly string[]
 }) {
 // Idempotent per (run, map), like the real one: a run is on one arm.
 if (this.uses.some((use) => use.mapId === input.mapId && use.agentRunId === input.agentRunId)) {
 return
 }
 this.uses = [
...this.uses,
 {
 mapId: input.mapId,
 agentRunId: input.agentRunId,
 arm: input.arm,
 nodesShown: input.nodesShown,
 edgesShown: input.edgesShown,
 nodeIds: input.nodeIds,
 },
 ]
 }

 async tallyNodeOutcomes {
 return this.nodeOutcomes
 }

 async countExpertiseUses(_w: typeof workspaceId, mapId: SubjectMap['id']) {
 const forMap = this.uses.filter((use) => use.mapId === mapId)
 return {
 retrieved: forMap.filter((use) => use.arm === 'retrieved').length,
 withheld: forMap.filter((use) => use.arm === 'withheld').length,
 }
 }

 async tallyExpertiseOutcomes(_w: typeof workspaceId, mapIds: readonly SubjectMap['id'][]) {
 return Object.fromEntries(
 mapIds.map((mapId) => [mapId as string, this.tallies[mapId as string] ?? []]),
)
 }

 async listExpertiseUsesForRuns(_w: typeof workspaceId, agentRunIds: readonly string[]) {
 return this.uses
.filter((use) => agentRunIds.includes(use.agentRunId))
.map((use) => ({
 agentRunId: use.agentRunId,
 mapId: use.mapId,
 arm: use.arm,
 nodesShown: use.nodesShown,
 edgesShown: use.edgesShown,
 }))
 }
}

let maps: FakeMaps
let deps: MasteryDeps

beforeEach( => {
 maps = new FakeMaps
 deps = {
 subjectMaps: maps,
 // A run row that costs nothing, which is what `getMastery` reads for the spend it
 // reports: the checkpoint's copy is a sample taken mid-run, and on the unsandboxed
 // path the whole cost arrives after the last one.
 agentRuns: {
 findById: async => ({ totalCostUsd: null }),
 } as unknown as MasteryDeps['agentRuns'],
 }
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
 retirementProposedAt: null,
 retirementReason: null,
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

 /**
 * The trial changed what "a ready map" means for the *first* run against it: a
 * tie goes to the baseline, so the very first eligible run measures the unaided case.
 * The map is rendered on the next one — and both are recorded, which is the point.
 */
 it('renders a ready map inside the untrusted fence, once the trial reaches that arm', async => {
 await readyMapWithNode

 const baseline = await buildMapContext(deps, {
 workspaceId,
 personaId,
 repositoryId,
 agentRunId: otherRunId,
 })
 expect(baseline).toBe('')
 expect(maps.uses.map((use) => use.arm)).toEqual(['withheld'])

 const context = await buildMapContext(deps, {
 workspaceId,
 personaId,
 repositoryId,
 agentRunId: asAgentRunId('run3'),
 })

 expect(context).toContain('Checkout flow')
 expect(context).toContain(UNTRUSTED_MAP_OPEN)
 expect(maps.uses.map((use) => use.arm)).toEqual(['withheld', 'retrieved'])
 })

 it('withholds a map of another repository — an expert on the wrong codebase is worse than none', async => {
 await readyMapWithNode

 const context = await buildMapContext(deps, {
 workspaceId,
 personaId,
 repositoryId: asRepositoryId('hotel'),
 agentRunId: otherRunId,
 })

 expect(context).toBe('')
 })

 it('withholds a map still being mastered', async => {
 const map = await readyMapWithNode
 await maps.setStatus(workspaceId, map.id, 'mastering')

 expect(await buildMapContext(deps, { workspaceId, personaId, repositoryId, agentRunId: otherRunId })).toBe('')
 })

 it("never hands a mastery run its own in-progress map back", async => {
 await readyMapWithNode

 const context = await buildMapContext(deps, {
 workspaceId,
 personaId,
 repositoryId,
 agentRunId: runId,
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

/**
 * The gate: an expertise is off for a pairing until it has beaten the unaided
 * baseline, and Phase 3b makes that the gate on curation, the Colosseum and handoff.
 *
 * The domain tests cover what the verdict means. These cover the half that could silently
 * not happen: that both arms are *recorded*, that an `off` map records nothing, and that
 * a human's answer beats the measurement.
 */
describe('the expertise trial', => {
 const readyMap = async => {
 const map = await openMap(deps, {
 workspaceId,
 personaId,
 subjectKind: 'repository',
 repositoryId,
 subjectRef: 'flight',
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

 const runContext = (agentRunId: string) =>
 buildMapContext(deps, {
 workspaceId,
 personaId,
 repositoryId,
 agentRunId: asAgentRunId(agentRunId),
 })

 it('alternates, so the baseline it is judged against actually accumulates', async => {
 await readyMap
 for (const id of ['a', 'b', 'c', 'd']) await runContext(id)

 expect(maps.uses.map((use) => use.arm)).toEqual([
 'withheld',
 'retrieved',
 'withheld',
 'retrieved',
 ])
 })

 it('records what a retrieved run was actually shown, not merely that it was shown one', async => {
 await readyMap
 await runContext('a')
 await runContext('b')

 const retrieved = maps.uses.find((use) => use.arm === 'retrieved')!
 expect(retrieved.nodesShown).toBe(1)
 // A withheld run's row is the baseline, and it saw nothing — recording a count here
 // would make the two arms indistinguishable in the one field that says what happened.
 expect(maps.uses.find((use) => use.arm === 'withheld')!.nodesShown).toBe(0)
 })

 /**
 * The per-claim citation, and the reason it is not a guess: these are the exact nodes
 * `selectMapForContext` rendered, not an inference about which ones a run acted on.
 */
 it('records which claims the run was shown, not just how many', async => {
 await readyMap
 await runContext('a')
 await runContext('b')

 const retrieved = maps.uses.find((use) => use.arm === 'retrieved')!
 expect(retrieved.nodeIds).toHaveLength(retrieved.nodesShown)
 expect(retrieved.nodeIds[0]).toBe(maps.nodes[0]?.id)
 })

 it('cites nothing for a run the trial deliberately denied the map', async => {
 await readyMap
 await runContext('a')
 await runContext('b')

 expect(maps.uses.find((use) => use.arm === 'withheld')!.nodeIds).toEqual([])
 })

 it('is idempotent per run, so one run cannot be counted twice in an arm', async => {
 await readyMap
 await runContext('a')
 await runContext('a')

 expect(maps.uses).toHaveLength(1)
 })

 it('hands over the map every time once the measurement says it helps', async => {
 const map = await readyMap
 maps.tallies = {
 [map.id]: [
 { arm: 'retrieved', decided: 5, merged: 5, discarded: 0, failed: 0, costUsdTotal: 1 },
 { arm: 'withheld', decided: 5, merged: 1, discarded: 4, failed: 0, costUsdTotal: 1 },
 ],
 }

 expect(await runContext('a')).toContain('Checkout flow')
 expect(await runContext('b')).toContain('Checkout flow')
 expect(maps.uses.every((use) => use.arm === 'retrieved')).toBe(true)
 })

 /**
 * The reason `off` records nothing: withheld rows for a map nobody retrieves from would
 * inflate the baseline it is judged against, so the decision could never be revisited.
 * Off has to be reversible, not merely permanent.
 */
 it('records nothing at all for a map the measurement turned off', async => {
 const map = await readyMap
 maps.tallies = {
 [map.id]: [
 { arm: 'retrieved', decided: 5, merged: 1, discarded: 4, failed: 0, costUsdTotal: 1 },
 { arm: 'withheld', decided: 5, merged: 5, discarded: 0, failed: 0, costUsdTotal: 1 },
 ],
 }

 expect(await runContext('a')).toBe('')
 expect(maps.uses).toEqual([])
 })

 it('lets a human turn a map on against the measurement, and off against it', async => {
 const map = await readyMap
 maps.tallies = {
 [map.id]: [
 { arm: 'retrieved', decided: 5, merged: 1, discarded: 4, failed: 0, costUsdTotal: 1 },
 { arm: 'withheld', decided: 5, merged: 5, discarded: 0, failed: 0, costUsdTotal: 1 },
 ],
 }

 await setRetrievalOverride(deps, { workspaceId, mapId: map.id, override: 'on' })
 expect(await runContext('a')).toContain('Checkout flow')

 await setRetrievalOverride(deps, { workspaceId, mapId: map.id, override: 'off' })
 expect(await runContext('b')).toBe('')

 // Cleared is a third act: the measurement decides again, and it says off.
 await setRetrievalOverride(deps, { workspaceId, mapId: map.id, override: null })
 expect(await runContext('c')).toBe('')
 })

 it('reports the trial with the map, so a human can see whether it earned its place', async => {
 const map = await readyMap
 maps.tallies = {
 [map.id]: [
 { arm: 'retrieved', decided: 5, merged: 4, discarded: 1, failed: 0, costUsdTotal: 1 },
 { arm: 'withheld', decided: 5, merged: 1, discarded: 4, failed: 0, costUsdTotal: 1 },
 ],
 }

 const view = await getMastery(deps, { workspaceId, mapId: map.id })
 expect(view.effect.verdict).toBe('helps')
 expect(view.retrievalState).toBe('on')

 const listed = await listPersonaMaps(deps, { workspaceId, personaId })
 expect(listed[0]?.retrievalState).toBe('on')
 expect(listed[0]?.decided).toEqual({ retrieved: 5, withheld: 5 })
 })

 /**
 * The operator's badge, at its strongest reading: not "this persona holds a map" but
 * "this run read it". Only the trial rows can answer that.
 */
 it('answers which expertise one run actually read', async => {
 await readyMap
 await runContext('a')
 await runContext('b')

 const uses = await listExpertiseUsedByRuns(deps, {
 workspaceId,
 agentRunIds: [asAgentRunId('a'), asAgentRunId('b')],
 })

 expect(uses.find((use) => use.agentRunId === 'a')?.arm).toBe('withheld')
 const read = uses.find((use) => use.agentRunId === 'b')
 expect(read?.arm).toBe('retrieved')
 expect(read?.map.subjectRef).toBe('flight')
 })
})

/**
 * Idle curation.
 *
 * The domain tests cover which claims a pass would propose. These cover the half that
 * decides whether it is safe: that the first pass only *proposes*, that the second
 * carries it out, that a proposal which stopped being true is withdrawn, and that the
 * whole thing declines to run while a human is waiting for something.
 */
describe('curateMap and the idle gate', => {
 const openReadyMap = async (revision: string) => {
 const map = await openMap(deps, {
 workspaceId,
 personaId,
 subjectKind: 'repository',
 repositoryId,
 subjectRef: 'flight',
 revision,
 masteryRunId: runId,
 })
 await maps.setStatus(workspaceId, map.id, 'ready')
 return map
 }

 it('proposes on the first pass and retires nothing', async => {
 const map = await openReadyMap('rev1')
 await recordMapFragment(deps, {
 workspaceId,
 agentRunId: runId,
 fragment: { nodes: [{ key: 'guess', kind: 'concept', label: 'A guess' }] },
 })
 // Re-mastered at a newer revision without re-confirming the claim.
 await maps.upsertMap({
 workspaceId,
 personaId,
 subjectKind: 'repository',
 repositoryId,
 subjectRef: 'flight',
 revision: 'rev2',
 status: 'ready',
 masteryRunId: runId,
 })

 const first = await curateMap(deps, { workspaceId, mapId: map.id })
 expect(first).toMatchObject({ checked: 1, retired: 0, proposed: 1 })
 expect(maps.nodes[0]?.invalidatedAt).toBeNull
 expect(maps.nodes[0]?.retirementReason).toContain('not re-confirmed')

 const second = await curateMap(deps, { workspaceId, mapId: map.id })
 expect(second).toMatchObject({ retired: 1, proposed: 0 })
 expect(maps.nodes[0]?.invalidatedAt).not.toBeNull
 // Retired with the reason the *proposal* carried — that is what a human had the
 // chance to disagree with.
 expect(maps.nodes[0]?.invalidatedReason).toContain('not re-confirmed')
 })

 it('withdraws a proposal that stopped being true instead of carrying it out', async => {
 const map = await openReadyMap('rev1')
 await recordMapFragment(deps, {
 workspaceId,
 agentRunId: runId,
 fragment: { nodes: [{ key: 'guess', kind: 'concept', label: 'A guess' }] },
 })
 await maps.upsertMap({
 workspaceId,
 personaId,
 subjectKind: 'repository',
 repositoryId,
 subjectRef: 'flight',
 revision: 'rev2',
 status: 'ready',
 masteryRunId: runId,
 })
 await curateMap(deps, { workspaceId, mapId: map.id })

 // A later mastery run re-confirms it at the current revision, which is exactly the
 // case the window exists for.
 maps.nodes = maps.nodes.map((node) => ({...node, derivedAtRevision: 'rev2' }))

 const next = await curateMap(deps, { workspaceId, mapId: map.id })
 expect(next).toMatchObject({ retired: 0, withdrawn: 1 })
 expect(maps.nodes[0]?.invalidatedAt).toBeNull
 expect(maps.nodes[0]?.retirementProposedAt).toBeNull
 })

 /**
 * Mastery: "idle means idle — curation never competes with work a human is waiting for."
 * Checked in the use case rather than by its caller, because the caller is a timer and
 * a timer cannot be trusted to remember a safety rule.
 */
 it('declines to run while anything in the workspace is running', async => {
 await openReadyMap('rev1')
 const result = await curateIdleMaps(
 {...deps, runControl: { get: async => ({ paused: false }) } as never },
 { workspaceId, activeRuns: 1 },
)
 expect(result.maps).toBe(0)
 })

 it('declines to run while the kill switch is down', async => {
 await openReadyMap('rev1')
 const result = await curateIdleMaps(
 {...deps, runControl: { get: async => ({ paused: true }) } as never },
 { workspaceId, activeRuns: 0 },
)
 expect(result.maps).toBe(0)
 })

 it('runs over every ready map when nothing is competing with it', async => {
 await openReadyMap('rev1')
 const result = await curateIdleMaps(
 {...deps, runControl: { get: async => ({ paused: false }) } as never },
 { workspaceId, activeRuns: 0 },
)
 expect(result.maps).toBe(1)
 })
})
