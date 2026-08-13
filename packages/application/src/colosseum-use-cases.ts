import {
 MAX_COLOSSEUM_TURNS,
 NotFoundError,
 ValidationError,
 colosseumOpening,
 conveneRoster,
 settleClaim as settleClaimRule,
 summarizeOutcome,
 type AgentPersonaId,
 type ColosseumClaim,
 type ColosseumOutcome,
 type ColosseumParticipant,
 type ColosseumPurpose,
 type ColosseumSession,
 type RepositoryId,
 type ThreadId,
 type WorkspaceId,
} from '@loom/domain'
import type { ColosseumRepositoryPort, PersonaRepositoryPort, SubjectMapRepositoryPort } from './agent-ports.js'

/**
 * The Colosseum, as use cases.
 *
 * The domain holds the rules; this holds the two things a rule cannot: **who is in the
 * room**, which is a query against personas and their maps, and **the order of events**,
 * which is what makes "recorded before the first exchange" a fact rather than an
 * intention.
 *
 * There is deliberately no function here that merges a session's conclusions into a map.
 * Mastery: "a session's output is a set of claims with verdicts, never a merged map. Nothing
 * a session says is written into a trusted layer by the session itself." Promotion stays
 * a human act, as it is for notes-to-ADR and for distilled experience.
 */

export interface ColosseumDeps {
 readonly colosseum: ColosseumRepositoryPort
 readonly personas: PersonaRepositoryPort
 readonly subjectMaps: SubjectMapRepositoryPort
}

/**
 * Convenes a session.
 *
 * The roster is resolved here — each persona with the map it brings to *this* subject —
 * and then checked by `conveneRoster`, which refuses a roster that cannot disagree. A
 * participant with no map of the subject is allowed and carries an empty `subjectRef`:
 * The consultation case is a worker putting a question to an expert, and the worker is
 * not an expert in anything. What it may not be is *everyone*.
 */
export const conveneSession = async (
 deps: ColosseumDeps,
 input: {
 workspaceId: WorkspaceId
 threadId: ThreadId
 repositoryId: RepositoryId | null
 purpose: ColosseumPurpose
 subject: string
 question: string
 personaIds: readonly AgentPersonaId[]
 turnCap?: number
 spendCapUsd?: number | null
 },
): Promise<ColosseumSession> => {
 const question = input.question.trim
 if (question.length === 0) {
 throw new ValidationError('A session is convened for a reason — give it a question')
 }

 const personas = await deps.personas.listByWorkspace(input.workspaceId)
 const participants: ColosseumParticipant[] = []
 for (const personaId of input.personaIds) {
 const persona = personas.find((entry) => entry.id === personaId)
 if (!persona) throw new NotFoundError('AgentPersona')

 /**
 * What this persona **brings**, which is deliberately not the session's subject.
 *
 * The first version matched each participant's maps against the topic under
 * discussion, which made every participant's `subjectRef` the same string and turned
 * the diversity check into a check that always failed. It also had the relationship
 * backwards: a contention session is two experts *on different subjects* asked one
 * question, and what makes it worth convening is exactly that each brings something
 * the other cannot see.
 *
 * A map of the topic itself is preferred when one exists — that participant is the
 * closest thing to an authority here — and otherwise the most recently updated map
 * they hold. Nothing is a legitimate answer: the consultation case is a worker
 * putting a question to an expert.
 */
 const maps = (
 await deps.subjectMaps.listMapsForPersona(input.workspaceId, persona.id)
).filter((entry) => entry.status === 'ready')
 const map =
 maps.find((entry) => entry.subjectRef === input.subject) ??
 [...maps].sort((a, b) => b.updatedAt.getTime - a.updatedAt.getTime)[0]
 participants.push({
 personaId: persona.id,
 personaName: persona.name,
 mapId: map?.id ?? null,
 model: persona.model,
 subjectRef: map?.subjectRef ?? '',
 })
 }

 const verdict = conveneRoster(participants)
 if (!verdict.ok) throw new ValidationError(verdict.reason)

 const turnCap = Math.min(Math.max(input.turnCap ?? MAX_COLOSSEUM_TURNS, 1), MAX_COLOSSEUM_TURNS)

 return deps.colosseum.convene({
 workspaceId: input.workspaceId,
 threadId: input.threadId,
 repositoryId: input.repositoryId,
 purpose: input.purpose,
 subject: input.subject,
 question,
 turnCap,
 spendCapUsd: input.spendCapUsd ?? null,
 diversity: verdict.diversity,
 participants,
 })
}

/**
 * Records a claim a participant held **before the first exchange**.
 *
 * Refused once the session has started, and that refusal is the entire value of the
 * field: a claim entered mid-session cannot be distinguished afterwards from one the
 * conversation produced, and attrition — "correct claims present in round one are
 * progressively dropped" — is only measurable against an opening position nobody could
 * revise.
 */
export const recordOpeningClaim = async (
 deps: ColosseumDeps,
 input: {
 workspaceId: WorkspaceId
 sessionId: string
 statement: string
 personaId: AgentPersonaId
 },
): Promise<ColosseumClaim> => {
 const session = await deps.colosseum.getSession(input.workspaceId, input.sessionId)
 if (!session) throw new NotFoundError('ColosseumSession')
 if (session.status !== 'convened') {
 throw new ValidationError(
 'Opening claims are recorded before the first exchange. A claim entered afterwards ' +
 'cannot be told apart from one the conversation produced, and that distinction is ' +
 'what makes attrition measurable at all.',
)
 }

 const statement = input.statement.trim
 if (statement.length === 0) throw new ValidationError('A claim needs a statement')

 const participants = await deps.colosseum.listParticipants(input.workspaceId, input.sessionId)
 if (!participants.some((participant) => participant.personaId === input.personaId)) {
 throw new ValidationError('That persona is not on this session\'s roster')
 }

 return deps.colosseum.recordClaim({
 workspaceId: input.workspaceId,
 sessionId: input.sessionId,
 statement,
 originalHolderPersonaId: input.personaId,
 })
}

/**
 * Appends a turn, against the cap.
 *
 * The cap is enforced here rather than trusted to the caller for the same reason the
 * concurrency limit lives at `startAgentRun`: this is the one door every turn comes
 * through. Reaching it **abandons** the session rather than concluding it, because a
 * session that ran out of turns did not reach a conclusion — and recording it as
 * concluded would put a verdict on a conversation that was cut off.
 */
export const appendSessionTurn = async (
 deps: ColosseumDeps,
 input: {
 workspaceId: WorkspaceId
 sessionId: string
 personaId: AgentPersonaId | null
 personaName: string
 agentRunId: string | null
 text: string
 },
): Promise<{ seq: number; capped: boolean }> => {
 const session = await deps.colosseum.getSession(input.workspaceId, input.sessionId)
 if (!session) throw new NotFoundError('ColosseumSession')
 if (session.status === 'concluded' || session.status === 'abandoned') {
 throw new ValidationError('This session has ended')
 }

 const taken = await deps.colosseum.countTurns(input.workspaceId, input.sessionId)
 if (taken >= session.turnCap) {
 await deps.colosseum.setStatus(input.workspaceId, input.sessionId, 'abandoned')
 return { seq: taken, capped: true }
 }

 if (session.status === 'convened') {
 await deps.colosseum.setStatus(input.workspaceId, input.sessionId, 'running')
 }

 const { seq } = await deps.colosseum.appendTurn({
 workspaceId: input.workspaceId,
 sessionId: input.sessionId,
 personaId: input.personaId,
 personaName: input.personaName,
 agentRunId: input.agentRunId as never,
 text: input.text,
 })
 return { seq, capped: false }
}

/**
 * Settles a claim, or refuses.
 *
 * The refusal path goes through the domain, which accepts a citation and nothing else.
 * Nothing here counts participants, weighs confidence or breaks a tie: a verdict with no
 * check behind it is the conversation marking its own homework, and the useful answer for
 * such a claim is that it stays unsettled.
 */
export const settleSessionClaim = async (
 deps: ColosseumDeps,
 input: {
 workspaceId: WorkspaceId
 claimId: string
 verdict: 'upheld' | 'refuted'
 citation: string
 },
): Promise<ColosseumClaim> => {
 const verdict = settleClaimRule({ verdict: input.verdict, citation: input.citation })
 if (!verdict.ok) throw new ValidationError(verdict.reason)

 const claim = await deps.colosseum.settleClaim({
 workspaceId: input.workspaceId,
 claimId: input.claimId,
 verdict: verdict.verdict === 'unsettled' ? 'upheld': verdict.verdict,
 citation: verdict.citation,
 })
 if (!claim) throw new NotFoundError('ColosseumClaim')
 return claim
}

export interface ColosseumView {
 readonly session: ColosseumSession
 readonly participants: ColosseumParticipant[]
 readonly claims: ColosseumClaim[]
 readonly turns: {
 seq: number
 personaName: string
 agentRunId: string | null
 text: string
 createdAt: Date
 }[]
 readonly outcome: ColosseumOutcome
}

export const getSession = async (
 deps: ColosseumDeps,
 input: { workspaceId: WorkspaceId; sessionId: string },
): Promise<ColosseumView> => {
 const session = await deps.colosseum.getSession(input.workspaceId, input.sessionId)
 if (!session) throw new NotFoundError('ColosseumSession')

 const [participants, claims, turns] = await Promise.all([
 deps.colosseum.listParticipants(input.workspaceId, session.id),
 deps.colosseum.listClaims(input.workspaceId, session.id),
 deps.colosseum.listTurns(input.workspaceId, session.id),
 ])

 return { session, participants, claims, turns, outcome: summarizeOutcome(claims) }
}

export const listSessions = async (
 deps: ColosseumDeps,
 input: { workspaceId: WorkspaceId },
): Promise<ColosseumSession[]> => deps.colosseum.listSessions(input.workspaceId)

/**
 * Ends a session.
 *
 * Concluding writes no map, changes no persona and promotes nothing — the output is the
 * claims with their verdicts, and everything still `unsettled` stays that way. That is
 * not a shortfall: "an unsettled disagreement is recorded as one — both claims kept, both
 * scores lowered — and that is a *successful* outcome."
 */
export const concludeSession = async (
 deps: ColosseumDeps,
 input: { workspaceId: WorkspaceId; sessionId: string },
): Promise<ColosseumView> => {
 const session = await deps.colosseum.getSession(input.workspaceId, input.sessionId)
 if (!session) throw new NotFoundError('ColosseumSession')
 if (session.status !== 'concluded' && session.status !== 'abandoned') {
 await deps.colosseum.setStatus(input.workspaceId, input.sessionId, 'concluded')
 }
 return getSession(deps, input)
}

/**
 * What a participant is told before it speaks — the domain's opening, with the roster
 * filled in.
 *
 * Assembled server-side for the same reason a map's prompt block is: the wording is the
 * mitigation. It says a disagreement is a successful outcome, that a claim it cannot
 * check stays unsettled, and that everything it will hear is another model's output —
 * and a second copy of that on the Runner would be a second place for it to soften.
 */
export const openingFor = async (
 deps: ColosseumDeps,
 input: { workspaceId: WorkspaceId; sessionId: string; personaId: AgentPersonaId },
): Promise<string> => {
 const session = await deps.colosseum.getSession(input.workspaceId, input.sessionId)
 if (!session) throw new NotFoundError('ColosseumSession')

 const participants = await deps.colosseum.listParticipants(input.workspaceId, session.id)
 const speaker = participants.find(
 (participant) => participant.personaId === input.personaId,
)
 if (!speaker) throw new ValidationError('That persona is not on this session\'s roster')

 return colosseumOpening({
 personaName: speaker.personaName,
 purpose: session.purpose,
 subject: session.subject,
 question: session.question,
 otherParticipants: participants
.filter((participant) => participant.personaId !== input.personaId)
.map((participant) => participant.personaName),
 })
}
