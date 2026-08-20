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
      refusedAt: new Date(0),
    })),
    total: options.refusals ?? 0,
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
    screens: { listRefusedCandidates },
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

  return { deps, listLosingArms, listRefusedCandidates }
}

const start = (deps: AgentDeps) =>
  startVariantProposer(deps, {
    workspaceId: WS,
    actor: userActor(asUserId('user_1')),
    threadId: 'thread_1' as never,
    repositoryId: REPO,
    personaId: SUBJECT,
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
    const { deps, listLosingArms, listRefusedCandidates } = harness({ refusals: 1 })
    await start(deps).catch(() => {})
    expect(limitOf(listLosingArms)).toBe(6)
    expect(limitOf(listRefusedCandidates)).toBe(6)
  })
})
