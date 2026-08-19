import {
  planVerification,
  type VerificationCheck,
  type VerificationCheckResult,
  type VerificationPlan,
} from '@loom/domain'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DEP_CACHE_DIR, depCacheEnv, depCacheFromEnv, prepareDepCache } from './dep-cache.js'
import {
  sandboxConfigFromEnv,
  sandboxEnabled,
  unsandboxedAcknowledged,
  type SandboxConfig,
} from './sandbox.js'

const execFileAsync = promisify(execFile)

/**
 * The verification harness's host side: run a repository's
 * definition of done against a clone and report what each check did.
 *
 * The policy — whether verification may run at all, in what order, and what the verdict
 * is — is `packages/domain/src/verification.ts`; this is the processes. Two callers:
 * the merge queue, against a rebased branch, and a finished run, against its own.
 *
 * Extracted from `merge.ts`, where it used to be one command inline. The extraction is
 * the point rather than tidiness: the merge queue and a finished run must execute the
 * *same* definition of done, and a second copy of the sandbox arguments is a second
 * place the `--network none` could quietly stop being there.
 */

const VERIFY_TIMEOUT_MS = Number(process.env.LOOM_MERGE_VERIFY_TIMEOUT_MS ?? 600_000)

/**
 * Last few lines only — a thread message is not the place for a full test log.
 *
 * Stack frames are dropped *before* the window is taken, and that is the whole point
 * rather than tidiness. A failing `node --test` prints the assertion message, then the
 * frames, then a dump of the error object — so the last twelve lines are frames and
 * field names, and the one sentence saying what failed sits just above the cut. Live,
 * that turned the queue catching a wrong reconcile into a thread message that opened
 * `at TestContext.<anonymous>` and never said why. Every runner puts its frames in this
 * shape and none of them carry information a human reading a failure needs.
 */
export const tail = (text: string, lines = 12): string =>
  text
    .trim()
    .split('\n')
    .filter((line) => !/^\s+at\s/.test(line))
    .slice(-lines)
    .join('\n')
    .slice(0, 4_000)

/**
 * The container a verification command runs in.
 *
 * Tighter than a run gets: `--network none` outright, because verification needs no
 * model API and therefore no egress proxy — the one reason the sandbox settles for
 * an internal network instead.
 *
 * **The dependency cache is what makes that isolation affordable**. With
 * no network and nothing but a `git clone` in the container, a verification command
 * could only ever run what was already committed — which rules out every project whose
 * test suite needs an install step, which is most of them. Measured, that made
 * `verifyCommand` unusable on real repositories and quietly reduced the safety net to
 * "merged unverified and said so". Mounting the warmed cache leaves the network closed
 * and lets an offline install succeed, so the operator's command can be
 * `npm ci --offline && npm test` rather than nothing.
 *
 * In the default `copy` mode this mount is a per-verification clone of the warmed cache,
 * discarded afterwards — so code from the agent's branch cannot write anything a later
 * run or verification will read. That matters more here than for a run: the commands are
 * the operator's, but everything they execute came off the branch under verification.
 *
 * `--entrypoint` is overridden because the image's entrypoint is the agent host.
 */
export const buildVerifyArgs = (
  config: SandboxConfig,
  clonePath: string,
  command: string,
  depCachePath: string | null,
): string[] => [
  'run',
  '--rm',
  '--network',
  'none',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--user',
  '1000:1000',
  '--read-only',
  '--tmpfs',
  '/tmp:rw,noexec,nosuid,size=1g',
  '-v',
  `${clonePath}:/work:rw`,
  ...(depCachePath ? ['-v', `${depCachePath}:${DEP_CACHE_DIR}:rw`] : []),
  '-w',
  '/work',
  '--memory',
  config.memory,
  '--memory-swap',
  config.memory,
  '--cpus',
  config.cpus,
  '--pids-limit',
  config.pidsLimit,
  ...(depCachePath
    ? Object.entries(depCacheEnv()).flatMap(([key, value]) => ['-e', `${key}=${value}`])
    : []),
  '--entrypoint',
  'sh',
  config.image,
  '-c',
  command,
]

const runToCompletion = (
  file: string,
  args: readonly string[],
  cwd: string | undefined,
  env?: Record<string, string>,
): Promise<{ ok: boolean; output: string }> =>
  new Promise((resolve) => {
    const child = spawn(file, [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const capture = (chunk: Buffer) => {
      // Bounded: a runaway test suite must not be able to exhaust the Runner's
      // memory through its log, and only the tail is ever reported anyway.
      if (output.length < 1_000_000) output += chunk.toString()
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({
        ok: false,
        output: `${output}\nVerification exceeded its ${Math.round(VERIFY_TIMEOUT_MS / 60_000)} minute timeout.`,
      })
    }, VERIFY_TIMEOUT_MS)

    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, output: `${output}\n${error.message}` })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output })
    })
  })

const runOneCheck = (
  clonePath: string,
  command: string,
  sandboxed: boolean,
  depCachePath: string | null,
): Promise<{ ok: boolean; output: string }> =>
  sandboxed
    ? runToCompletion(
        sandboxConfigFromEnv().runtime,
        buildVerifyArgs(sandboxConfigFromEnv(), clonePath, command, depCachePath),
        undefined,
      )
    : /**
       * The unsandboxed path, behind the acknowledgement the roadmap requires.
       *
       * The cache is a host directory here rather than a mount, so the package managers
       * are pointed at where it actually is. Still a per-verification copy in `copy`
       * mode — the isolation is a property of the copy, not of the container.
       */
      runToCompletion('sh', ['-c', command], clonePath, depCachePath ? depCacheEnv(depCachePath) : undefined)

export interface RunVerificationInput {
  readonly clonePath: string
  readonly plan: Extract<VerificationPlan, { kind: 'run' }>
  /** Names the dependency-cache copy on disk, so a leftover directory is searchable. */
  readonly label: string
  readonly log?: (message: string) => void
}

/**
 * Runs a plan's checks in order and **stops at the first failure**, reporting the ones
 * after it as `not_run` rather than omitting them.
 *
 * One dependency-cache copy for the whole list, not one per check: the checks of a
 * single definition of done share an install step by construction — `build` populates
 * what `tests` runs against — so a copy per check would both cost N times the disk and
 * make a two-line `npm ci --offline && npm test` the only shape that ever worked.
 */
export const runVerification = async (
  input: RunVerificationInput,
): Promise<VerificationCheckResult[]> => {
  const log = input.log ?? (() => {})
  const cacheConfig = depCacheFromEnv()
  const mount = cacheConfig
    ? await prepareDepCache(cacheConfig, `verify-${input.label.replace(/[^a-zA-Z0-9]+/g, '-')}`)
    : null

  const results: VerificationCheckResult[] = []
  try {
    let stopped = false
    for (const check of input.plan.checks) {
      if (stopped) {
        results.push({ name: check.name, status: 'not_run', detail: null, durationMs: null })
        continue
      }
      log(`verifying ${input.label}: ${check.name} — ${check.command}`)
      const startedAt = Date.now()
      const result = await runOneCheck(
        input.clonePath,
        check.command,
        input.plan.sandboxed,
        mount?.path ?? null,
      )
      results.push({
        name: check.name,
        status: result.ok ? 'passed' : 'failed',
        // Kept on success too: a passing check's tail is what an operator reads to
        // confirm the command did what they think it does, and a check that passes
        // because it silently ran nothing looks identical without it.
        detail: tail(result.output),
        durationMs: Date.now() - startedAt,
      })
      if (!result.ok) stopped = true
    }
  } finally {
    // A leaked copy is a whole dependency tree on disk per verification; in `shared`
    // mode this is a no-op by design.
    await mount?.release().catch(() => {})
  }
  return results
}

/**
 * Every git call in this file goes through here.
 *
 * The `-c` flags are not tidiness, and they matter more here than almost anywhere: this
 * runs against a clone an agent had write access to, *after* that agent finished, and
 * repository binding names `core.hooksPath` as exactly the way a run turns a later
 * host-side git invocation into code execution. `prepareRunWorkspace` pins both at clone
 * time; pinning them again per invocation means a clone whose config was rewritten
 * afterwards still cannot reach the host through us.
 */
const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { maxBuffer: 32 * 1024 * 1024 },
  )
  return stdout.trim()
}

export type VerifyRunBranchOutcome =
  | {
      readonly status: 'ran'
      readonly commitSha: string
      readonly checks: VerificationCheckResult[]
    }
  | { readonly status: 'skipped' | 'refused' | 'error'; readonly reason: string }

export interface VerifyRunBranchInput {
  readonly clonePath: string
  readonly branchName: string
  readonly defaultBranch: string
  readonly checks: readonly VerificationCheck[]
  readonly log?: (message: string) => void
}

/**
 * A finished run's own branch, against its repository's definition of done.
 *
 * Run **in the run's own clone at its own head** — not rebased onto anything. That is the
 * whole difference from the merge queue: this asks whether the work the run produced is
 * done, before a human spends time reviewing it or a candidate is promoted (continuity mode
 * tiers 3–4); the queue asks the later, separate question of whether it still passes on top
 * of everything that landed since.
 *
 * A branch with no commits is `skipped` and says so. Only the Runner can know that —
 * the server has a branch name and no repository — and reporting it as a pass would
 * have every planner, mastery and Colosseum run in the workspace certifying itself
 * against checks that never ran.
 */
export const verifyRunBranch = async (
  input: VerifyRunBranchInput,
): Promise<VerifyRunBranchOutcome> => {
  const plan = planVerification({
    checks: input.checks,
    sandboxAvailable: sandboxEnabled(),
    unsandboxedAcknowledged: unsandboxedAcknowledged(),
  })
  if (plan.kind === 'refuse') return { status: 'refused', reason: plan.reason }
  if (plan.kind === 'skip') return { status: 'skipped', reason: plan.reason }

  let head: string
  try {
    head = await git(input.clonePath, ['rev-parse', input.branchName])
    const ahead = await git(input.clonePath, [
      'rev-list',
      '--count',
      `${input.defaultBranch}..${input.branchName}`,
    ])
    if (ahead === '0') {
      return { status: 'skipped', reason: 'the run committed nothing to verify' }
    }
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
  }

  const checks = await runVerification({
    clonePath: input.clonePath,
    plan,
    label: `${input.branchName}@${head.slice(0, 8)}`,
    ...(input.log ? { log: input.log } : {}),
  })

  /**
   * The same guard the merge queue has, and for the same reason: verification executes
   * code from the branch in a container with the clone mounted writable, so it could
   * commit. A result recorded against a commit that is no longer the branch's head
   * would be a passing verdict attached to code nobody verified.
   */
  const afterSha = await git(input.clonePath, ['rev-parse', input.branchName]).catch(() => head)
  if (afterSha !== head) {
    return { status: 'error', reason: 'the branch moved during verification' }
  }

  return { status: 'ran', commitSha: head, checks }
}
