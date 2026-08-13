import {
 MAX_EDGES_PER_MAP,
 MAX_NODES_PER_MAP,
 NotFoundError,
 ValidationError,
 asSubjectMapId,
 computeMasteryProgress,
 findHubNodes,
 retrievalStateFor,
 summarizeExpertiseEffect,
 trialAssignment,
 parseMapFragment,
 renderMapForPrompt,
 selectMapForContext,
 selectStaleNodeIds,
 type AgentPersonaId,
 type AgentRunId,
 type MapEdge,
 type MapNode,
 type ExpertiseEffect,
 type MapSubjectKind,
 type MasteryProgress,
 type RetrievalOverride,
 type RetrievalState,
 type RepositoryId,
 type SubjectMap,
 type SubjectMapId,
 type WorkspaceId,
} from '@loom/domain'
import type { AgentRunRepositoryPort, SubjectMapRepositoryPort } from './agent-ports.js'

/**
 * Mastery — how a persona comes to know a subject, and what a later run gets for it
 *.
 *
 * Split out of agent-use-cases.ts for the same reason note-use-cases.ts was: these are
 * the only callers that may write a map, and one small file is what makes "a model may
 * never write trusted structure" auditable rather than merely intended.
 * `recordMapFragment` is the single function here that accepts model-authored content,
 * and it is the only one that passes `authorKind: 'agent_run'` to the domain's parser.
 */

export interface MasteryDeps {
 readonly subjectMaps: SubjectMapRepositoryPort
 readonly agentRuns: AgentRunRepositoryPort
}

/**
 * The revision a map carries before the Runner has told the server what the clone
 * actually opened at.
 *
 * A sentinel rather than an empty string or a branch name, both of which would read as
 * a real answer somewhere: a branch name is not a revision (it moves), and an empty
 * string is the shape every "unset" bug in this codebase has taken. A map still holding
 * this when its run ends is marked `failed`, because a map that can never be
 * invalidated is worse than no map — it keeps its authority while the repository moves
 * underneath it.
 */
export const PENDING_REVISION = 'pending'

/**
 * Opens (or re-opens) the map a mastery run will write into.
 *
 * Called when the run starts, not when it first writes, and the difference matters: a
 * mastery run that produced nothing must still leave a map row saying it tried, at what
 * revision, and how it ended. A map that only exists once a model has succeeded cannot
 * record a failure, and the whole progress story is about runs a human may want to
 * stop early.
 */
export const openMap = async (
 deps: MasteryDeps,
 input: {
 workspaceId: WorkspaceId
 personaId: AgentPersonaId
 subjectKind: MapSubjectKind
 repositoryId: RepositoryId | null
 subjectRef: string
 revision: string
 masteryRunId: AgentRunId | null
 },
): Promise<SubjectMap> => {
 const subjectRef = input.subjectRef.trim
 if (subjectRef.length === 0) throw new ValidationError('A subject needs a reference')

 /**
 * Mastery: "A subject with no checkable revision cannot be mastered, only summarized, and
 * should be refused rather than quietly given a map that can never be invalidated."
 * A map whose claims can never go stale is the worst artifact in this design — it
 * keeps its authority forever while the repository moves underneath it.
 */
 const revision = input.revision.trim
 if (revision.length === 0) {
 throw new ValidationError(
 'A map needs a revision to be derived at — a commit for a repository, a digest for a corpus. Without one, nothing can ever invalidate it.',
)
 }

 return deps.subjectMaps.upsertMap({
 workspaceId: input.workspaceId,
 personaId: input.personaId,
 subjectKind: input.subjectKind,
 repositoryId: input.repositoryId,
 subjectRef,
 revision,
 status: 'mastering',
 masteryRunId: input.masteryRunId,
 })
}

/**
 * Fixes a map's revision once the Runner reports what its clone opened at.
 *
 * This exists because the server genuinely cannot know the answer: the repository is on
 * the Runner's machine and nothing in the contract resolves a ref. Rather than storing a
 * guess, the map is opened `pending` at dispatch and corrected here — and if this never
 * arrives, `closeMap` refuses to call the map ready.
 */
export const resolveMapRevision = async (
 deps: MasteryDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId; revision: string },
): Promise<void> => {
 const revision = input.revision.trim
 if (revision.length === 0 || revision === PENDING_REVISION) return

 const map = await deps.subjectMaps.findMapByRun(input.workspaceId, input.agentRunId)
 if (!map || map.revision === revision) return

 await deps.subjectMaps.upsertMap({
 workspaceId: map.workspaceId,
 personaId: map.personaId,
 subjectKind: map.subjectKind,
 repositoryId: map.repositoryId,
 subjectRef: map.subjectRef,
 revision,
 status: map.status,
 masteryRunId: map.masteryRunId,
 })
}

/**
 * Records one fragment a mastery run wrote, called per tool call.
 *
 * **Incremental, and that is the requirement**: a mastery run is the
 * longest-lived run in the system and therefore the most likely to be killed, reaped or
 * capped before it finishes. A map assembled at a stop handler is a map those runs never
 * produce, and it is also what makes the partial map unreadable *during* the run — which
 * is what makes stopping early a real option rather than a loss.
 *
 * The verdict is returned rather than thrown because the Runner relays it into the tool
 * result: a refusal a model cannot see is a refusal it will earn again on the next call.
 */
export const recordMapFragment = async (
 deps: MasteryDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId; fragment: unknown },
): Promise<
 | { ok: true; nodesWritten: number; edgesWritten: number; superseded: number }
 | { ok: false; reason: string }
> => {
 const map = await deps.subjectMaps.findMapByRun(input.workspaceId, input.agentRunId)
 if (!map) {
 return {
 ok: false,
 reason:
 'This run is not a mastery run, so it has no map to write to. Record what you learned as a note instead.',
 }
 }

 const verdict = parseMapFragment(input.fragment, {
 // The one call site in the system that passes this. Everything the platform's own
 // extractors write goes through `openMap`/`writeFragment` with 'platform', which is
 // what keeps `extracted` provenance out of a model's reach.
 authorKind: 'agent_run',
 subjectKind: map.subjectKind,
 })
 if (!verdict.ok) return { ok: false, reason: verdict.reason }

 /**
 * The map's own bound (mastery, "bounded by construction"). Checked before the write and
 * against the *live* counts, so invalidated history never consumes the budget a live
 * map is allowed — otherwise a long-lived, frequently re-mastered subject would
 * eventually be unable to record anything new because of what it used to believe.
 */
 const live = await deps.subjectMaps.countLive(input.workspaceId, map.id)
 if (live.nodes + verdict.nodes.length > MAX_NODES_PER_MAP) {
 return {
 ok: false,
 reason: `This map already holds ${live.nodes} nodes, its maximum being ${MAX_NODES_PER_MAP}. Record only what a later worker could not derive from the code itself, and merge what you have already written rather than adding to it.`,
 }
 }
 if (live.edges + verdict.edges.length > MAX_EDGES_PER_MAP) {
 return {
 ok: false,
 reason: `This map already holds ${live.edges} edges, its maximum being ${MAX_EDGES_PER_MAP}.`,
 }
 }

 const written = await deps.subjectMaps.writeFragment({
 workspaceId: input.workspaceId,
 mapId: map.id,
 revision: map.revision,
 nodes: verdict.nodes,
 edges: verdict.edges,
 })

 return { ok: true,...written }
}

/**
 * A measured checkpoint (mastery — "training progress is a measured quantity, not a status
 * line").
 *
 * Every argument is a figure the *platform* computed: `filesRead` from the run's own
 * persisted `tool_call` events, `filesInScope` from the tree at the mastered revision,
 * the counts from the map, the spend from the meter. Nothing here accepts the agent's
 * estimate of its own progress, which is model output and may be a remark but never the
 * number.
 */
export const recordMasteryCheckpoint = async (
 deps: MasteryDeps,
 input: {
 workspaceId: WorkspaceId
 agentRunId: AgentRunId
 filesRead: number
 filesInScope: number
 },
): Promise<MasteryProgress | null> => {
 const map = await deps.subjectMaps.findMapByRun(input.workspaceId, input.agentRunId)
 if (!map) return null

 /**
 * Spend is read here rather than accepted as an argument, and the difference is a bug
 * this had: the one caller passed `0`, so the "spend against cap, shown next to
 * coverage" was a zero on every checkpoint of every run. The run row already carries
 * what the **egress proxy** metered — the number that is authoritative
 * precisely because it is not the model's account of itself — and a checkpoint that
 * takes it from its caller is a checkpoint whose caller can be wrong.
 */
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)

 const live = await deps.subjectMaps.countLive(input.workspaceId, map.id)
 await deps.subjectMaps.appendCheckpoint({
 workspaceId: input.workspaceId,
 mapId: map.id,
 agentRunId: input.agentRunId,
 filesRead: input.filesRead,
 filesInScope: input.filesInScope,
 nodeCount: live.nodes,
 edgeCount: live.edges,
 spendUsd: run?.totalCostUsd ?? 0,
 })

 return computeMasteryProgress(
 await deps.subjectMaps.listCheckpoints(input.workspaceId, map.id),
)
}

/** Marks a mastery run's map finished. A failed run still leaves the map it built. */
export const closeMap = async (
 deps: MasteryDeps,
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId; ok: boolean },
): Promise<void> => {
 const map = await deps.subjectMaps.findMapByRun(input.workspaceId, input.agentRunId)
 if (!map) return

 /**
 * A run that failed after writing claims still leaves a `ready` map, and that is
 * deliberate. Mastery writes the map incrementally precisely so a killed run's partial
 * work survives; marking the map `failed` because the run was cancelled would throw
 * away claims that are individually true and individually checkable. `failed` is for
 * a map with nothing in it — a run that never learned anything.
 */
 const live = await deps.subjectMaps.countLive(input.workspaceId, map.id)

 /**
 * A map still on the sentinel never learned what it was derived at, so nothing can
 * ever invalidate its claims — see `PENDING_REVISION`. It is failed regardless of how
 * much it recorded, which is the one case where discarding real work is right.
 */
 const status =
 map.revision === PENDING_REVISION ? 'failed': live.nodes > 0 || input.ok ? 'ready': 'failed'
 await deps.subjectMaps.setStatus(input.workspaceId, map.id, status)
}

export interface MasteryView {
 readonly map: SubjectMap
 readonly nodes: MapNode[]
 readonly edges: MapEdge[]
 readonly progress: MasteryProgress | null
 /**
 * Whether reading this map has been shown to help, and what the
 * platform is currently doing about it. On the view rather than a separate procedure
 * because a human looking at a map is exactly the human who should see whether it has
 * earned its place — Phase 3b makes this the gate on everything after the map.
 */
 readonly effect: ExpertiseEffect
 readonly retrievalState: RetrievalState
 /** The god nodes — computed from the graph, never asked of a model. */
 readonly hubs: { readonly key: string; readonly degree: number }[]
}

export const getMastery = async (
 deps: MasteryDeps,
 input: { workspaceId: WorkspaceId; mapId: SubjectMapId },
): Promise<MasteryView> => {
 const map = await deps.subjectMaps.getMap(input.workspaceId, input.mapId)
 if (!map) throw new NotFoundError('SubjectMap')

 const [nodes, edges, checkpoints, trial] = await Promise.all([
 deps.subjectMaps.listNodes(input.workspaceId, map.id),
 deps.subjectMaps.listEdges(input.workspaceId, map.id),
 deps.subjectMaps.listCheckpoints(input.workspaceId, map.id),
 expertiseEffectFor(deps, { workspaceId: input.workspaceId, map }),
 ])

 return {
 map,
 nodes,
 edges,
 progress: computeMasteryProgress(checkpoints),
 hubs: findHubNodes(nodes, edges),
 effect: trial.effect,
 retrievalState: trial.state,
 }
}

/**
 * What a *working* run is handed from its persona's maps.
 *
 * Phase 3b makes this the gate on everything after the map, so what it does and does
 * not do are both deliberate:
 *
 * - **Only maps for the repository this run is against.** portable expertise: an expert persona put
 * on a team bound to another repository is "an ordinary agent with a misleading name",
 * and handing it the flight map while it works on the hotel codebase would be worse
 * than handing it nothing — it would be handing it confidently irrelevant structure.
 * - **Bounded by `selectMapForContext`**, which keeps concepts and hubs and says how
 * much it dropped.
 * - **Never the run's own mastery map mid-run**, because a run reading back its own
 * in-progress claims is a model re-reading its own output through the platform's
 * framing — the one case the untrusted fence cannot help with.
 */
export const buildMapContext = async (
 deps: MasteryDeps,
 input: {
 workspaceId: WorkspaceId
 personaId: AgentPersonaId
 repositoryId: RepositoryId | null
 /**
 * The run being started. Named rather than optional now: it is both the map to skip
 * (a mastery run must not read back its own in-progress claims) **and** the subject
 * of the trial record, and a caller that omitted it would silently produce a run
 * nobody measured.
 */
 agentRunId: AgentRunId
 },
): Promise<string> => {
 const maps = (await deps.subjectMaps.listMapsForPersona(input.workspaceId, input.personaId))
.filter((map) => map.status === 'ready')
.filter((map) => map.masteryRunId === null || map.masteryRunId !== input.agentRunId)
.filter((map) => map.repositoryId === null || map.repositoryId === input.repositoryId)

 /**
 * The effective retrieval state per map. One aggregate query for
 * every candidate, rather than a query per map: this is on the dispatch path, and a
 * persona with four subjects would otherwise pay four round trips before a run starts.
 */
 const tallies = await deps.subjectMaps.tallyExpertiseOutcomes(
 input.workspaceId,
 maps.map((map) => map.id),
)

 const rendered: string[] = []
 for (const map of maps) {
 const effect = summarizeExpertiseEffect(tallies[map.id] ?? [])
 const state = retrievalStateFor(map.retrievalOverride, effect.verdict)
 const used = await deps.subjectMaps.countExpertiseUses(input.workspaceId, map.id)
 const arm = trialAssignment(state, used)

 // `off` — nothing offered and nothing recorded. See `trialAssignment`: writing
 // withheld rows for an off map would inflate the baseline it is judged against and
 // make the decision unreachable rather than reversible.
 if (arm === null) continue

 const [nodes, edges] = await Promise.all([
 deps.subjectMaps.listNodes(input.workspaceId, map.id),
 deps.subjectMaps.listEdges(input.workspaceId, map.id),
 ])
 const selected = selectMapForContext(nodes, edges)
 const text =
 arm === 'withheld'
 ? ''
: renderMapForPrompt(map, selected.nodes, selected.edges, {
 nodes: selected.elidedNodes,
 edges: selected.elidedEdges,
 })

 /**
 * Recorded for **both** arms, which is the whole measurement. A run deliberately
 * denied a map it was eligible for is the baseline; without a row saying so, the
 * comparison is against runs that were never candidates, which is not a baseline —
 * it is a different population.
 *
 * Best-effort, like the retrieval it describes: a run whose measurement could not be
 * written is worse recorded, not broken, and failing a start over a bookkeeping row
 * would tie throughput to the least important write in the system.
 */
 try {
 await deps.subjectMaps.recordExpertiseUse({
 workspaceId: input.workspaceId,
 mapId: map.id,
 agentRunId: input.agentRunId,
 arm,
 nodesShown: arm === 'retrieved' ? selected.nodes.length: 0,
 edgesShown: arm === 'retrieved' ? selected.edges.length: 0,
 })
 } catch {
 // Deliberately swallowed — see above.
 }

 if (text !== '') rendered.push(text)
 }

 return rendered.join('\n\n')
}

/**
 * What one map's trial says so far, and what the platform is doing
 * about it.
 *
 * Computed on every read rather than stored, for the reason in `expertise-trial.ts`: a
 * map re-mastered at a newer revision is a different artifact, and a verdict written last
 * month would keep answering for it.
 */
export const expertiseEffectFor = async (
 deps: MasteryDeps,
 input: { workspaceId: WorkspaceId; map: SubjectMap },
): Promise<{ effect: ExpertiseEffect; state: RetrievalState }> => {
 const tallies = await deps.subjectMaps.tallyExpertiseOutcomes(input.workspaceId, [input.map.id])
 const effect = summarizeExpertiseEffect(tallies[input.map.id] ?? [])
 return { effect, state: retrievalStateFor(input.map.retrievalOverride, effect.verdict) }
}

/**
 * A human's standing answer about whether a map is used.
 *
 * Promotion is a human act, and so is demotion: an operator watching a map produce bad
 * advice should not have to wait for five more runs to agree with them. Clearing it hands
 * the decision back to the measurement, which is a third act and not the same as `off`.
 */
export const setRetrievalOverride = async (
 deps: MasteryDeps,
 input: {
 workspaceId: WorkspaceId
 mapId: SubjectMapId
 override: RetrievalOverride
 },
): Promise<SubjectMap> => {
 const map = await deps.subjectMaps.setRetrievalOverride(
 input.workspaceId,
 input.mapId,
 input.override,
)
 if (!map) throw new NotFoundError('SubjectMap')
 return map
}

/**
 * Invalidates what a merge made stale (domain expertise: "a claim about a file is invalidated by that
 * file changing — which this platform can detect, because it owns the merge queue").
 *
 * Every map bound to the repository, across every persona: a merged change makes a claim
 * false for whoever holds it, and invalidating only the map of the persona that happened
 * to be involved would leave every *other* expert on that repository confidently wrong.
 *
 * Deliberately does not re-derive. A curation pass is a scheduled, budgeted run and
 * this is a hook on a merge — doing model work here would put an unbounded cost on the
 * merge path, which is the one path a human is actively waiting on.
 */
export const invalidateMapsForMerge = async (
 deps: MasteryDeps,
 input: {
 workspaceId: WorkspaceId
 repositoryId: RepositoryId
 changedPaths: readonly string[]
 revision: string
 },
): Promise<{ invalidated: number }> => {
 if (input.changedPaths.length === 0) return { invalidated: 0 }

 const maps = await deps.subjectMaps.listMapsForRepository(input.workspaceId, input.repositoryId)
 let invalidated = 0
 for (const map of maps) {
 const nodes = await deps.subjectMaps.listNodes(input.workspaceId, map.id)
 const stale = selectStaleNodeIds(nodes, input.changedPaths)
 if (stale.length === 0) continue
 invalidated += await deps.subjectMaps.invalidateNodes(
 input.workspaceId,
 stale,
 `changed at ${input.revision}`,
)
 }
 return { invalidated }
}

export interface SubjectMapListing {
 readonly map: SubjectMap
 /** What the platform is doing with this map right now. */
 readonly retrievalState: RetrievalState
 /** How many decided runs are behind that, per arm — the evidence, in two numbers. */
 readonly decided: { readonly retrieved: number; readonly withheld: number }
}

/**
 * Every subject a persona holds a map of, with what the platform is doing with each.
 *
 * The state travels with the list rather than being fetched per map, because that is what
 * makes an expertise **legible before it is used**: a badge that says "expert
 * in this repository" while the platform is quietly withholding the map is the surface
 * lying, and it is the same class of dishonesty as a canvas drawing an edge the runtime
 * refuses. One aggregate query serves the whole list.
 */
const listingsFor = async (
 deps: MasteryDeps,
 workspaceId: WorkspaceId,
 maps: readonly SubjectMap[],
): Promise<SubjectMapListing[]> => {
 const tallies = await deps.subjectMaps.tallyExpertiseOutcomes(
 workspaceId,
 maps.map((map) => map.id),
)
 return maps.map((map) => {
 const arms = tallies[map.id] ?? []
 const effect = summarizeExpertiseEffect(arms)
 return {
 map,
 retrievalState: retrievalStateFor(map.retrievalOverride, effect.verdict),
 decided: {
 retrieved: effect.retrieved.decided,
 withheld: effect.withheld.decided,
 },
 }
 })
}

export const listPersonaMaps = async (
 deps: MasteryDeps,
 input: { workspaceId: WorkspaceId; personaId: AgentPersonaId },
): Promise<SubjectMapListing[]> =>
 listingsFor(
 deps,
 input.workspaceId,
 await deps.subjectMaps.listMapsForPersona(input.workspaceId, input.personaId),
)

export const listWorkspaceMaps = async (
 deps: MasteryDeps,
 input: { workspaceId: WorkspaceId },
): Promise<SubjectMapListing[]> =>
 listingsFor(deps, input.workspaceId, await deps.subjectMaps.listAllMaps(input.workspaceId))

export const listRepositoryMaps = async (
 deps: MasteryDeps,
 input: { workspaceId: WorkspaceId; repositoryId: RepositoryId },
): Promise<SubjectMapListing[]> =>
 listingsFor(
 deps,
 input.workspaceId,
 await deps.subjectMaps.listMapsForRepository(input.workspaceId, input.repositoryId),
)

/**
 * Which maps one run was handed, and which it was deliberately denied.
 *
 * The badge the operator asked for is built on this: "which agents adopted which
 * expertise" is answerable per *persona* from the map list, and per *run* only from here
 * — and the second is the stronger claim, because it says what a particular piece of work
 * actually read rather than what its persona happens to hold.
 */
export const listExpertiseUsedByRuns = async (
 deps: MasteryDeps,
 input: { workspaceId: WorkspaceId; agentRunIds: readonly AgentRunId[] },
): Promise<
 {
 readonly agentRunId: string
 readonly map: SubjectMap
 readonly arm: 'retrieved' | 'withheld'
 readonly nodesShown: number
 readonly edgesShown: number
 }[]
> => {
 const uses = await deps.subjectMaps.listExpertiseUsesForRuns(
 input.workspaceId,
 input.agentRunIds,
)
 // One read per distinct map rather than per use: a tree of twenty runs against one
 // repository names the same two or three maps over and over.
 const mapIds = [...new Set(uses.map((use) => use.mapId))]
 const maps = new Map<string, SubjectMap>
 for (const mapId of mapIds) {
 const map = await deps.subjectMaps.getMap(input.workspaceId, asSubjectMapId(mapId))
 if (map) maps.set(mapId, map)
 }

 return uses.flatMap((use) => {
 const map = maps.get(use.mapId)
 return map
 ? [
 {
 agentRunId: use.agentRunId,
 map,
 arm: use.arm,
 nodesShown: use.nodesShown,
 edgesShown: use.edgesShown,
 },
 ]
: []
 })
}
