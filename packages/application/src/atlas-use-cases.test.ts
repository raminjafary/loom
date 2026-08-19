import {
  MAX_OPEN_ATLAS_PROPOSALS,
  agentRunActor,
  asAgentPersonaId,
  asAgentRunId,
  asRepositoryId,
  asSubjectMapId,
  asThreadId,
  asUserId,
  asWorkspaceId,
  userActor,
  type AgentPersona,
  type AgentRun,
  type MapNodeKind,
  type SubjectMap,
} from '@loom/domain'
import { beforeEach, describe, expect, it } from 'vitest'

import type {
  AgentRunRepositoryPort,
  AtlasEdge,
  AtlasRepositoryPort,
  ColosseumRepositoryPort,
  PersonaRepositoryPort,
  SubjectMapRepositoryPort,
} from './agent-ports.js'
import {
  contendAtlasProposal,
  decideAtlasProposal,
  findAtlasLeads,
  proposeCrossSubjectRelation,
  renderProposalOutcome,
  type AtlasContentionDeps,
} from './atlas-use-cases.js'

const workspaceId = asWorkspaceId('w1')
const repositoryId = asRepositoryId('r-flight')
const otherRepo = asRepositoryId('r-hotel')
const runId = asAgentRunId('run1')
const flightPersona = asAgentPersonaId('p-flight')
const hotelPersona = asAgentPersonaId('p-hotel')

interface SeededConcept {
  nodeId: string
  mapId: string
  personaId: typeof flightPersona
  kind: MapNodeKind
  label: string
  summary: string
  subjectRef: string
  repositoryId: typeof repositoryId | null
  live: boolean
  createdAt: Date
}

/**
 * The two ports the atlas touches, in memory.
 *
 * Narrow on purpose — only the methods these use cases call are implemented, because the
 * shape this test is about is *which* facts a proposal is checked against, not how they
 * are stored. The joins and the uniqueness constraint are asserted against real SQL in
 * `repositories.integration.test.ts`, which is the only place they exist.
 */
class FakeAtlasWorld {
  concepts: SeededConcept[] = []
  edges: (AtlasEdge & { workspaceId: string })[] = []
  personas: AgentPersona[] = []
  convened: Parameters<ColosseumRepositoryPort['convene']>[0][] = []
  claims: Parameters<ColosseumRepositoryPort['recordClaim']>[0][] = []
  private seq = 0

  seed(over: Partial<SeededConcept> & { label: string; subjectRef: string }): SeededConcept {
    this.seq += 1
    const concept: SeededConcept = {
      nodeId: over.nodeId ?? `n${this.seq}`,
      mapId: over.mapId ?? `m-${over.subjectRef}`,
      personaId: over.personaId ?? flightPersona,
      kind: over.kind ?? 'concept',
      label: over.label,
      summary: over.summary ?? '',
      subjectRef: over.subjectRef,
      repositoryId: over.repositoryId ?? null,
      live: over.live ?? true,
      createdAt: over.createdAt ?? new Date('2026-08-01T00:00:00Z'),
    }
    this.concepts.push(concept)
    return concept
  }

  private toEnd(concept: SeededConcept) {
    return {
      nodeId: concept.nodeId,
      mapId: asSubjectMapId(concept.mapId),
      label: concept.label,
      summary: concept.summary,
      subjectRef: concept.subjectRef,
      personaName: `persona-${concept.personaId}`,
      live: concept.live,
    }
  }

  subjectMaps: SubjectMapRepositoryPort = {
    findConceptsByLabel: async (
      _w: unknown,
      input: { label: string; repositoryId?: unknown; subjectRef?: string },
    ) =>
      this.concepts
        .filter((concept) => concept.live)
        .filter((concept) => concept.label.toLowerCase() === input.label.toLowerCase())
        .filter(
          (concept) =>
            input.repositoryId === undefined || concept.repositoryId === input.repositoryId,
        )
        .filter(
          (concept) => input.subjectRef === undefined || concept.subjectRef === input.subjectRef,
        )
        .map((concept) => ({
          nodeId: concept.nodeId,
          mapId: asSubjectMapId(concept.mapId),
          kind: concept.kind,
          label: concept.label,
          summary: concept.summary,
          subjectRef: concept.subjectRef,
          repositoryId: concept.repositoryId,
          personaId: concept.personaId,
          personaName: `persona-${concept.personaId}`,
        })),
    listConceptsAcrossSubjects: async (_w: unknown, options: { excludeRepositoryId?: unknown; limit: number }) =>
      this.concepts
        .filter((concept) => concept.live)
        .filter(
          (concept) =>
            options.excludeRepositoryId === undefined ||
            concept.repositoryId !== options.excludeRepositoryId,
        )
        .slice(0, options.limit)
        .map((concept) => ({
          nodeId: concept.nodeId,
          mapId: asSubjectMapId(concept.mapId),
          label: concept.label,
          summary: concept.summary,
          subjectRef: concept.subjectRef,
          personaName: `persona-${concept.personaId}`,
          createdAt: concept.createdAt,
        })),
    tallyNodeOutcomes: async () => ({}),
    getMap: async (_w: unknown, mapId: unknown) => {
      const concept = this.concepts.find((entry) => entry.mapId === (mapId as string))
      if (!concept) return null
      return {
        id: asSubjectMapId(concept.mapId),
        workspaceId,
        personaId: concept.personaId,
        subjectKind: 'repository',
        repositoryId: concept.repositoryId,
        subjectRef: concept.subjectRef,
        revision: 'abc1234',
        status: 'ready',
        retrievalOverride: null,
        masteryRunId: null,
        createdAt: concept.createdAt,
        updatedAt: concept.createdAt,
      } satisfies SubjectMap
    },
  } as unknown as SubjectMapRepositoryPort

  atlas: AtlasRepositoryPort = {
    propose: async (input) => {
      const existing = this.edges.find(
        (edge) =>
          edge.from.nodeId === input.fromNodeId &&
          edge.to.nodeId === input.toNodeId &&
          edge.relation === input.relation,
      )
      if (existing) return { edge: existing, created: false }
      const from = this.concepts.find((entry) => entry.nodeId === input.fromNodeId)
      const to = this.concepts.find((entry) => entry.nodeId === input.toNodeId)
      if (!from || !to) throw new Error('endpoint missing')
      this.seq += 1
      const edge: AtlasEdge & { workspaceId: string } = {
        workspaceId: input.workspaceId as string,
        id: `e${this.seq}`,
        relation: input.relation,
        rationale: input.rationale,
        status: 'proposed',
        from: this.toEnd(from),
        to: this.toEnd(to),
        proposedByPersonaName: 'flight-worker',
        proposedByRunId: input.proposedByRunId as string | null,
        sessionId: null,
        decidedByName: '',
        decidedAt: null,
        decisionNote: '',
        createdAt: new Date('2026-08-02T00:00:00Z'),
      }
      this.edges.push(edge)
      return { edge, created: true }
    },
    get: async (_w, edgeId) => this.edges.find((edge) => edge.id === edgeId) ?? null,
    list: async (_w, options) =>
      this.edges.filter(
        (edge) => options?.statuses === undefined || options.statuses.includes(edge.status),
      ),
    countByStatus: async (_w, statuses) =>
      this.edges.filter((edge) => statuses.includes(edge.status)).length,
    listPromotedTouching: async (_w, nodeIds) =>
      this.edges.filter(
        (edge) =>
          edge.status === 'promoted' &&
          (nodeIds.includes(edge.from.nodeId) || nodeIds.includes(edge.to.nodeId)),
      ),
    attachSession: async (_w, edgeId, sessionId) => {
      const edge = this.edges.find((entry) => entry.id === edgeId && entry.status === 'proposed')
      if (!edge) return null
      const next = { ...edge, sessionId, status: 'contended' as const }
      this.edges = this.edges.map((entry) => (entry.id === edgeId ? next : entry))
      return next
    },
    decide: async (input) => {
      const edge = this.edges.find(
        (entry) =>
          entry.id === input.edgeId && (entry.status === 'proposed' || entry.status === 'contended'),
      )
      if (!edge) return null
      const next = {
        ...edge,
        status: input.status,
        decidedByName: input.decidedByName,
        decidedAt: new Date('2026-08-03T00:00:00Z'),
        decisionNote: input.note,
      }
      this.edges = this.edges.map((entry) => (entry.id === input.edgeId ? next : entry))
      return next
    },
  }

  agentRuns: AgentRunRepositoryPort = {
    findById: async () =>
      ({
        id: runId,
        workspaceId,
        repositoryId,
        persona: { name: 'flight-worker' },
      }) as unknown as AgentRun,
  } as unknown as AgentRunRepositoryPort

  personasPort: PersonaRepositoryPort = {
    listByWorkspace: async () => this.personas,
  } as unknown as PersonaRepositoryPort

  colosseum: ColosseumRepositoryPort = {
    convene: async (input: Parameters<ColosseumRepositoryPort['convene']>[0]) => {
      this.convened.push(input)
      return { id: 'session-1', ...input, status: 'convened' } as never
    },
    recordClaim: async (input: Parameters<ColosseumRepositoryPort['recordClaim']>[0]) => {
      this.claims.push(input)
      return { id: 'claim-1' } as never
    },
  } as unknown as ColosseumRepositoryPort

  get deps(): AtlasContentionDeps {
    return {
      atlas: this.atlas,
      subjectMaps: this.subjectMaps,
      personas: this.personasPort,
      agentRuns: this.agentRuns,
      colosseum: this.colosseum,
    }
  }
}

let world: FakeAtlasWorld

const persona = (id: typeof flightPersona, name: string, model: string): AgentPersona =>
  ({ id, name, model, workspaceId }) as unknown as AgentPersona

beforeEach(() => {
  world = new FakeAtlasWorld()
  world.personas = [
    persona(flightPersona, 'flight-worker', 'claude-opus-5'),
    persona(hotelPersona, 'hotel-expert', 'claude-sonnet-5'),
  ]
})

const seedPair = () => {
  world.seed({
    label: 'Cancellation fee',
    subjectRef: 'flight-api',
    repositoryId,
    personaId: flightPersona,
    nodeId: 'n-flight',
    mapId: 'm-flight',
  })
  world.seed({
    label: 'Refund policy',
    subjectRef: 'hotel-api',
    repositoryId: otherRepo,
    personaId: hotelPersona,
    nodeId: 'n-hotel',
    mapId: 'm-hotel',
  })
}

/**
 * The atlas's read side — what the *other* subjects in this workspace know.
 *
 * The domain owns ranking and rendering; what is asserted here is the part only the
 * application can get wrong: which subjects are searched, and which one is deliberately
 * left out.
 */
describe('findAtlasLeads', () => {
  it('answers from another subject, and never from the one this run already holds', async () => {
    seedPair()
    const leads = await findAtlasLeads(world.deps, {
      workspaceId,
      repositoryId,
      topic: 'cancellation refund',
    })
    expect(leads).toContain('hotel-api')
    // The run has already been handed this map; repeating it here would spend the window
    // twice and make a duplicate look like a discovery.
    expect(leads).not.toContain('flight-api')
  })

  it('asks for a topic rather than answering an empty one', async () => {
    expect(
      await findAtlasLeads(world.deps, { workspaceId, repositoryId, topic: '   ' }),
    ).toContain('Ask about something')
  })

  /**
   * The payoff of the write side, and the reason promotion means anything: The "a
   * confirmed edge stops being a lead and starts being ranked above leads".
   */
  it('renders a promoted relation above the leads, with the human who confirmed it', async () => {
    seedPair()
    const proposal = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'same_concept',
      rationale: 'Both compute a partial charge from time-to-departure.',
    })
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    await decideAtlasProposal(world.deps, {
      workspaceId,
      actor: userActor(asUserId('u1')),
      edgeId: proposal.edge.id,
      decision: 'promoted',
      decidedByName: 'Ada',
    })

    const answer = await findAtlasLeads(world.deps, {
      workspaceId,
      repositoryId,
      topic: 'refund policy',
    })
    expect(answer).toContain('a **human has confirmed**')
    expect(answer).toContain('Ada')
    // Above the leads, not among them — the two blocks say different things.
    expect(answer.indexOf('confirmed')).toBeLessThan(answer.indexOf('leads, not facts'))
  })

  /**
   * A relation is stored once and read from either end, so the *other* end is whichever
   * one the topic did not match.
   */
  it('names the far end of a confirmed relation, whichever end matched', async () => {
    seedPair()
    const proposal = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'same_concept',
      rationale: 'Same computation.',
    })
    if (!proposal.ok) throw new Error('expected a proposal')
    await decideAtlasProposal(world.deps, {
      workspaceId,
      actor: userActor(asUserId('u1')),
      edgeId: proposal.edge.id,
      decision: 'promoted',
      decidedByName: 'Ada',
    })

    const answer = await findAtlasLeads(world.deps, {
      workspaceId,
      repositoryId,
      topic: 'refund policy',
    })
    // The topic matched hotel's concept, so the relation reads hotel → flight.
    const confirmedLine = answer.split('\n').find((line) => line.includes('confirmed by'))
    expect(confirmedLine).toContain('hotel-api — Refund policy')
    expect(confirmedLine).toContain('flight-api — Cancellation fee')
  })

  /**
   * The bi-temporal model means the edge outlives its own endpoint. A human's
   * confirmation does not transfer to a claim the map has since withdrawn.
   */
  it('drops a confirmed relation whose endpoint the map has retired', async () => {
    seedPair()
    const proposal = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'same_concept',
      rationale: 'Same computation.',
    })
    if (!proposal.ok) throw new Error('expected a proposal')
    await decideAtlasProposal(world.deps, {
      workspaceId,
      actor: userActor(asUserId('u1')),
      edgeId: proposal.edge.id,
      decision: 'promoted',
      decidedByName: 'Ada',
    })
    world.edges = world.edges.map((edge) => ({ ...edge, from: { ...edge.from, live: false } }))

    const answer = await findAtlasLeads(world.deps, {
      workspaceId,
      repositoryId,
      topic: 'refund policy',
    })
    expect(answer).not.toContain('a **human has confirmed**')
  })
})

describe('proposeCrossSubjectRelation', () => {
  it('stores a proposal between two subjects, in state proposed', async () => {
    seedPair()
    const result = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'analogous_to',
      rationale: 'Both scale a charge by how late the change is.',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toBe(true)
    expect(result.edge.status).toBe('proposed')
    // Nothing promotes itself: a fresh proposal carries no human's name.
    expect(result.edge.decidedByName).toBe('')
  })

  /**
   * The whole content of a proposal is *which two things* it relates, so a shared label
   * has to come back to the model as a question rather than be resolved by picking one.
   */
  it('refuses a label two subjects share, and says which', async () => {
    seedPair()
    world.seed({
      label: 'Refund policy',
      subjectRef: 'billing-api',
      repositoryId: asRepositoryId('r-billing'),
      personaId: hotelPersona,
      nodeId: 'n-billing',
      mapId: 'm-billing',
    })
    const result = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'same_concept',
      rationale: 'Same idea.',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('hotel-api')
    expect(result.reason).toContain('billing-api')
  })

  it('refuses a concept it was never shown', async () => {
    seedPair()
    const result = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Whatever I imagined',
      relation: 'same_concept',
      rationale: 'Feels right.',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('No subject here has recorded')
  })

  /**
   * The boundary: extracted structure never crosses a subject boundary, so a file in
   * another repository has no business being an endpoint.
   */
  it('refuses an endpoint that is structure rather than a concept', async () => {
    world.seed({
      label: 'Cancellation fee',
      subjectRef: 'flight-api',
      repositoryId,
      nodeId: 'n-flight',
      mapId: 'm-flight',
    })
    world.seed({
      label: 'refund.ts',
      subjectRef: 'hotel-api',
      repositoryId: otherRepo,
      personaId: hotelPersona,
      kind: 'file',
      nodeId: 'n-file',
      mapId: 'm-hotel',
    })
    const result = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'refund.ts',
      relation: 'same_concept',
      rationale: 'That file does it.',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('only concepts cross a subject boundary')
  })

  /** Two readings of one subject are a disagreement, and the venue for that is a session. */
  it('refuses a relation inside one subject', async () => {
    world.seed({
      label: 'Cancellation fee',
      subjectRef: 'flight-api',
      repositoryId,
      nodeId: 'n-a',
      mapId: 'm-flight',
    })
    world.seed({
      label: 'Change fee',
      subjectRef: 'flight-api',
      repositoryId,
      nodeId: 'n-b',
      mapId: 'm-flight',
    })
    const result = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Change fee',
      theirSubject: 'flight-api',
      relation: 'same_concept',
      rationale: 'Same thing twice.',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('The atlas holds what no single')
  })

  it('refuses a relation with no argument behind it', async () => {
    seedPair()
    const result = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'same_concept',
      rationale: '   ',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Say why')
  })

  it('refuses an untyped relation', async () => {
    seedPair()
    const result = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'relates_to',
      rationale: 'They are connected somehow.',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Unknown relation')
  })

  /**
   * Every relation is symmetric, so the same claim proposed the other way round is the
   * same row — otherwise one relation would collect two human decisions.
   */
  it('treats the reverse of a proposal as the same claim', async () => {
    seedPair()
    const first = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'same_concept',
      rationale: 'Same computation.',
    })
    if (!first.ok) throw new Error('expected a proposal')

    // Node ids are ordered by the domain, so proposing from the other side lands on the
    // same pair — this asserts the normalization, not the fake's uniqueness.
    const second = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'same_concept',
      rationale: 'Rewritten argument.',
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.created).toBe(false)
    expect(world.edges).toHaveLength(1)
    // The first rationale stands: a second proposer must not overwrite the argument a
    // human is going to read.
    expect(second.edge.rationale).toBe('Same computation.')
  })

  it('refuses once the queue a human has to work through is full', async () => {
    seedPair()
    world.atlas.countByStatus = async () => MAX_OPEN_ATLAS_PROPOSALS
    const result = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'same_concept',
      rationale: 'Same computation.',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('waiting on a human')
  })

  /** A model told "noted" carries on as though the relation were established. */
  it('tells the proposing run that nothing has been established', async () => {
    seedPair()
    const result = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'same_concept',
      rationale: 'Same computation.',
    })
    const rendered = renderProposalOutcome(result)
    expect(rendered).toContain('proposal, not a finding')
    expect(rendered).toContain('carry on')
  })
})

describe('contendAtlasProposal', () => {
  const propose = async () => {
    seedPair()
    const result = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'same_concept',
      rationale: 'Both compute a partial charge.',
    })
    if (!result.ok) throw new Error('expected a proposal')
    return result.edge
  }

  it('puts the two experts who hold the ends in one room', async () => {
    const edge = await propose()
    const held = await contendAtlasProposal(world.deps, {
      workspaceId,
      threadId: asThreadId('t1'),
      edgeId: edge.id,
    })
    expect(held).not.toBeNull()
    const convened = world.convened[0]
    expect(convened?.purpose).toBe('contention')
    expect(convened?.participants.map((p) => p.personaName).sort()).toEqual([
      'flight-worker',
      'hotel-expert',
    ])
    // A session about a relation between two subjects belongs to neither repository.
    expect(convened?.repositoryId).toBeNull()
    expect(held?.edge.status).toBe('contended')
  })

  /**
   * The attrition check compares what was held before the first exchange against what
   * survived, and the claim under test here is the proposal itself.
   */
  it('records the proposal as an opening claim before anybody speaks', async () => {
    const edge = await propose()
    await contendAtlasProposal(world.deps, {
      workspaceId,
      threadId: asThreadId('t1'),
      edgeId: edge.id,
    })
    expect(world.claims[0]?.statement).toContain('Cancellation fee')
    expect(world.claims[0]?.statement).toContain('Refund policy')
  })

  /** One expert who mastered both sides is a fine proposer and a pointless room. */
  it('does not convene a room where one persona would argue with itself', async () => {
    world.seed({
      label: 'Cancellation fee',
      subjectRef: 'flight-api',
      repositoryId,
      personaId: flightPersona,
      nodeId: 'n-flight',
      mapId: 'm-flight',
    })
    world.seed({
      label: 'Refund policy',
      subjectRef: 'hotel-api',
      repositoryId: otherRepo,
      personaId: flightPersona,
      nodeId: 'n-hotel',
      mapId: 'm-hotel',
    })
    const result = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'same_concept',
      rationale: 'Same computation.',
    })
    if (!result.ok) throw new Error('expected a proposal')
    expect(
      await contendAtlasProposal(world.deps, {
        workspaceId,
        threadId: asThreadId('t1'),
        edgeId: result.edge.id,
      }),
    ).toBeNull()
    expect(world.convened).toHaveLength(0)
  })
})

describe('decideAtlasProposal', () => {
  const propose = async () => {
    seedPair()
    const result = await proposeCrossSubjectRelation(world.deps, {
      workspaceId,
      agentRunId: runId,
      mine: 'Cancellation fee',
      theirs: 'Refund policy',
      relation: 'same_concept',
      rationale: 'Both compute a partial charge.',
    })
    if (!result.ok) throw new Error('expected a proposal')
    return result.edge
  }

  /**
   * The check *is* the feature. A promoted edge is the one artifact this platform treats
   * as more than a lead, and an agent reaching this call would put a model's claim about
   * another model's summary under a human's name.
   */
  it('refuses an agent', async () => {
    const edge = await propose()
    await expect(
      decideAtlasProposal(world.deps, {
        workspaceId,
        actor: agentRunActor(runId),
        edgeId: edge.id,
        decision: 'promoted',
        decidedByName: 'flight-worker',
      }),
    ).rejects.toThrow(/Only a human/)
  })

  it('records a rejection rather than deleting the proposal', async () => {
    const edge = await propose()
    const decided = await decideAtlasProposal(world.deps, {
      workspaceId,
      actor: userActor(asUserId('u1')),
      edgeId: edge.id,
      decision: 'rejected',
      note: 'Hotel refunds are regulatory; flight fees are commercial.',
      decidedByName: 'Ada',
    })
    expect(decided.status).toBe('rejected')
    // The reason a plausible relation is wrong is written down nowhere else.
    expect(decided.decisionNote).toContain('regulatory')
    expect(world.edges).toHaveLength(1)
  })

  it('refuses a second decision on the same relation', async () => {
    const edge = await propose()
    await decideAtlasProposal(world.deps, {
      workspaceId,
      actor: userActor(asUserId('u1')),
      edgeId: edge.id,
      decision: 'promoted',
      decidedByName: 'Ada',
    })
    await expect(
      decideAtlasProposal(world.deps, {
        workspaceId,
        actor: userActor(asUserId('u2')),
        edgeId: edge.id,
        decision: 'rejected',
        decidedByName: 'Someone else',
      }),
    ).rejects.toThrow(/already been decided/)
  })
})
