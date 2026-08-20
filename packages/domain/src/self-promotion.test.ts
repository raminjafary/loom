import { describe, expect, it } from 'vitest'
import type { ManifestCheck, RollbackManifest } from './rollback-manifest.js'
import {
  promoteSelfRevision,
  rollbackSelfRevision,
  type SelfDeployment,
  type SelfRevision,
} from './self-promotion.js'

/**
 * The gate on tiers 3 and 4.
 *
 * Most of these assert a refusal, and that is the shape of the thing: the four tiers below this
 * one change configuration, and this one changes the program. The interesting question is never
 * "does a good revision promote" — it is which bad ones are stopped, and by a rule rather than
 * by whoever is watching.
 */

const RUNNING = 'a'.repeat(40)
const CANDIDATE = 'b'.repeat(40)
const OLDER = 'c'.repeat(40)

const revision = (commit: string, over: Partial<SelfRevision> = {}): SelfRevision => ({
  commit,
  builtAt: new Date(0),
  retained: true,
  health: 'healthy',
  ...over,
})

const MANIFEST: RollbackManifest = {
  commit: RUNNING,
  recordedAt: new Date(0),
  checks: [
    { name: 'typecheck', status: 'passed', detail: null },
    { name: 'the boundary guard', status: 'passed', detail: null },
  ],
}

const OBSERVED: ManifestCheck[] = [
  { name: 'typecheck', status: 'passed', detail: null },
  { name: 'the boundary guard', status: 'passed', detail: null },
]

const promote = (over: {
  enabled?: boolean
  deployment?: SelfDeployment
  candidate?: SelfRevision
  ancestors?: readonly string[]
  observed?: readonly ManifestCheck[]
} = {}) =>
  promoteSelfRevision({
    enabled: over.enabled ?? true,
    deployment: over.deployment ?? { running: revision(RUNNING), previous: null },
    candidate: over.candidate ?? revision(CANDIDATE),
    ancestors: over.ancestors ?? [RUNNING, OLDER],
    manifest: MANIFEST,
    observed: over.observed ?? OBSERVED,
  })

const refusal = (verdict: ReturnType<typeof promote>) => {
  expect(verdict.ok).toBe(false)
  if (verdict.ok) throw new Error('expected a refusal')
  return verdict
}

describe('promoteSelfRevision', () => {
  it('promotes a healthy descendant whose checks all still pass, and keeps the way back', () => {
    const verdict = promote()
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.next.running.commit).toBe(CANDIDATE)
    expect(verdict.next.previous?.commit).toBe(RUNNING)
    expect(verdict.detail).toContain('is kept as the way back')
  })

  /**
   * Exactly one previous revision, so the revision that was the way back before this promotion
   * is named as releasable rather than left for a caller to work out.
   */
  it('releases the revision that is no longer reachable by a rollback', () => {
    const verdict = promote({
      deployment: { running: revision(RUNNING), previous: revision(OLDER) },
    })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.releasable).toEqual([OLDER])
  })

  /**
   * The permission first, before any shape check. A deployment with this switched off has to
   * hear the same sentence whatever it asked for, or the refusal doubles as a probe for what
   * would have been allowed.
   */
  it('refuses when self-promotion is off, whatever else is wrong', () => {
    const verdict = refusal(
      promote({
        enabled: false,
        candidate: revision(CANDIDATE, { retained: false, health: 'unhealthy' }),
        ancestors: [],
      }),
    )
    expect(verdict.rule).toBe('disabled')
    expect(verdict.reason).toContain('a real off switch')
  })

  /**
   * The rule a passing manifest cannot enforce, which is why it is checked before the checks: a
   * manifest reports what still passes and has no way to report a commit that was not there.
   */
  it('refuses a candidate that does not contain what is running, even with every check green', () => {
    const verdict = refusal(promote({ ancestors: [OLDER] }))
    expect(verdict.rule).toBe('not-a-descendant')
    expect(verdict.reason).toContain('silently undo everything between')
  })

  it('refuses to promote what is already serving', () => {
    const verdict = refusal(promote({ candidate: revision(RUNNING) }))
    expect(verdict.rule).toBe('already-running')
    expect(verdict.reason).toContain('cost the way back')
  })

  it('refuses a revision with no build on disk, because promotion never builds', () => {
    const verdict = refusal(promote({ candidate: revision(CANDIDATE, { retained: false }) }))
    expect(verdict.rule).toBe('unbuilt')
  })

  /**
   * The failure the manifest is blindest to: well-typed code that does not start. Asserted with
   * every check passing, so nothing else could be producing the refusal.
   */
  it('refuses a revision that has never answered as a running process', () => {
    expect(refusal(promote({ candidate: revision(CANDIDATE, { health: 'unchecked' }) })).rule).toBe(
      'unhealthy',
    )
    expect(refusal(promote({ candidate: revision(CANDIDATE, { health: 'unhealthy' }) })).rule).toBe(
      'unhealthy',
    )
  })

  it('refuses a revision that loses a check which used to pass', () => {
    const verdict = refusal(
      promote({
        observed: [
          { name: 'typecheck', status: 'passed', detail: null },
          { name: 'the boundary guard', status: 'failed', detail: 'expected 1, got 0' },
        ],
      }),
    )
    expect(verdict.rule).toBe('regressed')
    expect(verdict.reason).toContain('the boundary guard')
  })

  /**
   * And absence counts the same as failure. A modification that deleted the check which would
   * have caught it is the failure mode this repository has actually shipped.
   */
  it('counts a check that no longer runs as a loss, not as a pass', () => {
    const verdict = refusal(
      promote({ observed: [{ name: 'typecheck', status: 'passed', detail: null }] }),
    )
    expect(verdict.rule).toBe('regressed')
    expect(verdict.reason).toContain('did not run')
    expect(verdict.reason).toContain('absence is how a self-modification hides')
  })

  /**
   * A check that was already failing is not a regression — otherwise a repository with one
   * known-broken check could never promote anything.
   */
  it('promotes over a check that was already failing before', () => {
    const verdict = promoteSelfRevision({
      enabled: true,
      deployment: { running: revision(RUNNING), previous: null },
      candidate: revision(CANDIDATE),
      ancestors: [RUNNING],
      manifest: {
        commit: RUNNING,
        recordedAt: new Date(0),
        checks: [
          { name: 'typecheck', status: 'passed', detail: null },
          { name: 'a flaky driver', status: 'failed', detail: null },
        ],
      },
      observed: [
        { name: 'typecheck', status: 'passed', detail: null },
        { name: 'a flaky driver', status: 'failed', detail: null },
      ],
    })
    expect(verdict.ok).toBe(true)
  })

  it('refuses to promote over a revision whose build is gone, since that has no way back', () => {
    const verdict = refusal(
      promote({ deployment: { running: revision(RUNNING, { retained: false }), previous: null } }),
    )
    expect(verdict.rule).toBe('no-way-back')
    expect(verdict.reason).toContain('a pointer to nothing')
  })

  /** The first promotion on a deployment that has never had one says so rather than implying a target. */
  it('promotes onto a deployment that has never promoted, and says there is no way back yet', () => {
    const verdict = promote({ deployment: { running: null, previous: null }, ancestors: [] })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.next.previous).toBeNull()
    expect(verdict.detail).toContain('nothing to roll back to yet')
  })
})

describe('rollbackSelfRevision', () => {
  it('puts the previous revision back and releases the one it rejected', () => {
    const verdict = rollbackSelfRevision({
      deployment: { running: revision(CANDIDATE), previous: revision(RUNNING) },
    })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.next.running.commit).toBe(RUNNING)
    expect(verdict.releasable).toEqual([CANDIDATE])
  })

  /**
   * The one thing a rollback must never be able to do. Left as a target, a second rollback would
   * mean "put the broken one back".
   */
  it('leaves nothing to roll back to, so the rejected revision cannot return by this gesture', () => {
    const first = rollbackSelfRevision({
      deployment: { running: revision(CANDIDATE), previous: revision(RUNNING) },
    })
    if (!first.ok) throw new Error(first.reason)
    expect(first.next.previous).toBeNull()
    const second = rollbackSelfRevision({ deployment: first.next })
    expect(second.ok).toBe(false)
  })

  it('refuses when nothing was ever promoted here', () => {
    const verdict = rollbackSelfRevision({ deployment: { running: null, previous: null } })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('expected a refusal')
    expect(verdict.rule).toBe('not-serving')
  })

  /** A recorded predecessor whose build is gone is not a target, and the refusal names the drill. */
  it('refuses when the way back is recorded but its build is gone', () => {
    const verdict = rollbackSelfRevision({
      deployment: {
        running: revision(CANDIDATE),
        previous: revision(RUNNING, { retained: false }),
      },
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('expected a refusal')
    expect(verdict.rule).toBe('nothing-retained')
    expect(verdict.reason).toContain('the drill')
  })
})
