import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import PersonaDivergencePanel from './PersonaDivergencePanel.vue'

/**
 * Where a persona's humans and its repository's checks disagree.
 *
 * The discipline this panel has to keep is the domain's: a disagreement is not a mistake by
 * either side, so nothing here may read as a score. The rest is about not misleading with the
 * arithmetic — a bounded list under unbounded counts, and a denominator that is comparable
 * runs rather than decided ones.
 */
const report = {
  detail:
    '3 of 40 comparable runs were ruled on twice and differently: 2 passed and were discarded, 1 failed and was merged.',
  passedAndDiscarded: 2,
  failedAndMerged: 1,
  comparable: 40,
  runs: [
    {
      runId: 'r1',
      task: 'tighten the refund path',
      kind: 'failed-and-merged' as const,
      failingCheck: 'tests',
      decidedAt: new Date('2026-09-09T00:00:00Z'),
    },
    {
      runId: 'r2',
      task: 'rename the money helpers',
      kind: 'passed-and-discarded' as const,
      failingCheck: null,
      decidedAt: new Date('2026-09-08T00:00:00Z'),
    },
  ],
}

const settle = async (wrapper: { vm: { $nextTick: () => Promise<void> } }) => {
  await Promise.resolve()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

const panel = (over: Record<string, unknown> = {}) =>
  mount(PersonaDivergencePanel, {
    props: {
      personas: [{ id: 'p1', name: 'swe' }],
      read: vi.fn(async () => report),
      open: vi.fn(),
      ...over,
    },
  })

describe('PersonaDivergencePanel', () => {
  it('reads nothing until an agent is chosen', () => {
    const read = vi.fn(async () => report)
    panel({ read })
    expect(read).not.toHaveBeenCalled()
  })

  it('renders the domain’s sentence unedited', async () => {
    const wrapper = panel()
    await wrapper.get('select').setValue('p1')
    await settle(wrapper)
    expect(wrapper.text()).toContain(report.detail)
  })

  /** Both directions are shown, and neither is marked as the wrong one. */
  it('distinguishes the two directions without grading either', async () => {
    const wrapper = panel()
    await wrapper.get('select').setValue('p1')
    await settle(wrapper)

    expect(wrapper.text()).toContain('failed, merged')
    expect(wrapper.text()).toContain('passed, discarded')
    // Scoped to the rows: the lead paragraph legitimately says a disagreement is *not* a
    // mistake, and a pattern over the whole panel matches the promise rather than a breach.
    const rows = wrapper.findAll('button.run').map((row) => row.text()).join(' ')
    expect(rows).not.toMatch(/mistake|wrong|should have|error|violation|failure by/i)
  })

  /**
   * The list is bounded and the counts are not, so a reader seeing two rows under a sentence
   * saying three is not looking at a contradiction.
   */
  it('says the list is the newest few out of the total', async () => {
    const wrapper = panel()
    await wrapper.get('select').setValue('p1')
    await settle(wrapper)
    expect(wrapper.get('.bound').text()).toContain('out of 3')
  })

  it('opens a divergent run by its id', async () => {
    const open = vi.fn()
    const wrapper = panel({ open })
    await wrapper.get('select').setValue('p1')
    await settle(wrapper)
    await wrapper.findAll('button.run')[0]!.trigger('click')
    expect(open).toHaveBeenCalledWith('r1')
  })

  it('says so when a persona has nothing to show, rather than rendering an empty box', async () => {
    const wrapper = panel({ read: vi.fn(async () => null) })
    await wrapper.get('select').setValue('p1')
    await settle(wrapper)
    expect(wrapper.text()).toContain('Nothing to show')
  })
})
