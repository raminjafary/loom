import type { AtlasEdge } from '@loom/api-contract'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AtlasPanel from './AtlasPanel.vue'

/**
 * The atlas's queue, where the human act happens.
 *
 * What is worth asserting here is not that a list renders. It is the four things this
 * surface says that a list of rows would not, each of them a rule: that there is no way to
 * propose one from here, that confirming is not a quiet approval, that a proposal nobody
 * argued over is different from one that went through the venue, and that a relation whose
 * endpoint its own map has retired cannot be confirmed at all.
 */

const end = (over: Partial<AtlasEdge['from']> = {}): AtlasEdge['from'] => ({
 nodeId: 'n-flight',
 mapId: 'm-flight',
 label: 'Cancellation fee',
 summary: 'A charge scaled by time to departure.',
 subjectRef: 'flight-api',
 personaName: 'flight-expert',
 live: true,
...over,
})

const edge = (over: Partial<AtlasEdge> = {}): AtlasEdge => ({
 id: 'e1',
 relation: 'same_concept',
 rationale: 'Both compute a partial charge from time remaining.',
 status: 'proposed',
 from: end,
 to: end({
 nodeId: 'n-hotel',
 mapId: 'm-hotel',
 label: 'Refund policy',
 subjectRef: 'hotel-api',
 personaName: 'hotel-expert',
 }),
 proposedByPersonaName: 'flight-worker',
 proposedByRunId: 'run1',
 sessionId: null,
 decidedByName: '',
 decidedAt: null,
 decisionNote: '',
 createdAt: new Date('2026-08-02T00:00:00Z'),
...over,
})

describe('AtlasPanel', => {
 it('names both subjects and both concepts, because a relation without them checks nothing', => {
 const wrapper = mount(AtlasPanel, { props: { proposals: [edge] } })
 const text = wrapper.text
 expect(text).toContain('flight-api')
 expect(text).toContain('Cancellation fee')
 expect(text).toContain('hotel-api')
 expect(text).toContain('Refund policy')
 expect(text).toContain('is the same concept as')
 })

 /**
 * A relation reaches this queue from a run that went and looked. A form here would let
 * somebody record a relation nobody checked with the same status as one that was.
 */
 it('offers no way to propose a relation', => {
 const wrapper = mount(AtlasPanel, { props: { proposals: [] } })
 expect(wrapper.text).toContain('no way to add one from here')
 expect(wrapper.findAll('input')).toHaveLength(0)
 })

 /** Confirming publishes the relation to every run that asks. The button says so. */
 it('says what confirming does rather than calling it approval', => {
 const wrapper = mount(AtlasPanel, { props: { proposals: [edge] } })
 const labels = wrapper.findAll('button').map((button) => button.text)
 expect(labels.some((label) => label.includes('every run sees this'))).toBe(true)
 expect(labels).not.toContain('Approve')
 })

 it('tells a proposal nobody argued over from one that went through the venue', => {
 const alone = mount(AtlasPanel, { props: { proposals: [edge] } })
 expect(alone.text).toContain("one agent's word")

 const argued = mount(AtlasPanel, {
 props: { proposals: [edge({ status: 'contended', sessionId: 's1' })] },
 })
 expect(argued.text).toContain('argued over in the venue')
 // And once it has been, there is nothing left to send there.
 expect(argued.text).not.toContain('Put it to both experts first')
 })

 /**
 * The bi-temporal model lets a map retire a concept under a relation. Confirming then
 * would put a human's name on a claim its own source has withdrawn.
 */
 it('refuses to let a relation with a retired endpoint be confirmed', => {
 const wrapper = mount(AtlasPanel, {
 props: { proposals: [edge({ to: end({ label: 'Refund policy', live: false }) })] },
 })
 expect(wrapper.text).toContain('no longer in its map')
 const confirm = wrapper
.findAll('button')
.find((button) => button.text.includes('every run sees this'))
 expect(confirm?.attributes('disabled')).toBeDefined
 })

 /** The reason a plausible relation is wrong is written down nowhere else. */
 it('keeps a rejection on the panel, with its reason', => {
 const wrapper = mount(AtlasPanel, {
 props: {
 proposals: [
 edge({
 status: 'rejected',
 decidedByName: 'Ramin',
 decisionNote: 'Hotel refunds are regulatory; flight fees are commercial.',
 }),
 ],
 },
 })
 expect(wrapper.text).toContain('rejected by Ramin')
 expect(wrapper.text).toContain('regulatory')
 })

 it('puts what is waiting above what has been decided', => {
 const wrapper = mount(AtlasPanel, {
 props: {
 proposals: [
 edge({ id: 'decided', status: 'promoted', decidedByName: 'Ramin' }),
 edge({ id: 'waiting', status: 'contended' }),
 ],
 },
 })
 const rows = wrapper.findAll('.row')
 expect(rows[0]?.classes).toContain('contended')
 expect(rows[1]?.classes).toContain('promoted')
 })

 it('carries the note a human typed with the decision', async => {
 const wrapper = mount(AtlasPanel, { props: { proposals: [edge] } })
 await wrapper.find('input').setValue('Checked both — same rounding rule.')
 await wrapper
.findAll('button')
.find((button) => button.text.includes('every run sees this'))
 ?.trigger('click')
 expect(wrapper.emitted('decide')?.[0]).toEqual([
 { edgeId: 'e1', decision: 'promoted', note: 'Checked both — same rounding rule.' },
 ])
 })
})
