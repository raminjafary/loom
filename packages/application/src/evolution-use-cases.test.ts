import { asAgentPersonaId, asWorkspaceId } from '@loom/domain'
import { describe, expect, it, vi } from 'vitest'
import { personaEvolution, type EvolutionDeps } from './evolution-use-cases.js'

/**
 * The walk, at the layer that decides what is read.
 *
 * The domain owns the classification and the sentences; what only this layer can show is
 * which queries it makes — a tally is fetched for a revision something actually put on trial
 * and for no other, because a walk that queried every revision would be twenty round trips to
 * be told nineteen times that nothing measured it.
 */

const WS = asWorkspaceId('ws_1')
const PERSONA = asAgentPersonaId('p_1')

const doc = (body: string, tools = 'Read') =>
  ['---', 'name: swe', 'description: A worker.', 'model: m', `tools: [${tools}]`, '---', '', body].join('\n')

const harness = (options: {
  revisions?: { id: string; markdownSource: string; kind?: 'human' | 'agent_run'; trialDecidedAt?: Date | null; createdAt?: Date }[]
  onTrial?: string | null
  sets?: {
    id: string
    status: 'open' | 'settled'
    promotedVariantId?: string | null
    variants: { id: string; rationale: string }[]
    rejected?: string[]
  }[]
}) => {
  const tallyTrialOutcomes = vi.fn(async () => [
    { arm: 'revised' as const, decided: 5, merged: 4 },
    { arm: 'previous' as const, decided: 5, merged: 2 },
  ])
  const deps = {
    personas: {
      findById: vi.fn(async () => ({
        id: PERSONA,
        name: 'swe',
        markdownSource: doc('The prompt it has now.'),
      })),
      listRevisions: vi.fn(async () =>
        (options.revisions ?? []).map((revision) => ({
          id: revision.id,
          markdownSource: revision.markdownSource,
          replacedByKind: revision.kind ?? 'agent_run',
          replacedByRunId: 'run_1',
          rationale: 'Terser.',
          trialDecidedAt: revision.trialDecidedAt ?? null,
          createdAt: revision.createdAt ?? new Date(1_000),
        })),
      ),
      findRevisionOnTrial: vi.fn(async () =>
        options.onTrial === undefined || options.onTrial === null ? null : { id: options.onTrial },
      ),
      tallyTrialOutcomes,
    },
    personaVariants: {
      listSetsForPersona: vi.fn(async () =>
        (options.sets ?? []).map((set) => ({
          set: {
            id: set.id,
            status: set.status,
            promotedVariantId: set.promotedVariantId ?? null,
            proposedByRunId: 'run_9',
            verifierDecidedAt: null,
            verifierPickedVariantId: null,
            settledAt: set.status === 'settled' ? new Date(5_000) : null,
            createdAt: new Date(4_000),
          },
          variants: set.variants,
        })),
      ),
      tallyVariantOutcomes: vi.fn(async () => []),
    },
    screens: {
      screensForSet: vi.fn(async (_ws: unknown, setId: string) => {
        const set = (options.sets ?? []).find((entry) => entry.id === setId)
        return (set?.rejected ?? []).map((variantId) => ({
          screen: {
            variantId,
            decision: 'rejected',
            reason: 'Rejected by the held-out screen: it passed 2 of 6 items.',
          },
          runs: [],
        }))
      }),
    },
  } as unknown as EvolutionDeps
  return { deps, tallyTrialOutcomes }
}

describe('personaEvolution', () => {
  it('fetches a trial tally only for revisions something actually put on trial', async () => {
    const h = harness({
      revisions: [
        { id: 'rev_1', markdownSource: doc('One.'), trialDecidedAt: new Date(2_000) },
        { id: 'rev_2', markdownSource: doc('Two.'), createdAt: new Date(900) },
        { id: 'rev_3', markdownSource: doc('Three.'), createdAt: new Date(800) },
      ],
    })
    await personaEvolution(h.deps, { workspaceId: WS, personaId: PERSONA })
    expect(h.tallyTrialOutcomes).toHaveBeenCalledTimes(1)
  })

  it('includes the revision on trial right now, which has no decided-at yet', async () => {
    const h = harness({
      revisions: [{ id: 'rev_1', markdownSource: doc('One.') }],
      onTrial: 'rev_1',
    })
    const walk = await personaEvolution(h.deps, { workspaceId: WS, personaId: PERSONA })
    expect(h.tallyTrialOutcomes).toHaveBeenCalledTimes(1)
    expect(walk.measured).toBe(1)
  })

  /**
   * "Kept" is merged-or-pushed, the fitness's first term. A walk that counted anything else
   * would report a different number from the panel that settled the trial, which is the
   * defect the one-comparison rule exists to prevent.
   */
  it('reports an arm with the same figure the trial panel shows', async () => {
    const h = harness({
      revisions: [{ id: 'rev_1', markdownSource: doc('One.'), trialDecidedAt: new Date(2_000) }],
    })
    const walk = await personaEvolution(h.deps, { workspaceId: WS, personaId: PERSONA })
    const entry = walk.entries[0]
    expect(entry?.kind === 'revision' && entry.arms).toEqual([
      { label: 'the revised prompt', decided: 5, kept: 4 },
      { label: 'the prompt it replaced', decided: 5, kept: 2 },
    ])
  })

  it('marks a candidate the screen refused as refused, not as one that lost', async () => {
    const h = harness({
      sets: [
        {
          id: 'set_1',
          status: 'settled',
          promotedVariantId: 'v2',
          variants: [
            { id: 'v1', rationale: 'terser' },
            { id: 'v2', rationale: 'louder' },
          ],
          rejected: ['v1'],
        },
      ],
    })
    const walk = await personaEvolution(h.deps, { workspaceId: WS, personaId: PERSONA })
    const search = walk.entries.find((entry) => entry.kind === 'search')
    expect(search?.kind === 'search' && search.candidates).toEqual([
      {
        variantId: 'v1',
        rationale: 'terser',
        outcome: 'refused',
        reason: 'Rejected by the held-out screen: it passed 2 of 6 items.',
        decided: 0,
        kept: 0,
      },
      { variantId: 'v2', rationale: 'louder', outcome: 'promoted', reason: null, decided: 0, kept: 0 },
    ])
  })

  it('is empty rather than an error for a persona nothing has ever changed', async () => {
    const walk = await personaEvolution(harness({}).deps, { workspaceId: WS, personaId: PERSONA })
    expect(walk.entries).toEqual([])
    expect(walk.measured).toBe(0)
    expect(walk.unmeasured).toBe(0)
  })
})
