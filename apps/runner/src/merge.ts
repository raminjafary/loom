import { planMergeVerification, type MergeFailureReason } from '@loom/domain'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DEP_CACHE_DIR, depCacheEnv, depCacheFromEnv, prepareDepCache } from './dep-cache.js'
import { sandboxConfigFromEnv, sandboxEnabled, unsandboxedAcknowledged, type SandboxConfig } from './sandbox.js'

const execFileAsync = promisify(execFile)

/**
 * The merge queue's host side: rebase in order, run tests,
 * fast-forward. The policy — what order, whether verification may run at all — is
 * `packages/domain/src/merge-queue.ts`; this is the git.
 *
 * The target is the **bound repository's own default branch**, not `origin`.
 * Pushing is the separate the push policy path with its own policy and credentials; a merge
 * is the local integration repository binding describes ("the run's branch diff renders in-thread
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
 * an agent had write access to that clone's `.git/config` — repository binding names
 * `core.hooksPath` as exactly the way a run turns a later host-side git invocation
 * into code execution. `prepareRunWorkspace` pins both at clone time; pinning them
 * again per invocation means a clone whose config was rewritten afterwards still
 * cannot reach the host through us.
 */
const git = async (cwd: string, args: readonly string[]): Promise<string> => {
 const { stdout } = await execFileAsync(
 'git',
 ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',...args],
 { maxBuffer: 32 * 1024 * 1024 },
)
 return stdout.trim
}

const errorText = (error: unknown): string => {
 if (error instanceof Error) {
 const stderr = (error as { stderr?: string }).stderr
 return (stderr && stderr.trim.length > 0 ? stderr: error.message).trim
 }
 return String(error)
}

/**
 * Last few lines only — a thread message is not the place for a full test log.
 *
 * Stack frames are dropped *before* the window is taken, and that is the whole point
 * rather than tidiness. A failing `node --test` prints the assertion message, then the
 * frames, then a dump of the error object — so the last twelve lines are frames and
 * field names, and the one sentence saying what failed sits just above the cut. Live,
 * that turned the queue catching a wrong reconcile into a thread message that opened
 * `at TestContext.<anonymous>` and never said why. Every runner puts its frames in this
 * shape and none of them carry information a human reading a merge failure needs.
 */
const tail = (text: string, lines = 12): string =>
 text
.trim
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
 * run or verification will read. That matters more here than for a run: the command is
 * the operator's, but everything it executes came off the branch under review.
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
...(depCachePath ? ['-v', `${depCachePath}:${DEP_CACHE_DIR}:rw`]: []),
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
 ? Object.entries(depCacheEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`])
: []),
 '--entrypoint',
 'sh',
 config.image,
 '-c',
 command,
]

const verifyInSandbox = async (
 config: SandboxConfig,
 clonePath: string,
 command: string,
 depCachePath: string | null,
): Promise<{ ok: boolean; output: string }> =>
 runToCompletion(config.runtime, buildVerifyArgs(config, clonePath, command, depCachePath), undefined)

/**
 * The unsandboxed path, behind the acknowledgement the roadmap requires.
 *
 * The cache is a host directory here rather than a mount, so the package managers are
 * pointed at where it actually is. Still a per-verification copy in `copy` mode — the
 * isolation is a property of the copy, not of the container.
 */
const verifyOnHost = async (
 clonePath: string,
 command: string,
 depCachePath: string | null,
): Promise<{ ok: boolean; output: string }> =>
 runToCompletion('sh', ['-c', command], clonePath, depCachePath ? depCacheEnv(depCachePath): undefined)

const runToCompletion = (
 file: string,
 args: readonly string[],
 cwd: string | undefined,
 env?: Record<string, string>,
): Promise<{ ok: boolean; output: string }> =>
 new Promise((resolve) => {
 const child = spawn(file, [...args], {
...(cwd === undefined ? {}: { cwd }),
...(env === undefined ? {}: { env: {...process.env,...env } }),
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 let output = ''
 const capture = (chunk: Buffer) => {
 // Bounded: a runaway test suite must not be able to exhaust the Runner's
 // memory through its log, and only the tail is ever reported anyway.
 if (output.length < 1_000_000) output += chunk.toString
 }
 child.stdout.on('data', capture)
 child.stderr.on('data', capture)

 const timer = setTimeout( => {
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
 const log = input.log ?? ( => {})
 const { sourcePath, clonePath, branchName, defaultBranch } = input

 const plan = planMergeVerification({
 command: input.verifyCommand,
 sandboxAvailable: sandboxEnabled,
 unsandboxedAcknowledged: unsandboxedAcknowledged,
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

 // Rebase, not merge: the roadmap says "rebase in order", and the point of ordering is that
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
 await git(clonePath, ['rebase', '--abort']).catch( => {})
 const detail = conflicted.length > 0 ? conflicted.split('\n').join(', '): tail(errorText(error), 4)
 return { ok: false, reason: 'conflict', detail }
 }

 const rebasedSha = await git(clonePath, ['rev-parse', 'HEAD'])

 let verified = false
 let note: string | undefined
 if (plan.kind === 'run') {
 log(`verifying ${branchName} at ${rebasedSha.slice(0, 8)}: ${plan.command}`)
 /**
 * Prepared per verification and released whatever happens, exactly as a run's is.
 * The label is the branch rather than a run id because that is what this function
 * is given, and it is what an operator finding a leftover directory would search
 * for — sanitised because a branch name has slashes in it and this becomes a path.
 */
 const cacheConfig = depCacheFromEnv
 const mount = cacheConfig
 ? await prepareDepCache(cacheConfig, `verify-${branchName.replace(/[^a-zA-Z0-9]+/g, '-')}`)
: null
 let result: { ok: boolean; output: string }
 try {
 result = plan.sandboxed
 ? await verifyInSandbox(sandboxConfigFromEnv, clonePath, plan.command, mount?.path ?? null)
: await verifyOnHost(clonePath, plan.command, mount?.path ?? null)
 } finally {
 // A leaked copy is a whole dependency tree on disk per merge; in `shared` mode
 // this is a no-op by design.
 await mount?.release.catch( => {})
 }
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
 return { ok: false, reason: stale ? 'stale_target': 'runner_error', detail: tail(text, 4) }
 }

 log(`merged ${branchName} into ${defaultBranch} at ${rebasedSha.slice(0, 8)}`)
 return { ok: true, commitSha: rebasedSha, verified,...(note === undefined ? {}: { note }) }
}
