import { asAgentPersonaId, asRepositoryId, asUserId, asWorkspaceId, userActor } from '@loom/domain'
import { describe, expect, it, vi } from 'vitest'
import { startVariantProposer, type AgentDeps } from './agent-use-cases.js'

/**
 * Starting a proposer, at the layer where the decision is whether to spend a session at all.
 *
 * Every assertion here is about a refusal, because that is the whole of what this use case
 * decides before it starts anything: four states in which a proposer session would read a
 * record it cannot generate from, or write candidates that would be refused when they arrive
 * an hour later. The happy path is asserted over the real protocol in the server suite, since
 * what matters there is what reaches the Runner.
 */

const WS = asWorkspaceId('ws_1')
const SUBJECT = asAgentPersonaId('p_subject')
const REPO = asRepositoryId('repo_1')

/** With an envelope: a persona a human has never let rewrite itself gets no candidates. */
const PERSONA_MARKDOWN = `---
name: swe
description: A worker.
model: claude-haiku-4-5-20251001
envelope:
  tools: [Read]
---

The prompt in use.
`

const NO_ENVELOPE_MARKDOWN = PERSONA_MARKDOWN.replace('envelope:\n  tools: [Read]\n', '')

const VARIANT_MARKDOWN = PERSONA_MARKDOWN.replace('The prompt in use.', 'A candidate that lost.')

const persona = (name: string, id = SUBJECT, markdownSource = PERSONA_MARKDOWN) => ({
  id,
  name,
  description: 'A worker.',
  markdownSource,
})

const harness = (options: {
  subjectName?: string
  proposerExists?: boolean
  trialOpen?: boolean
  searchOpen?: boolean
  losingArms?: number
  refusals?: number
  divergences?: number
  siblingRefusals?: number
  envelope?: false
}) => {
  const subject = persona(
    options.subjectName ?? 'swe',
    SUBJECT,
    options.envelope === false ? NO_ENVELOPE_MARKDOWN : PERSONA_MARKDOWN,
  )
  const listLosingArms = vi.fn(async () => ({
    arms: Array.from({ length: options.losingArms ?? 0 }, (_, index) => ({
      variantId: `variant_${index}`,
      markdownSource: VARIANT_MARKDOWN,
      rationale: 'It would have been shorter.',
      decided: 5,
      kept: 1,
      models: ['claude-sonnet-5'],
      settledAt: new Date(0),
    })),
    total: options.losingArms ?? 0,
  }))
  const listRefusedCandidates = vi.fn(async () => ({
    candidates: Array.from({ length: options.refusals ?? 0 }, (_, index) => ({
      variantId: `refused_${index}`,
      markdownSource: VARIANT_MARKDOWN,
      rationale: 'It would have been shorter.',
      reason: 'Passed 2 of 6 items where the prompt in use passed 5.',
      models: ['claude-sonnet-5'],
      items: [
        { position: 1, outcome: 'passed' as const, task: 'Fix the parser.', failingCheck: null },
        {
          position: 2,
          outcome: 'failed' as const,
          task: 'Handle an empty list.',
          failingCheck: 'boundary',
        },
      ],
      refusedAt: new Date(0),
    })),
    total: options.refusals ?? 0,
  }))

  const tallyFailingChecks = vi.fn(async () => ({
    decidedRuns: 24,
    verificationFailures: 9,
    checks: [{ name: 'boundary', failures: 5 }],
  }))

  const divergenceSet = vi.fn(async () => ({
    runs: Array.from({ length: options.divergences ?? 0 }, (_, index) => ({
      runId: `run_${index}`,
      task: 'Add the refund endpoint.',
      kind: 'passed-and-discarded' as const,
      failingCheck: null,
      decidedAt: new Date(0),
    })),
    passedAndDiscarded: options.divergences ?? 0,
    failedAndMerged: 0,
    comparable: 30,
  }))

  const listSiblingRefusals = vi.fn(async () => ({
    candidates: Array.from({ length: options.siblingRefusals ?? 0 }, (_, index) => ({
      variantId: `sibling_${index}`,
      personaName: 'security-reviewer',
      markdownSource: VARIANT_MARKDOWN,
      rationale: 'Fewer gates.',
      reason: 'Passed 1 of 6 items where the prompt in use passed 5.',
      models: ['claude-sonnet-5'],
      items: [],
      refusedAt: new Date(0),
    })),
    total: options.siblingRefusals ?? 0,
  }))

  const deps = {
    audit: { record: vi.fn(async () => ({})) },
    personas: {
      findById: vi.fn(async () => subject),
      listByWorkspace: vi.fn(async () =>
        options.proposerExists === false
          ? [subject]
          : [subject, persona('variant-proposer', asAgentPersonaId('p_proposer'))],
      ),
      findRevisionOnTrial: vi.fn(async () => (options.trialOpen ? { id: 'rev_1' } : null)),
      listRevisions: vi.fn(async () => []),
    },
    personaVariants: {
      findOpenSet: vi.fn(async () => (options.searchOpen ? { set: {}, variants: [] } : null)),
      listLosingArms,
    },
    screens: { listRefusedCandidates, listSiblingRefusals },
    agentRuns: { tallyFailingChecks, divergenceSet },
    /**
     * The first thing `startAgentRun` reads. Throwing here is how these tests tell "it got
     * past every gate and started a run" apart from "it refused" — the alternative is
     * asserting that *something* threw, which any missing stub would satisfy.
     */
    runControl: {
      get: async () => {
        throw new Error('REACHED-START')
      },
    },
  } as unknown as AgentDeps

  return {
    deps,
    listLosingArms,
    listRefusedCandidates,
    tallyFailingChecks,
    divergenceSet,
    listSiblingRefusals,
  }
}

const start = (deps: AgentDeps, source?: 'failure-record' | 'taste-record' | 'sibling-refusals') =>
  startVariantProposer(deps, {
    workspaceId: WS,
    actor: userActor(asUserId('user_1')),
    threadId: 'thread_1' as never,
    repositoryId: REPO,
    personaId: SUBJECT,
    ...(source === undefined ? {} : { source }),
  })

/** The mocks are declared without argument types, so a call is read positionally. */
const limitOf = (mock: ReturnType<typeof vi.fn>): unknown =>
  (mock.mock.calls as unknown as unknown[][])[0]?.[2]

const refusal = async (deps: AgentDeps): Promise<string> => {
  const verdict = await start(deps)
  expect(verdict.ok).toBe(false)
  if (verdict.ok) throw new Error('expected a refusal')
  return verdict.reason
}

describe('startVariantProposer', () => {
  /**
   * The domain's rule, reached through the use case: with nothing lost and nothing refused a
   * proposer knows exactly what the run being edited knows. Asserted here as well as in the
   * domain because this is the layer that decides whether a run is started, and the buffer
   * being empty is the *ordinary* state of a young workspace rather than an error.
   */
  it('refuses when the persona has no record to generate from', async () => {
    const { deps } = harness({})
    expect(await refusal(deps)).toContain('Nothing has been measured and lost')
  })

  it('opens on refusals alone — a screen kill is evidence no run ever sees', async () => {
    const { deps } = harness({ refusals: 2 })
    await expect(start(deps)).rejects.toThrow('REACHED-START')
  })

  it('opens on losing arms alone', async () => {
    const { deps } = harness({ losingArms: 1 })
    await expect(start(deps)).rejects.toThrow('REACHED-START')
  })

  it('names the missing proposer persona rather than failing generically', async () => {
    const { deps } = harness({ proposerExists: false, losingArms: 1 })
    expect(await refusal(deps)).toContain('variant-proposer')
  })

  /**
   * The property the piece exists for, at the one moment it can be checked before a run
   * exists: a proposer revising itself is the run being edited under another name.
   */
  it('refuses to propose for the proposer persona itself', async () => {
    const { deps } = harness({ subjectName: 'variant-proposer', losingArms: 1 })
    expect(await refusal(deps)).toContain('proposing about itself')
  })

  /**
   * Both storage answers to "is something being measured", because a session spent writing
   * candidates the validator refuses on arrival is the expensive way to learn this.
   */
  /**
   * The ceiling, read from the persona under revision. The validator refuses such a candidate
   * when it arrives anyway, so what this saves is the session — and a proposer must not be
   * the way around an off switch a human left off.
   */
  it('refuses to propose for a persona a human never let rewrite itself', async () => {
    const { deps } = harness({ envelope: false, losingArms: 1 })
    expect(await refusal(deps)).toContain('no self-modification envelope')
  })

  it('refuses while a variant search is open', async () => {
    const { deps } = harness({ searchOpen: true, losingArms: 1 })
    expect(await refusal(deps)).toContain('already running')
  })

  it('refuses while a prompt is on trial', async () => {
    const { deps } = harness({ trialOpen: true, losingArms: 1 })
    expect(await refusal(deps)).toContain('already running')
  })

  /**
   * The bound is asked for, not assumed. A brief that quietly took everything would grow with
   * the buffer until it spent more context on failures than on the prompt being revised.
   */
  it('asks storage for no more than the brief can carry', async () => {
    const { deps, listLosingArms, listRefusedCandidates, tallyFailingChecks } = harness({
      refusals: 1,
    })
    await start(deps).catch(() => {})
    expect(limitOf(listLosingArms)).toBe(6)
    expect(limitOf(listRefusedCandidates)).toBe(6)
    // The histogram is mined by persona *name*, because a run carries a snapshot.
    expect((tallyFailingChecks.mock.calls as unknown as unknown[][])[0]?.slice(1)).toEqual([
      'swe',
      5,
    ])
  })

  it('starts a proposer even when the weakness histogram cannot be read', async () => {
    // Best-effort by design: a proposer is worth starting on the losses and refusals alone,
    // and a mining query that fails must not be the reason nothing is ever proposed.
    const { deps, tallyFailingChecks } = harness({ refusals: 1 })
    tallyFailingChecks.mockRejectedValueOnce(new Error('the histogram is unreadable'))
    await expect(start(deps)).rejects.toThrow('REACHED-START')
  })
})


/**
 * Brief sources, at the layer that decides which record is read at all.
 *
 * The domain owns what a brief says; what only this layer can show is that the *other*
 * records are never fetched. That is not an optimisation — a query whose result is dropped is
 * an invitation for a later edit to render it, and the experiments these sources exist for
 * are comparisons that only hold while a session sees one record.
 */
describe('startVariantProposer — which record it reads', () => {
  it('reads only the failure record by default, which is what it always did', async () => {
    const h = harness({ losingArms: 2 })
    await expect(start(h.deps)).rejects.toThrow('REACHED-START')
    expect(h.listLosingArms).toHaveBeenCalled()
    expect(h.divergenceSet).not.toHaveBeenCalled()
    expect(h.listSiblingRefusals).not.toHaveBeenCalled()
  })

  it('reads only the divergence set on a taste brief', async () => {
    const h = harness({ losingArms: 2, divergences: 3 })
    await expect(start(h.deps, 'taste-record')).rejects.toThrow('REACHED-START')
    expect(h.divergenceSet).toHaveBeenCalled()
    expect(h.listLosingArms).not.toHaveBeenCalled()
    expect(h.listRefusedCandidates).not.toHaveBeenCalled()
    expect(h.tallyFailingChecks).not.toHaveBeenCalled()
  })

  it('reads only other personas’ refusals on a sibling brief', async () => {
    const h = harness({ losingArms: 2, siblingRefusals: 2 })
    await expect(start(h.deps, 'sibling-refusals')).rejects.toThrow('REACHED-START')
    expect(h.listSiblingRefusals).toHaveBeenCalled()
    expect(h.listLosingArms).not.toHaveBeenCalled()
    expect(h.divergenceSet).not.toHaveBeenCalled()
  })

  /**
   * A source with nothing in it refuses on its own terms rather than falling back. Falling
   * back would be the one failure that never shows up as one: every arm of the experiment
   * would quietly become the failure-record arm, on exactly the personas where the
   * difference was hardest to see.
   */
  it('refuses a taste brief with an empty divergence set, even when the failure record is full', async () => {
    const reason = await (async () => {
      const verdict = await start(harness({ losingArms: 6, refusals: 6 }).deps, 'taste-record')
      expect(verdict.ok).toBe(false)
      return verdict.ok ? '' : verdict.reason
    })()
    expect(reason).toContain('never disagreed')
  })

  it('refuses a sibling brief when no other persona has been refused anything', async () => {
    const verdict = await start(harness({ losingArms: 6 }).deps, 'sibling-refusals')
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('anti-library')
  })
})
