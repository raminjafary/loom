import { BUILTIN_PERSONAS, asAgentPersonaId, asWorkspaceId, type AgentPersona } from '@loom/domain'
import { describe, expect, it, vi } from 'vitest'
import { seedBuiltinPersonas, type AgentDeps } from './agent-use-cases.js'

/**
 * Whether a shipped persona change reaches a workspace that already has one
 *.
 *
 * The rule used to be "skip by name", which is right about the thing it was
 * protecting — an operator's tuned prompt must not be reverted on every restart —
 * and wrong about everything else. The `planner` built-in shipped with `tools: []`;
 * The planner/worker trust boundary was later amended to give a planner read-only tools *because* the empty list
 * made sub-planners stall on the approval SLA. Every existing workspace kept the
 * version that stalls, a new one got the fix, and nothing said so.
 */

const WS = asWorkspaceId('ws_1')

const planner = BUILTIN_PERSONAS.find((persona) => persona.harnessPlanner)
if (!planner) throw new Error('no planner built-in to test against')

const row = (overrides: Partial<AgentPersona> = {}): AgentPersona =>
 ({
 id: asAgentPersonaId('p_1'),
 workspaceId: WS,
 name: planner.name,
 description: planner.description,
 markdownSource: planner.markdownSource,
 model: planner.model,
 tools: planner.tools,
 harnessEffort: planner.harnessEffort,
 harnessMaxTurns: planner.harnessMaxTurns,
 harnessAutoApprove: planner.harnessAutoApprove,
 harnessPlanner: planner.harnessPlanner,
 harnessDelegates: planner.harnessDelegates,
 harnessBudgetCapUsd: planner.harnessBudgetCapUsd,
 builtinSource: planner.markdownSource,
 createdAt: new Date(0),
 updatedAt: new Date(0),
...overrides,
 }) as AgentPersona

const deps = (existing: AgentPersona[]) => {
 const created: Record<string, unknown>[] = []
 const updated: Record<string, unknown>[] = []
 const create = vi.fn(async (input: Record<string, unknown>) => {
 created.push(input)
 return {} as AgentPersona
 })
 const update = vi.fn(
 async (_workspaceId: unknown, _id: unknown, patch: Record<string, unknown>) => {
 updated.push(patch)
 return {} as AgentPersona
 },
)
 return {
 calls: { create, update },
 created,
 updated,
 deps: {
 personas: { listByWorkspace: vi.fn(async => existing), create, update },
 } as unknown as AgentDeps,
 }
}

/** An older shipped version of the same built-in — the case the fix is about. */
const OUTDATED = planner.markdownSource.replace(/^tools:.*$/m, 'tools: []')

describe('seedBuiltinPersonas', => {
 it('creates every built-in in an empty workspace, recording what it seeded', async => {
 const { calls, created, deps: d } = deps([])
 await seedBuiltinPersonas(d, { workspaceId: WS })

 expect(calls.create).toHaveBeenCalledTimes(BUILTIN_PERSONAS.length)
 const first = created[0] as { builtinSource: string; markdownSource: string } | undefined
 expect(first?.builtinSource).toBe(first?.markdownSource)
 })

 it('leaves an up-to-date built-in completely alone', async => {
 const { calls, created, deps: d } = deps([row])
 await seedBuiltinPersonas(d, { workspaceId: WS })

 expect(calls.update).not.toHaveBeenCalled
 expect(created.some((input) => input.name === planner.name)).toBe(false)
 })

 /** The failure this exists for. */
 it('brings an untouched but outdated built-in forward', async => {
 const { calls, updated, deps: d } = deps([
 row({ markdownSource: OUTDATED, builtinSource: OUTDATED }),
 ])
 await seedBuiltinPersonas(d, { workspaceId: WS })

 expect(calls.update).toHaveBeenCalledTimes(1)
 expect(updated[0]?.markdownSource).toBe(planner.markdownSource)
 expect(updated[0]?.tools).toEqual(planner.tools)
 // Restamped, or the next resolution would think a human had edited it.
 expect(updated[0]?.builtinSource).toBe(planner.markdownSource)
 })

 /**
 * The rule the original "skip by name" was actually protecting. An operator who
 * tuned the planner's prompt must not have it reverted because the platform shipped
 * a new one.
 */
 it('never touches a persona a human has edited', async => {
 const edited = `${planner.markdownSource}\n\nAlways prefer smaller subtasks.`
 const { calls, deps: d } = deps([
 row({ markdownSource: edited, builtinSource: OUTDATED }),
 ])
 await seedBuiltinPersonas(d, { workspaceId: WS })

 expect(calls.update).not.toHaveBeenCalled
 })

 /**
 * A row seeded before `builtinSource` existed carries null, and with nothing
 * recorded there is no way to tell an untouched row from a tuned one. Overwriting a
 * human's prompt to fix a different persona is the wrong trade, so these are left
 * alone and surfaced in the editor instead.
 */
 it('does not auto-update a built-in seeded before the seed was recorded', async => {
 const { calls, deps: d } = deps([row({ markdownSource: OUTDATED, builtinSource: null })])
 await seedBuiltinPersonas(d, { workspaceId: WS })

 expect(calls.update).not.toHaveBeenCalled
 })
})
