import { asAgentRunId, asWorkspaceId, type AgentRun, type Prosecution } from '@loom/domain'
import { describe, expect, it, vi } from 'vitest'
import {
  closeUnreportedProsecution,
  recordProsecution,
  renderProsecutorTask,
  startProsecutor,
} from './prosecution-use-cases.js'
import type { AgentDeps } from './agent-use-cases.js'

/**
 * The prosecutor pass, at the layer that starts it.
 *
 * The cases worth the file are the ones that would pass a careless implementation while
 * either costing money forever or quietly overwriting evidence: a prosecutor prosecuting a
 * prosecutor, and a second report landing on a row a person has already read.
 */

const WS = asWorkspaceId('00000000-0000-4000-8000-000000000001')
const RUN = asAgentRunId('00000000-0000-4000-8000-0000000000a1')
const PROSECUTOR_RUN = asAgentRunId('00000000-0000-4000-8000-0000000000a2')

const run = (overrides: Partial<AgentRun> = {}): AgentRun =>
  ({
    id: RUN,
    workspaceId: WS,
    threadId: 'thread',
    repositoryId: 'repo',
    status: 'completed',
    branchName: 'loom/run-a1',
    clonePath: '/tmp/clone',
    relation: null,
    task: 'add the thing',
    persona: { name: 'swe', model: 'claude-sonnet-5' },
    ...overrides,
  }) as unknown as AgentRun

const harness = (
  options: {
    prosecutorExists?: boolean
    prosecution?: Prosecution | null
    reportReturns?: Prosecution | null
  } = {},
) => {
  const open = vi.fn(async () => ({}) as Prosecution)
  const report = vi.fn(async () =>
    'reportReturns' in options ? options.reportReturns : ({ ...stored } as Prosecution),
  )
  const started = vi.fn(async () => ({ id: PROSECUTOR_RUN as string }))
  const stored: Prosecution = {
    id: 'p1',
    workspaceId: WS,
    agentRunId: RUN,
    prosecutorRunId: PROSECUTOR_RUN,
    status: 'reported',
    observations: [{ name: 'a', outcome: 'broke', detail: null }],
    reason: null,
    createdAt: new Date(0),
    finishedAt: new Date(1),
  }
  const deps = {
    personas: {
      listByWorkspace: vi.fn(async () =>
        options.prosecutorExists === false ? [] : [{ id: 'persona', name: 'prosecutor' }],
      ),
    },
    repositories: { findById: vi.fn(async () => ({ id: 'repo', defaultBranch: 'main' })) },
    runVerifications: {
      listByRuns: vi.fn(async () => [
        { status: 'passed', checks: [{ name: 'tests', status: 'passed' }] },
      ]),
    },
    prosecutions: {
      open,
      report,
      findByProsecutorRun: vi.fn(async () =>
        options.prosecution === undefined ? stored : options.prosecution,
      ),
    },
  } as unknown as AgentDeps
  return { deps, open, report, started }
}

describe('renderProsecutorTask', () => {
  it('names the branch, the base, and what the repository already said', () => {
    const task = renderProsecutorTask({
      branchName: 'loom/run-a1',
      baseBranch: 'main',
      task: 'add the thing',
      verdict: 'passed (tests: passed)',
    })
    expect(task).toContain('loom/run-a1')
    expect(task).toContain('git diff main...HEAD')
    expect(task).toContain('add the thing')
    // The point of carrying the verdict: it must not spend its run re-running those checks.
    expect(task).toContain('Do not run them again')
  })

  /**
   * A prosecutor is started when the run ends, which is when its verification is enqueued —
   * so no verdict yet is the *common* case, not the edge one. It still has to be told not to
   * run the repository's checks itself, and it must not be told they passed.
   */
  it('tells it not to run the checks even when their verdict is not known yet', () => {
    const task = renderProsecutorTask({
      branchName: 'b',
      baseBranch: 'main',
      task: null,
      verdict: null,
    })
    expect(task).toContain('Do not run them.')
    expect(task).not.toMatch(/passed/i)
  })
})

describe('startProsecutor', () => {
  it('starts a child of the run under prosecution and opens a row for it', async () => {
    const { deps, open, started } = harness()
    await startProsecutor(deps, run(), started)
    expect(started).toHaveBeenCalledTimes(1)
    const input = (started.mock.calls as unknown as Record<string, unknown>[][])[0]![0]!
    expect(input.relation).toBe('prosecute')
    expect(input.parentRunId).toBe(RUN)
    expect(input.prosecute).toBe(true)
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunId: RUN, prosecutorRunId: PROSECUTOR_RUN }),
    )
  })

  /**
   * The whole pass is about a diff, and this is the field that gives the run one.
   *
   * Without it the Runner opens every run on a fresh branch off the default — which is the
   * *base* of the change under prosecution, so the tree holds none of it and `git diff` comes
   * back empty. It cost a live session nine minutes and a third of a dollar searching for a
   * branch its own task had named.
   */
  it('opens the prosecutor on the branch it is prosecuting', async () => {
    const { deps, started } = harness()
    await startProsecutor(deps, run(), started)
    const input = (started.mock.calls as unknown as Record<string, unknown>[][])[0]![0]!
    expect(input.openOnBranch).toEqual({ targetRunId: RUN, branchName: 'loom/run-a1' })
  })

  /**
   * The one that would otherwise cost money forever: a prosecution leaves a branch, and a
   * branch starts a prosecution. The only bound on that loop is the workspace concurrency
   * limit, which is to say the bill.
   */
  it('never prosecutes a prosecutor, a verifier, or a screening run', async () => {
    for (const relation of ['prosecute', 'verify', 'screen'] as const) {
      const { deps, started } = harness()
      await startProsecutor(deps, run({ relation }), started)
      expect(started, relation).not.toHaveBeenCalled()
    }
  })

  it('does nothing when the run left no branch', async () => {
    const { deps, started } = harness()
    await startProsecutor(deps, run({ branchName: null }), started)
    expect(started).not.toHaveBeenCalled()
  })

  it('does nothing, and does not throw, when the workspace has no prosecutor', async () => {
    const { deps, started } = harness({ prosecutorExists: false })
    await expect(startProsecutor(deps, run(), started)).resolves.toBeUndefined()
    expect(started).not.toHaveBeenCalled()
  })

  /**
   * The run is over and its branch is intact. A prosecutor that could not start is evidence
   * nobody gathered — never a finished run that looks failed.
   */
  it('swallows a failure to start rather than letting it reach the finished run', async () => {
    const { deps } = harness()
    const started = vi.fn(async () => {
      throw new Error('at the concurrency limit')
    })
    await expect(startProsecutor(deps, run(), started)).resolves.toBeUndefined()
  })
})

describe('closeUnreportedProsecution', () => {
  const prosecutorRun = (overrides: Partial<AgentRun> = {}) =>
    run({ id: PROSECUTOR_RUN, relation: 'prosecute', ...overrides })

  const unreported = {
    id: 'p1',
    workspaceId: WS,
    agentRunId: RUN,
    prosecutorRunId: PROSECUTOR_RUN,
    status: 'running',
    observations: [],
    reason: null,
    createdAt: new Date(0),
    finishedAt: null,
  } as Prosecution

  /**
   * The state the domain already defined and nothing wrote. A session that ends without
   * calling the tool — out of turns, or narrating its findings into the thread — used to
   * leave the row `running`, so the card said "Writing tests against this diff…" about a run
   * that had been over for a week.
   */
  it('marks a running prosecution inconclusive when its prosecutor just stops', async () => {
    const { deps, report } = harness({ prosecution: unreported })
    await closeUnreportedProsecution(deps, prosecutorRun(), { ok: true })
    expect(report).toHaveBeenCalledWith(WS, 'p1', {
      status: 'inconclusive',
      observations: [],
      reason: expect.stringContaining('without reporting'),
    })
  })

  it('records why, when the prosecutor failed rather than finished', async () => {
    const { deps, report } = harness({ prosecution: unreported })
    await closeUnreportedProsecution(deps, prosecutorRun(), { ok: false, message: 'budget cap' })
    expect(report).toHaveBeenCalledWith(
      WS,
      'p1',
      expect.objectContaining({ reason: expect.stringContaining('budget cap') }),
    )
  })

  /** Evidence a person may already have read is never overwritten by a tidy-up. */
  it('leaves a prosecution that already reported alone', async () => {
    const { deps, report } = harness()
    await closeUnreportedProsecution(deps, prosecutorRun(), { ok: true })
    expect(report).not.toHaveBeenCalled()
  })

  it('is a no-op for every run that was not prosecuting', async () => {
    const { deps, report } = harness({ prosecution: unreported })
    await closeUnreportedProsecution(deps, run(), { ok: true })
    expect(report).not.toHaveBeenCalled()
  })
})

describe('recordProsecution', () => {
  it('records the report and answers with a sentence that is not a verdict', async () => {
    const { deps, report } = harness()
    const result = await recordProsecution(deps, {
      workspaceId: WS,
      agentRunId: PROSECUTOR_RUN,
      observations: [{ name: 'a', outcome: 'broke', detail: 'boom' }],
      inconclusive: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toContain('does not affect')
    expect(report).toHaveBeenCalledWith(
      WS,
      'p1',
      expect.objectContaining({ status: 'reported', reason: null }),
    )
  })

  it('files an inconclusive report as inconclusive, not as an empty success', async () => {
    const { deps, report } = harness()
    await recordProsecution(deps, {
      workspaceId: WS,
      agentRunId: PROSECUTOR_RUN,
      observations: [],
      inconclusive: 'its own tests would not compile',
    })
    expect(report).toHaveBeenCalledWith(
      WS,
      'p1',
      expect.objectContaining({ status: 'inconclusive', reason: 'its own tests would not compile' }),
    )
  })

  /**
   * A refusal travels as a refusal — `ok: false` — which is what the tool inside the
   * container turns into a result the session can read. The design channel had to be
   * corrected to this shape after a refused design was reported to everything except the
   * model as a success.
   */
  it('refuses a run that is not prosecuting anything', async () => {
    const { deps } = harness({ prosecution: null })
    const result = await recordProsecution(deps, {
      workspaceId: WS,
      agentRunId: PROSECUTOR_RUN,
      observations: [],
      inconclusive: null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('not prosecuting anything')
  })

  it('refuses a second report rather than overwriting evidence somebody has read', async () => {
    const { deps } = harness({ reportReturns: null })
    const result = await recordProsecution(deps, {
      workspaceId: WS,
      agentRunId: PROSECUTOR_RUN,
      observations: [],
      inconclusive: null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('already been reported')
  })
})
