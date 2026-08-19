import {
  ATLAS_RELATIONS,
  ForbiddenError,
  MAX_OPEN_ATLAS_PROPOSALS,
  NotFoundError,
  ValidationError,
  atlasContentionQuestion,
  isHuman,
  proposeAtlasEdge,
  renderAtlasLeads,
  selectAtlasLeads,
  type Actor,
  type AgentRunId,
  type AtlasEdgeStatus,
  type AtlasEndpoint,
  type ClaimOutcomes,
  type ColosseumParticipant,
  type ColosseumSession,
  type ConfirmedRelation,
  type RepositoryId,
  type SubjectMapId,
  type ThreadId,
  type WorkspaceId,
  conveneRoster,
} from '@loom/domain'
import type {
  AgentRunRepositoryPort,
  AtlasEdge,
  AtlasRepositoryPort,
  ColosseumRepositoryPort,
  PersonaRepositoryPort,
  SubjectMapRepositoryPort,
} from './agent-ports.js'

/**
 * The atlas's write side — an agent proposes a cross-subject relation, the
 * Colosseum contends it, a human promotes it.
 *
 * **What makes this the write side and not a second read side.** The read side is a query
 * over the concepts the maps already hold: it re-derives its answer every time and stores
 * nothing, which is why it needed no table. The one thing a query can never re-derive is
 * that somebody went and looked and said yes — and the rule for when an edge earns
 * storage is exactly that. So every function here exists to move one claim along a single
 * path: proposed by an agent, argued over in a venue, decided by a human, and only then
 * ranked above the leads it started as.
 *
 * Its own file rather than more of mastery-use-cases.ts, for that file's own stated
 * reason: those are the only callers that may write a *map*, and an atlas edge belongs to
 * no map. Keeping them apart is what stops a re-mastering from ever touching a relation a
 * human confirmed.
 */

export interface AtlasDeps {
  readonly atlas: AtlasRepositoryPort
  readonly subjectMaps: SubjectMapRepositoryPort
  readonly personas: PersonaRepositoryPort
  readonly agentRuns: AgentRunRepositoryPort
}

export interface AtlasContentionDeps extends AtlasDeps {
  readonly colosseum: ColosseumRepositoryPort
}

/**
 * What the read side needs, which is less than the write side does.
 *
 * Kept narrow deliberately: `look_across_projects` is on the hot path of every ordinary
 * run, and a read that could reach the persona or run repositories would be one edit away
 * from doing something on that path that is not a read.
 */
export interface AtlasReadDeps {
  readonly atlas: AtlasRepositoryPort
  readonly subjectMaps: SubjectMapRepositoryPort
}

/**
 * Resolves one end of a proposal from the words a model used.
 *
 * Returns a *reason* rather than throwing, because every failure here is something the
 * model can act on — a label it invented, a label two subjects share, a subject it named
 * wrongly — and the tool's job is to say which.
 */
const resolveEnd = async (
  deps: AtlasDeps,
  input: {
    workspaceId: WorkspaceId
    label: string
    repositoryId?: RepositoryId
    subjectRef?: string
    side: string
  },
): Promise<{ ok: true; end: AtlasEndpoint } | { ok: false; reason: string }> => {
  const label = input.label.trim()
  if (label.length === 0) return { ok: false, reason: `Name the ${input.side} concept` }

  const candidates = await deps.subjectMaps.findConceptsByLabel(input.workspaceId, {
    label,
    ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
    ...(input.subjectRef === undefined ? {} : { subjectRef: input.subjectRef }),
  })

  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        `No subject here has recorded a concept called "${label}"${
          input.subjectRef === undefined ? '' : ` in ${input.subjectRef}`
        }. Use the label exactly as it was shown to you — a relation between something ` +
        'you were told about and something you named yourself is a relation to nothing.',
    }
  }

  /**
   * Several subjects using one label is the *interesting* case and cannot be resolved
   * here: picking the first would decide which two things the relation is between, which
   * is the whole content of the proposal. The model is asked which, and the subjects are
   * listed so it can answer without guessing.
   */
  const subjects = [...new Set(candidates.map((candidate) => candidate.subjectRef))]
  if (subjects.length > 1) {
    return {
      ok: false,
      reason:
        `"${label}" is recorded in more than one subject here (${subjects.join(', ')}). ` +
        'Say which one you mean.',
    }
  }

  const chosen = candidates[0]
  if (!chosen) return { ok: false, reason: `No concept called "${label}"` }
  return {
    ok: true,
    end: {
      nodeId: chosen.nodeId,
      mapId: chosen.mapId as string,
      kind: chosen.kind,
      subjectRef: chosen.subjectRef,
      label: chosen.label,
    },
  }
}

export type AtlasProposalResult =
  | { readonly ok: true; readonly edge: AtlasEdge; readonly created: boolean }
  | { readonly ok: false; readonly reason: string }

/**
 * An agent proposing a relation between its own subject and another's.
 *
 * **The proposing run is the one that just followed a lead**, and that is why this belongs
 * beside `look_across_projects` rather than in a mastery run. A mastery run knows one
 * subject exhaustively and the others not at all — it is the worst-placed agent in the
 * system to relate two. A worker that asked the atlas, opened the subject it was pointed
 * at, and found the thing really there is the best-placed, and it is the only one holding
 * the evidence at the moment the claim is worth making.
 *
 * Nothing here is trusted. The two labels are resolved against what the platform holds,
 * the endpoints are checked by the domain, and the result is a row in state `proposed` —
 * which no reader treats as a fact. Mastery: "nothing in the system promotes itself."
 */
export const proposeCrossSubjectRelation = async (
  deps: AtlasDeps,
  input: {
    workspaceId: WorkspaceId
    agentRunId: AgentRunId
    /** A concept in this run's own subject, named as its map named it. */
    mine: string
    /** A concept in another subject — the one a lead pointed at. */
    theirs: string
    /** Which subject `theirs` is in. Optional, and the tie-break when a label is shared. */
    theirSubject?: string
    relation: string
    rationale: string
  },
): Promise<AtlasProposalResult> => {
  const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
  if (!run) throw new NotFoundError('AgentRun')

  /**
   * A cap on *open* proposals, not on proposals ever made.
   *
   * The queue is worked through by a human, and an agent that can extend it without
   * bound turns somebody's review list into a denial of service — the same reasoning
   * `MAX_NOTES_PER_RUN` applies to a sibling's context window. Decided rows do not
   * count, because a workspace that keeps promoting and rejecting is one where the
   * mechanism is working.
   */
  const open = await deps.atlas.countByStatus(input.workspaceId, ['proposed', 'contended'])
  if (open >= MAX_OPEN_ATLAS_PROPOSALS) {
    return {
      ok: false,
      reason:
        `There are already ${open} cross-project relations here waiting on a human. ` +
        'Adding to that queue does not get any of them read — carry on with your task.',
    }
  }

  /**
   * The run's own side is scoped to its repository, and that scope is what gives the
   * proposal standing. A run relating two concepts in somebody *else's* two subjects
   * would be asserting something about two codebases it can open neither of — which is
   * a lead dressed as a finding, and the whole thing the fence exists to prevent.
   */
  const mine = await resolveEnd(deps, {
    workspaceId: input.workspaceId,
    label: input.mine,
    repositoryId: run.repositoryId,
    side: 'your own',
  })
  if (!mine.ok) {
    return {
      ok: false,
      reason:
        mine.reason +
        ' (Looking in your own subject — if nobody has mastered this repository, there ' +
        'is nothing here yet to relate.)',
    }
  }

  const theirs = await resolveEnd(deps, {
    workspaceId: input.workspaceId,
    label: input.theirs,
    ...(input.theirSubject === undefined ? {} : { subjectRef: input.theirSubject }),
    side: 'other',
  })
  if (!theirs.ok) return { ok: false, reason: theirs.reason }

  const verdict = proposeAtlasEdge({
    from: mine.end,
    to: theirs.end,
    relation: input.relation,
    rationale: input.rationale,
  })
  if (!verdict.ok) return { ok: false, reason: verdict.reason }

  /**
   * Who proposed it, resolved from the run's persona *snapshot* by name.
   *
   * A run carries a snapshot rather than a persona id — that is deliberate everywhere
   * else, because a persona edited mid-run must not change what the run is — and names
   * are unique per workspace, so this is exact. A persona renamed since the run started
   * resolves to null, and the row keeps the relation without an author, which is the
   * right trade: the claim outlives whoever made it.
   */
  const personas = await deps.personas.listByWorkspace(input.workspaceId)
  const proposer = personas.find((entry) => entry.name === run.persona.name)

  const stored = await deps.atlas.propose({
    workspaceId: input.workspaceId,
    fromNodeId: verdict.fromNodeId,
    toNodeId: verdict.toNodeId,
    relation: verdict.relation,
    rationale: verdict.rationale,
    proposedByPersonaId: proposer?.id ?? null,
    proposedByRunId: input.agentRunId,
  })

  return { ok: true, edge: stored.edge, created: stored.created }
}

/**
 * What the proposing run is told back.
 *
 * Deliberately flat about what just happened: a proposal is **not** a fact recorded, and
 * a model that reads "noted" will carry on as though the relation were now established.
 * The sentence that matters is the last one — nothing changed for this run, and the work
 * in front of it is the same work.
 */
export const renderProposalOutcome = (result: AtlasProposalResult): string => {
  if (!result.ok) return result.reason
  const { edge } = result
  const where =
    `${edge.from.subjectRef} — ${edge.from.label} ↔ ${edge.to.subjectRef} — ${edge.to.label}`
  if (!result.created) {
    const state =
      edge.status === 'promoted'
        ? `a human has already confirmed it${edge.decidedByName === '' ? '' : ` (${edge.decidedByName})`}`
        : edge.status === 'rejected'
          ? 'a human has already looked at it and said no'
          : edge.status === 'contended'
            ? 'it is being argued over now'
            : 'it is already waiting for a human'
  return `That relation was already proposed — ${state}. (${where})`
  }
  return (
    `Proposed: ${where}. It is a proposal, not a finding: a human decides whether it ` +
    'holds, and nothing else in the system treats it as true until they do. Nothing about ' +
    'your own task has changed — carry on.'
  )
}

/**
 * Puts a proposal in front of the two experts who hold its ends.
 *
 * **The roster is not a choice.** A contention session convened for anything else has to
 * decide who should be in the room; here the two participants are determined by the claim
 * itself — whoever mastered each side. That is also why this is the case mastery names as
 * the one where the Colosseum "earns its existence": the two personas hold different
 * subjects by construction, so the roster passes the diversity check for the right reason
 * rather than by arrangement.
 *
 * Convening spends nothing, as everywhere else in mastery: this creates the room and
 * records the proposal as an opening claim. The turns are ordinary runs somebody asks for.
 *
 * One persona on both ends returns null rather than convening. It is not a failure — one
 * expert who mastered both subjects noticing a relation between them is a perfectly good
 * proposal, and a room where somebody argues with themselves would produce agreement that
 * means nothing and cost real money to produce.
 */
export const contendAtlasProposal = async (
  deps: AtlasContentionDeps,
  input: {
    workspaceId: WorkspaceId
    threadId: ThreadId
    edgeId: string
  },
): Promise<{ session: ColosseumSession; edge: AtlasEdge } | null> => {
  const edge = await deps.atlas.get(input.workspaceId, input.edgeId)
  if (!edge) throw new NotFoundError('AtlasEdge')
  if (edge.status !== 'proposed') {
    throw new ValidationError(
      'Only an undecided proposal goes to the venue. A relation a human has already ' +
        'decided on is not made truer by being argued over afterwards.',
    )
  }

  const personas = await deps.personas.listByWorkspace(input.workspaceId)
  const maps = await Promise.all([
    deps.subjectMaps.getMap(input.workspaceId, edge.from.mapId),
    deps.subjectMaps.getMap(input.workspaceId, edge.to.mapId),
  ])
  const participants: ColosseumParticipant[] = []
  for (const [index, map] of maps.entries()) {
    if (!map) continue
    const persona = personas.find((entry) => entry.id === map.personaId)
    if (!persona) continue
    if (participants.some((entry) => entry.personaId === persona.id)) continue
    participants.push({
      personaId: persona.id,
      personaName: persona.name,
      mapId: map.id,
      model: persona.model,
      subjectRef: index === 0 ? edge.from.subjectRef : edge.to.subjectRef,
    })
  }

  const verdict = conveneRoster(participants, 'contention')
  if (!verdict.ok) return null

  const session = await deps.colosseum.convene({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    /**
     * No repository. A session about a relation between two subjects belongs to neither,
     * and naming one of them would make the crunch sweep and every per-repository view
     * treat this room as being about that repository.
     */
    repositoryId: null,
    purpose: 'contention',
    subject: `${edge.from.subjectRef} ↔ ${edge.to.subjectRef}`,
    question: atlasContentionQuestion({
      relation: edge.relation,
      fromLabel: edge.from.label,
      fromSubjectRef: edge.from.subjectRef,
      toLabel: edge.to.label,
      toSubjectRef: edge.to.subjectRef,
      rationale: edge.rationale,
    }),
    turnCap: participants.length,
    spendCapUsd: null,
    diversity: verdict.diversity,
    participants,
  })

  /**
   * The proposal, recorded as an opening claim before anybody speaks.
   *
   * This is what makes the session measurable in the same way every other session is:
   * The attrition check compares what was held at the start against what survived, and
   * the claim under test here is the proposal itself. Attributed to the persona on the
   * proposing side, because that is who is asserting it.
   */
  const holder = participants[0]
  if (holder) {
    await deps.colosseum.recordClaim({
      workspaceId: input.workspaceId,
      sessionId: session.id,
      statement:
        `${edge.from.subjectRef}'s "${edge.from.label}" ${edge.relation} ` +
        `${edge.to.subjectRef}'s "${edge.to.label}"`,
      originalHolderPersonaId: holder.personaId,
    })
  }

  const attached = await deps.atlas.attachSession(input.workspaceId, edge.id, session.id)
  return { session, edge: attached ?? edge }
}

/**
 * A human's decision on a proposal.
 *
 * The actor check is the feature, not a guard on it. Every other trust boundary in this
 * platform holds because model output is never treated as authority, and
 * a promoted atlas edge is the one artifact that *is* treated as more than a lead — it
 * renders above them, in its own block, saying somebody checked. If an agent could reach
 * this call, that block would be a model's claim about another model's summary wearing a
 * human's name.
 *
 * Rejection is recorded rather than deleted, and it is worth the row: a proposal deleted
 * is a proposal the next run makes again, and the rejection note is the only place the
 * reason a plausible relation is wrong ever gets written down.
 */
export const decideAtlasProposal = async (
  deps: AtlasDeps,
  input: {
    workspaceId: WorkspaceId
    actor: Actor
    edgeId: string
    decision: Extract<AtlasEdgeStatus, 'promoted' | 'rejected'>
    note?: string
    /** The human's display name, resolved server-side from the session — never sent. */
    decidedByName: string
  },
): Promise<AtlasEdge> => {
  if (!isHuman(input.actor) || input.actor.kind !== 'user') {
    throw new ForbiddenError(
      'Only a human promotes a cross-project relation. An agent confirming another ' +
        'agent’s claim is the loop this venue exists to break.',
    )
  }
  const edge = await deps.atlas.get(input.workspaceId, input.edgeId)
  if (!edge) throw new NotFoundError('AtlasEdge')

  const decided = await deps.atlas.decide({
    workspaceId: input.workspaceId,
    edgeId: input.edgeId,
    status: input.decision,
    decidedByUserId: input.actor.userId,
    decidedByName: input.decidedByName,
    note: (input.note ?? '').trim(),
  })
  if (!decided) {
    throw new ValidationError(
      'That relation has already been decided. The first decision stands — a second one ' +
        'would rewrite whose name is on it.',
    )
  }
  return decided
}

export const listAtlasProposals = async (
  deps: AtlasDeps,
  input: { workspaceId: WorkspaceId; statuses?: readonly AtlasEdgeStatus[] },
): Promise<AtlasEdge[]> =>
  deps.atlas.list(input.workspaceId, {
    ...(input.statuses === undefined ? {} : { statuses: input.statuses }),
  })

export { ATLAS_RELATIONS }
/**
 * How many concepts the atlas reads before ranking them.
 *
 * A ceiling on the *query*, not on the answer — the answer is capped at
 * `MAX_ATLAS_LEADS`, which is far smaller. This exists so the read stays bounded on a
 * workspace with fifty subjects: ranking happens in memory, and a workspace that has
 * recorded more concepts than this returns its most recent ones, which is the same
 * fallback `selectMapForContext` makes when a map outgrows a window.
 */
export const MAX_ATLAS_CANDIDATES = 400

/**
 * What the workspace's *other* subjects know about a topic.
 *
 * **Called from a tool, never from a prompt**, and that is the whole design. A subject
 * map is injected because it is bounded — one repository, at one revision, trimmed and
 * reported. The atlas spans every subject in the workspace and grows with the number of
 * projects, so injecting it would fill a window with confidently irrelevant structure
 * about code the run cannot see. Reachable on demand costs one line of tool description
 * until the moment somebody needs it.
 *
 * The run's own repository is excluded because it has already been handed that map: the
 * atlas answers "somewhere else", and repeating the map here would spend the window twice
 * and make a duplicate look like a discovery.
 *
 * Outcomes are read for the candidates that survive matching rather than for all of them,
 * because the ranking only has to order what is going to be shown — tallying four
 * hundred nodes to rank eight would be the expensive half of a cheap operation.
 */
export const findAtlasLeads = async (
  deps: AtlasReadDeps,
  input: {
    workspaceId: WorkspaceId
    /** The run asking, so its own subject can be left out. */
    repositoryId: RepositoryId | null
    topic: string
  },
): Promise<string> => {
  const topic = input.topic.trim()
  if (topic.length === 0) {
    return 'Ask about something: a concept, a mechanism, a problem you think another project here has already had.'
  }

  const rows = await deps.subjectMaps.listConceptsAcrossSubjects(input.workspaceId, {
    ...(input.repositoryId === null ? {} : { excludeRepositoryId: input.repositoryId }),
    limit: MAX_ATLAS_CANDIDATES,
  })

  const matched = selectAtlasLeads(
    rows.map((row) => ({
      nodeId: row.nodeId,
      label: row.label,
      summary: row.summary,
      subjectRef: row.subjectRef,
      personaName: row.personaName,
      createdAt: row.createdAt,
    })),
    topic,
  )

  /**
   * The confirmed half, and it is looked up from the concepts the topic **matched**
   * rather than from the whole table.
   *
   * That ordering is what keeps promotion from quietly becoming a second injection
   * channel: a workspace with two hundred confirmed relations would otherwise render
   * every one of them into every atlas answer, which is the failure this section spends
   * its whole length avoiding — a window filled with confidently irrelevant structure.
   * A confirmed relation earns its place in *this* answer by touching a concept this
   * topic matched, exactly as a lead does.
   */
  const confirmed = await confirmedRelationsFor(deps, {
    workspaceId: input.workspaceId,
    nodeIds: matched.leads.map((lead) => lead.nodeId),
  })

  if (matched.leads.length === 0) return renderAtlasLeads(topic, matched, confirmed)

  /**
   * The "scored by outcome, not recency", applied to the leads that are going to be
   * shown. Grouped by map because that is how the tally is keyed, and a workspace-wide
   * tally would be a second query shape for the same answer.
   */
  const byMap = new Map<string, SubjectMapId>()
  for (const row of rows) byMap.set(row.nodeId, row.mapId)
  const mapIds = [...new Set(matched.leads.map((lead) => byMap.get(lead.nodeId)))].filter(
    (id): id is SubjectMapId => id !== undefined,
  )
  const outcomes: Record<string, ClaimOutcomes> = {}
  for (const mapId of mapIds) {
    Object.assign(outcomes, await deps.subjectMaps.tallyNodeOutcomes(input.workspaceId, mapId))
  }

  return renderAtlasLeads(
    topic,
    selectAtlasLeads(
      matched.leads.map((lead) => ({
        ...lead,
        ...(outcomes[lead.nodeId] === undefined ? {} : { outcomes: outcomes[lead.nodeId] }),
      })),
      topic,
    ),
    confirmed,
  )
}

/**
 * The promoted relations touching a set of concepts, as the renderer wants them.
 *
 * The **other** end is what a reader needs named, and which end that is depends on which
 * of the two the topic matched — so the pair is oriented here rather than stored oriented.
 * A relation is symmetric in the table by design (see `proposeAtlasEdge`); orienting it at
 * read time is what lets one row answer both directions.
 *
 * A relation with an endpoint the map has since retired is dropped. The bi-temporal
 * model means the row survives its own endpoint, and a human's confirmation does not
 * transfer to a claim the map no longer makes — rendering it would be the atlas asserting
 * something its own source has withdrawn.
 */
const confirmedRelationsFor = async (
  deps: AtlasReadDeps,
  input: { workspaceId: WorkspaceId; nodeIds: readonly string[] },
): Promise<ConfirmedRelation[]> => {
  if (input.nodeIds.length === 0) return []
  const matchedIds = new Set(input.nodeIds)
  const edges = await deps.atlas.listPromotedTouching(input.workspaceId, input.nodeIds)
  return edges
    .filter((edge) => edge.from.live && edge.to.live)
    .map((edge) => {
      const matchedIsFrom = matchedIds.has(edge.from.nodeId)
      const near = matchedIsFrom ? edge.from : edge.to
      const far = matchedIsFrom ? edge.to : edge.from
      return {
        relation: edge.relation,
        fromLabel: near.label,
        fromSubjectRef: near.subjectRef,
        toLabel: far.label,
        toSubjectRef: far.subjectRef,
        rationale: edge.rationale,
        // Falls back rather than dropping the relation: a departed employee does not
        // un-confirm what they confirmed.
        confirmedBy: edge.decidedByName === '' ? 'a human here' : edge.decidedByName,
        confirmedAt: edge.decidedAt ?? edge.createdAt,
      }
    })
    .slice(0, MAX_CONFIRMED_RELATIONS)
}

/**
 * How many confirmed relations one answer may carry.
 *
 * Smaller than `MAX_ATLAS_LEADS`, because these render above the leads and would
 * otherwise crowd out the thing the run actually asked for. Four is enough to say "this
 * has been settled here" and too few to become the answer.
 */
export const MAX_CONFIRMED_RELATIONS = 4
