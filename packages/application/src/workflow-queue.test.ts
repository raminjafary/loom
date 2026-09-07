import {
  bracketMatches,
  bracketSeeding,
  asAgentPersonaId,
  asAgentRunId,
  asRepositoryId,
  asThreadId,
  asUserId,
  asWorkflowId,
  asWorkflowRunId,
  asWorkflowStepRunId,
  asWorkflowVersionId,
  asWorkspaceId,
  parseWorkflowGraph,
  STEP_UNANSWERED,
  systemActor,
  userActor,
  type AgentPersona,
  type AgentRun,
  type WorkflowGraph,
  type WorkflowStepRunRecord,
  type WorkflowStepStatus,
} from '@loom/domain'
import { describe, expect, it, vi } from 'vitest'
import type { AgentDeps } from './agent-use-cases.js'
import {
  advanceWorkflowQueue,
  nextTrialArmFor,
  recordWorkflowAnswer,
  runTrialTask,
  validateWorkflowGraph,
  workflowDigest,
} from './workflow-use-cases.js'

/**
 * The executor's tick, where the decision meets the money.
 *
 * The domain already decides *what* may be dealt; what these tests hold down is what only this
 * layer can get wrong — dealing a step the cap will not pay for, settling a step before its cost
 * is known, closing an execution that is merely waiting, and letting a step answer for a sibling.
 */

const WS = asWorkspaceId('ws_1')
const RUN = asWorkflowRunId('wfr_1')
const VERSION = asWorkflowVersionId('wfv_1')

const GRAPH = ((): WorkflowGraph => {
  const verdict = parseWorkflowGraph({
    nodes: [
      {
        kind: 'step',
        id: 'discover',
        title: 'discover',
        persona: 'Scout',
        task: 'find the sites for {{input}}',
        answer: { fields: [{ kind: 'list', name: 'sites' }] },
      },
      {
        kind: 'fan',
        id: 'transform',
        title: 'transform',
        persona: 'Worker',
        task: 'rewrite {{item}}',
        source: 'discover',
        over: 'sites',
        maxWidth: 4,
        answer: { fields: [{ kind: 'text', name: 'diff' }] },
      },
    ],
    edges: [{ from: 'discover', to: 'transform' }],
  })
  if (!verdict.ok) throw new Error(verdict.reason)
  return verdict.graph
})()

const persona = (name: string): AgentPersona =>
  ({
    id: asAgentPersonaId(`p_${name}`),
    workspaceId: WS,
    name,
    description: 'a worker',
    markdownSource: `---\nname: ${name}\ndescription: A worker.\nmodel: claude-haiku-4-5-20251001\n---\n\nDo the work.`,
    model: 'claude-haiku-4-5-20251001',
    tools: ['Read', 'Write'],
    harnessEffort: null,
    harnessMaxTurns: null,
    harnessApprovalMode: 'ask',
    harnessPlanner: false,
    harnessDelegates: [],
    harnessBudgetCapUsd: 1,
    envelope: null,
  }) as unknown as AgentPersona

const step = (
  nodeId: string,
  over: Partial<WorkflowStepRunRecord> = {},
): WorkflowStepRunRecord => ({
  id: asWorkflowStepRunId(`step_${nodeId}_${over.itemIndex ?? 0}_${over.attempt ?? 0}`),
  workflowRunId: RUN,
  nodeId,
  pass: 0,
  itemIndex: 0,
  attempt: 0,
  item: null,
  claimedAt: new Date(),
  agentRunId: asAgentRunId('ar_1'),
  status: 'running' as WorkflowStepStatus,
  answer: null,
  reason: null,
  costUsd: null,
  finishedAt: null,
  ...over,
})

const agentRun = (over: Partial<AgentRun> = {}): AgentRun =>
  ({
    id: asAgentRunId('ar_1'),
    workspaceId: WS,
    threadId: asThreadId('t_1'),
    repositoryId: asRepositoryId('repo_1'),
    status: 'completed',
    totalCostUsd: 0.4,
    persona: { name: 'Scout', model: 'claude-haiku-4-5-20251001' },
    ...over,
  }) as unknown as AgentRun

const harness = (options: {
  steps: WorkflowStepRunRecord[]
  capUsd?: number | null
  spentUsd?: number
  run?: AgentRun | null
  claimSucceeds?: boolean
  runnerConnected?: boolean
  personas?: AgentPersona[]
  graph?: WorkflowGraph
}) => {
  const finishStep = vi.fn(async () => {})
  const closeRun = vi.fn(async () => null)
  const attachStepRun = vi.fn(async () => {})
  const releaseStep = vi.fn(async () => {})
  const recordStepAnswer = vi.fn(async () => {})
  const started: unknown[] = []

  const claimStep = vi.fn(
    async (input: {
      nodeId: string
      pass: number
      itemIndex: number
      attempt: number
      item: string | null
    }) =>
      options.claimSucceeds === false
        ? null
        : step(input.nodeId, {
            id: asWorkflowStepRunId(
              `claimed_${input.nodeId}_${input.itemIndex}_${input.attempt}`,
            ),
            itemIndex: input.itemIndex,
            pass: input.pass,
            attempt: input.attempt,
            item: input.item,
            agentRunId: null,
          }),
  )

  const deps = {
    audit: { record: vi.fn(async () => ({})) },
    messages: { append: vi.fn(async () => ({ id: 'm1' })) },
    events: { publish: vi.fn(async () => {}) },
    limits: { maxConcurrentRunsPerWorkspace: 6, maxDelegationDepth: 2 },
    runControl: { get: vi.fn(async () => ({ paused: false })) },
    threads: { findById: vi.fn(async () => ({ id: asThreadId('t_1'), workspaceId: WS })) },
    capabilities: { listByPersona: vi.fn(async () => []) },
    repositories: {
      findById: vi.fn(async () => ({
        id: asRepositoryId('repo_1'),
        workspaceId: WS,
        runnerId: 'runner_1',
        defaultBranch: 'main',
        absolutePath: '/tmp/repo',
      })),
    },
    runners: {
      findById: vi.fn(async () => ({
        id: 'runner_1',
        workspaceId: WS,
        connected: options.runnerConnected !== false,
      })),
    },
    personas: {
      listByWorkspace: vi.fn(async () => options.personas ?? [persona('Scout'), persona('Worker')]),
      findById: vi.fn(async (_ws: unknown, id: string) => {
        const found = (options.personas ?? [persona('Scout'), persona('Worker')]).find(
          (entry) => entry.id === id,
        )
        return found ?? null
      }),
    },
    agentRuns: {
      findById: vi.fn(async () => options.run ?? agentRun()),
      listActiveByWorkspace: vi.fn(async () => []),
      create: vi.fn(async () => agentRun({ id: asAgentRunId('ar_new'), status: 'pending' })),
      updateStatus: vi.fn(async () => agentRun()),
    },
    workflows: {
      listRunningWorkflowRuns: vi.fn(async () => [{ workspaceId: WS, runId: RUN }]),
      findRun: vi.fn(async () => ({
        id: RUN,
        workspaceId: WS,
        workflowVersionId: VERSION,
        repositoryId: asRepositoryId('repo_1'),
        threadId: asThreadId('t_1'),
        input: 'the ask',
        status: 'running' as const,
        capUsd: options.capUsd === undefined ? 10 : options.capUsd,
        startedByUserId: 'user_1',
        haltReason: null,
        createdAt: new Date(0),
        finishedAt: null,
      })),
      findVersion: vi.fn(async () => ({
        id: VERSION,
        workflowId: 'wf_1',
        version: 1,
        graph: options.graph ?? GRAPH,
        digest: 'd',
        createdByUserId: null,
        createdAt: new Date(0),
      })),
      stepsForRun: vi.fn(async () => options.steps),
      spentOnRun: vi.fn(async () => options.spentUsd ?? 0),
      claimStep,
      attachStepRun,
      releaseStep,
      finishStep,
      recordStepAnswer,
      closeRun,
      findStepByRun: vi.fn(async () => options.steps[0] ?? null),
    },
    dispatch: { startRun: vi.fn(async (input: unknown) => void started.push(input)) },
  } as unknown as AgentDeps

  return {
    deps,
    finishStep,
    closeRun,
    attachStepRun,
    releaseStep,
    recordStepAnswer,
    claimStep,
    started: started as { task?: string }[],
  }
}

const tick = (deps: AgentDeps) =>
  advanceWorkflowQueue(deps, { stepStuckMs: 60_000, maxStartsPerTick: 8 })

const callsOf = (mock: ReturnType<typeof vi.fn>): unknown[][] =>
  mock.mock.calls as unknown as unknown[][]

describe('validateWorkflowGraph', () => {
  it('refuses a shape naming a persona this workspace does not have', () => {
    const verdict = validateWorkflowGraph(GRAPH, [persona('Scout')])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('"Worker", which this workspace does not have')
  })

  it('accepts one whose personas are all here', () => {
    expect(validateWorkflowGraph(GRAPH, [persona('Scout'), persona('Worker')]).ok).toBe(true)
  })
})

describe('workflowDigest', () => {
  it('is the same for two shapes drawn in a different order', () => {
    const reordered: WorkflowGraph = { nodes: [...GRAPH.nodes].reverse(), edges: GRAPH.edges }
    expect(workflowDigest(reordered)).toBe(workflowDigest(GRAPH))
  })
})

describe('advanceWorkflowQueue', () => {
  it('deals the step nothing waits for', async () => {
    const { deps, claimStep, attachStepRun, started } = harness({ steps: [] })
    await tick(deps)
    expect(callsOf(claimStep)[0]?.[0]).toMatchObject({ nodeId: 'discover' })
    expect(attachStepRun).toHaveBeenCalled()
    // The task is rendered before dispatch, with the execution's own input interpolated.
    expect(started[0]).toMatchObject({ task: 'find the sites for the ask' })
  })

  /**
   * A start that never happened is not an answer. A *dispatch* failure is a different case and
   * deliberately not this one: it produces a real run marked failed, which the next tick settles
   * as a refusal with the run named, so a person can see what went wrong in the thread.
   */
  it('gives a claimed step back when no run could be started at all', async () => {
    const { deps, releaseStep, finishStep } = harness({ steps: [], runnerConnected: false })
    await tick(deps)
    expect(releaseStep).toHaveBeenCalled()
    expect(finishStep).not.toHaveBeenCalled()
  })

  it('halts on the cap rather than dealing one more step', async () => {
    const { deps, closeRun, attachStepRun } = harness({ steps: [], capUsd: 1, spentUsd: 1 })
    await tick(deps)
    expect(attachStepRun).not.toHaveBeenCalled()
    expect(callsOf(closeRun)[0]?.[2]).toMatchObject({ status: 'halted' })
  })

  it('settles a step when its run ends, with the cost that run reported', async () => {
    const answered = step('discover', { answer: { sites: ['a', 'b'] } })
    const { deps, finishStep } = harness({ steps: [answered] })
    await tick(deps)
    expect(callsOf(finishStep)[0]?.[2]).toMatchObject({
      status: 'answered',
      costUsd: 0.4,
      answer: { sites: ['a', 'b'] },
    })
  })

  it('refuses a step whose run ended without answering', async () => {
    const { deps, finishStep } = harness({ steps: [step('discover')] })
    await tick(deps)
    expect(callsOf(finishStep)[0]?.[2]).toMatchObject({
      status: 'refused',
      reason: STEP_UNANSWERED,
    })
  })

  /**
   * The settlement's wording is the retry's trigger, so this holds the two halves together: a
   * reason reworded on one side of the file would turn the retry off silently, and the sentence
   * a person reads is not the sort of thing anybody expects to be load-bearing.
   */
  it('deals a step that answered nothing a second time, telling it so', async () => {
    const refused = step('discover', {
      status: 'refused',
      reason: STEP_UNANSWERED,
      finishedAt: new Date(1),
    })
    const { deps, claimStep, started } = harness({ steps: [refused] })
    await tick(deps)
    expect(callsOf(claimStep)[0]?.[0]).toMatchObject({ nodeId: 'discover', attempt: 1 })
    expect(started[0]?.task).toContain('find the sites for the ask')
    expect(started[0]?.task).toContain('ended without submitting an answer')
  })

  it('stops after the second, and says which step cost the execution', async () => {
    const silent = (attempt: number) =>
      step('discover', {
        attempt,
        status: 'refused' as WorkflowStepStatus,
        reason: STEP_UNANSWERED,
        finishedAt: new Date(1 + attempt),
      })
    const { deps, claimStep, closeRun } = harness({ steps: [silent(0), silent(1)] })
    await tick(deps)
    expect(callsOf(claimStep).map((call) => call[0])).not.toContainEqual(
      expect.objectContaining({ nodeId: 'discover' }),
    )
    expect(callsOf(closeRun)[0]?.[2]).toMatchObject({ status: 'failed' })
    const reason = String((callsOf(closeRun)[0]?.[2] as { reason: string }).reason)
    expect(reason).toContain('"discover"')
    expect(reason).toContain('all 2 attempts')
  })

  /**
   * A run that failed is not dealt again: something happened to the *run*, and a second one is
   * the same bet at twice the price. Only a run that completed and said nothing is a dice roll.
   */
  it('does not deal a step whose run failed a second time', async () => {
    const refused = step('discover', {
      status: 'refused',
      reason: 'the run failed',
      finishedAt: new Date(1),
    })
    const { deps, claimStep } = harness({ steps: [refused] })
    await tick(deps)
    expect(callsOf(claimStep).map((call) => call[0])).not.toContainEqual(
      expect.objectContaining({ nodeId: 'discover' }),
    )
  })

  /**
   * A node that declared no answer is dealt no answer tool — that is decided at dispatch, and
   * deliberately. Settling it as a refusal for not answering therefore refused it every time,
   * whatever its run did, and an execution ending in one could never finish: it closed
   * "Nothing at the bottom of this workflow answered" on work that had actually been done.
   * The node whose deliverable is the tree rather than a field is the ordinary case for this.
   */
  const NO_ANSWER_GRAPH = ((): WorkflowGraph => {
    const verdict = parseWorkflowGraph({
      nodes: [
        {
          kind: 'step',
          id: 'discover',
          title: 'discover',
          persona: 'Scout',
          task: 'find the sites for {{input}}',
          answer: { fields: [{ kind: 'list', name: 'sites' }] },
        },
        { kind: 'step', id: 'ship', title: 'ship', persona: 'Scout', task: 'carry it out', answer: null },
      ],
      edges: [{ from: 'discover', to: 'ship' }],
    })
    if (!verdict.ok) throw new Error(verdict.reason)
    return verdict.graph
  })()

  it('settles a step that declared no answer, because none was ever owed', async () => {
    const { deps, finishStep } = harness({
      steps: [step('ship')],
      graph: NO_ANSWER_GRAPH,
    })
    await tick(deps)
    expect(callsOf(finishStep)[0]?.[2]).toMatchObject({ status: 'answered', answer: null })
  })

  it('still refuses one whose run failed, since no answer due is not work done', async () => {
    const { deps, finishStep } = harness({
      steps: [step('ship')],
      graph: NO_ANSWER_GRAPH,
      run: agentRun({ status: 'failed' }),
    })
    await tick(deps)
    expect(callsOf(finishStep)[0]?.[2]).toMatchObject({ status: 'refused' })
  })

  it('leaves a step alone while its run is still going', async () => {
    const { deps, finishStep } = harness({
      steps: [step('discover')],
      run: agentRun({ status: 'running' }),
    })
    await tick(deps)
    expect(finishStep).not.toHaveBeenCalled()
  })

  it('deals one lane per item once the fan source has answered', async () => {
    const { deps, claimStep } = harness({
      steps: [
        step('discover', { status: 'answered', answer: { sites: ['a', 'b', 'c'] }, costUsd: 0.4 }),
      ],
    })
    await tick(deps)
    const fanned = callsOf(claimStep)
      .map((call) => call[0] as { nodeId: string; item: string | null })
      .filter((call) => call.nodeId === 'transform')
    expect(fanned.map((call) => call.item)).toEqual(['a', 'b', 'c'])
  })

  it('closes as finished when every lane has settled', async () => {
    const { deps, closeRun } = harness({
      steps: [
        step('discover', { status: 'answered', answer: { sites: ['a'] }, costUsd: 0.4 }),
        step('transform', {
          id: asWorkflowStepRunId('t0'),
          status: 'answered',
          answer: { diff: 'x' },
          costUsd: 0.2,
        }),
      ],
    })
    await tick(deps)
    expect(callsOf(closeRun)[0]?.[2]).toMatchObject({ status: 'finished' })
  })

  it('closes as failed when nothing at the bottom answered', async () => {
    const { deps, closeRun } = harness({
      steps: [
        step('discover', { status: 'answered', answer: { sites: ['a'] }, costUsd: 0.4 }),
        step('transform', { id: asWorkflowStepRunId('t0'), status: 'refused', costUsd: 0.2 }),
      ],
    })
    await tick(deps)
    expect(callsOf(closeRun)[0]?.[2]).toMatchObject({ status: 'failed' })
  })

  it('does not close an execution that is merely waiting', async () => {
    const { deps, closeRun } = harness({
      steps: [step('discover')],
      run: agentRun({ status: 'running' }),
    })
    await tick(deps)
    expect(closeRun).not.toHaveBeenCalled()
  })
})

describe('recordWorkflowAnswer', () => {
  it('stores an answer that matches the shape its node declared, without settling the step', async () => {
    const { deps, recordStepAnswer, finishStep } = harness({ steps: [step('discover')] })
    const result = await recordWorkflowAnswer(deps, {
      workspaceId: WS,
      agentRunId: asAgentRunId('ar_1'),
      answer: { sites: ['a', 'b'] },
    })
    expect(result.ok).toBe(true)
    expect(callsOf(recordStepAnswer)[0]?.[2]).toEqual({ sites: ['a', 'b'] })
    expect(finishStep).not.toHaveBeenCalled()
  })

  it('tells the model what was wrong rather than recording a shape nothing can read', async () => {
    const { deps, recordStepAnswer } = harness({ steps: [step('discover')] })
    const result = await recordWorkflowAnswer(deps, {
      workspaceId: WS,
      agentRunId: asAgentRunId('ar_1'),
      answer: { sites: 'a and b' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('rather than a list')
    expect(recordStepAnswer).not.toHaveBeenCalled()
  })

  it('refuses an answer from a run that is not a step of any workflow', async () => {
    const { deps } = harness({ steps: [] })
    const result = await recordWorkflowAnswer(deps, {
      workspaceId: WS,
      agentRunId: asAgentRunId('ar_stranger'),
      answer: { sites: [] },
    })
    expect(result.ok).toBe(false)
  })

  it('refuses to change a settled step', async () => {
    const { deps } = harness({ steps: [step('discover', { status: 'answered' })] })
    const result = await recordWorkflowAnswer(deps, {
      workspaceId: WS,
      agentRunId: asAgentRunId('ar_1'),
      answer: { sites: ['a'] },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('already settled')
  })
})

/**
 * A tournament, where the seeding meets the money.
 *
 * The domain decides who meets whom; what only this layer can get wrong is *what it seeds from*.
 * A seed taken from a clock or a counter would seat the same execution differently on every tick,
 * and a bracket that cannot be re-derived from its own rows is not evidence about the attempts.
 */
const BRACKET_GRAPH = ((): WorkflowGraph => {
  const verdict = parseWorkflowGraph({
    nodes: [
      {
        kind: 'step',
        id: 'approaches',
        title: 'approaches',
        persona: 'Scout',
        task: 'name the approaches to {{input}}',
        answer: { fields: [{ kind: 'list', name: 'approaches' }] },
      },
      {
        kind: 'fan',
        id: 'attempt',
        title: 'attempt',
        persona: 'Worker',
        task: 'try {{item}}',
        source: 'approaches',
        over: 'approaches',
        maxWidth: 4,
        answer: { fields: [{ kind: 'text', name: 'result' }] },
      },
      { kind: 'barrier', id: 'attempted', title: 'attempts in' },
      {
        kind: 'bracket',
        id: 'judge',
        title: 'judge',
        persona: 'Judge',
        task: 'better, {{left}} or {{right}}?',
        entrants: 'attempt',
        over: 'result',
        maxEntrants: 4,
        answer: { fields: [{ kind: 'text', name: 'why' }] },
      },
    ],
    edges: [
      { from: 'approaches', to: 'attempt' },
      { from: 'attempt', to: 'attempted' },
      { from: 'approaches', to: 'attempted' },
      { from: 'attempted', to: 'judge' },
    ],
  })
  if (!verdict.ok) throw new Error(verdict.reason)
  return verdict.graph
})()

const ATTEMPTED = ['first way', 'second way'] as const

const bracketSteps = (): WorkflowStepRunRecord[] => [
  step('approaches', {
    status: 'answered',
    answer: { approaches: ['one', 'two'] },
    agentRunId: asAgentRunId('ar_1'),
  }),
  ...ATTEMPTED.map((result, at) =>
    step('attempt', {
      id: asWorkflowStepRunId(`attempt_${at}`),
      itemIndex: at,
      status: 'answered',
      answer: { result },
    }),
  ),
  step('attempted', { status: 'answered', answer: {}, agentRunId: null }),
]

describe('a bracket, through the tick', () => {
  const judges = [persona('Scout'), persona('Worker'), persona('Judge')]

  it('deals one match with both entrants in the prompt it is given', async () => {
    const { deps, started } = harness({
      graph: BRACKET_GRAPH,
      steps: bracketSteps(),
      personas: judges,
    })
    await tick(deps)
    const matches = started.filter((entry) => String(entry.task).startsWith('better,'))
    expect(matches).toHaveLength(1)
    expect(matches[0]?.task).toContain('first way')
    expect(matches[0]?.task).toContain('second way')
  })

  /**
   * The assertion that pins the seed to a row: the pairing dealt is the one `bracketSeeding` and
   * `bracketMatches` produce for *this execution's id*. Seeded from anything else — a clock, a
   * counter, the graph alone — this is a different pair.
   */
  it('seats the match from the execution’s own id, not from a clock', async () => {
    const { deps, started } = harness({
      graph: BRACKET_GRAPH,
      steps: bracketSteps(),
      personas: judges,
    })
    await tick(deps)
    const seeded = bracketSeeding(RUN as string, 'judge', [...ATTEMPTED], 4)
    const { matches } = bracketMatches(RUN as string, 'judge', 0, seeded)
    expect(started.find((entry) => String(entry.task).startsWith('better,'))?.task).toBe(
      `better, ${matches[0]?.left} or ${matches[0]?.right}?`,
    )
  })

  it('records the pair on the row, so the journal says which match this was', async () => {
    const { deps, claimStep } = harness({
      graph: BRACKET_GRAPH,
      steps: bracketSteps(),
      personas: judges,
    })
    await tick(deps)
    const claimed = callsOf(claimStep).map((call) => call[0] as { nodeId: string; item: string })
    const match = claimed.find((entry) => entry.nodeId === 'judge')
    expect(match?.item).toContain('⟂')
  })

  /**
   * The vocabulary reaches the Runner as the tool's own enum, so a side that does not exist is a
   * tool error the model can still fix rather than a refusal it never saw.
   */
  it('hands the judge a winner field whose vocabulary is the two sides', async () => {
    const { deps, started } = harness({
      graph: BRACKET_GRAPH,
      steps: bracketSteps(),
      personas: judges,
    })
    await tick(deps)
    const match = started.find((entry) => String(entry.task).startsWith('better,')) as {
      answerWorkflow?: { fields: { name: string; choices?: readonly string[] }[] }
    }
    const winner = match.answerWorkflow?.fields.find((field) => field.name === 'winner')
    expect(winner?.choices).toEqual(['left', 'right'])
    expect(match.answerWorkflow?.fields.map((field) => field.name)).toEqual(['winner', 'why'])
  })

  it('refuses a side outside the vocabulary and says what the two words are', async () => {
    const { deps, recordStepAnswer } = harness({
      graph: BRACKET_GRAPH,
      steps: [step('judge', { status: 'running' })],
      personas: judges,
    })
    const result = await recordWorkflowAnswer(deps, {
      workspaceId: WS,
      agentRunId: asAgentRunId('ar_1'),
      answer: { winner: 'the second one', why: 'it is better' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('left, right')
    expect(recordStepAnswer).not.toHaveBeenCalled()
  })

  it('takes a side that is one of them', async () => {
    const { deps, recordStepAnswer } = harness({
      graph: BRACKET_GRAPH,
      steps: [step('judge', { status: 'running' })],
      personas: judges,
    })
    const result = await recordWorkflowAnswer(deps, {
      workspaceId: WS,
      agentRunId: asAgentRunId('ar_1'),
      answer: { winner: 'right', why: 'it ran' },
    })
    expect(result.ok).toBe(true)
    expect(callsOf(recordStepAnswer)[0]?.[2]).toEqual({ winner: 'right', why: 'it ran' })
  })
})

/**
 * The trial, where an arm becomes a decision to spend.
 *
 * The domain decides which arm is owed; what only this layer can get wrong is what it does with
 * that answer — starting the wrong kind of work, recording an entry that points at nothing, or
 * letting the arm be chosen by whoever is asking.
 */
describe('runTrialTask', () => {
  const HUMAN = userActor(asUserId('u_1'))

  const trialHarness = (used: { workflow: number; planner: number }) => {
    const base = harness({ steps: [], personas: [persona('Scout'), persona('Worker')] })
    const entries: Record<string, unknown>[] = []
    const workflows = base.deps.workflows as unknown as Record<string, unknown>
    workflows.findById = vi.fn(async () => ({
      id: 'wf_1',
      workspaceId: WS,
      name: 'the harness',
      description: null,
      createdByUserId: null,
      createdAt: new Date(0),
      archivedAt: null,
    }))
    workflows.openRun = vi.fn(async () => ({
      id: RUN,
      workspaceId: WS,
      workflowVersionId: VERSION,
      repositoryId: asRepositoryId('repo_1'),
      threadId: asThreadId('t_1'),
      input: 'a task',
      status: 'running' as const,
      capUsd: 5,
      startedByUserId: 'u_1',
      haltReason: null,
      createdAt: new Date(0),
      finishedAt: null,
    }))
    workflows.latestVersion = vi.fn(async () => ({
      id: VERSION,
      workflowId: asWorkflowId('wf_1'),
      version: 1,
      graph: GRAPH,
      digest: 'd',
      createdByUserId: null,
      createdAt: new Date(0),
    }))
    workflows.countTrialArms = vi.fn(async () => used)
    workflows.recordTrialEntry = vi.fn(async (entry: Record<string, unknown>) => {
      entries.push(entry)
    })
    const personas = base.deps.personas as unknown as Record<string, unknown>
    personas.findById = vi.fn(async () => ({ ...persona('Scout'), harnessPlanner: true }))
    const deps = base.deps as unknown as Record<string, unknown>
    deps.personaGroups = { listByWorkspace: vi.fn(async () => []) }
    deps.notes = { listForTree: vi.fn(async () => []), append: vi.fn(async () => ({})) }
    return { ...base, entries }
  }

  const ask = (deps: AgentDeps) =>
    runTrialTask(deps, {
      workspaceId: WS,
      actor: HUMAN,
      workflowId: asWorkflowId('wf_1'),
      repositoryId: asRepositoryId('repo_1'),
      threadId: asThreadId('t_1'),
      input: 'a task of this class',
      capUsd: 5,
      plannerPersonaId: asAgentPersonaId('p_Scout'),
    })

  it('sends the first task of a class to a planner, and records what it started', async () => {
    const { deps, entries, started } = trialHarness({ workflow: 0, planner: 0 })
    const dealt = await ask(deps)
    expect(dealt.arm).toBe('planner')
    expect(started).toHaveLength(1)
    expect(entries[0]?.arm).toBe('planner')
    expect(entries[0]?.agentRunId).toBeDefined()
    expect(entries[0]?.workflowRunId).toBeNull()
    // And the person is told what it is being compared against.
    expect(dealt.detail).toContain('has to beat')
  })

  it('sends the next one through the harness, opening an execution rather than a run', async () => {
    const { deps, entries, started } = trialHarness({ workflow: 0, planner: 1 })
    const dealt = await ask(deps)
    expect(dealt.arm).toBe('workflow')
    expect(entries[0]?.workflowRunId).toBe(RUN)
    expect(entries[0]?.agentRunId).toBeNull()
    // The execution's steps are dealt by the sweep, so nothing is dispatched here.
    expect(started).toHaveLength(0)
  })

  /**
   * The control has to be able to do the work without the shape. One agent against a harness
   * measures something else, and it would favour the harness on every task big enough to split.
   */
  it('refuses a control that cannot delegate', async () => {
    const { deps } = trialHarness({ workflow: 0, planner: 0 })
    const personas = deps.personas as unknown as Record<string, unknown>
    personas.findById = vi.fn(async () => ({ ...persona('Worker'), harnessPlanner: false }))
    await expect(ask(deps)).rejects.toThrow(/cannot delegate/)
  })

  it('refuses to be run by anything but a person', async () => {
    const { deps } = trialHarness({ workflow: 0, planner: 0 })
    await expect(
      runTrialTask(deps, {
        workspaceId: WS,
        actor: systemActor(),
        workflowId: asWorkflowId('wf_1'),
        repositoryId: asRepositoryId('repo_1'),
        threadId: asThreadId('t_1'),
        input: 'a task',
        capUsd: null,
        plannerPersonaId: asAgentPersonaId('p_Scout'),
      }),
    ).rejects.toThrow(/Only a person/)
  })

  it('reports which side the next task will go to, from the counts alone', async () => {
    const { deps } = trialHarness({ workflow: 2, planner: 1 })
    expect(
      await nextTrialArmFor(deps, { workspaceId: WS, workflowId: asWorkflowId('wf_1') }),
    ).toBe('planner')
  })
})
