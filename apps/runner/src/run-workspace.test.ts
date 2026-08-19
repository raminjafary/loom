import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
 finishReconcile,
 getDiff,
 prepareReconcileWorkspace,
 prepareReviewWorkspace,
 prepareRunWorkspace,
 updateBranchFrom,
} from './run-workspace.js'

const execFileAsync = promisify(execFile)

/**
 * Real git, not a mock. The whole value of the reconcile workspace is the exact state
 * git is left in — a paused rebase with markers in the tree — and a mock would assert
 * the shape this file already assumes rather than the shape git actually produces.
 */

const git = (cwd: string, args: string[]) =>
 execFileAsync('git', ['-C', cwd, '-c', 'user.email=t@t.invalid', '-c', 'user.name=t',...args])

/**
 * A source repository plus a run clone whose branch conflicts with work that landed on
 * the default branch after it was cloned. This is the merge queue's conflict case, built
 * the only way it can honestly be built: both sides diverge from the same base.
 */
const buildConflict = async => {
 const source = await mkdtemp(join(tmpdir, 'recon-src-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', source])
 await writeFile(join(source, 'list.md'), '# List\n\n- base entry\n')
 await git(source, ['add', '-A'])
 await git(source, ['commit', '-qm', 'base'])

 // The worker's clone, taken before the sibling lands.
 const { clonePath } = await prepareRunWorkspace(source, 'worker-1')
 await writeFile(join(clonePath, 'list.md'), '# List\n\n- base entry\n- from the worker\n')
 await git(clonePath, ['add', '-A'])
 await git(clonePath, ['commit', '-qm', 'worker work'])

 // The sibling, landing on main afterwards and touching the same line region.
 await writeFile(join(source, 'list.md'), '# List\n\n- base entry\n- from the sibling\n')
 await git(source, ['add', '-A'])
 await git(source, ['commit', '-qm', 'sibling work'])

 return { source, clonePath, branchName: 'loom/run-worker-1' }
}

describe('prepareReconcileWorkspace', => {
 it('leaves a paused rebase with real conflict markers in the tree', async => {
 const { source, clonePath, branchName } = await buildConflict
 const workspace = await prepareReconcileWorkspace(clonePath, source, 'main', branchName, 'recon-1')

 expect(workspace.conflictedPaths).toEqual(['list.md'])
 const content = await readFile(join(workspace.clonePath, 'list.md'), 'utf8')
 expect(content).toContain('<<<<<<<')
 expect(content).toContain('from the worker')
 expect(content).toContain('from the sibling')
 })

 it('does not touch the branch in the run\'s own clone', async => {
 // A reconciler that goes wrong must not damage the branch a human may still want to
 // review or fix by hand, so it works in a clone of the clone.
 const { source, clonePath, branchName } = await buildConflict
 const before = (await git(clonePath, ['rev-parse', 'HEAD'])).stdout.trim
 const workspace = await prepareReconcileWorkspace(clonePath, source, 'main', branchName, 'recon-2')

 expect(workspace.clonePath).not.toBe(clonePath)
 expect((await git(clonePath, ['rev-parse', 'HEAD'])).stdout.trim).toBe(before)
 })

 it('reports no conflicts when the rebase turns out clean', async => {
 // Legitimate: the target can move between the failed merge attempt and this run.
 const source = await mkdtemp(join(tmpdir, 'recon-clean-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', source])
 await writeFile(join(source, 'a.md'), 'base\n')
 await git(source, ['add', '-A'])
 await git(source, ['commit', '-qm', 'base'])
 const { clonePath } = await prepareRunWorkspace(source, 'worker-2')
 await writeFile(join(clonePath, 'b.md'), 'independent\n')
 await git(clonePath, ['add', '-A'])
 await git(clonePath, ['commit', '-qm', 'work'])

 const workspace = await prepareReconcileWorkspace(clonePath, source, 'main', 'loom/run-worker-2', 'recon-3')
 expect(workspace.conflictedPaths).toEqual([])
 })
})

describe('finishReconcile', => {
 it('commits the rebase once the markers are gone, keeping both sides', async => {
 const { source, clonePath, branchName } = await buildConflict
 const workspace = await prepareReconcileWorkspace(clonePath, source, 'main', branchName, 'recon-4')

 // What the reconciler agent does: keep both, drop the markers.
 await writeFile(
 join(workspace.clonePath, 'list.md'),
 '# List\n\n- base entry\n- from the sibling\n- from the worker\n',
)

 const result = await finishReconcile(workspace.clonePath)
 expect(result.ok).toBe(true)

 const content = await readFile(join(workspace.clonePath, 'list.md'), 'utf8')
 expect(content).toContain('from the worker')
 expect(content).toContain('from the sibling')
 expect(content).not.toContain('<<<<<<<')
 // Rebased, so the sibling's commit is an ancestor rather than a sibling.
 const log = (await git(workspace.clonePath, ['log', '--oneline'])).stdout
 expect(log).toContain('sibling work')
 expect(log).toContain('worker work')
 })

 it('refuses when conflict markers survive, and leaves no rebase in progress', async => {
 // The safety property: `git rebase --continue` does not read file contents, so
 // without this check a branch carrying `<<<<<<<` merges clean into the default
 // branch. Refusing is also an expected outcome — the persona is told to refuse
 // conflicts that encode a real disagreement.
 const { source, clonePath, branchName } = await buildConflict
 const workspace = await prepareReconcileWorkspace(clonePath, source, 'main', branchName, 'recon-5')

 const result = await finishReconcile(workspace.clonePath)
 expect(result.ok).toBe(false)
 if (!result.ok) expect(result.reason).toContain('list.md')

 const status = (await git(workspace.clonePath, ['status', '--porcelain=v2', '--branch'])).stdout
 expect(status).not.toContain('rebase')
 })

 it('writes the reconciled branch back into a clone that has it checked out', async => {
 /**
 * The regression that reached a live run: `prepareRunWorkspace` leaves the run's
 * branch checked out, and git refuses to fetch into a checked-out branch. The
 * reconciler resolved its conflict correctly and the result was discarded here,
 * reported to the human as "the reconciler did not resolve it".
 *
 * The merge queue merges out of the *parent's* clone, so if this does not land the
 * queue re-merges the untouched branch and conflicts again forever.
 */
 const { source, clonePath, branchName } = await buildConflict
 const workspace = await prepareReconcileWorkspace(clonePath, source, 'main', branchName, 'recon-7')
 await writeFile(
 join(workspace.clonePath, 'list.md'),
 '# List\n\n- base entry\n- from the sibling\n- from the worker\n',
)
 const finished = await finishReconcile(workspace.clonePath)
 expect(finished.ok).toBe(true)

 expect((await git(clonePath, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim).toBe(branchName)
 await updateBranchFrom(clonePath, workspace.clonePath, branchName)

 // The ref moved *and* the working tree with it — a moved ref over a stale tree
 // would make the next `git status` in that clone report phantom changes.
 if (finished.ok) {
 expect((await git(clonePath, ['rev-parse', 'HEAD'])).stdout.trim).toBe(finished.commitSha)
 }
 expect((await git(clonePath, ['status', '--porcelain'])).stdout.trim).toBe('')
 expect(await readFile(join(clonePath, 'list.md'), 'utf8')).toContain('from the sibling')
 })

 it('refuses a resolution that staged markers rather than removing them', async => {
 // The dangerous shape: git considers the path resolved because it was staged, so
 // `diff --diff-filter=U` reports nothing and only the content check catches it.
 const { source, clonePath, branchName } = await buildConflict
 const workspace = await prepareReconcileWorkspace(clonePath, source, 'main', branchName, 'recon-6')
 await git(workspace.clonePath, ['add', 'list.md'])

 const result = await finishReconcile(workspace.clonePath)
 expect(result.ok).toBe(false)
 if (!result.ok) expect(result.reason).toContain('list.md')
 })
})

/**
 * The "read access to the reviewed branch", against real git.
 *
 * The two properties are the point of the function. The reviewer must *see* the work —
 * a review of the default branch is a review of nothing — and it must not be *on* that
 * branch, because `commitRunWork` commits whatever the agent left behind and a stray
 * edit would otherwise land on the reviewed branch's own name.
 */
describe('prepareReviewWorkspace', => {
 const buildReviewable = async => {
 const source = await mkdtemp(join(tmpdir, 'review-src-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', source])
 await writeFile(join(source, 'app.ts'), 'export const a = 1\n')
 await git(source, ['add', '-A'])
 await git(source, ['commit', '-qm', 'base'])

 const { clonePath, branchName } = await prepareRunWorkspace(source, 'worker-9')
 await writeFile(join(clonePath, 'app.ts'), 'export const a = 1\nexport const b = 2\n')
 await git(clonePath, ['add', '-A'])
 await git(clonePath, ['commit', '-qm', 'the work under review'])
 return { source, clonePath, branchName }
 }

 it('opens on the reviewed work', async => {
 const { clonePath, branchName } = await buildReviewable
 const workspace = await prepareReviewWorkspace(clonePath, branchName, 'reviewer-1')

 const content = await readFile(join(workspace.clonePath, 'app.ts'), 'utf8')
 expect(content).toContain('export const b = 2')
 })

 it('gives the reviewer its own branch, not the one it reviews', async => {
 // Load-bearing: two runs answering to one branch name is how a reviewer's stray
 // edit would reach the merge queue as the reviewed run's work.
 const { clonePath, branchName } = await buildReviewable
 const workspace = await prepareReviewWorkspace(clonePath, branchName, 'reviewer-2')

 expect(workspace.branchName).toBe('loom/run-reviewer-2')
 expect(workspace.branchName).not.toBe(branchName)
 const { stdout } = await git(workspace.clonePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
 expect(stdout.trim).toBe('loom/run-reviewer-2')
 })

 it('leaves no rebase in progress — a reviewer reads, it does not resolve', async => {
 const { clonePath, branchName } = await buildReviewable
 const workspace = await prepareReviewWorkspace(clonePath, branchName, 'reviewer-3')

 const { stdout } = await git(workspace.clonePath, ['status', '--porcelain'])
 expect(stdout.trim).toBe('')
 })

 it('has a computable diff — a clone of a clone has no local default branch', async => {
 /**
 * `git clone` creates a local branch only for the source's HEAD, and the source here
 * is a run clone with its own run branch checked out. So `main` exists only as
 * `origin/main`, and `git diff main...HEAD` fails outright.
 *
 * Found live: a reviewer's diff came back empty while its notes quoted the code it
 * had just read. Silent, because the caller reads a git error as "no diff yet".
 * `prepareReconcileWorkspace` produces the same shape, so this was latent there too.
 */
 const { clonePath, branchName } = await buildReviewable
 const workspace = await prepareReviewWorkspace(clonePath, branchName, 'reviewer-5')

 const diff = await getDiff(workspace.clonePath, 'main')
 expect(diff).toContain('export const b = 2')
 })

 it('cannot affect the branch it reviews', async => {
 // A clone, not a checkout of the reviewed clone — the reviewed branch is what a
 // human may still want to read by hand.
 const { clonePath, branchName } = await buildReviewable
 const workspace = await prepareReviewWorkspace(clonePath, branchName, 'reviewer-4')
 await writeFile(join(workspace.clonePath, 'app.ts'), 'reviewer scribbled here\n')
 await git(workspace.clonePath, ['add', '-A'])
 await git(workspace.clonePath, ['commit', '-qm', 'a stray edit'])

 const original = await readFile(join(clonePath, 'app.ts'), 'utf8')
 expect(original).toContain('export const b = 2')
 expect(original).not.toContain('scribbled')
 })
})

/**
 * The generating side — the held-out screen. A screening run has to open on the tree the
 * original run faced, so the clone is pinned at a commit rather than taken at HEAD.
 */
describe('prepareRunWorkspace, pinned at a commit', => {
 const buildHistory = async => {
 const source = await mkdtemp(join(tmpdir, 'pin-src-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', source])
 await writeFile(join(source, 'state.md'), 'first\n')
 await git(source, ['add', '-A'])
 await git(source, ['commit', '-qm', 'first'])
 const first = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim

 await writeFile(join(source, 'state.md'), 'second\n')
 await git(source, ['add', '-A'])
 await git(source, ['commit', '-qm', 'second'])
 const head = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim
 return { source, first, head }
 }

 it('opens the branch at the named commit, not at the source HEAD', async => {
 const { source, first } = await buildHistory
 const { clonePath } = await prepareRunWorkspace(source, 'pinned-1', first)

 expect((await git(clonePath, ['rev-parse', 'HEAD'])).stdout.trim).toBe(first)
 expect(await readFile(join(clonePath, 'state.md'), 'utf8')).toBe('first\n')
 })

 it('still takes HEAD when no commit is named, which is every other run', async => {
 const { source, head } = await buildHistory
 const { clonePath } = await prepareRunWorkspace(source, 'pinned-2')
 expect((await git(clonePath, ['rev-parse', 'HEAD'])).stdout.trim).toBe(head)
 })

 it('fails on a commit the clone does not contain, rather than falling back to HEAD', async => {
 // The silent alternative is the whole reason this is asserted: a screening run that
 // quietly opened at HEAD would report a verdict about a commit nobody asked for, and
 // The control would have drifted without anything saying so.
 const { source } = await buildHistory
 await expect(
 prepareRunWorkspace(source, 'pinned-3', '0000000000000000000000000000000000000000'),
).rejects.toThrow
 })

 it('still applies the hook and fsmonitor pinning repository binding requires', async => {
 const { source, first } = await buildHistory
 const { clonePath } = await prepareRunWorkspace(source, 'pinned-4', first)
 expect((await git(clonePath, ['config', 'core.hooksPath'])).stdout.trim).toBe('/dev/null')
 expect((await git(clonePath, ['config', 'core.fsmonitor'])).stdout.trim).toBe('false')
 })
})
