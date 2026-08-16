import { describe, expect, it } from 'vitest'
import { asAgentRunId, asWorkspaceId } from '@loom/domain'
import { recordRunHeartbeat } from './agent-use-cases.js'
import type { AgentDeps } from './agent-use-cases.js'

/**
 * The nudge decides on the sample the frame carried.
 *
 * **This is a regression test for an intermittent that three handoffs recorded as "cause
 * unproven".** The gateway starts an async task per frame, so two heartbeats from one run
 * are in flight together; `recordRunHeartbeat` wrote and then *re-read the row*, and when
 * the writes landed out of order the 91% frame read back 10% and decided there was no
 * pressure. Nothing was delivered, `markHandoffSuggested` was never claimed, and the run
 * whose window had filled was never told — in the suite that surfaced as a test waiting
 * for a frame that would never arrive, roughly one run in five under load.
 *
 * The stale row is modelled directly here rather than by racing anything, because a test
 * that reproduces a race by racing is a test that fails one run in five in the other
 * direction.
 */

const workspaceId = asWorkspaceId('w1')
const runId = asAgentRunId('run-1')

const depsFor = (storedRow: { contextTokens: number | null; contextMaxTokens: number | null }) => {
 const delivered: { runId: string; text: string }[] = []
 let stamped = false

 const deps = {
 agentRuns: {
 recordHeartbeat: async => {},
 /** Deliberately stale: what another in-flight heartbeat left behind. */
 findById: async => ({
 id: runId,
 workspaceId,
 runnerId: 'runner-1',
 status: 'running',
 threadId: 'thread-1',
 parentRunId: null,
 relation: null,
...storedRow,
 }),
 markHandoffSuggested: async => {
 if (stamped) return false
 stamped = true
 return true
 },
 listTree: async => [],
 },
 runControl: {
 get: async => ({ paused: false, handoff: { threshold: null, capPerTree: null } }),
 },
 dispatch: {
 deliverToRun: async (input: { runId: string; text: string }) => {
 delivered.push(input)
 },
 },
 /**
 * `postRunSystemMessage` needs a thread and an event bus; it runs *after* the delivery
 * and inside the same best-effort try, so leaving it to throw exercises the real
 * ordering — a nudge that reached the run counts even when the human-facing notice
 * fails, which is the priority the use case already encodes.
 */
 messages: {},
 threads: {},
 events: {},
 } as unknown as AgentDeps

 return { deps, delivered, stamped: => stamped }
}

describe('the handoff nudge, from the heartbeat that measured it', => {
 it('acts on the window this frame reported, not the one the row holds', async => {
 const { deps, delivered } = depsFor({ contextTokens: 10_000, contextMaxTokens: 100_000 })

 await recordRunHeartbeat(deps, {
 workspaceId,
 agentRunId: runId,
 context: { tokens: 91_000, maxTokens: 100_000 },
 })

 expect(delivered).toHaveLength(1)
 expect(delivered[0]?.text).toContain('91%')
 })

 it('stays quiet when the frame itself reports room, whatever the row says', async => {
 const { deps, delivered } = depsFor({ contextTokens: 99_000, contextMaxTokens: 100_000 })

 await recordRunHeartbeat(deps, {
 workspaceId,
 agentRunId: runId,
 context: { tokens: 10_000, maxTokens: 100_000 },
 })

 expect(delivered).toHaveLength(0)
 })

 /** A heartbeat with no sample has told the platform nothing new — see the use case. */
 it('does not re-decide on a heartbeat that carried no measurement', async => {
 const { deps, delivered } = depsFor({ contextTokens: 95_000, contextMaxTokens: 100_000 })

 await recordRunHeartbeat(deps, { workspaceId, agentRunId: runId })

 expect(delivered).toHaveLength(0)
 })
})
