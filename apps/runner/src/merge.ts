import { planMergeVerification, type MergeFailureReason } from '@loom/domain'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { sandboxConfigFromEnv, sandboxEnabled, unsandboxedAcknowledged, type SandboxConfig } from './sandbox.js'

const execFileAsync = promisify(execFile)

/**
 * The merge queue's host side (PLAN.md §7 Phase 2): rebase in order, run tests,
 * fast-forward. The policy — what order, whether verification may run at all — is
 * `packages/domain/src/merge-queue.ts`; this is the git.
 *
 * The target is the **bound repository's own default branch**, not `origin`.
 * Pushing is the separate §6 A2 path with its own policy and credentials; a merge
 * is the local integration §5a describes ("the run's branch diff renders in-thread
 * for review → merge / open PR / keep branch / discard"). Keeping them apart also
 * means the queue is exercisable on a repository with no remote at all.
 */

export type MergeOutcome =
  | {
      readonly ok: true
      readonly commitSha: string
      readonly verified: boolean
      /** Why verification did not run, when it did not. Recorded, never implied. */
      readonly note?: string
    }
  | { readonly ok: false; readonly reason: MergeFailureReason; readonly detail: string }

const VERIFY_TIMEOUT_MS = Number(process.env.LOOM_MERGE_VERIFY_TIMEOUT_MS ?? 600_000)

/**
 * Every host-side git call in this file goes through here.
 *
 * The `-c` flags are not tidiness. These commands run inside the run's clone, and
 * an agent had write access to that clone's `.git/config` — §5a names
 * `core.hooksPath` as exactly the way a run turns a later host-side git invocation
 * into code execution. `prepareRunWorkspace` pins both at clone time; pinning them
 * again per invocation means a clone whose config was rewritten afterwards still
 * cannot reach the host through us.
 */
const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { maxBuffer: 32 * 1024 * 1024 },
  )
  return stdout.trim()
}

const errorText = (error: unknown): string => {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: string }).stderr
    return (stderr && stderr.trim().length > 0 ? stderr : error.message).trim()
  }
  return String(error)
}

/** Last few lines only — a thread message is not the place for a full test log. */
const tail = (text: string, lines = 12): string =>
  text.trim().split('\n').slice(-lines).join('\n').slice(0, 4_000)

/**
 * Runs the repository's verification command against the rebased tree.
 *
 * Sandboxed by default, and with tighter settings than a run gets: `--network none`
 * outright, because verification needs no model API and therefore no egress proxy —
 * the one reason §6 A5's sandbox settles for an internal network instead. The
 * practical consequence is that verification runs what is already in the clone and
 * cannot install anything, which is the correct trade for executing a branch's own
 * test code.
 *
 * `--entrypoint` is overridden because the image's entrypoint is the agent host.
 */
const verifyInSandbox = async (
  config: SandboxConfig,
  clonePath: string,
  command: string,
): Promise<{ ok: boolean; output: string }> => {
  const args = [
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
    '--entrypoint',
    'sh',
    config.image,
    '-c',
    command,
  ]
  return runToCompletion(config.runtime, args, undefined)
}

const verifyOnHost = async (
  clonePath: string,
  command: string,
): Promise<{ ok: boolean; output: string }> => runToCompletion('sh', ['-c', command], clonePath)

const runToCompletion = (
  file: string,
  args: readonly string[],
  cwd: string | undefined,
): Promise<{ ok: boolean; output: string }> =>
  new Promise((resolve) => {
    const child = spawn(file, [...args], { ...(cwd === undefined ? {} : { cwd }), stdio: ['ignore', 'pipe', 'pipe'] })
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

export interface MergeRunBranchInput {
  readonly sourcePath: string
  readonly clonePath: string
  readonly branchName: string
  readonly defaultBranch: string
  readonly verifyCommand: string | null
  readonly log?: (message: string) => void
}

export const mergeRunBranch = async (input: MergeRunBranchInput): Promise<MergeOutcome> => {
  const log = input.log ?? (() => {})
  const { sourcePath, clonePath, branchName, defaultBranch } = input

  const plan = planMergeVerification({
    command: input.verifyCommand,
    sandboxAvailable: sandboxEnabled(),
    unsandboxedAcknowledged: unsandboxedAcknowledged(),
  })
  // Checked before any git runs. Refusing after a rebase would leave the branch
  // rewritten for a merge that was never going to happen.
  if (plan.kind === 'refuse') {
    return { ok: false, reason: 'verification_refused', detail: plan.reason }
  }

  // A human's uncommitted work is not ours to move, stash, or commit. This only
  // matters when the target branch is the one checked out — updating a ref that no
  // working tree is on touches no files.
  let checkedOutBranch: string | null
  try {
    checkedOutBranch = await git(sourcePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  } catch {
    checkedOutBranch = null // detached HEAD
  }
  const targetIsCheckedOut = checkedOutBranch === defaultBranch

  if (targetIsCheckedOut) {
    const status = await git(sourcePath, ['status', '--porcelain'])
    if (status.length > 0) {
      return {
        ok: false,
        reason: 'dirty_target',
        detail: `${status.split('\n').length} uncommitted change(s) in ${sourcePath}`,
      }
    }
  }

  // The tip we rebase onto, captured now so the fast-forward below can be a
  // compare-and-swap against it. Anything that moves the target between here and
  // there is `stale_target`, not a silent overwrite.
  let targetTipBefore: string
  try {
    await git(clonePath, ['fetch', '--quiet', sourcePath, defaultBranch])
    targetTipBefore = await git(clonePath, ['rev-parse', 'FETCH_HEAD'])
  } catch (error) {
    return { ok: false, reason: 'runner_error', detail: errorText(error) }
  }

  try {
    await git(clonePath, ['checkout', '--quiet', branchName])
  } catch (error) {
    return { ok: false, reason: 'runner_error', detail: errorText(error) }
  }

  // Rebase, not merge: §7 says "rebase in order", and the point of ordering is that
  // entry N+1 lands on top of entry N's result rather than beside it.
  try {
    await git(clonePath, ['rebase', targetTipBefore])
  } catch (error) {
    let conflicted = ''
    try {
      conflicted = await git(clonePath, ['diff', '--name-only', '--diff-filter=U'])
    } catch {
      // The rebase may have failed before producing a conflict set at all.
    }
    // Always aborted, so the branch is left exactly as its run produced it — a
    // half-rebased branch would be neither reviewable nor re-queueable.
    await git(clonePath, ['rebase', '--abort']).catch(() => {})
    const detail = conflicted.length > 0 ? conflicted.split('\n').join(', ') : tail(errorText(error), 4)
    return { ok: false, reason: 'conflict', detail }
  }

  const rebasedSha = await git(clonePath, ['rev-parse', 'HEAD'])

  let verified = false
  let note: string | undefined
  if (plan.kind === 'run') {
    log(`verifying ${branchName} at ${rebasedSha.slice(0, 8)}: ${plan.command}`)
    const result = plan.sandboxed
      ? await verifyInSandbox(sandboxConfigFromEnv(), clonePath, plan.command)
      : await verifyOnHost(clonePath, plan.command)
    if (!result.ok) {
      return { ok: false, reason: 'verification_failed', detail: tail(result.output) }
    }
    verified = true

    // Verification executes code from the branch, in a container with the clone
    // mounted writable — so it could commit, and move the branch to something no
    // human reviewed and no verification passed. Merging `rebasedSha` rather than
    // "whatever the branch points at now" is what makes that ineffective, and this
    // check is what makes it *visible* rather than quietly ignored.
    const afterSha = await git(clonePath, ['rev-parse', branchName])
    if (afterSha !== rebasedSha) {
      return {
        ok: false,
        reason: 'runner_error',
        detail: 'the branch moved during verification — nothing was merged',
      }
    }
  } else {
    note = plan.reason
  }

  try {
    await git(sourcePath, ['fetch', '--quiet', clonePath, branchName])
    const fetched = await git(sourcePath, ['rev-parse', 'FETCH_HEAD'])
    if (fetched !== rebasedSha) {
      return {
        ok: false,
        reason: 'runner_error',
        detail: 'the fetched branch head did not match the verified commit',
      }
    }

    if (targetIsCheckedOut) {
      // Moves the ref and the working tree together, and refuses anything that is
      // not a fast-forward — which, after the rebase above, can only mean the
      // target moved underneath us.
      await git(sourcePath, ['merge', '--ff-only', rebasedSha])
    } else {
      // Compare-and-swap on the ref: the third argument is the value it must
      // currently hold. Same guarantee as --ff-only, without touching a working
      // tree that is on some other branch.
      await git(sourcePath, ['update-ref', `refs/heads/${defaultBranch}`, rebasedSha, targetTipBefore])
    }
  } catch (error) {
    const text = errorText(error)
    const stale = /not something we can merge|non-fast-forward|not a fast|cannot lock ref|changed from expected|unable to update/i.test(text)
    return { ok: false, reason: stale ? 'stale_target' : 'runner_error', detail: tail(text, 4) }
  }

  log(`merged ${branchName} into ${defaultBranch} at ${rebasedSha.slice(0, 8)}`)
  return { ok: true, commitSha: rebasedSha, verified, ...(note === undefined ? {} : { note }) }
}
