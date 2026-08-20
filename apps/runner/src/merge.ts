import {
  describeVerification,
  parseRevertedShas,
  planVerification,
  summarizeVerification,
  type MergeFailureReason,
  type VerificationCheck,
} from '@loom/domain'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { LOOM_COMMITTER_FLAGS } from './git-identity.js'
import { sandboxEnabled, unsandboxedAcknowledged } from './sandbox.js'
import { runVerification, tail } from './verify.js'

const execFileAsync = promisify(execFile)

/**
 * The merge queue's host side: rebase in order, run tests,
 * fast-forward. The policy — what order, whether verification may run at all — is
 * `packages/domain/src/merge-queue.ts`; this is the git.
 *
 * The target is the **bound repository's own default branch**, not `origin`. Pushing is the
 * separate the push policy path with its own policy and credentials; a merge is the local
 * integration repository binding describes ("the run's branch diff renders in-thread for
 * review → merge / open PR / keep branch / discard"). Keeping them apart also means the
 * queue is exercisable on a repository with no remote at all.
 */

export type MergeOutcome =
  | {
      readonly ok: true
      readonly commitSha: string
      readonly verified: boolean
      /**
       * The files this merge actually changed, from git rather than from anyone's
       * claim.
       *
       * From git deliberately: a run's *claimed* paths are a Planner's guess, and
       * invalidating a persona's map on a guess would retire true claims and keep false
       * ones.
       */
      readonly changedPaths: string[]
      /**
       * The commits these merged commits say they revert, from their own messages.
       *
       * Read here because this is the one moment the branch's contribution is exactly
       * `targetTipBefore..HEAD` — the same reason `changedPaths` is computed here — and
       * because the server has no git. Empty is the ordinary answer.
       */
      readonly revertedShas: string[]
      /** Why verification did not run, when it did not. Recorded, never implied. */
      readonly note?: string
    }
  | { readonly ok: false; readonly reason: MergeFailureReason; readonly detail: string }

/**
 * Every host-side git call in this file goes through here.
 *
 * The `-c` flags are not tidiness. These commands run inside the run's clone, and
 * an agent had write access to that clone's `.git/config` — repository binding names
 * `core.hooksPath` as exactly the way a run turns a later host-side git invocation
 * into code execution. `prepareRunWorkspace` pins both at clone time; pinning them
 * again per invocation means a clone whose config was rewritten afterwards still
 * cannot reach the host through us.
 */
const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...LOOM_COMMITTER_FLAGS, ...args],
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

export interface MergeRunBranchInput {
  readonly sourcePath: string
  readonly clonePath: string
  readonly branchName: string
  readonly defaultBranch: string
  /**
   * The repository's definition of done, resolved by the server
   * from the repository's checks or its legacy single command. The queue runs the same
   * list a finished run is verified against — this call just asks it of a *rebased*
   * branch, which is the different question the queue exists to ask.
   */
  readonly checks: readonly VerificationCheck[]
  readonly log?: (message: string) => void
}

export const mergeRunBranch = async (input: MergeRunBranchInput): Promise<MergeOutcome> => {
  const log = input.log ?? (() => {})
  const { sourcePath, clonePath, branchName, defaultBranch } = input

  const plan = planVerification({
    checks: input.checks,
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

  // Rebase, not merge: the roadmap says "rebase in order", and the point of ordering is
  // that entry N+1 lands on top of entry N's result rather than beside it.
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

  // Computed after the rebase and before the fast-forward, which is the one moment
  // the branch's own contribution is exactly `targetTipBefore..HEAD`.
  let changedPaths: string[] = []
  try {
    const names = await git(clonePath, ['diff', '--name-only', `${targetTipBefore}..HEAD`])
    changedPaths = names.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  } catch {
    // A merge that succeeded must not fail because the file list could not be read.
    // The cost of an empty list is a map that stays stale until the next curation
    // pass, which is strictly better than a merge reported as failed.
  }

  /**
   * What this branch takes back out, from git's own `This reverts commit …` lines.
   *
   * Best-effort like `changedPaths`, and for the same reason: a merge that succeeded must
   * not be reported as failed because a log could not be read. The cost of an empty list is
   * a tripwire that misses one revert, which is the direction that tripwire errs in anyway.
   */
  let revertedShas: string[] = []
  try {
    const messages = await git(clonePath, ['log', '--format=%B%x00', `${targetTipBefore}..HEAD`])
    revertedShas = parseRevertedShas(messages.split('\0'))
  } catch {
    // See above.
  }

  let verified = false
  let note: string | undefined
  if (plan.kind === 'run') {
    /**
     * The label is the branch rather than a run id because that is what this function
     * is given, and it is what an operator finding a leftover dependency-cache copy
     * would search for.
     */
    const results = await runVerification({
      clonePath,
      plan,
      label: `${branchName}@${rebasedSha.slice(0, 8)}`,
      log,
    })
    const summary = summarizeVerification(results)
    if (summary.status === 'failed') {
      // The check's name leads, then its output. A merge failure that said only
      // "verification failed" made a human open a log to learn which of three
      // commands it was.
      const named = describeVerification({ status: 'failed', checks: results, reason: null })
      return {
        ok: false,
        reason: 'verification_failed',
        detail: `${named}\n${summary.failed?.detail ?? ''}`.trim(),
      }
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
  return {
    ok: true,
    commitSha: rebasedSha,
    verified,
    changedPaths,
    revertedShas,
    ...(note === undefined ? {} : { note }),
  }
}
