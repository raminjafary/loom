import {
  ForbiddenError,
  ValidationError,
  agentRunActor,
  asAgentPersonaId,
  asAgentRunId,
  asChannelId,
  asRepositoryId,
  asRunnerId,
  asUserId,
  asWorkspaceId,
  userActor,
  type AgentRun,
} from '@loom/domain'
import { describe, expect, it, vi } from 'vitest'
import {
  deleteChannel,
  deletePersona,
  deleteRunner,
  unbindRepository,
  type AgentDeps,
} from './agent-use-cases.js'

/**
 * The gates on removal.
 *
 * Every one of these exists because the schema cascades — runner → repository →
 * agent_run, and channel → thread → message → agent_run — so an ungated delete
 * destroys run history and the spend the budget enforcement is judged against.
 * These tests are the record of which losses are refused outright, which require the
 * caller to have been told the number first, and which are not losses at all.
 */

const WS = asWorkspaceId('ws_1')
const human = userActor(asUserId('u_1'))
const agent = agentRunActor(asAgentRunId('run_1'))

const run = (overrides: Partial<AgentRun> = {}): AgentRun =>
  ({
    id: asAgentRunId('run_x'),
    workspaceId: WS,
    persona: { name: 'swe' },
    status: 'running',
    ...overrides,
  }) as AgentRun

const deps = (overrides: Record<string, unknown>): AgentDeps =>
  ({
    audit: { record: vi.fn(async () => ({})) },
    ...overrides,
  }) as unknown as AgentDeps

describe('deletePersona', () => {
  const persona = { id: asAgentPersonaId('p_1'), name: 'swe' }

  const personaDeps = (activeRuns: AgentRun[], prunedGroupCount = 0) => {
    const del = vi.fn(async () => {})
    const prunePersona = vi.fn(async () => prunedGroupCount)
    return {
      del,
      prunePersona,
      deps: deps({
        personas: { findById: async () => persona, delete: del },
        agentRuns: { listActiveByWorkspace: async () => activeRuns },
        personaGroups: { prunePersona },
      }),
    }
  }

  /**
   * The one deletion that loses nothing: a run snapshots its whole persona spec at
   * start, so a finished run keeps its persona, model and cost regardless.
   */
  it('deletes a persona no run is currently using', async () => {
    const { deps: d, del } = personaDeps([])
    await deletePersona(d, { workspaceId: WS, actor: human, personaId: persona.id })
    expect(del).toHaveBeenCalledWith(WS, persona.id)
  })

  it('refuses while a run of that persona is in flight', async () => {
    const { deps: d, del } = personaDeps([run({ persona: { name: 'swe' } as AgentRun['persona'] })])
    await expect(
      deletePersona(d, { workspaceId: WS, actor: human, personaId: persona.id }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(del).not.toHaveBeenCalled()
  })

  it('ignores a run of a different persona', async () => {
    const { deps: d, del } = personaDeps([run({ persona: { name: 'qa' } as AgentRun['persona'] })])
    await deletePersona(d, { workspaceId: WS, actor: human, personaId: persona.id })
    expect(del).toHaveBeenCalled()
  })

  /**
   * Group membership is a plain id array with no foreign key, so a deleted persona
   * would leave a chip with no name behind it. What this asserts is only that the
   * pruning is *asked for*, and before the delete — which group rows change is the
   * port's business now, tested against real Postgres in
   * packages/db/src/repositories.integration.test.ts. Asserting the write pattern here
   * meant this test knew how membership was stored.
   */
  it('asks the port to prune the persona out of its groups, before deleting it', async () => {
    const { deps: d, prunePersona, del } = personaDeps([], 1)
    await deletePersona(d, { workspaceId: WS, actor: human, personaId: persona.id })
    expect(prunePersona).toHaveBeenCalledWith(WS, persona.id)
    expect(prunePersona.mock.invocationCallOrder[0]!).toBeLessThan(del.mock.invocationCallOrder[0]!)
  })

  it('does not prune when it refuses the delete', async () => {
    const { deps: d, prunePersona } = personaDeps([
      run({ persona: { name: 'swe' } as AgentRun['persona'] }),
    ])
    await expect(
      deletePersona(d, { workspaceId: WS, actor: human, personaId: persona.id }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(prunePersona).not.toHaveBeenCalled()
  })

  it('is a human-only action', async () => {
    const { deps: d } = personaDeps([])
    await expect(
      deletePersona(d, { workspaceId: WS, actor: agent, personaId: persona.id }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('unbindRepository', () => {
  const repository = { id: asRepositoryId('r_1'), displayName: 'loom' }

  const repoDeps = (counts: { total: number; active: number }) => {
    const del = vi.fn(async () => {})
    return {
      del,
      deps: deps({
        repositories: { findById: async () => repository, delete: del },
        agentRuns: { countByRepository: async () => counts },
      }),
    }
  }

  it('unbinds a repository nothing has ever run in, with no ceremony', async () => {
    const { deps: d, del } = repoDeps({ total: 0, active: 0 })
    await unbindRepository(d, { workspaceId: WS, actor: human, repositoryId: repository.id })
    expect(del).toHaveBeenCalledWith(WS, repository.id)
  })

  /**
   * Unconditional, and not merely un-acknowledged: a live run has a clone on a Runner
   * and a branch in flight, so there is no confirmation that makes deleting the record
   * of it coherent.
   */
  it('refuses while a run is still live, acknowledged or not', async () => {
    const { deps: d, del } = repoDeps({ total: 3, active: 1 })
    await expect(
      unbindRepository(d, {
        workspaceId: WS,
        actor: human,
        repositoryId: repository.id,
        acknowledgeRunHistoryLoss: true,
      }),
    ).rejects.toThrow(/still working/)
    expect(del).not.toHaveBeenCalled()
  })

  it('refuses finished history until the loss is acknowledged, and says how much', async () => {
    const { deps: d, del } = repoDeps({ total: 12, active: 0 })
    await expect(
      unbindRepository(d, { workspaceId: WS, actor: human, repositoryId: repository.id }),
    ).rejects.toThrow(/12 run/)
    expect(del).not.toHaveBeenCalled()

    await unbindRepository(d, {
      workspaceId: WS,
      actor: human,
      repositoryId: repository.id,
      acknowledgeRunHistoryLoss: true,
    })
    expect(del).toHaveBeenCalled()
  })
})

describe('deleteRunner', () => {
  const runner = { id: asRunnerId('rn_1'), name: 'laptop' }

  const runnerDeps = (bound: number) => {
    const del = vi.fn(async () => {})
    return {
      del,
      deps: deps({
        runners: { findById: async () => runner, delete: del },
        repositories: { countByRunner: async () => bound },
      }),
    }
  }

  it('removes a runner with nothing bound to it', async () => {
    const { deps: d, del } = runnerDeps(0)
    await deleteRunner(d, { workspaceId: WS, actor: human, runnerId: runner.id })
    expect(del).toHaveBeenCalledWith(WS, runner.id)
  })

  /**
   * No acknowledgement path here on purpose. A runner cascades to its repositories and
   * through them to every run — an amount of history nobody can weigh from one
   * confirmation. Unbinding first makes the operator meet each repository's own count.
   */
  it('refuses while repositories are bound, and tells the operator what to do', async () => {
    const { deps: d, del } = runnerDeps(2)
    await expect(
      deleteRunner(d, { workspaceId: WS, actor: human, runnerId: runner.id }),
    ).rejects.toThrow(/unbind them first/)
    expect(del).not.toHaveBeenCalled()
  })

  it('says "it" rather than "them" for a single repository', async () => {
    const { deps: d } = runnerDeps(1)
    await expect(
      deleteRunner(d, { workspaceId: WS, actor: human, runnerId: runner.id }),
    ).rejects.toThrow(/repository is still bound .* unbind it first/)
  })
})

describe('deleteChannel', () => {
  const channel = { id: asChannelId('c_1'), name: 'general' }

  const channelDeps = (input: {
    remaining: number
    runs: { total: number; active: number }
  }) => {
    const del = vi.fn(async () => {})
    return {
      del,
      deps: deps({
        channels: {
          findById: async () => channel,
          delete: del,
          countByWorkspace: async () => input.remaining,
        },
        agentRuns: { countByChannel: async () => input.runs },
      }),
    }
  }

  it('deletes an empty channel', async () => {
    const { deps: d, del } = channelDeps({ remaining: 2, runs: { total: 0, active: 0 } })
    await deleteChannel(d, { workspaceId: WS, actor: human, channelId: channel.id })
    expect(del).toHaveBeenCalledWith(WS, channel.id)
  })

  /** Every client selects the first channel on load; a workspace with none is broken. */
  it('refuses to delete the last channel in a workspace', async () => {
    const { deps: d, del } = channelDeps({ remaining: 1, runs: { total: 0, active: 0 } })
    await expect(
      deleteChannel(d, {
        workspaceId: WS,
        actor: human,
        channelId: channel.id,
        acknowledgeRunHistoryLoss: true,
      }),
    ).rejects.toThrow(/only channel/)
    expect(del).not.toHaveBeenCalled()
  })

  it('refuses while a run in it is live', async () => {
    const { deps: d } = channelDeps({ remaining: 3, runs: { total: 4, active: 2 } })
    await expect(
      deleteChannel(d, { workspaceId: WS, actor: human, channelId: channel.id }),
    ).rejects.toThrow(/still working/)
  })

  it('requires the run-history loss to be acknowledged', async () => {
    const { deps: d, del } = channelDeps({ remaining: 3, runs: { total: 4, active: 0 } })
    await expect(
      deleteChannel(d, { workspaceId: WS, actor: human, channelId: channel.id }),
    ).rejects.toThrow(/4 run/)

    await deleteChannel(d, {
      workspaceId: WS,
      actor: human,
      channelId: channel.id,
      acknowledgeRunHistoryLoss: true,
    })
    expect(del).toHaveBeenCalled()
  })

  it('is a human-only action', async () => {
    const { deps: d } = channelDeps({ remaining: 3, runs: { total: 0, active: 0 } })
    await expect(
      deleteChannel(d, { workspaceId: WS, actor: agent, channelId: channel.id }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})
