import { describe, expect, it } from 'vitest'
import {
 asAgentPersonaId,
 asAgentRunId,
 asRepositoryId,
 asThreadId,
 asWorkspaceId,
 type AgentPersonaId,
 type AgentRunId,
 type ColosseumClaim,
 type ColosseumParticipant,
 type ColosseumSession,
} from '@loom/domain'
import type { ColosseumRepositoryPort } from './agent-ports.js'
import {
 conveneCrunchForDrift,
 recordSpokenTurn,
 takeSessionTurn,
 type ColosseumTurnDeps,
} from './colosseum-use-cases.js'

/**
 * The exchange, which is the half the venue was built for and did not have.
 *
 * Every test here is one of the four properties mastery says a venue needs — a fixed roster, a
 * spend ceiling, a transcript, a verdict — doing its job at the moment a turn is taken.
 * The venue's rules are worth nothing if the exchange can walk around them.
 */

const workspaceId = asWorkspaceId('w1')
const flight = asAgentPersonaId('p-flight')
const hotel = asAgentPersonaId('p-hotel')

const roster: ColosseumParticipant[] = [
 {
 personaId: flight,
 personaName: 'flight-expert',
 mapId: null,
 model: 'claude-sonnet-5',
 subjectRef: 'flight-api',
 },
 {
 personaId: hotel,
 personaName: 'hotel-expert',
 mapId: null,
 model: 'claude-sonnet-5',
 subjectRef: 'hotel-api',
 },
]

interface Harness {
 readonly deps: ColosseumTurnDeps
 readonly session: => ColosseumSession
 readonly turns: => { seq: number; personaName: string; agentRunId: string | null; text: string; createdAt: Date }[]
 readonly started: => { task: string; personaId: AgentPersonaId; budgetCapUsd: number | null }[]
 readonly costs: Map<string, number>
}

const harness = (
 over: Partial<ColosseumSession> = {},
 options: { startFails?: boolean } = {},
): Harness => {
 let session: ColosseumSession = {
 id: 's1',
 workspaceId,
 threadId: asThreadId('t1'),
 repositoryId: asRepositoryId('r1'),
 purpose: 'contention',
 subject: 'refund handling',
 question: 'Does the refund path double-convert?',
 status: 'convened',
 turnCap: 3,
 spendCapUsd: null,
 distinctSubjects: 2,
 distinctModels: 1,
 speakingRunId: null,
 speakingPersonaId: null,
 createdAt: new Date('2026-08-13T00:00:00Z'),
 concludedAt: null,
...over,
 }
 const turns: Harness['turns'] extends => infer T ? T: never = []
 const claims: ColosseumClaim[] = [
 {
 id: 'c1',
 statement: 'Refunds re-apply the minor-units conversion',
 originalHolderPersonaId: flight,
 verdict: 'unsettled',
 citation: '',
 droppedAt: null,
 },
 ]
 const started: { task: string; personaId: AgentPersonaId; budgetCapUsd: number | null }[] = []
 const costs = new Map<string, number>
 let nextRun = 0

 const colosseum: ColosseumRepositoryPort = {
 convene: async => session,
 getSession: async => session,
 listSessions: async => [session],
 listParticipants: async => roster,
 setStatus: async (_workspaceId, _sessionId, status) => {
 session = {...session, status }
 return session
 },
 claimFloor: async (_workspaceId, _sessionId, input) => {
 if (session.speakingRunId !== null) return false
 session = {...session, speakingRunId: input.agentRunId, speakingPersonaId: input.personaId }
 return true
 },
 releaseFloor: async => {
 session = {...session, speakingRunId: null, speakingPersonaId: null }
 },
 findSessionSpeakingFor: async (_workspaceId, agentRunId) =>
 session.speakingRunId === agentRunId ? session: null,
 recordClaim: async => claims[0] as ColosseumClaim,
 listClaims: async => claims,
 settleClaim: async => null,
 dropClaim: async => null,
 appendTurn: async (input) => {
 const seq = turns.length + 1
 turns.push({
 seq,
 personaName: input.personaName,
 agentRunId: input.agentRunId,
 text: input.text,
 createdAt: new Date,
 })
 return { seq }
 },
 listTurns: async => turns,
 countTurns: async => turns.length,
 }

 const deps: ColosseumTurnDeps = {
 colosseum,
 personas: {} as ColosseumTurnDeps['personas'],
 subjectMaps: {} as ColosseumTurnDeps['subjectMaps'],
 agentRuns: {
 findById: async (_workspaceId, id) => ({ totalCostUsd: costs.get(id) ?? null }),
 },
 startTurnRun: async ({ speaker, task, budgetCapUsd }) => {
 if (options.startFails) throw new Error('no runner connected')
 started.push({ task, personaId: speaker.personaId, budgetCapUsd })
 nextRun += 1
 return asAgentRunId(`run-${nextRun}`)
 },
 }

 return { deps, session: => session, turns: => turns, started: => started, costs }
}

describe('takeSessionTurn', => {
 it('starts exactly one run, and hands it the opening and the transcript', async => {
 const h = harness
 const result = await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })

 expect(result.ok).toBe(true)
 expect(h.started).toHaveLength(1)
 const task = h.started[0]?.task ?? ''
 expect(task).toContain('recorded session about refund handling')
 expect(task).toContain('Nothing has been said yet')
 // The session is running and the floor is held by the run that is speaking.
 expect(h.session.status).toBe('running')
 expect(h.session.speakingRunId).toBe(result.agentRunId)
 })

 /**
 * A session speaks one voice at a time. Two runs answering at once would land in the
 * transcript in whichever order they finished, and neither would have heard the other.
 */
 it('refuses a second turn while one is in flight', async => {
 const h = harness
 await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })
 const second = await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })

 expect(second.ok).toBe(false)
 expect(second.reason).toContain('already speaking')
 expect(h.started).toHaveLength(1)
 })

 it('gives the floor to whoever has gone longest without it', async => {
 const h = harness
 await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })
 await recordSpokenTurn(h.deps, {
 workspaceId,
 agentRunId: asAgentRunId('run-1'),
 outcome: { ok: true, text: 'It double-converts.' },
 })
 await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })

 expect(h.started.map((entry) => entry.personaId)).toEqual([flight, hotel])
 })

 it('refuses a persona who is not on the roster', async => {
 const h = harness
 const result = await takeSessionTurn(h.deps, {
 workspaceId,
 sessionId: 's1',
 personaId: asAgentPersonaId('p-stranger'),
 })
 expect(result.ok).toBe(false)
 expect(result.reason).toContain("not on this session's roster")
 })

 /**
 * Mastery: "reaching the turn cap abandons a session; it does not conclude one." A
 * conversation that was cut off has not reached a verdict, and recording it as concluded
 * would put one on it.
 */
 it('abandons rather than concludes when the cap is reached', async => {
 const h = harness({ turnCap: 1 })
 await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })
 await recordSpokenTurn(h.deps, {
 workspaceId,
 agentRunId: asAgentRunId('run-1'),
 outcome: { ok: true, text: 'said something' },
 })

 const second = await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })
 expect(second.ok).toBe(false)
 expect(h.session.status).toBe('abandoned')
 expect(h.started).toHaveLength(1)
 })

 /** The ceiling is one of the venue's four properties. One nothing checks is a comment. */
 it('passes what is left of the ceiling to the run, and abandons when it is spent', async => {
 const h = harness({ spendCapUsd: 1 })
 await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })
 expect(h.started[0]?.budgetCapUsd).toBe(1)

 h.costs.set('run-1', 0.4)
 await recordSpokenTurn(h.deps, {
 workspaceId,
 agentRunId: asAgentRunId('run-1'),
 outcome: { ok: true, text: 'said something' },
 })
 await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })
 expect(h.started[1]?.budgetCapUsd).toBeCloseTo(0.6)

 h.costs.set('run-2', 0.7)
 await recordSpokenTurn(h.deps, {
 workspaceId,
 agentRunId: asAgentRunId('run-2'),
 outcome: { ok: true, text: 'said more' },
 })
 const third = await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })
 expect(third.ok).toBe(false)
 expect(third.reason).toContain('spent its ceiling')
 expect(h.session.status).toBe('abandoned')
 })

 /**
 * The arbiter is the repository, and a run needs one to start at all. Saying so beats
 * picking one on the session's behalf.
 */
 it('refuses a session with no repository, and says why', async => {
 const h = harness({ repositoryId: null })
 const result = await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })
 expect(result.ok).toBe(false)
 expect(result.reason).toContain('no repository')
 expect(h.started).toHaveLength(0)
 })

 it('refuses a session that has ended', async => {
 const h = harness({ status: 'concluded' })
 const result = await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })
 expect(result.ok).toBe(false)
 expect(h.started).toHaveLength(0)
 })

 /**
 * The failure this ordering guards is a session with the floor held by a run that never
 * started — a session nobody can ever speak in again.
 */
 it('leaves the floor free when the run could not be started', async => {
 const h = harness({}, { startFails: true })
 await expect(takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })).rejects.toThrow
 expect(h.session.speakingRunId).toBeNull
 })

 it('shows the speaker its own opening claim', async => {
 const h = harness
 await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1', personaId: flight })
 expect(h.started[0]?.task).toContain('Refunds re-apply the minor-units conversion')
 })
})

describe('recordSpokenTurn', => {
 it('records the answer as a turn and gives the floor back', async => {
 const h = harness
 const { agentRunId } = await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })

 await recordSpokenTurn(h.deps, {
 workspaceId,
 agentRunId: agentRunId as AgentRunId,
 outcome: { ok: true, text: 'It double-converts on the refund path.' },
 })

 expect(h.turns).toHaveLength(1)
 expect(h.turns[0]?.personaName).toBe('flight-expert')
 expect(h.turns[0]?.text).toContain('double-converts')
 expect(h.session.speakingRunId).toBeNull
 })

 it('is a no-op for a run that was not speaking in any session', async => {
 const h = harness
 await recordSpokenTurn(h.deps, {
 workspaceId,
 agentRunId: asAgentRunId('some-other-run'),
 outcome: { ok: true, text: 'unrelated work' },
 })
 expect(h.turns).toHaveLength(0)
 })

 /**
 * A failed turn cost money and a slot, so hiding it would make a session look cheaper
 * and longer-lived than it was. Attributing it to the persona would put words in a mouth
 * that never opened, so the platform narrates it.
 */
 it('narrates a failed turn itself, and still spends the slot', async => {
 const h = harness
 const { agentRunId } = await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })

 await recordSpokenTurn(h.deps, {
 workspaceId,
 agentRunId: agentRunId as AgentRunId,
 outcome: { ok: false, message: 'reaped — no heartbeat' },
 })

 expect(h.turns).toHaveLength(1)
 expect(h.turns[0]?.personaName).toBe('the platform')
 expect(h.turns[0]?.text).toContain('flight-expert')
 expect(h.turns[0]?.text).toContain('did not finish')
 expect(h.session.speakingRunId).toBeNull
 })

 /** An answer that arrives after the venue closed would sit below a verdict that never heard it. */
 it('drops an answer that arrives after the session ended, but frees the floor', async => {
 const h = harness
 const { agentRunId } = await takeSessionTurn(h.deps, { workspaceId, sessionId: 's1' })
 await h.deps.colosseum.setStatus(workspaceId, 's1', 'concluded')

 await recordSpokenTurn(h.deps, {
 workspaceId,
 agentRunId: agentRunId as AgentRunId,
 outcome: { ok: true, text: 'too late' },
 })

 expect(h.turns).toHaveLength(0)
 expect(h.session.speakingRunId).toBeNull
 })
})

/**
 * The crunch, convened by the merge queue.
 *
 * The condition is the whole design: a merge landed, and it made more than one persona's
 * map of that repository wrong. What is asserted here is that the platform makes a
 * *place* and never a spend — a session with a roster and a question, and no runs.
 */
describe('conveneCrunchForDrift', => {
 const repositoryId = asRepositoryId('r1')
 const threadId = asThreadId('t1')

 const crunchHarness = (options: { sessions?: ColosseumSession[]; personaIds?: string[] } = {}) => {
 const convened: {
 purpose: string
 participants: readonly ColosseumParticipant[]
 turnCap: number
 question: string
 }[] = []

 const deps = {
 colosseum: {
 convene: async (input: {
 purpose: string
 participants: readonly ColosseumParticipant[]
 turnCap: number
 question: string
 }) => {
 convened.push(input)
 return { id: `s${convened.length}` } as ColosseumSession
 },
 listSessions: async => options.sessions ?? [],
 },
 personas: {
 listByWorkspace: async =>
 (options.personaIds ?? ['p-flight', 'p-hotel']).map((id) => ({
 id: asAgentPersonaId(id),
 name: id,
 model: 'claude-sonnet-5',
 })),
 },
 subjectMaps: {},
 } as unknown as ColosseumTurnDeps

 return { deps, convened: => convened }
 }

 const drifted = (entries: [string, string][]) =>
 entries.map(([id, personaId]) => ({
 id: id as never,
 personaId: asAgentPersonaId(personaId),
 }))

 const call = async (
 h: ReturnType<typeof crunchHarness>,
 maps: ReturnType<typeof drifted>,
): Promise<ColosseumSession | null> =>
 conveneCrunchForDrift(h.deps, {
 workspaceId,
 threadId,
 repositoryId,
 subject: 'loom',
 revision: 'abc1234567',
 drifted: maps,
 })

 it('convenes over the personas whose maps this merge made wrong', async => {
 const h = crunchHarness
 const session = await call(h, drifted([['m1', 'p-flight'], ['m2', 'p-hotel']]))

 expect(session).not.toBeNull
 const room = h.convened[0]
 expect(room?.purpose).toBe('crunching')
 expect(room?.participants.map((p) => p.personaName).sort).toEqual(['p-flight', 'p-hotel'])
 // The question points at something checkable, because the arbiter is the repository.
 expect(room?.question).toContain('abc12345')
 })

 /** One expert's map going stale is not a drift — it is a map to re-master. */
 it('convenes nothing when only one persona was affected', async => {
 const h = crunchHarness
 expect(await call(h, drifted([['m1', 'p-flight']]))).toBeNull
 expect(h.convened).toHaveLength(0)
 })

 /** A persona holding two maps of one repository is still one voice in the room. */
 it('counts a persona once however many of its maps drifted', async => {
 const h = crunchHarness
 expect(
 await call(h, drifted([['m1', 'p-flight'], ['m2', 'p-flight']])),
).toBeNull
 })

 /**
 * Merges land in bursts, and one room per merge would bury the one somebody might
 * actually speak in under a stack of identical ones.
 */
 it('does not open a second room while one is still open for this repository', async => {
 const open = {
 id: 's-open',
 purpose: 'crunching',
 repositoryId,
 status: 'convened',
 } as ColosseumSession
 const h = crunchHarness({ sessions: [open] })
 expect(await call(h, drifted([['m1', 'p-flight'], ['m2', 'p-hotel']]))).toBeNull

 // A concluded one is not in the way — the next merge is a new disagreement.
 const done = crunchHarness({ sessions: [{...open, status: 'concluded' } as ColosseumSession] })
 expect(await call(done, drifted([['m1', 'p-flight'], ['m2', 'p-hotel']]))).not.toBeNull
 })

 /** A map whose persona has been deleted leaves the rest with nothing to reconcile. */
 it('convenes nothing when the drifted maps outlive their personas', async => {
 const h = crunchHarness({ personaIds: ['p-flight'] })
 expect(await call(h, drifted([['m1', 'p-flight'], ['m2', 'p-gone']]))).toBeNull
 })
})
