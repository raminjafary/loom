import { describe, expect, it } from 'vitest'
import {
  buildLineage,
  classifyRevisionChange,
  describeEvolutionEntry,
  type RevisionEntry,
  type SearchEntry,
} from './evolution.js'
import {
  asAgentPersonaId,
  asAgentRunId,
  asPersonaRevisionId,
  asPersonaVariantSetId,
} from './ids.js'

/**
 * The walk from a persona's first document to its current one.
 *
 * Two things are worth testing and the rest is rendering. That the classification reads
 * *fields* rather than text, so a reflowed paragraph is not reported as a tool change. And
 * that an edit nothing measured says so — which is the half of this instrument that exists to
 * make a gap visible rather than to describe a success.
 */

const doc = (over: { body?: string; tools?: string; model?: string; envelope?: string } = {}) =>
  [
    '---',
    'name: swe',
    'description: A worker.',
    `model: ${over.model ?? 'claude-haiku-4-5-20251001'}`,
    `tools: [${over.tools ?? 'Read'}]`,
    ...(over.envelope === undefined ? [] : ['envelope:', `  tools: [${over.envelope}]`]),
    '---',
    '',
    over.body ?? 'The prompt in use.',
  ].join('\n')

describe('classifyRevisionChange', () => {
  it('names the body when only the body moved', () => {
    expect(classifyRevisionChange(doc(), doc({ body: 'A different prompt.' }))).toEqual(['body'])
  })

  it('names the tool list when only the tool list moved', () => {
    expect(classifyRevisionChange(doc(), doc({ tools: 'Read, Grep' }))).toEqual(['tools'])
  })

  it('is unmoved by an ordering difference in the tool list', () => {
    expect(classifyRevisionChange(doc({ tools: 'Read, Grep' }), doc({ tools: 'Grep, Read' }))).toEqual([])
  })

  it('names every component that moved at once', () => {
    expect(
      classifyRevisionChange(doc(), doc({ body: 'New.', tools: 'Read, Bash', model: 'claude-opus-5' })),
    ).toEqual(['body', 'tools', 'model'])
  })

  /**
   * The event that should never occur, and therefore the one the instrument must be able to
   * name: a revision that moved the persona's own ceiling.
   */
  it('names the envelope, which is the change nothing is supposed to be able to make', () => {
    expect(classifyRevisionChange(doc(), doc({ envelope: 'Read, Bash' }))).toEqual(['envelope'])
  })

  it('reports nothing rather than throwing on a document that no longer parses', () => {
    expect(classifyRevisionChange('not a persona document', doc())).toEqual([])
  })
})

type RevisionInput = Parameters<typeof buildLineage>[0]['revisions'][number]

const revision = (
  over: Omit<Partial<RevisionInput>, 'id'> & { id: string },
): RevisionInput => ({
  markdownSource: doc(),
  replacedByKind: 'agent_run' as const,
  replacedByRunId: asAgentRunId('run_1'),
  rationale: 'Terser.',
  createdAt: new Date(1_000),
  trialDecidedAt: null,
  arms: [],
  ...over,
  id: asPersonaRevisionId(over.id),
})

const lineage = (
  revisions: Parameters<typeof buildLineage>[0]['revisions'],
  searches: Parameters<typeof buildLineage>[0]['searches'] = [],
  liveMarkdown = doc({ body: 'The prompt it has now.' }),
) =>
  buildLineage({
    personaId: asAgentPersonaId('p1'),
    personaName: 'swe',
    liveMarkdown,
    revisions,
    searches,
  })

describe('buildLineage', () => {
  /**
   * The newest revision is classified against the **live document**, which lives on the
   * persona row rather than in the history. A walker that forgot it would compare the newest
   * edit against the wrong document and report the wrong component — silently, and only for
   * the entry a reader looks at first.
   */
  it('classifies the newest revision against the document in use', () => {
    const walk = lineage([revision({ id: 'rev_1', markdownSource: doc() })])
    const entry = walk.entries[0] as RevisionEntry
    expect(entry.components).toEqual(['body'])
  })

  it('classifies an older revision against the one that replaced it, not against the live row', () => {
    const walk = lineage([
      revision({ id: 'rev_2', markdownSource: doc({ tools: 'Read, Grep' }), createdAt: new Date(2_000) }),
      revision({ id: 'rev_1', markdownSource: doc({ tools: 'Read' }), createdAt: new Date(1_000) }),
    ])
    const older = walk.entries.find(
      (entry) => entry.kind === 'revision' && entry.revisionId === 'rev_1',
    ) as RevisionEntry
    expect(older.components).toEqual(['tools'])
  })

  it('counts an edit as measured only when runs were actually dealt to it', () => {
    const walk = lineage([
      revision({ id: 'rev_1', arms: [{ label: 'revised', decided: 5, kept: 3 }] }),
      revision({ id: 'rev_2', arms: [{ label: 'revised', decided: 0, kept: 0 }], createdAt: new Date(500) }),
      revision({ id: 'rev_3', createdAt: new Date(400) }),
    ])
    expect(walk.measured).toBe(1)
    expect(walk.unmeasured).toBe(2)
  })

  it('interleaves searches and revisions, newest first', () => {
    const search: Omit<SearchEntry, 'kind'> = {
      at: new Date(3_000),
      setId: asPersonaVariantSetId('set_1'),
      status: 'settled',
      proposedByRunId: asAgentRunId('run_9'),
      candidates: [],
      verifierPickedVariantId: null,
      settledAt: new Date(3_500),
    }
    const walk = lineage([revision({ id: 'rev_1', createdAt: new Date(1_000) })], [search])
    expect(walk.entries.map((entry) => entry.kind)).toEqual(['search', 'revision'])
  })
})

describe('describeEvolutionEntry', () => {
  /**
   * The sentence this whole instrument exists for. Tier 2 writes a tool-list change into the
   * history and nothing ever measures it, and an absence is not something a reader notices.
   */
  it('says plainly when an agent’s edit was captured and never measured', () => {
    const walk = lineage([
      revision({ id: 'rev_1', markdownSource: doc({ tools: 'Read, Grep' }) }),
    ])
    const text = describeEvolutionEntry(walk.entries[0]!)
    expect(text).toContain('Captured, and nothing measured it')
  })

  it('does not call a human’s edit unmeasured in the same breath as an agent’s', () => {
    const walk = lineage([revision({ id: 'rev_1', replacedByKind: 'human', replacedByRunId: null })])
    const text = describeEvolutionEntry(walk.entries[0]!)
    expect(text).toContain('a decision rather than a hypothesis')
    expect(text).not.toContain('Captured, and nothing measured it')
  })

  it('reports a trial as the counts it recorded rather than as a verdict', () => {
    const walk = lineage([
      revision({
        id: 'rev_1',
        arms: [
          { label: 'the revised prompt', decided: 5, kept: 4 },
          { label: 'the prompt it replaced', decided: 5, kept: 2 },
        ],
      }),
    ])
    const text = describeEvolutionEntry(walk.entries[0]!)
    expect(text).toContain('the revised prompt kept 4 of 5')
    expect(text).toContain('A human has not settled it yet')
    expect(text).not.toMatch(/better|worse|improve/i)
  })

  it('says how many candidates the screen refused an arm, and that a verdict counted for nothing', () => {
    const search: Omit<SearchEntry, 'kind'> = {
      at: new Date(3_000),
      setId: asPersonaVariantSetId('set_1'),
      status: 'settled',
      proposedByRunId: null,
      candidates: [
        { variantId: 'v1', rationale: 'terser', outcome: 'refused', reason: 'passed 2 of 6', decided: 0, kept: 0 },
        { variantId: 'v2', rationale: 'louder', outcome: 'promoted', reason: null, decided: 5, kept: 4 },
      ],
      verifierPickedVariantId: 'v2',
      settledAt: new Date(3_500),
    }
    const text = describeEvolutionEntry({ kind: 'search', ...search })
    expect(text).toContain('ended with one promoted')
    expect(text).toContain('refused 1 of them an arm')
    expect(text).toContain('counted in nothing')
  })
})
