import {
  asAgentPersonaId,
  asAgentRunId,
  asRepositoryId,
  asThreadId,
  asWorkspaceId,
  type TriggerCandidate,
  type TriggerPopulation,
} from '@loom/domain'
import { describe, expect, it, vi } from 'vitest'
import { advanceEvolutionTriggers, type EvolutionTriggerDeps } from './evolution-use-cases.js'

/**
 * The trigger sweep — the tick that closes the loop.
 *
 * What is worth asserting here is not the threshold (the domain owns that and tests it) but the
 * five things this layer decides: that it does nothing when it is off, that a persona nobody may
 * rewrite is skipped before it is counted, that the window is bounded by the last settlement,
 * that a refused start is recorded rather than swallowed, and that the start budget holds.
 */

const WS = asWorkspaceId('ws_1')
const PERSONA = asAgentPersonaId('p_swe')

const WITH_ENVELOPE = `---
name: swe
description: A worker.
model: claude-haiku-4-5-20251001
envelope:
  tools: [Read]
---

The prompt in use.
`

const NO_ENVELOPE = WITH_ENVELOPE.replace('envelope:\n  tools: [Read]\n', '')

const candidate = (over: Partial<TriggerCandidate> = {}): TriggerCandidate => ({
  workspaceId: WS,
  personaId: PERSONA,
  personaName: 'swe',
  markdownSource: WITH_ENVELOPE,
  threadId: asThreadId('t_1'),
  repositoryId: asRepositoryId('r_1'),
  ...over,
})

const population = (over: Partial<TriggerPopulation> = {}): TriggerPopulation => ({
  decided: 10,
  discarded: 0,
  recurringCheck: null,
  ...over,
})

const deps = (over: {
  candidates?: TriggerCandidate[]
  population?: TriggerPopulation
  settledAt?: Date | null
  runningSession?: boolean
  start?: EvolutionTriggerDeps['startProposer']
}) => {
  const record = vi.fn(
    async (_input: { action: string; metadata?: Record<string, unknown> }) => {},
  )
  const triggerPopulation = vi.fn(async () => over.population ?? population())
  const lastMeasurementSettledAt = vi.fn(async () => over.settledAt ?? null)
  const startProposer =
    over.start ??
    vi.fn(async () => ({
      ok: true as const,
      run: { id: asAgentRunId('run_1') } as never,
    }))

  return {
    deps: {
      agentRuns: {
        listTriggerCandidates: vi.fn(async () => over.candidates ?? [candidate()]),
        triggerPopulation,
      },
      personaVariants: {
        lastMeasurementSettledAt,
        hasRunningProposerSession: vi.fn(async () => over.runningSession ?? false),
      },
      audit: { record },
      startProposer,
    } as unknown as EvolutionTriggerDeps,
    record,
    triggerPopulation,
    lastMeasurementSettledAt,
    startProposer,
  }
}

const options = {
  enabled: true,
  maxStartsPerTick: 1,
  maxCandidates: 50,
}

describe('advanceEvolutionTriggers', () => {
  /** Off is off: the flag is an operator's consent to autonomous spend, not a feature gate. */
  it('reads nothing at all when it is disabled', async () => {
    const { deps: d, startProposer } = deps({})
    const result = await advanceEvolutionTriggers(d, { ...options, enabled: false })
    expect(result).toEqual({ considered: 0, fired: 0, held: 0, refused: 0 })
    expect(d.agentRuns.listTriggerCandidates).not.toHaveBeenCalled()
    expect(startProposer).not.toHaveBeenCalled()
  })

  it('fires a session for a persona whose discards have crossed, and audits the population', async () => {
    const { deps: d, record, startProposer } = deps({
      population: population({ discarded: 4, decided: 9 }),
    })
    const result = await advanceEvolutionTriggers(d, options)

    expect(result.fired).toBe(1)
    expect(startProposer).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: PERSONA, source: 'taste-record' }),
    )
    const entry = record.mock.calls[0]?.[0]
    expect(entry?.action).toBe('persona.trigger_fired')
    // The population travels into the row, because these thresholds are a prior that only real
    // firings can correct.
    expect(entry?.metadata).toMatchObject({
      decided: 9,
      discarded: 4,
      signal: 'discarded-dispositions',
    })
  })

  it('holds without starting anything when nothing has crossed', async () => {
    const { deps: d, record, startProposer } = deps({ population: population({ discarded: 1 }) })
    const result = await advanceEvolutionTriggers(d, options)
    expect(result).toMatchObject({ fired: 0, held: 1 })
    expect(startProposer).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  /**
   * A persona with no envelope is skipped *before* it is counted, so the held count means
   * "considered and not due" rather than "could never have been due".
   */
  it('skips a persona nothing may rewrite, without reading its window', async () => {
    const { deps: d, triggerPopulation } = deps({
      candidates: [candidate({ markdownSource: NO_ENVELOPE })],
      population: population({ discarded: 9 }),
    })
    const result = await advanceEvolutionTriggers(d, options)
    expect(result).toMatchObject({ considered: 1, fired: 0, held: 0 })
    expect(triggerPopulation).not.toHaveBeenCalled()
  })

  /** A document a human has to fix is not the sweep's business, and must not stop the tick. */
  it('skips an unparseable persona and keeps sweeping', async () => {
    const { deps: d, startProposer } = deps({
      candidates: [candidate({ markdownSource: 'not a persona' }), candidate()],
      population: population({ discarded: 5 }),
    })
    const result = await advanceEvolutionTriggers(d, options)
    expect(result.fired).toBe(1)
    expect(startProposer).toHaveBeenCalledTimes(1)
  })

  /** The window is "since the last verdict", so the settlement has to reach the count. */
  it('bounds the window by the last settled measurement', async () => {
    const settledAt = new Date('2026-09-01T00:00:00Z')
    const { deps: d, triggerPopulation } = deps({ settledAt })
    await advanceEvolutionTriggers(d, options)
    expect(triggerPopulation).toHaveBeenCalledWith(WS, 'swe', settledAt)
  })

  /**
   * The gate and the use case disagreeing about one persona is the most interesting thing this
   * sweep produces, and silence would make it indistinguishable from a quiet workspace.
   */
  it('records a refused start rather than swallowing it', async () => {
    const { deps: d, record } = deps({
      population: population({ discarded: 5 }),
      start: vi.fn(async () => ({ ok: false as const, reason: 'A measurement is already running' })),
    })
    const result = await advanceEvolutionTriggers(d, options)
    expect(result).toMatchObject({ fired: 0, refused: 1 })
    const entry = record.mock.calls[0]?.[0]
    expect(entry?.action).toBe('persona.trigger_refused')
    expect(entry?.metadata?.reason).toContain('already running')
  })

  it('stops at the start budget even with more due personas', async () => {
    const { deps: d, startProposer } = deps({
      candidates: [
        candidate({ personaId: asAgentPersonaId('p_a') }),
        candidate({ personaId: asAgentPersonaId('p_b') }),
        candidate({ personaId: asAgentPersonaId('p_c') }),
      ],
      population: population({ discarded: 6 }),
    })
    const result = await advanceEvolutionTriggers(d, { ...options, maxStartsPerTick: 2 })
    expect(result.fired).toBe(2)
    expect(startProposer).toHaveBeenCalledTimes(2)
  })
})

/**
 * The re-fire guard, which the end-to-end test found missing.
 *
 * A proposer session is a run, and the search it opens does not exist until that run submits
 * candidates — so "is a measurement open" answers no for the whole life of the session, and a
 * sweep on a thirty-second timer would start one per tick.
 */
describe('advanceEvolutionTriggers — while a session is already working', () => {
  it('skips a persona whose proposer session is still running', async () => {
    const { deps: d, startProposer, triggerPopulation } = deps({
      population: population({ discarded: 9 }),
      runningSession: true,
    })
    const result = await advanceEvolutionTriggers(d, {
      enabled: true,
      maxStartsPerTick: 1,
      maxCandidates: 50,
    })
    expect(result).toMatchObject({ considered: 1, fired: 0, held: 0, refused: 0 })
    expect(startProposer).not.toHaveBeenCalled()
    // Checked before the window is read: the counts cannot matter yet.
    expect(triggerPopulation).not.toHaveBeenCalled()
  })
})
