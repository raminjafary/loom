import type { AgentPersona, DelegationEdge } from '@loom/api-contract'
import { describe, expect, it } from 'vitest'
import {
 composerEdges,
 composerNodes,
 connectVerdict,
 layoutForGroup,
 summarizeRefusals,
 withWiderEnvelope,
} from './team-composition.js'

const persona = (overrides: Partial<AgentPersona> = {}): AgentPersona => ({
 id: 'p1',
 workspaceId: 'w1',
 name: 'swe',
 description: 'Writes code',
 markdownSource:
 '---\nname: swe\ndescription: Writes code\nmodel: claude-haiku-4-5-20251001\ntools: [Read]\n---\n\nBody.',
 model: 'claude-haiku-4-5-20251001',
 tools: ['Read'],
 harnessEffort: null,
 harnessMaxTurns: null,
 harnessApprovalMode: 'ask' as const,
 harnessPlanner: false,
 harnessDelegates: [],
 harnessBudgetCapUsd: null,
 builtinStatus: null,
 createdAt: new Date(0),
 updatedAt: new Date(0),
...overrides,
})

const edge = (overrides: Partial<DelegationEdge> = {}): DelegationEdge => ({
 plannerId: 'planner',
 workerId: 'swe',
 ok: true,
 refusals: [],
...overrides,
})

describe('layoutForGroup', => {
 it('keeps every position a human already chose', => {
 const stored = { p1: { x: 999, y: -40 } }
 const layout = layoutForGroup([persona({ id: 'p1' }), persona({ id: 'p2' })], stored)
 expect(layout.p1).toEqual({ x: 999, y: -40 })
 expect(layout.p2).toBeDefined
 })

 /**
 * The one relationship this canvas exists to show is which workers hang off which
 * planner; a grid that interleaves them makes it the hardest thing to see.
 */
 it('puts planners on their own row, above the workers', => {
 const layout = layoutForGroup(
 [
 persona({ id: 'w1' }),
 persona({ id: 'lead', harnessPlanner: true }),
 persona({ id: 'w2' }),
 ],
 {},
)
 expect(layout.lead?.y).toBeLessThan(layout.w1?.y ?? 0)
 expect(layout.w1?.y).toBe(layout.w2?.y)
 })
})

describe('composerEdges', => {
 it('draws only pairs where both personas are on the canvas', => {
 const edges = composerEdges(
 ['planner', 'swe'],
 [edge, edge({ workerId: 'elsewhere' })],
)
 expect(edges.map((e) => e.id)).toEqual(['planner->swe'])
 })

 it('leaves the self-edge out of the drawn edges — it belongs on the node', => {
 // Not dropped: `composerNodes` carries it as `recurses`. Between one node's own
 // handles it would be a line behind the box, which is the same as hiding it.
 expect(composerEdges(['planner'], [edge({ workerId: 'planner' })])).toEqual([])
 })

 it('carries the refusals through so an edge can be drawn refused', => {
 const edges = composerEdges(
 ['planner', 'swe'],
 [
 edge({
 ok: false,
 refusals: [{ rule: 'model', detail: 'higher tier', fix: 'move the planner up' }],
 }),
 ],
)
 expect(edges[0]?.ok).toBe(false)
 expect(edges[0]?.summary).toBe('model')
 })
})

describe('summarizeRefusals', => {
 it('counts them when there is more than one, which is the case that matters', => {
 expect(
 summarizeRefusals([
 { rule: 'tools', detail: '', fix: '' },
 { rule: 'budget', detail: '', fix: '' },
 ]),
).toBe('2 refusals: tools, budget')
 })
})

describe('connectVerdict', => {
 const source = { personaId: 'planner', name: 'planner', planner: true }

 it('refuses a connection from a persona that is not a planner', => {
 const verdict = connectVerdict({...source, planner: false }, { name: 'swe' }, undefined)
 expect(verdict.kind).toBe('not-a-planner')
 })

 it('says nothing needs doing when the edge already exists', => {
 expect(connectVerdict(source, { name: 'swe' }, edge).kind).toBe('already')
 })

 it('offers to widen the envelope when that is the whole of the refusal', => {
 const verdict = connectVerdict(
 source,
 { name: 'swe' },
 edge({
 ok: false,
 refusals: [{ rule: 'tools', detail: '', fix: '', widenEnvelopeWith: ['Bash', 'Edit'] }],
 }),
)
 expect(verdict).toMatchObject({ kind: 'widen', tools: ['Bash', 'Edit'] })
 })

 /**
 * The case the whole shape is built around. A composer that quietly lowered a
 * worker's model tier or turned off its auto-approve because someone dragged a line
 * would be changing what that worker *is* — a persona other teams also use — to
 * satisfy a gesture.
 */
 it('refuses rather than editing the worker, when any refusal is about the worker', => {
 const verdict = connectVerdict(
 source,
 { name: 'swe' },
 edge({
 ok: false,
 refusals: [
 { rule: 'tools', detail: '', fix: '', widenEnvelopeWith: ['Bash'] },
 { rule: 'model', detail: 'higher tier', fix: 'move it down' },
 ],
 }),
)
 expect(verdict.kind).toBe('refused')
 })
})

describe('withWiderEnvelope', => {
 const planner = persona({
 id: 'planner',
 name: 'planner',
 tools: ['Read', 'Grep', 'Glob'],
 harnessPlanner: true,
 harnessDelegates: ['Read'],
 markdownSource: [
 '---',
 'name: planner',
 'description: Decomposes',
 'model: claude-sonnet-5',
 'tools: [Read, Grep, Glob]',
 'harness:',
 ' planner: true',
 ' delegates: [Read]',
 '---',
 '',
 'You decompose.',
 ].join('\n'),
 })

 it('adds the tools and keeps everything else, including the prompt', => {
 const markdown = withWiderEnvelope(planner, ['Bash'])
 expect(markdown).toContain('delegates: [Read, Bash]')
 expect(markdown).toContain('planner: true')
 expect(markdown).toContain('tools: [Read, Grep, Glob]')
 expect(markdown.endsWith('You decompose.')).toBe(true)
 })

 it('never widens the planner\'s own tools, only what it may hand down', => {
 expect(withWiderEnvelope(planner, ['Bash'])).toContain('tools: [Read, Grep, Glob]')
 })

 it('is idempotent, so a second drag does not duplicate an entry', => {
 const once = withWiderEnvelope(planner, ['Bash'])
 expect(withWiderEnvelope({...planner, harnessDelegates: ['Read', 'Bash'] }, ['Bash'])).toBe(
 once,
)
 })
})

/**
 * The recursion edge. The reason it matters is stated in that section: "a planner
 * may delegate to another run of itself, that is how depth works, and hiding it makes
 * The own shape invisible on the surface built to show shape."
 *
 * It is the answer to "I cannot add multiple planners" — several planners on a team are
 * several planner *personas*, and one planner going deeper is this.
 */
describe('composerNodes recursion', => {
 it('marks a planner whose self-edge is allowed', => {
 const nodes = composerNodes(
 [persona({ id: 'planner', harnessPlanner: true })],
 {},
 [edge({ plannerId: 'planner', workerId: 'planner', ok: true })],
)
 expect(nodes[0]?.recurses).toBe(true)
 expect(nodes[0]?.recursionSummary).toBe('')
 })

 it('says why a planner cannot recurse, rather than looking like an ordinary planner', => {
 // A narrowed envelope that does not admit the planner's own tools makes depth
 // impossible — worth saying at design time instead of as a refused child start at
 // depth 2.
 const nodes = composerNodes(
 [persona({ id: 'planner', harnessPlanner: true })],
 {},
 [
 edge({
 plannerId: 'planner',
 workerId: 'planner',
 ok: false,
 refusals: [
 {
 rule: 'tools',
 detail: 'Bash is outside the envelope',
 fix: "Add Bash to this planner's delegation envelope",
 },
 ],
 }),
 ],
)
 expect(nodes[0]?.recurses).toBe(false)
 expect(nodes[0]?.recursionSummary).toContain('tools')
 })

 it('never marks a worker, which cannot delegate at all', => {
 const nodes = composerNodes(
 [persona({ id: 'swe' })],
 {},
 [edge({ plannerId: 'swe', workerId: 'swe', ok: true })],
)
 expect(nodes[0]?.recurses).toBe(false)
 })

 it('renders nodes when no matrix is available yet', => {
 // A node without its recursion mark is incomplete; a canvas without nodes is empty.
 const nodes = composerNodes([persona({ id: 'planner', harnessPlanner: true })], {})
 expect(nodes).toHaveLength(1)
 expect(nodes[0]?.recurses).toBe(false)
 })

 it('keeps the position a human chose', => {
 const nodes = composerNodes([persona({ id: 'p1' })], { p1: { x: 12, y: 34 } })
 expect(nodes[0]?.position).toEqual({ x: 12, y: 34 })
 })
})
