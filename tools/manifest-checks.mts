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
 * ## What is in the list, in two tiers
 *
 * The live drivers were this list's natural material and were left out of it, on the argument
 * that every one needs a live server, a Runner process and model access, and that a gate needing
 * all three is a gate that gets switched off. Two thirds of that turned out to be wrong. The
 * drivers **build their own server and spawn their own Runner** — that is what makes them
 * drivers rather than tests — so the only real dependency is the compose stack, which is one
 * command, and model access, which the zero-token ones do not need at all.
 *
 * So there are two tiers:
 *
 * - **static** — the platform's guarantees and its infrastructure-free suites. Seconds. The
 *   default, because the drill is run by hand and often.
 * - **live** — the zero-token drivers, each of which stands up everything it needs given
 *   Postgres and Valkey, plus the two that ask the container daemon whether the sandbox
 *   isolation is real. Minutes: `workflow-check` alone is two of them, which is the honest
 *   reason this is a tier and not simply more rows.
 *
 * **The tier is shared state, read from one place**, because the rule that made this file exist
 * still holds: a promoter gating on a wider set than the drill rehearses would refuse promotions
 * for a class of breakage nobody has rehearsed recovering from. Set `LOOM_MANIFEST_TIER=live`
 * and both callers widen together.
 *
 * What is still absent, and stated rather than implied: every driver that spends tokens. A gate
 * that costs money per invocation is a gate someone turns off, and that argument was always the
 * true one — it just never applied to the twenty-odd drivers that spend nothing.
 */
/**
 * What a check needs from the host beyond the tree.
 *
 * `stack` is Postgres and Valkey — everything else a driver needs, it starts itself. `sandbox`
 * is the container daemon's side of it: the egress proxy, the agent image, and per-run networks
 * left on. Absent means the check needs nothing but the tree, which is what makes the static
 * tier the tier it is.
 */
export type ManifestPrerequisite = 'stack' | 'sandbox'

export type ManifestTier = 'static' | 'live'

export interface ManifestCheckSpec {
  readonly name: string
  readonly command: string
  /**
   * What this check cannot run without — see `ManifestPrerequisite`.
   *
   * Absent means it needs nothing but the tree, which is what makes the static tier the tier
   * that can run anywhere, including inside a worktree pinned at another commit.
   */
  readonly needs?: ManifestPrerequisite
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

  /**
   * The live tier. Every one of these spends nothing, builds its own server, spawns its own
   * Runner where it needs one, and asserts rather than prints — which is what makes them
   * usable as a gate at all. `requires` is the same distinction it is above: a driver the
   * modification *deleted* is a check that cannot answer, not a check that failed.
   */
  {
    name: 'workflow-driver',
    command: 'npx tsx tools/workflow-check.mts',
    requires: 'tools/workflow-check.mts',
    needs: 'stack',
  },
  {
    name: 'designer-driver',
    command: 'npx tsx tools/designer-check.mts',
    requires: 'tools/designer-check.mts',
    needs: 'stack',
  },
  {
    name: 'trial-driver',
    command: 'npx tsx tools/trial-check.mts',
    requires: 'tools/trial-check.mts',
    needs: 'stack',
  },
  {
    name: 'backend-driver',
    command: 'npx tsx tools/backend-check.mts',
    requires: 'tools/backend-check.mts',
    needs: 'stack',
  },
  {
    name: 'persona-share-driver',
    command: 'npx tsx tools/persona-share-check.mts',
    requires: 'tools/persona-share-check.mts',
    needs: 'stack',
  },
  {
    name: 'browser',
    command: 'npx tsx tools/browser-check.mts',
    requires: 'tools/browser-check.mts',
    needs: 'stack',
  },
  /**
   * The prosecutor's plumbing, and the three negatives the whole pass rests on: a verdict that
   * must not move, a run that must not change, a merge that must not be blocked. It belongs
   * here for the reason the six above do — zero tokens, its own server, its own Runner, and it
   * asserts — and it was left out when it was written.
   */
  {
    name: 'prosecutor-driver',
    command: 'npx tsx tools/prosecutor-check.mts',
    requires: 'tools/prosecutor-check.mts',
    needs: 'stack',
  },

  /**
   * The sandbox tier: the two drivers that ask the **container daemon** questions rather than
   * this repository's own code. Neither needs Postgres; both need a proxy, an image and per-run
   * networks left on, which is why `needs` is a kind rather than a flag.
   *
   * They are the only checks in the manifest that can say the isolation is real. Everything
   * else here would pass unchanged on a host where every sandbox shared one network and could
   * open a socket to its neighbour by name — which is precisely the property a promotion should
   * not be allowed to lose quietly.
   */
  {
    name: 'sandbox-network',
    command: 'npx tsx tools/sandbox-network-check.mts',
    requires: 'tools/sandbox-network-check.mts',
    needs: 'sandbox',
  },
  {
    name: 'sandbox-load',
    command: 'npx tsx tools/sandbox-load-check.mts',
    requires: 'tools/sandbox-load-check.mts',
    needs: 'sandbox',
  },
]

/**
 * Which tier both callers are on. One reader, so the drill and the promoter cannot silently
 * disagree about what a passing manifest means.
 */
export const manifestTier = (env: NodeJS.ProcessEnv = process.env): ManifestTier =>
  env.LOOM_MANIFEST_TIER === 'live' ? 'live' : 'static'

export const checksForTier = (tier: ManifestTier): readonly ManifestCheckSpec[] =>
  tier === 'live' ? MANIFEST_CHECKS : MANIFEST_CHECKS.filter((entry) => entry.needs === undefined)

export const selectChecks = (
  names: string | null,
  tier: ManifestTier = manifestTier(),
): readonly ManifestCheckSpec[] => {
  // A check named outright is a check the operator wants run, whatever tier it is in.
  if (names === null) return checksForTier(tier)
  const wanted = names.split(',').map((name) => name.trim())
  return MANIFEST_CHECKS.filter((entry) => wanted.includes(entry.name))
}

const runningServices = async (): Promise<string[]> => {
  const { stdout } = await execFileAsync('docker', [
    'compose', 'ps', '--services', '--filter', 'status=running',
  ])
  return stdout.split('\n').map((line) => line.trim())
}

/**
 * Whether the stack the live tier needs is actually up.
 *
 * Probed rather than assumed, and the caller **refuses** rather than narrowing: a manifest that
 * quietly dropped six checks because Postgres was down would record a clean run and compare a
 * candidate against it, which is the shape of every failure this file exists to prevent.
 */
export const stackIsUp = async (): Promise<boolean> => {
  try {
    const running = await runningServices()
    return running.includes('postgres') && running.includes('valkey')
  } catch {
    return false
  }
}

/**
 * Whether this host can answer the sandbox questions at all.
 *
 * Three conditions, and each is a way the drivers would fail as something they are not. Without
 * the egress proxy there is nothing to attach to a per-run network, and the failure reads as
 * broken isolation. Without the image there is nothing to probe with, and `docker run` fails
 * with a pull error. And under `LOOM_SANDBOX_NETWORK_MODE=shared` both drivers refuse by
 * design and exit non-zero — which is a host that cannot answer the question, not a host that
 * answered it badly, and a manifest that recorded it as a failure would be recording the
 * operator's topology choice as a defect.
 *
 * What is deliberately *not* checked is whether the image is current. The Runner's closure
 * guard refuses a stale one at run time with a message naming the rebuild, and a check that
 * silently accepted a stale image would be worse than one that fails loudly.
 */
export const sandboxIsUp = async (): Promise<boolean> => {
  if ((process.env.LOOM_SANDBOX_NETWORK_MODE ?? '') === 'shared') return false
  try {
    if (!(await runningServices()).includes('egress-proxy')) return false
    const { stdout } = await execFileAsync('docker', [
      'images', '--format', '{{.Repository}}:{{.Tag}}', 'loom-agent-sandbox',
    ])
    return stdout.trim() !== ''
  } catch {
    return false
  }
}

/**
 * What the selected checks need and this host does not have, as sentences a person can act on.
 *
 * One reader, for the reason `manifestTier` is one: the drill and the promoter had the same
 * ten lines each, and a second prerequisite would have been a second place for them to
 * disagree about what a runnable manifest is.
 */
export const missingPrerequisites = async (
  selected: readonly ManifestCheckSpec[],
): Promise<string[]> => {
  const needed = new Set(
    selected.map((entry) => entry.needs).filter((need): need is ManifestPrerequisite => need !== undefined),
  )
  const missing: string[] = []
  if (needed.has('stack') && !(await stackIsUp())) {
    missing.push(
      'Postgres or Valkey is not running:\n' +
        '  docker compose up -d postgres valkey && pnpm db:test:prepare',
    )
  }
  if (needed.has('sandbox') && !(await sandboxIsUp())) {
    missing.push(
      'the sandbox prerequisites are not met — the egress proxy must be running, the agent\n' +
        'image must exist, and per-run networks must not be turned off:\n' +
        '  docker compose up -d egress-proxy\n' +
        '  docker build -f apps/runner/Dockerfile.sandbox -t loom-agent-sandbox:latest .\n' +
        '  unset LOOM_SANDBOX_NETWORK_MODE',
    )
  }
  return missing
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
