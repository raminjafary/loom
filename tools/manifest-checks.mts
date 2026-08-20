import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ManifestCheck } from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)

/**
 * The checks a manifest is made of, and how to run them against a given tree.
 *
 * Shared by the two things that need them, which is the whole reason this file exists: the
 * rollback drill records a manifest at a known-good commit and compares a deliberately-broken
 * tree against it, and the promoter records one at the revision that is serving and compares a
 * *candidate* revision against it. Those are the same list by necessity rather than by
 * coincidence — a promoter that gated on a narrower set than the drill rehearses would be
 * rehearsing a recovery from a class of breakage it does not actually check for.
 *
 * ## What is in the list, and the part that is stated rather than implied
 *
 * The 21 live drivers are this list's natural material and they are not here: every one needs a
 * live server, a Runner process and model access, and a gate that needs all three is a gate that
 * gets switched off. So the manifest covers the platform's static guarantees and its
 * infrastructure-free suites, and both callers say so rather than implying coverage they do not
 * have. Individual checks can be selected with `--check`.
 */
export interface ManifestCheckSpec {
  readonly name: string
  readonly command: string
  /**
   * Repo-relative path the check needs.
   *
   * What makes "the modification deleted the check" a *different* outcome from "the check
   * failed". Without it, running a vitest file that no longer exists exits non-zero and reads as
   * a failure — which is nearly right and loses the distinction the comparison is built on:
   * absent is a check that cannot answer, and it is how a self-modification hides.
   */
  readonly requires?: string
}

export const MANIFEST_CHECKS: readonly ManifestCheckSpec[] = [
  { name: 'typecheck', command: 'pnpm typecheck' },
  { name: 'lint', command: 'pnpm lint' },
  {
    name: 'boundary',
    command: 'npx vitest run tools/architecture.test.ts',
    requires: 'tools/architecture.test.ts',
  },
  {
    name: 'domain-suite',
    command: 'npx vitest run packages/domain',
    requires: 'packages/domain/src/index.ts',
  },
]

export const selectChecks = (names: string | null): readonly ManifestCheckSpec[] => {
  if (names === null) return MANIFEST_CHECKS
  const wanted = names.split(',').map((name) => name.trim())
  return MANIFEST_CHECKS.filter((entry) => wanted.includes(entry.name))
}

const tail = (text: string, lines = 4): string | null => {
  const kept = text.trimEnd().split('\n').slice(-lines).join('\n')
  return kept.length === 0 ? null : kept
}

/**
 * Runs one check in `cwd`, or reports it absent.
 *
 * **Turbo's cache is forced off.** `pnpm typecheck` and `pnpm lint` cache by input hash, and both
 * callers compare a tree against results recorded for a very similar one — so a cached "pass"
 * would be reported for a check that never ran, which is precisely the failure a manifest exists
 * to be able to detect.
 */
export const runManifestCheck = async (
  entry: ManifestCheckSpec,
  cwd: string,
): Promise<ManifestCheck | null> => {
  if (entry.requires !== undefined && !existsSync(join(cwd, entry.requires))) return null
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', entry.command], {
      cwd,
      env: { ...process.env, TURBO_FORCE: '1', CI: '1' },
      maxBuffer: 64 * 1024 * 1024,
    })
    return { name: entry.name, status: 'passed', detail: tail(stdout + stderr) }
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string; message?: string }
    return {
      name: entry.name,
      status: 'failed',
      detail: tail(`${output.stdout ?? ''}${output.stderr ?? ''}` || (output.message ?? '')),
    }
  }
}

/** Every selected check against one tree, printing each as it lands. */
export const observeChecks = async (
  selected: readonly ManifestCheckSpec[],
  cwd: string,
): Promise<ManifestCheck[]> => {
  const results: ManifestCheck[] = []
  for (const entry of selected) {
    const result = await runManifestCheck(entry, cwd)
    console.log(`       ${entry.name}: ${result === null ? 'absent' : result.status}`)
    if (result !== null) results.push(result)
  }
  return results
}
