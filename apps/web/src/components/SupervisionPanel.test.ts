import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SupervisionPanel from './SupervisionPanel.vue'
import type { SupervisionLedger } from '@loom/api-contract'

/**
 * The supervision ledger, on screen.
 *
 * It was computed, exposed on the contract and rendered nowhere for as long as it existed —
 * so the tests here are mostly about what the panel must *not* add: this instrument's whole
 * discipline is that it reports a rate and refuses to say whether the rate is good.
 */
const ledger = (over: Partial<SupervisionLedger> = {}): SupervisionLedger =>
  ({
    since: new Date('2026-09-04T00:00:00Z'),
    detail: '12 human decisions in this window (7 approval, 5 disposition), against 30 decided runs: 0.40 human acts per decided run. Read it as a series rather than a level.',
    total: 12,
    byKind: { approval: 7, disposition: 5, promotion: 0, veto: 0, envelope: 0 },
    envelopeChanges: 0,
    decidedRuns: 30,
    uncounted: 0,
    automatic: 0,
    ...over,
  }) as SupervisionLedger

describe('SupervisionPanel', () => {
  it('renders the domain’s sentence unedited, because the panel has no opinion to add', () => {
    const record = ledger()
    const wrapper = mount(SupervisionPanel, { props: { ledger: record, fetchError: null } })
    expect(wrapper.text()).toContain(record.detail)
  })

  /**
   * The one thing this instrument must never do. A falling ratio is either trust being earned
   * or attention being withdrawn, and scoring an operator on it would be optimising the thing
   * it is supposed to measure.
   */
  it('offers no target, no verdict and no direction', () => {
    const text = mount(SupervisionPanel, {
      props: { ledger: ledger(), fetchError: null },
    }).text()
    expect(text).not.toMatch(/too (low|little|high|much)|should be|target|healthy|good|bad|warning/i)
  })

  it('shows only the kinds that actually happened', () => {
    const wrapper = mount(SupervisionPanel, { props: { ledger: ledger(), fetchError: null } })
    expect(wrapper.text()).toContain('approvals')
    expect(wrapper.text()).not.toContain('vetoes')
  })

  /**
   * The rate's own bound, on screen rather than implied. A reader who cannot see what was left
   * out has to trust that everything was counted, which is the one thing a measurement should
   * never ask for.
   */
  it('says what it did not count', () => {
    const wrapper = mount(SupervisionPanel, {
      props: { ledger: ledger({ uncounted: 3, automatic: 9 }), fetchError: null },
    })
    expect(wrapper.text()).toContain('3')
    expect(wrapper.text()).toContain('9')
  })

  /** An empty ledger and a failed read look identical without this. */
  it('shows a failed read as a failure rather than as no supervision', () => {
    const wrapper = mount(SupervisionPanel, {
      props: { ledger: null, fetchError: 'the audit log could not be read' },
    })
    expect(wrapper.text()).toContain('could not be read')
  })
})
