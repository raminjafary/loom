import type { AgentRun, RunVerification } from '@loom/api-contract'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import InboxView from './InboxView.vue'

/**
 * The review overlay's account of the definition of done.
 *
 * One thing is asserted, and it is the thing that was missing: the tail the Runner stored
 * for the check that failed reaches a human's screen. The card has always named the check;
 * naming it and never showing what it said sends someone to re-run a command the platform
 * has already run.
 */

const run = (overrides: Partial<AgentRun> = {}): AgentRun =>
  ({
    id: 'r1',
    status: 'completed',
    branchName: 'loom/run-1a2b3c4d',
    branchDisposition: null,
    totalCostUsd: 0.1,
    errorMessage: null,
    completedAt: new Date('2026-09-10T00:00:00Z'),
    createdAt: new Date('2026-09-10T00:00:00Z'),
    persona: { name: 'swe' },
    ...overrides,
  }) as AgentRun

const verification = (overrides: Partial<RunVerification> = {}): RunVerification =>
  ({
    id: 'v1',
    agentRunId: 'r1',
    branchName: 'loom/run-1a2b3c4d',
    status: 'failed',
    commitSha: 'abc1234',
    checks: [
      { name: 'build', status: 'passed', detail: 'built in 4s', durationMs: 4_000 },
      { name: 'tests', status: 'failed', detail: 'FAIL src/pay.test.ts\n  2 failed', durationMs: 9_000 },
      { name: 'smoke', status: 'not_run', detail: null, durationMs: null },
    ],
    reason: null,
    ...overrides,
  }) as RunVerification

const mountView = (input: { selected: AgentRun | null; verifications: RunVerification[] }) =>
  mount(InboxView, {
    props: {
      runs: [],
      settled: [run()],
      verifications: input.verifications,
      mergeQueue: [],
      selectedRun: input.selected,
      approvals: [],
      diff: null,
      fetchError: null,
      diffError: null,
      loading: false,
    },
    global: { stubs: { ApprovalCard: true, DiffView: true } },
  })

describe('InboxView', () => {
  it('shows what the failing check printed, not only its name', () => {
    const wrapper = mountView({ selected: run(), verifications: [verification()] })
    expect(wrapper.find('.verification .verdict').text()).toContain('tests')
    expect(wrapper.find('.check-output').text()).toContain('FAIL src/pay.test.ts')
  })

  /** A passing check keeps its tail on the row deliberately; a pass is not a thing to explain. */
  it('says nothing where the verdict is not a failure', () => {
    const wrapper = mountView({
      selected: run(),
      verifications: [
        verification({
          status: 'passed',
          checks: [{ name: 'tests', status: 'passed', detail: 'all good', durationMs: 1 }],
        }),
      ],
    })
    expect(wrapper.find('.verification').exists()).toBe(true)
    expect(wrapper.find('.check-output').exists()).toBe(false)
  })

  /** The board is for comparing lanes; command output belongs to one run at a time. */
  it('keeps the output out of the board when nothing is being reviewed', () => {
    const wrapper = mountView({ selected: null, verifications: [verification()] })
    expect(wrapper.find('.check-output').exists()).toBe(false)
    expect(wrapper.text()).toContain('the tests check failed')
  })
})
