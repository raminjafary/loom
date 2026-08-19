import type { PlanReview } from '@loom/api-contract'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PlanReviewPanel from './PlanReviewPanel.vue'

/**
 * The plan gate.
 *
 * What is asserted is the three things this surface has to do that a list of titles would
 * not: show the orchestration as stages, offer three acts rather than two, and refuse a
 * change request with no words in it.
 */

const subtask = (over: Partial<PlanReview['subtasks'][number]>): PlanReview['subtasks'][number] => ({
  id: `s${over.position ?? 0}`,
  position: 0,
  title: 'Docs',
  task: 'Write the docs.',
  personaName: 'swe',
  paths: [],
  dependsOn: [],
  reviews: null,
  repository: null,
  status: 'waiting',
  agentRunId: null,
  detail: null,
  ...over,
})

const review = (over: Partial<PlanReview> = {}): PlanReview => ({
  plannerRunId: 'run1',
  plannerName: 'planner',
  awaitingReview: true,
  subtasks: [
    subtask({ position: 0, title: 'Write it', personaName: 'swe' }),
    subtask({ position: 1, title: 'Test it', personaName: 'qa', dependsOn: [0], reviews: 0 }),
  ],
  ...over,
})

describe('PlanReviewPanel', () => {
  /** The shape is what is being approved — a flat list hides how much runs at once. */
  it('draws the plan as stages, not as a list', () => {
    const wrapper = mount(PlanReviewPanel, { props: { review: review() } })
    const stages = wrapper.findAll('.stages > li')
    expect(stages).toHaveLength(2)
    expect(stages[0]?.text()).toContain('Write it')
    expect(stages[1]?.text()).toContain('Test it')
    // And a review edge reads as a review, not as "waits for".
    expect(stages[1]?.text()).toContain('reviews')
  })

  it('says nothing has started, and how much there is', () => {
    const wrapper = mount(PlanReviewPanel, { props: { review: review() } })
    expect(wrapper.text()).toContain('Nothing has started')
    expect(wrapper.text()).toContain('2 subtask(s)')
  })

  /**
   * Three acts because they cost different things: accepting spends the plan, asking for
   * changes spends another planning turn, rejecting spends nothing.
   */
  it('offers accept, ask-for-changes and reject as separate acts', () => {
    const wrapper = mount(PlanReviewPanel, { props: { review: review() } })
    const labels = wrapper.findAll('button').map((button) => button.text())
    expect(labels.some((label) => label.includes('Accept'))).toBe(true)
    expect(labels.some((label) => label.includes('Ask for changes'))).toBe(true)
    expect(labels.some((label) => label.includes('Reject'))).toBe(true)
  })

  /** The note is the planner's next instruction verbatim, so an empty one is a guess. */
  it('will not ask for changes with no words', async () => {
    const wrapper = mount(PlanReviewPanel, { props: { review: review() } })
    const changes = wrapper
      .findAll('button')
      .find((button) => button.text().includes('Ask for changes'))
    expect(changes?.attributes('disabled')).toBeDefined()

    await wrapper.find('textarea').setValue('Split the docs subtask by area.')
    await changes?.trigger('click')
    expect(wrapper.emitted('requestChanges')?.[0]).toEqual([
      { agentRunId: 'run1', note: 'Split the docs subtask by area.' },
    ])
  })

  it('rejects with the same box, and without needing it filled', async () => {
    const wrapper = mount(PlanReviewPanel, { props: { review: review() } })
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Reject'))
      ?.trigger('click')
    expect(wrapper.emitted('reject')?.[0]).toEqual([{ agentRunId: 'run1' }])
  })

  /** A plan already running is steered, not re-decided — so the acts are gone. */
  it('offers no decision once the plan has started', () => {
    const wrapper = mount(PlanReviewPanel, {
      props: { review: review({ awaitingReview: false }) },
    })
    expect(wrapper.text()).toContain('Steer it rather than re-deciding it')
    expect(wrapper.findAll('textarea')).toHaveLength(0)
  })

  it('renders nothing when there is no plan', () => {
    expect(mount(PlanReviewPanel, { props: { review: null } }).text()).toBe('')
  })
})
