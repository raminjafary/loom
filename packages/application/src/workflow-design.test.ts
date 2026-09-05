import {
  asAgentPersonaId,
  asAgentRunId,
  asRepositoryId,
  asThreadId,
  asWorkflowDesignId,
  asWorkflowId,
  asWorkflowVersionId,
  asWorkspaceId,
  parseWorkflowGraph,
  systemActor,
  userActor,
  asUserId,
  type AgentPersona,
  type AgentRun,
  type WorkflowDesignRecord,
  type WorkflowGraph,
} from '@loom/domain'
import { describe, expect, it, vi } from 'vitest'
import type { AgentDeps } from './agent-use-cases.js'
import {
  approveWorkflowDesign,
  declineWorkflowDesign,
  recordWorkflowDesign,
  startWorkflowDesigner,
} from './workflow-design-use-cases.js'

/**
 * Asking for a harness, and deciding about the one that comes back.
 *
 * The claims this layer is the only place to hold down: that a designer cannot name a persona
 * outside its own envelope, that a name that already exists proposes a *version* rather than a
 * rival, that nothing becomes a version until a person says so, and that two people saying so at
 * once do not write two.
 */

const WS = asWorkspaceId('ws_1')
const DESIGN = asWorkflowDesignId('wd_1')

const persona = (over: Partial<AgentPersona> = {}): AgentPersona =>
  ({
    id: asAgentPersonaId(`p_${over.name ?? 'designer'}`),
    workspaceId: WS,
    name: 'designer',
    description: 'draws harnesses',
    markdownSource: [
      '---',
      `name: ${over.name ?? 'designer'}`,
      'description: Draws harnesses.',
      'model: claude-opus-5',
      '---',
      '',
      'Draw.',
    ].join('\n'),
    model: 'claude-opus-5',
    tools: ['Read', 'Grep', 'Glob'],
    harnessEffort: null,
    harnessMaxTurns: null,
    harnessApprovalMode: 'auto',
    harnessPlanner: true,
    harnessDelegates: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
    harnessBudgetCapUsd: 5,
    envelope: null,
    ...over,
  }) as unknown as AgentPersona

const WORKER = persona({
  name: 'worker',
  harnessPlanner: false,
  harnessDelegates: [],
  tools: ['Read', 'Edit'],
  model: 'claude-sonnet-5',
})

const SHELL_WORKER = persona({
  name: 'shell-worker',
  harnessPlanner: false,
  harnessDelegates: [],
  tools: ['Read', 'Bash'],
  model: 'claude-sonnet-5',
})

const graphNaming = (worker: string): unknown => ({
  nodes: [
    {
      kind: 'step',
      id: 'scope',
      title: 'scope',
      persona: 'designer',
      task: 'scope {{input}}',
      answer: { fields: [{ kind: 'list', name: 'parts' }] },
    },
    {
      kind: 'fan',
      id: 'work',
      title: 'work',
      persona: worker,
      task: 'do {{item}}',
      source: 'scope',
      over: 'parts',
      maxWidth: 3,
      answer: null,
    },
  ],
  edges: [{ from: 'scope', to: 'work' }],
})

const validated = (value: unknown): WorkflowGraph => {
  const verdict = parseWorkflowGraph(value)
  if (!verdict.ok) throw new Error(`bad fixture: ${verdict.reason}`)
  return verdict.graph
}

const designerRun = (over: Partial<AgentRun> = {}): AgentRun =>
  ({
    id: asAgentRunId('ar_designer'),
    workspaceId: WS,
    threadId: asThreadId('t_1'),
    repositoryId: asRepositoryId('repo_1'),
    status: 'running',
    relation: 'design',
    parentRunId: null,
    totalCostUsd: null,
    persona: {
      name: 'designer',
      systemPrompt: '',
      model: 'claude-opus-5',
      tools: ['Read', 'Grep', 'Glob'],
      approvalMode: 'auto',
      budgetCapUsd: 5,
      planner: true,
      delegates: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
    },
    ...over,
  }) as unknown as AgentRun

const design = (over: Partial<WorkflowDesignRecord> = {}): WorkflowDesignRecord => ({
  id: DESIGN,
  workspaceId: WS,
  workflowId: null,
  name: 'a new harness',
  description: null,
  rationale: 'because',
  graph: validated(graphNaming('worker')),
  digest: 'd'.repeat(64),
  status: 'proposed',
  proposedByRunId: asAgentRunId('ar_designer'),
  personaName: 'designer',
  decidedByUserId: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: new Date(0),
  ...over,
})

const harness = (options: {
  personas?: AgentPersona[]
  run?: AgentRun | null
  workflows?: { id: string; name: string }[]
  latestDigest?: string
  designsByRun?: number
  found?: WorkflowDesignRecord | null
  decided?: WorkflowDesignRecord | null
} = {}) => {
  const order: string[] = []
  const proposeDesign = vi.fn(async (input: Record<string, unknown>) => {
    order.push('propose')
    return design({
      workflowId: (input.workflowId as never) ?? null,
      name: input.name as string,
      rationale: input.rationale as string,
      graph: input.graph as WorkflowGraph,
    })
  })
  const decideDesign = vi.fn(async () => {
    order.push('decide')
    return options.decided === undefined ? design({ status: 'approved' }) : options.decided
  })
  const addVersion = vi.fn(async () => {
    order.push('addVersion')
    return {
      id: asWorkflowVersionId('wfv_2'),
      workflowId: asWorkflowId('wf_1'),
      version: 2,
      graph: validated(graphNaming('worker')),
      digest: 'e'.repeat(64),
      createdByUserId: null,
      createdAt: new Date(0),
    }
  })
  const create = vi.fn(async () => {
    order.push('create')
    return {
      workflow: {
        id: asWorkflowId('wf_new'),
        workspaceId: WS,
        name: 'a new harness',
        description: null,
        createdByUserId: null,
        createdAt: new Date(0),
        archivedAt: null,
      },
      version: {
        id: asWorkflowVersionId('wfv_1'),
        workflowId: asWorkflowId('wf_new'),
        version: 1,
        graph: validated(graphNaming('worker')),
        digest: 'f'.repeat(64),
        createdByUserId: null,
        createdAt: new Date(0),
      },
    }
  })
  const started: Record<string, unknown>[] = []

  const deps = {
    limits: { maxConcurrentRunsPerWorkspace: 6, maxDelegationDepth: 2 },
    audit: { record: vi.fn(async () => ({})) },
    messages: { append: vi.fn(async () => ({ id: 'm1' })) },
    events: { publish: vi.fn(async () => {}) },
    runControl: { get: vi.fn(async () => ({ paused: false })) },
    threads: { findById: vi.fn(async () => ({ id: asThreadId('t_1'), workspaceId: WS })) },
    capabilities: { listByPersona: vi.fn(async () => []), findById: vi.fn(async () => null) },
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
      findById: vi.fn(async () => ({ id: 'runner_1', workspaceId: WS, connected: true })),
    },
    personaGroups: { listByWorkspace: vi.fn(async () => []) },
    notes: { listForTree: vi.fn(async () => []), append: vi.fn(async () => ({})) },
    personas: {
      listByWorkspace: vi.fn(async () => options.personas ?? [persona(), WORKER]),
      findById: vi.fn(async (_ws: unknown, id: string) =>
        (options.personas ?? [persona(), WORKER]).find((entry) => entry.id === id) ?? null,
      ),
    },
    agentRuns: {
      findById: vi.fn(async () => (options.run === undefined ? designerRun() : options.run)),
      listActiveByWorkspace: vi.fn(async () => []),
      create: vi.fn(async () => designerRun({ id: asAgentRunId('ar_new') })),
      updateStatus: vi.fn(async () => designerRun()),
    },
    workflows: {
      listWorkflows: vi.fn(async () => options.workflows ?? []),
      latestVersion: vi.fn(async () => ({
        id: asWorkflowVersionId('wfv_1'),
        workflowId: asWorkflowId('wf_1'),
        version: 1,
        graph: validated(graphNaming('worker')),
        digest: options.latestDigest ?? 'aaaa',
        createdByUserId: null,
        createdAt: new Date(0),
      })),
      countDesignsByRun: vi.fn(async () => options.designsByRun ?? 0),
      proposeDesign,
      findDesign: vi.fn(async () => (options.found === undefined ? design() : options.found)),
      decideDesign,
      addVersion,
      create,
    },
    dispatch: { startRun: vi.fn(async (input: Record<string, unknown>) => void started.push(input)) },
  } as unknown as AgentDeps

  return { deps, proposeDesign, decideDesign, addVersion, create, started, order }
}

const submit = (deps: AgentDeps, over: Record<string, unknown> = {}) =>
  recordWorkflowDesign(deps, {
    workspaceId: WS,
    agentRunId: asAgentRunId('ar_designer'),
    name: 'a new harness',
    description: null,
    rationale: 'it splits the work so a reviewer never grades its own change',
    graph: graphNaming('worker'),
    ...over,
  })

describe('recordWorkflowDesign', () => {
  it('records a shape as a proposal, naming what a person will read beside it', async () => {
    const { deps, proposeDesign } = harness()
    const result = await submit(deps)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.outcome).toContain('Nothing runs until a person approves')
    const written = proposeDesign.mock.calls[0]?.[0] as { workflowId: string | null }
    expect(written.workflowId).toBeNull()
  })

  it('refuses a run that was not started as a designer', async () => {
    const { deps, proposeDesign } = harness({ run: designerRun({ relation: 'delegation' }) })
    const result = await submit(deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('not started as a designer')
    expect(proposeDesign).not.toHaveBeenCalled()
  })

  it('hands back the validator’s own words rather than a second opinion', async () => {
    const { deps } = harness()
    const result = await submit(deps, {
      graph: {
        nodes: [
          {
            kind: 'step',
            id: 'scope',
            title: 'scope',
            persona: 'designer',
            task: 'scope',
            answer: { fields: [{ kind: 'text', name: 'parts' }] },
          },
          {
            kind: 'fan',
            id: 'work',
            title: 'work',
            persona: 'worker',
            task: 'do {{item}}',
            source: 'scope',
            over: 'parts',
            maxWidth: 3,
            answer: null,
          },
        ],
        edges: [{ from: 'scope', to: 'work' }],
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('not a list')
  })

  /**
   * The claim the whole shape rests on: a designer that holds no shell and may not hand one
   * down cannot mint a harness whose every lane has one, however a person feels about the
   * diagram afterwards.
   */
  it('refuses a shape naming a persona outside the designing run’s envelope', async () => {
    const { deps, proposeDesign } = harness({ personas: [persona(), SHELL_WORKER] })
    const result = await submit(deps, { graph: graphNaming('shell-worker') })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Bash')
      expect(result.error).toContain('"work"')
    }
    expect(proposeDesign).not.toHaveBeenCalled()
  })

  /**
   * The envelope is the *run's* snapshot. A persona widened while the designer was thinking
   * must not widen what that session may name — the rule every child start already applies.
   */
  it('reads the envelope from the run and not from the persona row it was started with', async () => {
    const { deps } = harness({
      personas: [persona({ harnessDelegates: ['Read', 'Bash'] }), SHELL_WORKER],
      run: designerRun(),
    })
    const result = await submit(deps, { graph: graphNaming('shell-worker') })
    expect(result.ok).toBe(false)
  })

  it('proposes a new version when the name is one this workspace already has', async () => {
    const { deps, proposeDesign } = harness({ workflows: [{ id: 'wf_1', name: 'a new harness' }] })
    const result = await submit(deps)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.outcome).toContain('next version')
    const written = proposeDesign.mock.calls[0]?.[0] as { workflowId: string | null }
    expect(written.workflowId).toBe('wf_1')
  })

  it('refuses a shape identical to the version already in use', async () => {
    const digest = 'the-digest'
    const { deps, proposeDesign } = harness({
      workflows: [{ id: 'wf_1', name: 'a new harness' }],
      latestDigest: digest,
    })
    // The digest the use case will compute for this graph, from the same function it uses.
    const { workflowDigest } = await import('./workflow-use-cases.js')
    const same = harness({
      workflows: [{ id: 'wf_1', name: 'a new harness' }],
      latestDigest: workflowDigest(validated(graphNaming('worker'))),
    })
    const result = await submit(same.deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('already has, node for node')
    expect(same.proposeDesign).not.toHaveBeenCalled()
    // And the same graph against a different digest is proposed rather than refused.
    expect((await submit(deps)).ok).toBe(true)
    expect(proposeDesign).toHaveBeenCalled()
  })

  it('refuses a fourth proposal from one session', async () => {
    const { deps, proposeDesign } = harness({ designsByRun: 3 })
    const result = await submit(deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('limit')
    expect(proposeDesign).not.toHaveBeenCalled()
  })

  it('refuses a proposal with no case made for it', async () => {
    const { deps } = harness()
    const result = await submit(deps, { rationale: '   ' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('nothing to decide on')
  })
})

describe('approveWorkflowDesign', () => {
  const user = userActor(asUserId('u_1'))

  it('is what writes the version, and writes it as a new version of the named harness', async () => {
    const { deps, addVersion, order } = harness({
      found: design({ workflowId: asWorkflowId('wf_1') }),
      workflows: [{ id: 'wf_1', name: 'a new harness' }],
    })
    const approved = await approveWorkflowDesign(deps, {
      workspaceId: WS,
      actor: user,
      designId: DESIGN,
    })
    expect(approved.version.version).toBe(2)
    expect(addVersion).toHaveBeenCalled()
    // Claimed before it is written: two people clicking at once must not write two versions.
    expect(order).toEqual(['decide', 'addVersion'])
  })

  it('creates the harness when the proposal was for one this workspace lacked', async () => {
    const { deps, create } = harness({ found: design({ workflowId: null }) })
    const approved = await approveWorkflowDesign(deps, {
      workspaceId: WS,
      actor: user,
      designId: DESIGN,
    })
    expect(create).toHaveBeenCalled()
    expect(approved.detail).toContain('version 1')
  })

  it('tells the second of two clicks that somebody else decided it', async () => {
    const { deps, addVersion } = harness({ decided: null })
    await expect(
      approveWorkflowDesign(deps, { workspaceId: WS, actor: user, designId: DESIGN }),
    ).rejects.toThrow(/just now/)
    expect(addVersion).not.toHaveBeenCalled()
  })

  it('refuses one already decided rather than writing a second version of it', async () => {
    const { deps, decideDesign } = harness({ found: design({ status: 'declined' }) })
    await expect(
      approveWorkflowDesign(deps, { workspaceId: WS, actor: user, designId: DESIGN }),
    ).rejects.toThrow(/already declined/)
    expect(decideDesign).not.toHaveBeenCalled()
  })

  /**
   * Re-validated at approval for the reason an execution re-validates at start: a persona the
   * shape names can have left in the meantime, and a version whose fourth step nobody can deal
   * is worse than a refusal a person can read.
   */
  it('refuses a shape whose persona has left the workspace since it was drawn', async () => {
    const { deps, decideDesign } = harness({ personas: [persona()] })
    await expect(
      approveWorkflowDesign(deps, { workspaceId: WS, actor: user, designId: DESIGN }),
    ).rejects.toThrow(/no longer runnable/)
    expect(decideDesign).not.toHaveBeenCalled()
  })

  it('refuses to be approved by anything but a person', async () => {
    const { deps } = harness()
    await expect(
      approveWorkflowDesign(deps, { workspaceId: WS, actor: systemActor(), designId: DESIGN }),
    ).rejects.toThrow(/Only a person/)
  })
})

describe('declineWorkflowDesign', () => {
  it('keeps what the person said, which is the record a later designer is shown', async () => {
    const { deps, decideDesign } = harness({ decided: design({ status: 'declined' }) })
    await declineWorkflowDesign(deps, {
      workspaceId: WS,
      actor: userActor(asUserId('u_1')),
      designId: DESIGN,
      note: 'three barriers where one plain edge would do',
    })
    const written = (decideDesign.mock.calls as unknown as unknown[][])[0]?.[2] as {
      status: string
      note: string
    }
    expect(written.status).toBe('declined')
    expect(written.note).toContain('plain edge')
  })
})

describe('startWorkflowDesigner', () => {
  it('starts a parentless run carrying the design relation and the ask', async () => {
    const { deps, started } = harness()
    const result = await startWorkflowDesigner(deps, {
      workspaceId: WS,
      actor: userActor(asUserId('u_1')),
      personaId: asAgentPersonaId('p_designer'),
      threadId: asThreadId('t_1'),
      repositoryId: asRepositoryId('repo_1'),
      ask: 'something for triaging flaky tests',
    })
    expect(result.run.relation).toBe('design')
    const frame = started[0] as { designWorkflow?: { ask: string }; task?: string }
    expect(frame.designWorkflow?.ask).toBe('something for triaging flaky tests')
    // The brief is dispatched as the task: what a designer is told is the whole mechanism.
    expect(frame.task).toContain('something for triaging flaky tests')
    expect(frame.task).toContain('THE PERSONAS YOU MAY NAME')
  })

  it('names in the brief which personas are out of reach, and why', async () => {
    const { deps, started } = harness({ personas: [persona(), SHELL_WORKER] })
    await startWorkflowDesigner(deps, {
      workspaceId: WS,
      actor: userActor(asUserId('u_1')),
      personaId: asAgentPersonaId('p_designer'),
      threadId: asThreadId('t_1'),
      repositoryId: asRepositoryId('repo_1'),
      ask: 'draw me something',
    })
    const frame = started[0] as { task?: string }
    expect(frame.task).toContain('may NOT name')
    expect(frame.task).toContain('shell-worker')
  })

  it('will not be asked by anything but a person', async () => {
    const { deps } = harness()
    await expect(
      startWorkflowDesigner(deps, {
        workspaceId: WS,
        actor: systemActor(),
        personaId: asAgentPersonaId('p_designer'),
        threadId: asThreadId('t_1'),
        repositoryId: asRepositoryId('repo_1'),
        ask: 'draw me something',
      }),
    ).rejects.toThrow(/Only a person/)
  })
})
