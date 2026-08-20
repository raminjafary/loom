import { describe, expect, it } from 'vitest'
import {
  describeSupervision,
  tallySupervision,
  type SupervisionAct,
} from './supervision-ledger.js'

/**
 * The supervision ledger.
 *
 * The failures worth testing are the ways this instrument could lie about its own subject: by
 * counting the platform's own automation as attention paid, by absorbing any new audit action
 * into the rate, and by reporting a count without the work it was spent on.
 */

const act = (over: Partial<SupervisionAct> & { action: string }): SupervisionAct => ({
  actorKind: 'user',
  at: new Date(0),
  personaName: 'swe',
  envelopeChanged: null,
  ...over,
})

describe('tallySupervision', () => {
  it('counts a person ruling on a branch, approving, promoting, vetoing and re-ceilinging', () => {
    const ledger = tallySupervision(
      [
        act({ action: 'approval_request.approved' }),
        act({ action: 'agent_run.discarded' }),
        act({ action: 'merge_queue.enqueued' }),
        act({ action: 'persona.variant_promoted' }),
        act({ action: 'persona.reverted' }),
        act({ action: 'persona.updated', envelopeChanged: true }),
      ],
      12,
    )
    expect(ledger.byKind).toEqual({
      approval: 1,
      disposition: 2,
      promotion: 1,
      veto: 1,
      envelope: 1,
    })
    expect(ledger).toMatchObject({ total: 6, decidedRuns: 12, envelopeChanges: 1 })
  })

  it('never counts the platform"s own acts as attention paid', () => {
    // The inversion this instrument exists to catch: a workspace must not look more closely
    // watched the more of its decisions it makes for itself.
    const ledger = tallySupervision(
      [
        act({ action: 'agent_run.discarded', actorKind: 'platform' }),
        act({ action: 'persona.variant_promoted', actorKind: 'agent_run' }),
      ],
      4,
    )
    expect(ledger.total).toBe(0)
    expect(ledger.automatic).toBe(2)
  })

  it('does not absorb an audit action nobody classified', () => {
    const ledger = tallySupervision(
      [act({ action: 'channel.created' }), act({ action: 'workspace.model_routing_set' })],
      4,
    )
    expect(ledger.total).toBe(0)
    expect(ledger.uncounted).toBe(2)
  })

  it('counts an envelope-authority save that changed no ceiling as an act, not as a change', () => {
    const ledger = tallySupervision([act({ action: 'persona.updated', envelopeChanged: false })], 1)
    expect(ledger.byKind.envelope).toBe(1)
    expect(ledger.envelopeChanges).toBe(0)
  })
})

describe('describeSupervision', () => {
  const ledger = (acts: readonly SupervisionAct[], runs: number) => tallySupervision(acts, runs)

  it('says nothing happened rather than implying a rate', () => {
    expect(describeSupervision(ledger([], 0))).toContain('nothing to measure yet')
  })

  it('names the state a curve exists to catch: work decided with nobody deciding', () => {
    expect(describeSupervision(ledger([], 40))).toContain('or nobody is looking')
  })

  it('leads with the ratio, because a count alone says nothing', () => {
    const detail = describeSupervision(
      ledger([act({ action: 'agent_run.kept' }), act({ action: 'agent_run.discarded' })], 8),
    )
    expect(detail).toContain('0.25 human acts per decided run')
  })

  it('refuses to say whether a falling ratio is trust or abdication', () => {
    const detail = describeSupervision(ledger([act({ action: 'agent_run.kept' })], 8))
    expect(detail).toContain('nothing here can tell you which')
  })

  it('calls out an act that moved a ceiling, because nothing but a person can', () => {
    const detail = describeSupervision(
      ledger([act({ action: 'persona.updated', envelopeChanged: true })], 3),
    )
    expect(detail).toContain("moved a persona's envelope")
  })
})
