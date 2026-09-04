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
    // And the ceiling is above the button that spends it, not below.
    expect(wrapper.html().indexOf('ceiling')).toBeLessThan(wrapper.html().indexOf('type="submit"'))
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

  it('will not start an execution with nowhere for its steps to render', async () => {
    const wrapper = panel({ threadId: null })
    await settle(wrapper)
    await wrapper.find('textarea').setValue('do the thing')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  it('starts one on the thread the person is looking at, and shows what it says', async () => {
    const start = vi.fn(async () => ({ runId: 'wfr2', detail: 'Started: 4 steps in 4 stages.' }))
    const wrapper = panel({ start })
    await settle(wrapper)
    await wrapper.find('textarea').setValue('rename the old helper')
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
