import {
  MAX_COLOSSEUM_ROSTER,
  MIN_COLOSSEUM_ROSTER,
  MAX_COLOSSEUM_TURNS,
  MAX_TURN_TEXT_CHARS,
  NotFoundError,
  ValidationError,
  colosseumOpening,
  colosseumTurnContext,
  conveneRoster,
  nextSpeaker,
  settleClaim as settleClaimRule,
  summarizeOutcome,
  type AgentPersonaId,
  type AgentRunId,
  type ColosseumClaim,
  type ColosseumOutcome,
  type ColosseumParticipant,
  type ColosseumPurpose,
  type ColosseumSession,
  type RepositoryId,
  type SubjectMapId,
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
 * Mastery: "a session's output is a set of claims with verdicts, never a merged map.
 * Nothing a session says is written into a trusted layer by the session itself." Promotion
 * stays a human act, as it is for notes-to-ADR and for distilled experience.
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
  const question = input.question.trim()
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
     * they hold. Nothing is a legitimate answer: The consultation case is a worker
     * putting a question to an expert.
     */
    const maps = (
      await deps.subjectMaps.listMapsForPersona(input.workspaceId, persona.id)
    ).filter((entry) => entry.status === 'ready')
    const map =
      maps.find((entry) => entry.subjectRef === input.subject) ??
      [...maps].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
    participants.push({
      personaId: persona.id,
      personaName: persona.name,
      mapId: map?.id ?? null,
      model: persona.model,
      subjectRef: map?.subjectRef ?? '',
    })
  }

  const verdict = conveneRoster(participants, input.purpose)
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

  const statement = input.statement.trim()
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
    verdict: verdict.verdict === 'unsettled' ? 'upheld' : verdict.verdict,
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

/**
 * How much of a session's ceiling has already been spent.
 *
 * Summed from the runs that took the turns rather than kept as a column on the session,
 * for the reason `countHandoffsInTree` gives: a running total is a second fact that can
 * disagree with the runs, and the runs are what the ledger is built from. A turn whose run
 * has been deleted contributes nothing, which is the right answer — there is no longer a
 * charge to attribute.
 */
const spentOnSession = async (
  deps: ColosseumTurnDeps,
  input: { workspaceId: WorkspaceId; sessionId: string },
): Promise<number> => {
  const turns = await deps.colosseum.listTurns(input.workspaceId, input.sessionId)
  let spent = 0
  for (const runId of new Set(turns.map((turn) => turn.agentRunId).filter((id) => id !== null))) {
    const run = await deps.agentRuns.findById(input.workspaceId, runId as AgentRunId)
    spent += run?.totalCostUsd ?? 0
  }
  return spent
}

export interface ColosseumTurnDeps extends ColosseumDeps {
  readonly agentRuns: {
    findById(
      workspaceId: WorkspaceId,
      id: AgentRunId,
    ): Promise<{ totalCostUsd: number | null } | null>
  }
  /**
   * Starts the run that will speak, and returns its id. Throws if it could not start.
   *
   * Injected rather than imported for the reason `startSuccessor` is: it keeps this file
   * out of the cycle `startAgentRun` would create, and it puts the one thing a turn
   * actually *is* — an ordinary run, same sandbox, same metering, same kill switch — in
   * the signature where a reader will find it.
   */
  startTurnRun(input: {
    session: ColosseumSession
    speaker: ColosseumParticipant
    task: string
    /** What is left of the session's ceiling, or null when it has none. */
    budgetCapUsd: number | null
  }): Promise<AgentRunId>
}

export interface TurnResult {
  readonly ok: boolean
  readonly reason: string
  readonly agentRunId: AgentRunId | null
  readonly speaker: ColosseumParticipant | null
}

/**
 * Takes one turn.
 *
 * **One `startAgentRun` per turn, and that is the whole shape.** A turn in this venue is
 * an ordinary run — same sandbox, same egress policy, same metering, same kill switch —
 * because the alternative is a second execution path that the security model would have
 * to be re-proved against. What makes it a *session* rather than a run is what it is
 * handed and where its answer lands: the domain's opening, the transcript so far behind an
 * untrusted fence, and an answer appended as a turn against the cap.
 *
 * Four refusals, and each is one of the venue's four properties doing its job:
 *
 * - **The floor** — a turn requested while one is in flight is refused. A session speaks
 *   one voice at a time or its transcript is overlapping monologues in arrival order.
 * - **The turn cap** — reaching it *abandons* the session rather than concluding one, for
 *   the reason `appendSessionTurn` gives: a conversation cut off has not reached a verdict.
 * - **The spend ceiling** — counted from the turns' own runs, and a session that has spent
 *   it is abandoned rather than quietly continuing. A ceiling nothing checks is a comment.
 * - **The roster** — the speaker must be on it, and by default it is whoever has gone
 *   longest without speaking, so one voice cannot take every turn against the cap.
 */
export const takeSessionTurn = async (
  deps: ColosseumTurnDeps,
  input: {
    workspaceId: WorkspaceId
    sessionId: string
    /** Who speaks. Omitted means whoever has gone longest without it. */
    personaId?: AgentPersonaId
  },
): Promise<TurnResult> => {
  const session = await deps.colosseum.getSession(input.workspaceId, input.sessionId)
  if (!session) throw new NotFoundError('ColosseumSession')

  const refuse = (reason: string): TurnResult => ({
    ok: false,
    reason,
    agentRunId: null,
    speaker: null,
  })

  if (session.status === 'concluded' || session.status === 'abandoned') {
    return refuse('This session has ended')
  }
  if (session.speakingRunId !== null) {
    return refuse(
      'Somebody is already speaking. A session takes one turn at a time — two runs ' +
        'answering at once would land in the transcript in whichever order they finished, ' +
        'and neither would have heard the other.',
    )
  }
  /**
   * The arbiter is the repository, and a run has to have one to be started at all. A
   * session convened without one can still record claims and settle them by hand; what it
   * cannot do is send an agent to answer, and saying so is better than a repository picked
   * on the session's behalf.
   */
  if (session.repositoryId === null) {
    return refuse(
      'This session has no repository, so there is nothing for an agent to answer from ' +
        'and nothing to settle a claim against. Convene it against a repository to let ' +
        'the participants speak.',
    )
  }

  const taken = await deps.colosseum.countTurns(input.workspaceId, input.sessionId)
  if (taken >= session.turnCap) {
    await deps.colosseum.setStatus(input.workspaceId, input.sessionId, 'abandoned')
    return refuse(
      `This session has taken all ${session.turnCap} of its turns. It is abandoned rather ` +
        'than concluded: a conversation that ran out of turns did not reach a conclusion.',
    )
  }

  let budgetCapUsd: number | null = null
  if (session.spendCapUsd !== null) {
    const spent = await spentOnSession(deps, input)
    const remaining = session.spendCapUsd - spent
    if (remaining <= 0) {
      await deps.colosseum.setStatus(input.workspaceId, input.sessionId, 'abandoned')
      return refuse(
        `This session has spent its ceiling of $${session.spendCapUsd.toFixed(2)}. Abandoned ` +
          'for the same reason the turn cap abandons one — it stopped early rather than ' +
          'reaching a conclusion.',
      )
    }
    budgetCapUsd = remaining
  }

  const participants = await deps.colosseum.listParticipants(input.workspaceId, session.id)
  const turns = await deps.colosseum.listTurns(input.workspaceId, session.id)
  const speaker =
    input.personaId === undefined
      ? nextSpeaker(participants, turns)
      : (participants.find((participant) => participant.personaId === input.personaId) ?? null)
  if (!speaker) {
    return refuse(
      input.personaId === undefined
        ? 'This session has no participants'
        : "That persona is not on this session's roster",
    )
  }

  const claims = await deps.colosseum.listClaims(input.workspaceId, session.id)
  const task = [
    colosseumOpening({
      personaName: speaker.personaName,
      purpose: session.purpose,
      subject: session.subject,
      question: session.question,
      otherParticipants: participants
        .filter((participant) => participant.personaId !== speaker.personaId)
        .map((participant) => participant.personaName),
    }),
    colosseumTurnContext({
      turns,
      ownOpeningClaims: claims
        .filter((claim) => claim.originalHolderPersonaId === speaker.personaId)
        .map((claim) => claim.statement),
    }),
  ].join('\n\n')

  const agentRunId = await deps.startTurnRun({ session, speaker, task, budgetCapUsd })

  /**
   * Claimed *after* the run exists, and the refusal path retires the run rather than
   * leaving it.
   *
   * The other order — claim, then start — would leave a session with the floor held by a
   * run that failed to start, which is a session nobody can speak in again. This order's
   * failure is a run that speaks into nothing, which the transcript simply never gains and
   * which the ledger still accounts for.
   */
  const claimed = await deps.colosseum.claimFloor(input.workspaceId, session.id, {
    agentRunId,
    personaId: speaker.personaId,
  })
  if (!claimed) {
    return {
      ok: false,
      reason:
        'Another turn claimed the floor first. This one will not be recorded — stop it if ' +
        'it is still running.',
      agentRunId,
      speaker,
    }
  }

  if (session.status === 'convened') {
    await deps.colosseum.setStatus(input.workspaceId, session.id, 'running')
  }

  return { ok: true, reason: 'speaking', agentRunId, speaker }
}

/**
 * How many turns a warm-up holds: the brief, and what came of it.
 *
 * Not a bound on a conversation — there is no conversation. It is the shape of the record:
 * a predecessor says what it knows, a successor takes over, and what the successor
 * produced is the second half of the same story.
 */
export const WARM_UP_TURN_CAP = 2

/**
 * How many turns a crunch holds — one round of the room, and no more.
 *
 * A crunch exists to put N drifting maps of one subsystem in front of each other, and
 * The evidence is that further rounds are where factual attrition happens: correct
 * claims present at the start are progressively dropped as the conversation continues.
 * One pass each is the most a session can take and still be reporting what its
 * participants knew rather than what the conversation produced.
 */
export const CRUNCH_TURN_CAP = MAX_COLOSSEUM_ROSTER

/**
 * The merge that made several agents' maps wrong at once, convened as a crunch.
 *
 * **The schedule is the merge queue.** Mastery calls a crunch "scheduled" and nothing here
 * runs on a clock, which is not a shortcut — it is the better trigger. A timer would
 * convene sessions about subsystems nothing had touched, and the condition that actually
 * matters is knowable exactly: a merge landed, and it invalidated nodes in *more than one
 * persona's* map of that repository. That is the moment N private maps started drifting,
 * and the own argument for this purpose is the merge queue's argument applied to
 * knowledge.
 *
 * **Convening spends nothing.** A session is a row, a roster and a question; turns are
 * ordinary runs and are taken deliberately, by a human or by an agent asking for the
 * floor. So the platform creates the *place* and never the spend — the same division
 * The handoff rule draws when it says the threshold nudges and the agent asks. A
 * platform that convened and then argued with itself on a merge would be a budget with
 * no bottom attached to the most frequent event in the system.
 *
 * Returns null whenever there is nothing to convene, which is the common case and not a
 * failure: one map is not a drift, and a repository already holding an open crunch does
 * not need a second one saying the same thing.
 */
export const conveneCrunchForDrift = async (
  deps: ColosseumDeps,
  input: {
    workspaceId: WorkspaceId
    threadId: ThreadId
    repositoryId: RepositoryId
    /** What to call the subsystem in the room — the repository, as a human names it. */
    subject: string
    /** The commit that made them wrong, so the question can point at something checkable. */
    revision: string
    /** The maps this merge actually invalidated, from the invalidation itself. */
    drifted: readonly { readonly id: SubjectMapId; readonly personaId: AgentPersonaId }[],
  },
): Promise<ColosseumSession | null> => {
  /**
   * One map per persona, and at least two personas. A persona holding two maps of one
   * repository is still one voice in this room, and picking either of them would be the
   * roster asserting something about which is authoritative.
   */
  const byPersona = new Map<string, SubjectMapId>()
  for (const map of input.drifted) {
    if (!byPersona.has(map.personaId as string)) byPersona.set(map.personaId as string, map.id)
  }
  if (byPersona.size < MIN_COLOSSEUM_ROSTER) return null

  /**
   * Never a second open crunch for the same repository. Merges land in bursts — a queue
   * drains several branches in a row — and one session per merge would bury the one a
   * human might actually take turns in under a stack of identical rooms.
   */
  const sessions = await deps.colosseum.listSessions(input.workspaceId)
  const alreadyOpen = sessions.some(
    (session) =>
      session.purpose === 'crunching' &&
      session.repositoryId === input.repositoryId &&
      (session.status === 'convened' || session.status === 'running'),
  )
  if (alreadyOpen) return null

  const personas = await deps.personas.listByWorkspace(input.workspaceId)
  const participants: ColosseumParticipant[] = []
  for (const [personaId, mapId] of byPersona) {
    const persona = personas.find((entry) => (entry.id as string) === personaId)
    // A map whose persona is gone is not a participant. Skipped rather than refused: the
    // remaining experts still have something to reconcile.
    if (!persona) continue
    participants.push({
      personaId: persona.id,
      personaName: persona.name,
      mapId,
      model: persona.model,
      subjectRef: input.subject,
    })
    if (participants.length === MAX_COLOSSEUM_ROSTER) break
  }

  const verdict = conveneRoster(participants, 'crunching')
  if (!verdict.ok) return null

  return deps.colosseum.convene({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    repositoryId: input.repositoryId,
    purpose: 'crunching',
    subject: input.subject,
    question:
      `${input.revision.slice(0, 8)} landed and made part of every map here wrong. ` +
      'What does each of you now believe about the changed area, and what in the ' +
      'repository settles it?',
    turnCap: CRUNCH_TURN_CAP,
    spendCapUsd: null,
    diversity: verdict.diversity,
    participants,
  })
}

/**
 * A handover, held in the venue.
 *
 * **The venue is the record, not the channel**, and the difference is deliberate. The *
 * sentence reads as though the brief should travel through here, but a handoff is the one
 * item in mastery that can lose work — making it depend on a second subsystem to deliver
 * its payload would put a tree with no live run and a branch nobody owns behind an
 * unrelated failure. So the brief reaches the successor exactly as it did before, as its
 * task, and this writes down what happened where a human can audit it.
 *
 * What that buys is real rather than decorative: the brief becomes a transcript entry
 * nobody can quietly revise, the successor's run holds the session's floor so its cost is
 * summed by the same `spentOnSession` every other session uses, and a handover stops being
 * a thing that only exists as two rows in `agent_run` and a line in a thread.
 *
 * One participant, not two. The successor carries the *same persona snapshot* — that is
 * what makes it continuity rather than a substitution — so the roster is one persona and
 * two runs, and the runs are told apart by the `agentRunId` each turn already carries.
 */
export const recordWarmUp = async (
  deps: ColosseumDeps,
  input: {
    workspaceId: WorkspaceId
    threadId: ThreadId
    repositoryId: RepositoryId | null
    personaId: AgentPersonaId
    personaName: string
    predecessorRunId: AgentRunId
    successorRunId: AgentRunId
    /** What the predecessor is handing over, already checked and already rendered. */
    brief: string
    /** The task both runs are on, which is what this warm-up is about. */
    subject: string
  },
): Promise<ColosseumSession> => {
  const session = await deps.colosseum.convene({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    repositoryId: input.repositoryId,
    purpose: 'warm_up',
    subject: input.subject,
    question: 'What does the agent taking this over need to know?',
    turnCap: WARM_UP_TURN_CAP,
    spendCapUsd: null,
    diversity: { subjects: 0, models: 1, personas: 1, voices: 1 },
    participants: [
      {
        personaId: input.personaId,
        personaName: input.personaName,
        mapId: null,
        model: '',
        subjectRef: '',
      },
    ],
  })

  await appendSessionTurn(deps, {
    workspaceId: input.workspaceId,
    sessionId: session.id,
    personaId: input.personaId,
    personaName: input.personaName,
    agentRunId: input.predecessorRunId,
    text: input.brief.slice(0, MAX_TURN_TEXT_CHARS),
  })

  /**
   * The successor takes the floor, so what it produces lands here as the second turn
   * through the same completion path every other turn uses — and its spend is counted
   * against this session by the same sum. Without it the venue would hold half a story
   * and none of the accounting mastery says it inherits.
   */
  await deps.colosseum.claimFloor(input.workspaceId, session.id, {
    agentRunId: input.successorRunId,
    personaId: input.personaId,
  })

  return session
}

/**
 * A turn's run finished — record what it said.
 *
 * Called on **every** run's completion, and a no-op for every run that was not speaking in
 * a session, which is why it is unconditional rather than behind a check the caller would
 * have to keep in step with (`closeMap` is unconditional for the same reason and it was
 * the right call there too).
 *
 * A failed turn is recorded as a turn the *platform* narrated, and it counts against the
 * cap. That is deliberate on both halves: the failure cost money and a slot, so hiding it
 * would make a session look cheaper and longer-lived than it was, and attributing it to
 * the persona would put words in a mouth that never opened.
 */
export const recordSpokenTurn = async (
  deps: ColosseumDeps,
  input: {
    workspaceId: WorkspaceId
    agentRunId: AgentRunId
    outcome: { ok: true; text: string } | { ok: false; message: string }
  },
): Promise<void> => {
  const session = await deps.colosseum.findSessionSpeakingFor(input.workspaceId, input.agentRunId)
  if (!session) return

  const speakerName =
    (await deps.colosseum.listParticipants(input.workspaceId, session.id)).find(
      (participant) => participant.personaId === session.speakingPersonaId,
    )?.personaName ?? 'a participant'

  // The floor first. A record that throws must not leave the session unable to take
  // another turn — the transcript can lose an entry and recover; a stuck floor cannot.
  await deps.colosseum.releaseFloor(input.workspaceId, session.id)

  /**
   * A session ended while this run was speaking — a human concluded it, or the kill
   * switch took the run. The answer arrives after the venue closed and is not appended:
   * a turn recorded after the conclusion would sit below a verdict that never heard it.
   */
  if (session.status === 'concluded' || session.status === 'abandoned') return

  await appendSessionTurn(deps, {
    workspaceId: input.workspaceId,
    sessionId: session.id,
    ...(input.outcome.ok
      ? { personaId: session.speakingPersonaId, personaName: speakerName }
      : { personaId: null, personaName: 'the platform' }),
    agentRunId: input.agentRunId,
    text: input.outcome.ok
      ? input.outcome.text.slice(0, MAX_TURN_TEXT_CHARS)
      : `${speakerName}'s turn did not finish: ${input.outcome.message.slice(0, 500)}`,
  })
}
