import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type {
  WorkflowDetail,
  WorkflowRow,
  WorkflowRunDetail,
  WorkflowRunRow,
} from '@loom/client-core'
import WorkflowPanel from './WorkflowPanel.vue'

/**
 * The panel.
 *
 * What is asserted is the three things this surface has to say that a list of rows would not:
 * what the shape may cost before it runs, where the work waits, and which lane a step is in.
 */

const graph = {
  nodes: [
    { kind: 'step', id: 'discover', title: 'Find the sites', persona: 'scout' },
    {
      kind: 'fan',
      id: 'transform',
      title: 'Change each',
      persona: 'hand',
      source: 'discover',
      over: 'sites',
      maxWidth: 3,
    },
    { kind: 'step', id: 'lint', title: 'Lint', persona: 'hand' },
    { kind: 'barrier', id: 'swept', title: 'Every site done' },
    { kind: 'step', id: 'report', title: 'Report', persona: 'scout' },
  ],
  edges: [
    { from: 'discover', to: 'transform' },
    { from: 'discover', to: 'lint' },
    { from: 'transform', to: 'swept' },
    { from: 'lint', to: 'swept' },
    { from: 'swept', to: 'report' },
  ],
}

const row: WorkflowRow = {
  id: 'wf1',
  name: 'migration sweep',
  description: 'find every site, change each',
  createdAt: new Date(0),
  version: 2,
  digest: 'a'.repeat(64),
}

const detail: WorkflowDetail = {
  ...row,
  graph,
  detail: '4 step(s) in 4 stage(s)\n- "transform" runs once per item of discover.sites, up to 3 times.',
}

const runRow: WorkflowRunRow = {
  id: 'wfr1',
  input: 'rename the old helper',
  status: 'running',
  capUsd: 5,
  haltReason: null,
  createdAt: new Date(0),
  finishedAt: null,
}

const runDetail: WorkflowRunDetail = {
  ...runRow,
  workflowName: 'migration sweep',
  version: 2,
  spentUsd: 0.6,
  graph,
  steps: [
    {
      id: 'st1',
      nodeId: 'discover',
      pass: 0,
      itemIndex: 0,
      item: null,
      status: 'answered',
      agentRunId: 'run-a',
      reason: null,
      costUsd: 0.4,
      finishedAt: new Date(0),
    },
    {
      id: 'st2',
      nodeId: 'transform',
      pass: 0,
      itemIndex: 0,
      item: 'src/one.ts',
      status: 'running',
      agentRunId: 'run-b',
      reason: null,
      costUsd: null,
      finishedAt: null,
    },
    {
      id: 'st3',
      nodeId: 'transform',
      pass: 0,
      itemIndex: 1,
      item: 'src/two.ts',
      status: 'refused',
      agentRunId: 'run-c',
      reason: 'the run ended without submitting an answer',
      costUsd: 0.2,
      finishedAt: new Date(0),
    },
  ],
}

const trialReport = {
  nextArm: 'planner' as const,
  verdict: 'undecided' as const,
  detail: 'Still measuring: 1 decided task(s) run through the harness against 0 given to a planner.',
  arms: [
    {
      arm: 'workflow' as const,
      tasks: 2,
      decided: 1,
      merged: 1,
      discarded: 0,
      failed: 0,
      verificationFailed: 0,
      failingCheck: null,
      successRate: 1,
      meanCostUsd: 1.2345,
      meanRuns: 6,
    },
    {
      arm: 'planner' as const,
      tasks: 1,
      decided: 0,
      merged: 0,
      discarded: 0,
      failed: 0,
      verificationFailed: 0,
      failingCheck: null,
      successRate: 0,
      meanCostUsd: 0,
      meanRuns: 0,
    },
  ],
}

const panel = (over: Partial<Record<string, unknown>> = {}) =>
  mount(WorkflowPanel, {
    props: {
      workflows: [row],
      repositories: [{ id: 'repo1', displayName: 'loom' }],
      threadId: 'thread1',
      read: vi.fn(async () => detail),
      listRuns: vi.fn(async () => [runRow]),
      readRun: vi.fn(async () => runDetail),
      start: vi.fn(async () => ({ runId: 'wfr2', detail: 'started' })),
      cancel: vi.fn(async () => ({ cancelled: true, detail: 'stopped' })),
      personas: [{ id: 'p1', name: 'workflow-designer' }],
      proposals: [],
      design: vi.fn(async () => ({ runId: 'ar1', detail: 'drawing' })),
      approveDesign: vi.fn(async () => ({ versionId: 'v2', version: 2, detail: 'drawn as v2' })),
      declineDesign: vi.fn(async () => ({ declined: true, detail: 'declined' })),
      readTrial: vi.fn(async () => trialReport),
      runTrialTask: vi.fn(async () => ({
        arm: 'planner' as const,
        runId: 'ar-planner',
        detail: 'This one goes to planner and whatever it delegates to, with no harness',
      })),
      ...over,
    },
  })

const settle = async (wrapper: ReturnType<typeof panel>) => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

describe('WorkflowPanel', () => {
  it('says what the shape may cost before offering to run it', async () => {
    const wrapper = panel()
    await settle(wrapper)
    const ceiling = wrapper.find('.ceiling').text()
    expect(ceiling).toContain('up to 3 times')
    // And the ceiling is above the form that spends it, not below. Scoped to that form: the
    // panel has a second one — asking a designer for a harness — and it spends nothing.
    expect(wrapper.html().indexOf('ceiling')).toBeLessThan(wrapper.html().indexOf('class="start"'))
  })

  /** The distinction a script hides: waiting for every branch, versus not waiting. */
  it('draws a barrier as a bar and an ordinary step as a box', async () => {
    const wrapper = panel()
    await settle(wrapper)
    const barrier = wrapper.find('g.node.barrier rect')
    const step = wrapper.find('g.node.step rect')
    expect(Number(barrier.attributes('height'))).toBeLessThan(Number(step.attributes('height')))
    // And it says so in words for anyone who does not read the drawing.
    expect(wrapper.find('figcaption').text()).toContain('barrier')
  })

  it('names the persona each step runs, so a reader can see who does what', async () => {
    const wrapper = panel()
    await settle(wrapper)
    expect(wrapper.find('svg').text()).toContain('scout')
  })

  it('refuses to draw nothing for a shape it only partly recognizes', async () => {
    const wrapper = panel({
      read: vi.fn(async () => ({ ...detail, graph: { nodes: [{ id: 'x' }], edges: [] } })),
    })
    await settle(wrapper)
    expect(wrapper.findAll('g.node')).toHaveLength(1)
  })

  describe('with an execution open', () => {
    const opened = async () => {
      const wrapper = panel()
      await settle(wrapper)
      await wrapper.find('.runs .open').trigger('click')
      await settle(wrapper)
      return wrapper
    }

    it('shows what it has spent against the cap it was given', async () => {
      const wrapper = await opened()
      expect(wrapper.find('.spent').text()).toContain('$0.60')
      expect(wrapper.find('.spent').text()).toContain('$5.00')
    })

    it('identifies a lane by the item it is working on, not only by its index', async () => {
      const wrapper = await opened()
      expect(wrapper.find('.steps').text()).toContain('src/two.ts')
    })

    it('gives a refused step its reason rather than only the word', async () => {
      const wrapper = await opened()
      expect(wrapper.find('.steps').text()).toContain('without submitting an answer')
    })

    it('offers a way into the run a step was dealt to', async () => {
      const wrapper = await opened()
      await wrapper.findAll('.steps .link')[0]!.trigger('click')
      expect(wrapper.emitted('open')?.[0]).toEqual(['run-a'])
    })

    /**
     * A fan mid-flight has lanes that disagree, and either single word for it would be a lie in
     * a different direction.
     */
    it('marks a node whose lanes disagree as neither answered nor refused', async () => {
      const wrapper = await opened()
      expect(wrapper.find('g.node.fan').classes()).toContain('running')
    })
  })

  /**
   * A bracket's rows are matches over rounds, and "6 lanes" is the reading a person cannot act
   * on: what they want to know is how far the tournament has got.
   */
  describe('with a tournament in the shape', () => {
    const bracketGraph = {
      nodes: [
        {
          kind: 'fan',
          id: 'attempt',
          title: 'Attempt each',
          persona: 'hand',
          source: 'approaches',
          over: 'approaches',
          maxWidth: 4,
        },
        {
          kind: 'bracket',
          id: 'judge',
          title: 'Judge two at a time',
          persona: 'checker',
          entrants: 'attempt',
          over: 'result',
          maxEntrants: 4,
        },
      ],
      edges: [{ from: 'attempt', to: 'judge' }],
    }
    const match = (pass: number, itemIndex: number, id: string) => ({
      id,
      nodeId: 'judge',
      pass,
      itemIndex,
      item: 'one attempt ⟂ another',
      status: 'answered' as const,
      agentRunId: `run-${id}`,
      reason: null,
      costUsd: 0.1,
      finishedAt: new Date(0),
    })

    const opened = async () => {
      const wrapper = panel({
        read: vi.fn(async () => ({ ...detail, graph: bracketGraph })),
        readRun: vi.fn(async () => ({
          ...runDetail,
          graph: bracketGraph,
          steps: [match(0, 0, 'm1'), match(0, 1, 'm2'), match(1, 0, 'm3')],
        })),
      })
      await settle(wrapper)
      await wrapper.find('.runs .open').trigger('click')
      await settle(wrapper)
      return wrapper
    }

    it('says how many entrants may come forward before it is run', async () => {
      const wrapper = panel({ read: vi.fn(async () => ({ ...detail, graph: bracketGraph })) })
      await settle(wrapper)
      expect(wrapper.find('svg').text()).toContain('up to 4 entrants')
      expect(wrapper.find('svg').text()).toContain('two at a time')
    })

    it('counts matches and rounds rather than lanes', async () => {
      const wrapper = await opened()
      expect(wrapper.find('g.node.bracket').text()).toContain('3 match(es) in 2 round(s)')
    })
  })

  /**
   * The panel has no editor, deliberately — so what stands in for one is this: a person asks,
   * an agent draws, and what comes back is a *drawing* beside its ceiling rather than JSON in a
   * review queue.
   */
  describe('the designer, which stands in for the editor', () => {
    const proposal = {
      id: 'wd1',
      workflowId: null,
      name: 'flaky test triage',
      description: 'when a test fails twice a week',
      rationale: 'one run cannot tell a flake from a break; two lanes can',
      graph,
      digest: 'b'.repeat(64),
      status: 'proposed' as const,
      proposedByRunId: 'ar-designer',
      personaName: 'workflow-designer',
      shape: 'discover → transform(×3) → [swept] → report',
      detail: '4 step(s) in 4 stage(s)\nWorst case is $2.00 if every step spends its cap.',
      decidedAt: null,
      decisionNote: null,
      createdAt: new Date(0),
    }

    it('asks the designer for one, in the thread the person is looking at', async () => {
      const design = vi.fn(async () => ({ runId: 'ar1', detail: 'workflow-designer is drawing.' }))
      const wrapper = panel({ design })
      await settle(wrapper)
      await wrapper.find('form.designer textarea').setValue('something for flaky tests')
      await wrapper.find('form.designer').trigger('submit')
      await settle(wrapper)
      expect(design).toHaveBeenCalledWith({
        personaId: 'p1',
        repositoryId: 'repo1',
        threadId: 'thread1',
        ask: 'something for flaky tests',
      })
      expect(wrapper.find('.notice').text()).toContain('drawing')
    })

    it('will not ask with nowhere for the run to render', async () => {
      const wrapper = panel({ threadId: null })
      await settle(wrapper)
      await wrapper.find('form.designer textarea').setValue('draw me something')
      expect(
        wrapper.find('form.designer button[type="submit"]').attributes('disabled'),
      ).toBeDefined()
    })

    /** A JSON graph in a review queue is a decision nobody can make. */
    it('draws a proposal as a shape, with the ceiling it would spend', async () => {
      const wrapper = panel({ proposals: [proposal] })
      await settle(wrapper)
      await wrapper.findAll('.proposals .pick')[0]!.trigger('click')
      await settle(wrapper)
      expect(wrapper.findAll('figure.canvas').length).toBeGreaterThan(1)
      expect(wrapper.text()).toContain('Worst case is $2.00')
      expect(wrapper.text()).toContain('one run cannot tell a flake from a break')
      // And who drew it, since the envelope it was attenuated against was that persona's.
      expect(wrapper.text()).toContain('workflow-designer')
    })

    it('says whether approving would make a new harness or the next version of one', async () => {
      const wrapper = panel({
        proposals: [proposal, { ...proposal, id: 'wd2', workflowId: 'wf1', name: 'code review' }],
      })
      await settle(wrapper)
      const labels = wrapper.findAll('.proposals .version').map((node) => node.text())
      expect(labels[0]).toContain('new')
      expect(labels[1]).toContain('next version')
    })

    it('approves through the callback and refreshes, since a version now exists', async () => {
      const approveDesign = vi.fn(async () => ({
        versionId: 'v1',
        version: 1,
        detail: 'Drawn as version 1 of "flaky test triage".',
      }))
      const wrapper = panel({ proposals: [proposal], approveDesign })
      await settle(wrapper)
      await wrapper.findAll('.proposals .pick')[0]!.trigger('click')
      await settle(wrapper)
      await wrapper.findAll('.decide button')[0]!.trigger('click')
      await settle(wrapper)
      expect(approveDesign).toHaveBeenCalledWith('wd1')
      expect(wrapper.emitted('refresh')).toBeTruthy()
      expect(wrapper.find('.notice').text()).toContain('version 1')
    })

    it('carries the reason with a decline, which is what a later designer is shown', async () => {
      const declineDesign = vi.fn(async () => ({ declined: true, detail: 'declined' }))
      const wrapper = panel({ proposals: [proposal], declineDesign })
      await settle(wrapper)
      await wrapper.findAll('.proposals .pick')[0]!.trigger('click')
      await settle(wrapper)
      await wrapper.find('.decide input').setValue('three barriers where one edge would do')
      await wrapper.findAll('.decide button')[1]!.trigger('click')
      await settle(wrapper)
      expect(declineDesign).toHaveBeenCalledWith({
        designId: 'wd1',
        note: 'three barriers where one edge would do',
      })
    })

    it('offers no decision on one already decided', async () => {
      const wrapper = panel({
        proposals: [{ ...proposal, status: 'declined' as const, decisionNote: 'too wide' }],
      })
      await settle(wrapper)
      await wrapper.findAll('.proposals .pick')[0]!.trigger('click')
      await settle(wrapper)
      expect(wrapper.find('.decide').exists()).toBe(false)
      expect(wrapper.text()).toContain('too wide')
    })
  })

  /**
   * The verdict lives beside the button that spends money on the harness, because the claim it
   * has to survive is exactly the one a person is making when they press it.
   */
  describe('the trial the shape has to survive', () => {
    it('shows the verdict and both arms in tasks rather than runs', async () => {
      const wrapper = panel()
      await settle(wrapper)
      expect(wrapper.find('.verdict').text()).toContain('Still measuring')
      const rows = wrapper.findAll('.arms tbody tr').map((row) => row.text())
      expect(rows[0]).toContain('this harness')
      expect(rows[0]).toContain('1 of 2')
      expect(rows[0]).toContain('6.0')
      expect(rows[1]).toContain('a planner')
    })

    it('says which side the next task goes to before the person presses', async () => {
      const wrapper = panel()
      await settle(wrapper)
      expect(wrapper.find('form.trial .hint').text()).toContain('a planner')
      expect(wrapper.find('form.trial .hint').text()).toContain('do not get to choose')
    })

    it('runs the next task without letting the person pick the arm', async () => {
      const runTrialTask = vi.fn(async () => ({
        arm: 'workflow' as const,
        runId: 'wfr9',
        detail: 'This one goes through "migration sweep"',
      }))
      const wrapper = panel({ runTrialTask })
      await settle(wrapper)
      await wrapper.find('form.trial textarea').setValue('the next flaky test')
      await wrapper.find('form.trial').trigger('submit')
      await settle(wrapper)
      const sent = (runTrialTask.mock.calls as unknown as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >
      expect(sent.workflowId).toBe('wf1')
      expect(sent.input).toBe('the next flaky test')
      expect(Object.keys(sent)).not.toContain('arm')
      expect(wrapper.find('.notice').text()).toContain('goes through')
    })
  })

  it('will not start an execution with nowhere for its steps to render', async () => {
    const wrapper = panel({ threadId: null })
    await settle(wrapper)
    await wrapper.find('form.start textarea').setValue('do the thing')
    expect(wrapper.find('form.start button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  it('starts one on the thread the person is looking at, and shows what it says', async () => {
    const start = vi.fn(async () => ({ runId: 'wfr2', detail: 'Started: 4 steps in 4 stages.' }))
    const wrapper = panel({ start })
    await settle(wrapper)
    await wrapper.find('form.start textarea').setValue('rename the old helper')
    await wrapper.find('form.start').trigger('submit')
    await settle(wrapper)
    expect(start).toHaveBeenCalledWith({
      workflowId: 'wf1',
      repositoryId: 'repo1',
      threadId: 'thread1',
      input: 'rename the old helper',
      capUsd: 5,
    })
    expect(wrapper.find('.notice').text()).toContain('Started')
  })

  it('says what a workspace with no workflows is missing rather than showing an empty box', () => {
    const wrapper = panel({ workflows: [] })
    expect(wrapper.find('.empty').text()).toContain('harness for a task class')
  })
})
