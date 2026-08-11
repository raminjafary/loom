import { classifyPushEffect } from '@loom/domain'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RunWorkspace {
 readonly clonePath: string
 readonly branchName: string
 /**
 * Host-backed HOME for the run's sandbox. Exists so the SDK's session transcript
 * (`$HOME/.claude/projects`) outlives the container — without it the session id in
 * the Runner's state file names a transcript that was destroyed, and resumption after
 * a restart is impossible.
 */
 readonly homePath: string
}

const scratchRoot = : string => process.env.LOOM_RUN_SCRATCH_ROOT ?? tmpdir

/**
 * Clone-per-run isolation: concurrent runs against the same
 * bound repository must not collide in one working tree. A worktree was
 * considered and rejected — worktrees share the parent's `.git`, so a run
 * could write `.git/hooks`/`.git/config` and affect every sibling and the
 * host repo. `core.hooksPath=/dev/null` and `core.fsmonitor=false` are set on
 * the clone itself, per the exact requirement.
 */
export const prepareRunWorkspace = async (
 sourcePath: string,
 runId: string,
): Promise<RunWorkspace> => {
 const branchName = `loom/run-${runId}`
 const clonePath = await mkdtemp(join(scratchRoot, `loom-run-${runId}-`))
 const homePath = await mkdtemp(join(scratchRoot, `loom-home-${runId}-`))
 // The sandbox runs as uid 1000, which is not the Runner's uid on Linux. Docker
 // Desktop maps ownership on bind mounts, but a plain Linux host does not, so the
 // directory is made group/other-writable rather than silently unwritable there.
 await chmod(homePath, 0o777)

 await execFileAsync('git', ['clone', '--quiet', sourcePath, clonePath])
 await execFileAsync('git', ['-C', clonePath, 'checkout', '-b', branchName])
 await execFileAsync('git', ['-C', clonePath, 'config', 'core.hooksPath', '/dev/null'])
 await execFileAsync('git', ['-C', clonePath, 'config', 'core.fsmonitor', 'false'])

 return { clonePath, branchName, homePath }
}

export interface ReconcileWorkspace extends RunWorkspace {
 /** Repository-relative paths left with conflict markers, for the agent's task text. */
 readonly conflictedPaths: string[]
}

/**
 * A workspace for a reconciler run, left **deliberately mid-rebase**
 * so the agent sees real conflict markers in real files.
 *
 * The source is the *conflicted run's own clone*, not the bound repository: the branch
 * exists only there until it merges, which is the same constraint `getDiff`, `push` and
 * the merge itself already live under (the Runner that ran the branch must still hold
 * it). Cloning it rather than working in it is what keeps a reconciler that goes wrong
 * from damaging the branch a human may still want to review by hand.
 *
 * The rebase is expected to conflict — that is the entire point — so a clean result is
 * reported as zero conflicted paths rather than as an error. It can happen legitimately:
 * the merge queue's target may have moved between the failed attempt and this run.
 *
 * Note what is *not* done here: no `rebase --abort`. `prepareRunWorkspace`'s clone is a
 * fresh checkout, but this one is a paused rebase, and the paused state is the input to
 * the agent's task. `finishReconcile` is the other half.
 */
export const prepareReconcileWorkspace = async (
 parentClonePath: string,
 sourcePath: string,
 defaultBranch: string,
 branchName: string,
 runId: string,
): Promise<ReconcileWorkspace> => {
 const clonePath = await mkdtemp(join(scratchRoot, `loom-reconcile-${runId}-`))
 const homePath = await mkdtemp(join(scratchRoot, `loom-home-${runId}-`))
 await chmod(homePath, 0o777)

 await execFileAsync('git', ['clone', '--quiet', parentClonePath, clonePath])
 await execFileAsync('git', ['-C', clonePath, 'config', 'core.hooksPath', '/dev/null'])
 await execFileAsync('git', ['-C', clonePath, 'config', 'core.fsmonitor', 'false'])
 await execFileAsync('git', ['-C', clonePath, 'checkout', '--quiet', branchName])

 // The live tip of the merge target, from the bound repository rather than from the
 // parent's clone — the parent cloned before earlier entries in the queue landed, so
 // its copy of the default branch is exactly the stale thing being rebased away from.
 await execFileAsync('git', ['-C', clonePath, 'fetch', '--quiet', sourcePath, defaultBranch])
 const { stdout: tip } = await execFileAsync('git', ['-C', clonePath, 'rev-parse', 'FETCH_HEAD'])

 let conflictedPaths: string[] = []
 try {
 await execFileAsync('git', ['-C', clonePath, 'rebase', tip.trim])
 } catch {
 const { stdout } = await execFileAsync('git', [
 '-C', clonePath, 'diff', '--name-only', '--diff-filter=U',
 ])
 conflictedPaths = stdout.trim.split('\n').filter((line) => line.length > 0)
 }

 return { clonePath, branchName, homePath, conflictedPaths }
}

/**
 * Completes the paused rebase after the reconciler has edited the tree.
 *
 * Refuses on any surviving conflict marker, and that refusal is the safety property
 * this function exists for. `git rebase --continue` does not inspect content — it
 * happily commits a file with `<<<<<<<` still in it, producing a branch that merges
 * clean, may even pass a verification command that does not parse the file, and carries
 * garbage into the default branch. The persona is told refusing is a correct outcome
 * (see the `reconciler` built-in), so a tree with markers left in it is an *expected*
 * path, not an exceptional one.
 */
export const finishReconcile = async (
 clonePath: string,
): Promise<{ ok: true; commitSha: string } | { ok: false; reason: string }> => {
 const git = async (args: string[]): Promise<string> => {
 const { stdout } = await execFileAsync(
 'git',
 ['-C', clonePath, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',...args],
 { maxBuffer: 32 * 1024 * 1024 },
)
 return stdout.trim
 }

 const refuse = async (reason: string): Promise<{ ok: false; reason: string }> => {
 await git(['rebase', '--abort']).catch( => {})
 return { ok: false, reason }
 }

 /**
 * Staged *first*, deliberately. The agent edits the working tree and never runs git,
 * so until the resolution is staged git still considers the path unmerged — checking
 * `--diff-filter=U` before this point reports every file as conflicted no matter how
 * correctly the agent resolved it.
 */
 try {
 await git(['add', '-A'])
 } catch (error) {
 return refuse(error instanceof Error ? error.message: String(error))
 }

 /**
 * So the surviving check is on *content*, which is the one that matters anyway: a
 * staged file with `<<<<<<<` still inside it looks perfectly resolved to git, and
 * `rebase --continue` will commit it without ever reading it.
 */
 let marked = ''
 try {
 marked = await git(['grep', '-l', '-e', '^<<<<<<< ', '-e', '^>>>>>>> '])
 } catch {
 // `git grep -l` exits non-zero when nothing matches, which is the good case.
 }
 if (marked.length > 0) {
 return refuse(
 `conflict markers remain in ${marked.split('\n').join(', ')} — the reconciler did not resolve them`,
)
 }

 try {
 // An empty index means the resolution took the target's side wholesale, which git
 // reports as "nothing to commit" and `--skip` would answer by dropping the branch's
 // commit entirely. Refused rather than treated as success.
 if ((await git(['diff', '--cached', '--name-only'])).length === 0) {
 return refuse('resolution left nothing to commit — the branch would be dropped')
 }
 await execFileAsync(
 'git',
 ['-C', clonePath, '-c', 'core.hooksPath=/dev/null', '-c', 'core.editor=true', 'rebase', '--continue'],
 { env: {...process.env, GIT_EDITOR: 'true' } },
)
 } catch (error) {
 return refuse(error instanceof Error ? error.message: String(error))
 }

 return { ok: true, commitSha: await git(['rev-parse', 'HEAD']) }
}

/**
 * Moves a reconciled branch back into the clone the merge queue merges from.
 *
 * The queue merges `<run>`'s branch out of `<run>`'s own clone, so a reconciliation
 * performed in a separate clone is invisible to it — the queue would re-merge the
 * untouched branch and conflict again on every sweep. Fetching the ref across is what
 * makes the reconciliation the thing that merges.
 *
 * A forced update, and safely so: the destination branch is a run's own branch, the
 * reconciled commit is a rebase of exactly that branch onto the merge target, and
 * nothing else writes it. It is not a fast-forward, because a rebase never is.
 */
export const updateBranchFrom = async (
 destinationClonePath: string,
 sourceClonePath: string,
 branchName: string,
): Promise<void> => {
 const git = (args: string[]) =>
 execFileAsync('git', [
 '-C', destinationClonePath,
 '-c', 'core.hooksPath=/dev/null',
 '-c', 'core.fsmonitor=false',
...args,
 ])

 /**
 * The run's own branch is *checked out* in its clone — `prepareRunWorkspace` does
 * `checkout -b` — and git refuses to fetch directly into a checked-out branch:
 * "refusing to fetch into branch... checked out at...". Found by the first live
 * end-to-end reconcile, which resolved its conflict correctly and then threw the
 * result away here.
 *
 * So: land it on a temporary ref, then move the branch and its working tree together
 * with `reset --hard`. Safe because the owning run is terminal by the time anything
 * reconciles its branch, and `commitRunWork` has already committed whatever it left —
 * there is no uncommitted work in that tree for the reset to discard.
 */
 const TEMP_REF = 'refs/loom/reconciled'
 await git(['fetch', '--quiet', '--force', sourceClonePath, `refs/heads/${branchName}:${TEMP_REF}`])

 let checkedOut: string | null
 try {
 const { stdout } = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
 checkedOut = stdout.trim
 } catch {
 checkedOut = null // detached HEAD
 }

 if (checkedOut === branchName) {
 await git(['reset', '--hard', '--quiet', TEMP_REF])
 } else {
 await git(['update-ref', `refs/heads/${branchName}`, TEMP_REF])
 }
 await git(['update-ref', '-d', TEMP_REF]).catch( => {})
}

/**
 * Commits whatever the agent left in the working tree, on the run's own branch.
 *
 * Not optional, and not the model's job. Repository binding renders "the run's branch diff"
 * for review and the push policy pushes `HEAD:refs/heads/<branch>` — both are empty if the agent
 * edited files and never committed, which is exactly what a real run did: the diff came
 * back as zero bytes and a push would have shipped a branch with no commits. Relying on
 * the persona prompt to remember `git commit` makes the review and push paths depend on
 * model behaviour, so the platform does it.
 *
 * Runs on any terminal outcome, including failure and cancellation: partial work is
 * still worth showing a human, and it is theirs to keep or discard.
 *
 * Identity is the run's, never a human's — the commit is agent-authored and the history
 * should say so.
 */
export const commitRunWork = async (
 clonePath: string,
 input: { personaName: string; runId: string },
): Promise<{ committed: boolean }> => {
 const { stdout: status } = await execFileAsync('git', ['-C', clonePath, 'status', '--porcelain'])
 if (status.trim.length === 0) return { committed: false }

 await execFileAsync('git', ['-C', clonePath, 'add', '-A'])
 await execFileAsync('git', [
 '-C',
 clonePath,
 '-c',
 `user.name=${input.personaName} (Loom agent)`,
 '-c',
 'user.email=agent@loom.invalid',
 'commit',
 '--quiet',
 '-m',
 `${input.personaName}: work from run ${input.runId}`,
 ])
 return { committed: true }
}

/** The run's branch diff against the point it was cloned from, for end-of-run review. */
export const getDiff = async (clonePath: string, defaultBranch: string): Promise<string> => {
 const { stdout } = await execFileAsync('git', [
 '-C',
 clonePath,
 'diff',
 `${defaultBranch}...HEAD`,
 ])
 return stdout
}

/**
 * Removes a run's scratch clone after a human discards the branch on DiffView, and its
 * host-backed HOME with it — that directory holds the SDK session transcript, which is
 * a record of the run and should not outlive the branch a human just discarded.
 */
export const discardRunWorkspace = async (clonePath: string, homePath?: string): Promise<void> => {
 await rm(clonePath, { recursive: true, force: true })
 if (homePath) await rm(homePath, { recursive: true, force: true })
}

interface ParsedRemote {
 readonly host: string
 readonly owner: string
 readonly repo: string
}

/** Handles both `git@host:owner/repo.git` and `https://host/owner/repo.git` forms. */
const parseGitRemoteUrl = (url: string): ParsedRemote | null => {
 const ssh = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
 if (ssh?.[1] && ssh[2] && ssh[3]) return { host: ssh[1], owner: ssh[2], repo: ssh[3] }

 try {
 const parsed = new URL(url)
 const [owner, repo] = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/')
 if (!owner || !repo) return null
 return { host: parsed.hostname, owner, repo }
 } catch {
 return null
 }
}

export type PushResult =
 | { readonly ok: true; readonly prUrl?: string; readonly compareUrl?: string; readonly warning?: string }
 | { readonly ok: false; readonly error: string }

/**
 * Host-side push + best-effort PR/MR open. The agent never
 * holds git credentials or pushes — this runs on the Runner host, outside
 * any sandbox, using whatever git/`gh`/`glab` auth already exists there. The
 * push target is always exactly `refs/heads/<branchName>` (the run's own
 * trusted branch, never agent- or client-supplied) as a plain push, never
 * force, never a tag — there is no code path here that could do otherwise.
 */
export const pushRunBranch = async (
 sourcePath: string,
 clonePath: string,
 branchName: string,
 defaultBranch: string,
 acknowledgeCiChange: boolean,
): Promise<PushResult> => {
 let remoteUrl: string
 try {
 remoteUrl = (await execFileAsync('git', ['-C', sourcePath, 'remote', 'get-url', 'origin'])).stdout.trim
 } catch {
 return { ok: false, error: 'Repository has no configured remote — nothing to push to' }
 }

 const { stdout: changedRaw } = await execFileAsync('git', [
 '-C',
 clonePath,
 'diff',
 '--name-only',
 `${defaultBranch}...HEAD`,
 ])
 const changedPaths = changedRaw.split('\n').filter((line) => line.length > 0)
 const verdict = classifyPushEffect(changedPaths, acknowledgeCiChange)
 if (!verdict.ok) return { ok: false, error: verdict.reason }

 await execFileAsync('git', ['-C', clonePath, 'push', remoteUrl, `HEAD:refs/heads/${branchName}`])

 const parsed = parseGitRemoteUrl(remoteUrl)
 if (!parsed) return { ok: true, warning: 'Pushed, but the remote URL could not be parsed for a PR link' }

 const { host, owner, repo } = parsed

 if (host === 'github.com') {
 try {
 const { stdout } = await execFileAsync('gh', [
 'pr',
 'create',
 '--repo',
 `${owner}/${repo}`,
 '--head',
 branchName,
 '--base',
 defaultBranch,
 '--title',
 `Loom: ${branchName}`,
 '--body',
 `Opened by Loom for branch \`${branchName}\`.`,
 ])
 return { ok: true, prUrl: stdout.trim }
 } catch (error) {
 return {
 ok: true,
 compareUrl: `https://github.com/${owner}/${repo}/compare/${defaultBranch}...${branchName}`,
 warning: `Pushed, but PR creation failed: ${error instanceof Error ? error.message: String(error)}`,
 }
 }
 }

 if (host === 'gitlab.com') {
 try {
 const { stdout } = await execFileAsync('glab', [
 'mr',
 'create',
 '--repo',
 `${owner}/${repo}`,
 '--source-branch',
 branchName,
 '--target-branch',
 defaultBranch,
 '--title',
 `Loom: ${branchName}`,
 '--description',
 `Opened by Loom for branch \`${branchName}\`.`,
 '--yes',
 ])
 return { ok: true, prUrl: stdout.trim }
 } catch (error) {
 return {
 ok: true,
 compareUrl: `https://gitlab.com/${owner}/${repo}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${branchName}&merge_request%5Btarget_branch%5D=${defaultBranch}`,
 warning: `Pushed, but MR creation failed: ${error instanceof Error ? error.message: String(error)}`,
 }
 }
 }

 return { ok: true, warning: `Pushed. No PR/MR was opened — unrecognized git host: ${host}` }
}
