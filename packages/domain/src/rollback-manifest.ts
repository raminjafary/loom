/**
 * The previously-passing manifest, and what it means for one to regress.
 *
 * Phase 3b's list has one unbuilt item and it is the gate on tiers 3 and 4: *a scripted exercise
 * that promotes a knowingly-broken self-modification and recovers from it without the modified
 * code participating*. As written that was a sentence with no buildable content, which is why the
 * tiers stayed off rather than being worked on. **Self-Harness** (arXiv 2606.09498) supplies the
 * missing half: its third stage validates a proposed change against **tasks that previously
 * passed**, so a fix cannot regress what already worked.
 *
 * The drill's own first step is the thing that has to be able to fail: *a previously-passing
 * manifest — which drivers and which definition-of-done checks pass, at which commit, recorded as
 * an artifact rather than as folklore*. This module is that artifact's shape and the comparison
 * that reads it. The script that produces one and the recovery that uses it live in
 * `tools/rollback-drill.mts`, because they need processes and git.
 *
 * ## The three decisions here
 *
 * - **A check that no longer runs is a regression.** Absence is the failure mode this repository
 *   has actually shipped — a boundary test that had been failing on nothing for an unknown number
 *   of sessions, a `mastery` field dropped across a port with no type error. A manifest that
 *   compared only the checks it was handed would pass a modification that deleted the check that
 *   would have caught it.
 * - **The manifest records failures too, and they are not regressions.** A check that was already
 *   failing says nothing about a modification, and treating it as a regression would make
 *   every drill un-runnable on a repository with one known-broken check. This is the rule
 *   about `skipped` and `refused`, one level up.
 * - **Recovery is "everything that passed passes again", not "nothing fails".** A recovery that
 *   also had to fix a pre-existing failure would be a drill nobody could pass, and a recovery
 *   judged on "no failures now" would be satisfied by a revert that deleted the checks.
 */

/** The own vocabulary, because a drill's checks are the definition of done plus the drivers. */
export type ManifestCheckStatus = 'passed' | 'failed'

export interface ManifestCheck {
  /**
   * What ran. Names rather than indices, because the whole point of the named checks is
   * that "failed" is unactionable and "the boundary guard failed" is a next action.
   */
  readonly name: string
  readonly status: ManifestCheckStatus
  /** Tail of the output, and only the tail. Null when there was nothing to keep. */
  readonly detail: string | null
}

export interface RollbackManifest {
  /**
   * The commit of Loom's **own** source these results are about.
   *
   * Load-bearing rather than provenance: it is what the recovering process is pinned at,
   * which is the only reason "without the modified code participating" is a structural
   * property and not a promise. A manifest with no commit is the same rumour mastery
   * refuses in a map.
   */
  readonly commit: string
  readonly recordedAt: Date
  readonly checks: readonly ManifestCheck[]
}

export type ManifestVerdictKind =
  /** Passed before and passes now. */
  | 'held'
  /** Passed before and does not now — the drill's positive result. */
  | 'regressed'
  /** Passed before and is **absent** now. A check that cannot run cannot be said to pass. */
  | 'missing'
  /** Failed before and still fails. Not a regression; not a pass either. */
  | 'still-failing'
  /** Failed before and passes now. Worth saying, and not what a drill is looking for. */
  | 'fixed'
  /** Not in the manifest at all. Reported so a drill cannot quietly grow its own scope. */
  | 'new'

export interface ManifestVerdictEntry {
  readonly name: string
  readonly kind: ManifestVerdictKind
  readonly was: ManifestCheckStatus | null
  readonly now: ManifestCheckStatus | null
  readonly detail: string | null
}

export interface ManifestVerdict {
  readonly entries: readonly ManifestVerdictEntry[]
  /**
   * The checks that passed at the manifest's commit and do not now — regressed or missing
   * together, because for the drill's purpose "it fails" and "it is gone" are the same loss.
   */
  readonly regressions: readonly ManifestVerdictEntry[]
  /**
   * True when every check that passed at the manifest's commit passes again.
   *
   * Deliberately not "nothing fails": a repository with one known-broken check would make the
   * drill unpassable, and a recovery judged on no-failures-now is satisfied by a revert that
   * deleted the checks.
   */
  readonly recovered: boolean
  /** One line a script can print and a human can act on. Names the checks, never a count alone. */
  readonly detail: string
}

const kindOf = (
  was: ManifestCheckStatus | null,
  now: ManifestCheckStatus | null,
): ManifestVerdictKind => {
  if (was === null) return 'new'
  if (now === null) return 'missing'
  if (was === 'passed') return now === 'passed' ? 'held' : 'regressed'
  return now === 'passed' ? 'fixed' : 'still-failing'
}

/**
 * Compares an observed run of the checks against what the manifest recorded.
 *
 * Deterministic ordering — the manifest's order, then anything new by name — so two comparisons
 * of the same pair produce the same report. A drill whose output changed between runs is one
 * nobody can diff.
 */
export const compareToManifest = (
  manifest: RollbackManifest,
  observed: readonly ManifestCheck[],
): ManifestVerdict => {
  const observedByName = new Map(observed.map((check) => [check.name, check]))
  const entries: ManifestVerdictEntry[] = []

  for (const recorded of manifest.checks) {
    const seen = observedByName.get(recorded.name) ?? null
    entries.push({
      name: recorded.name,
      kind: kindOf(recorded.status, seen?.status ?? null),
      was: recorded.status,
      now: seen?.status ?? null,
      detail: seen?.detail ?? null,
    })
  }

  const recordedNames = new Set(manifest.checks.map((check) => check.name))
  for (const check of [...observed].sort((a, b) => a.name.localeCompare(b.name))) {
    if (recordedNames.has(check.name)) continue
    entries.push({
      name: check.name,
      kind: 'new',
      was: null,
      now: check.status,
      detail: check.detail,
    })
  }

  const regressions = entries.filter(
    (entry) => entry.kind === 'regressed' || entry.kind === 'missing',
  )
  const passedBefore = manifest.checks.filter((check) => check.status === 'passed').length

  const detail = describe({ regressions, entries, passedBefore, commit: manifest.commit })
  return { entries, regressions, recovered: regressions.length === 0, detail }
}

const describe = (input: {
  regressions: readonly ManifestVerdictEntry[]
  entries: readonly ManifestVerdictEntry[]
  passedBefore: number
  commit: string
}): string => {
  const short = input.commit.slice(0, 12)
  if (input.regressions.length === 0) {
    const fixed = input.entries.filter((entry) => entry.kind === 'fixed').length
    const stillFailing = input.entries.filter((entry) => entry.kind === 'still-failing').length
    const clauses = [
      `all ${input.passedBefore} checks that passed at ${short} pass again`,
      ...(fixed > 0 ? [`${fixed} that had been failing now pass`] : []),
      ...(stillFailing > 0
        ? [`${stillFailing} was already failing at ${short} and still is, which this drill says nothing about`]
        : []),
    ]
    return `${clauses.join('; ')}.`
  }

  const named = input.regressions
    .map((entry) => (entry.kind === 'missing' ? `${entry.name} (did not run)` : entry.name))
    .join(', ')
  return (
    `${input.regressions.length} of ${input.passedBefore} checks that passed at ${short} no ` +
    `longer do: ${named}.`
  )
}

/**
 * Whether a set of results is fit to be recorded as a manifest.
 *
 * A manifest of nothing is the failure this whole artifact exists to prevent: the drill's first
 * step is *"this is what the drill has to fail, and nothing today can fail"*, and an empty
 * manifest cannot fail, so recording one would produce a drill that passes by construction.
 * Duplicate names are refused for the neighbouring reason — two entries for one name make a
 * comparison read whichever came last.
 */
export type ManifestRule = 'empty' | 'nothing-passed' | 'duplicate-name' | 'no-commit'

export type ManifestVerdictResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: ManifestRule; readonly reason: string }

export const validateManifest = (input: {
  readonly commit: string
  readonly checks: readonly ManifestCheck[]
}): ManifestVerdictResult => {
  if (input.commit.trim().length === 0) {
    return {
      ok: false,
      rule: 'no-commit',
      reason:
        'A manifest with no commit cannot be recovered from: the commit is what the recovering ' +
        'process is pinned at, which is the only reason the modified code cannot participate.',
    }
  }
  if (input.checks.length === 0) {
    return {
      ok: false,
      rule: 'empty',
      reason:
        'An empty manifest cannot fail, so a drill using it would pass by construction — which ' +
        'is exactly the "check that always passes" this repository has shipped before.',
    }
  }
  const names = new Set<string>()
  for (const check of input.checks) {
    if (names.has(check.name)) {
      return {
        ok: false,
        rule: 'duplicate-name',
        reason:
          `Two checks are both called "${check.name}". A comparison would read whichever came ` +
          'last, so one of the two would be silently unguarded.',
      }
    }
    names.add(check.name)
  }
  if (!input.checks.some((check) => check.status === 'passed')) {
    return {
      ok: false,
      rule: 'nothing-passed',
      reason:
        'No check passed, so there is nothing for a modification to regress and nothing for a ' +
        'recovery to restore. Fix the repository before recording a manifest of it.',
    }
  }
  return { ok: true }
}
