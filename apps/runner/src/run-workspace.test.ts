import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { finishReconcile, prepareReconcileWorkspace, prepareRunWorkspace } from './run-workspace.js'

const execFileAsync = promisify(execFile)

/**
 * Real git, not a mock. The whole value of the reconcile workspace is the exact state
 * git is left in — a paused rebase with markers in the tree — and a mock would assert
 * the shape this file already assumes rather than the shape git actually produces.
 */

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', ...args])

/**
 * A source repository plus a run clone whose branch conflicts with work that landed on
 * the default branch after it was cloned. This is the merge queue's conflict case, built
 * the only way it can honestly be built: both sides diverge from the same base.
 */
const buildConflict = async () => {
  const source = await mkdtemp(join(tmpdir(), 'recon-src-'))
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

describe('prepareReconcileWorkspace', () => {
  it('leaves a paused rebase with real conflict markers in the tree', async () => {
    const { source, clonePath, branchName } = await buildConflict()
    const workspace = await prepareReconcileWorkspace(clonePath, source, 'main', branchName, 'recon-1')

    expect(workspace.conflictedPaths).toEqual(['list.md'])
    const content = await readFile(join(workspace.clonePath, 'list.md'), 'utf8')
    expect(content).toContain('<<<<<<<')
    expect(content).toContain('from the worker')
    expect(content).toContain('from the sibling')
  })

  it('does not touch the branch in the run\'s own clone', async () => {
    // A reconciler that goes wrong must not damage the branch a human may still want to
    // review or fix by hand, so it works in a clone of the clone.
    const { source, clonePath, branchName } = await buildConflict()
    const before = (await git(clonePath, ['rev-parse', 'HEAD'])).stdout.trim()
    const workspace = await prepareReconcileWorkspace(clonePath, source, 'main', branchName, 'recon-2')

    expect(workspace.clonePath).not.toBe(clonePath)
    expect((await git(clonePath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(before)
  })

  it('reports no conflicts when the rebase turns out clean', async () => {
    // Legitimate: the target can move between the failed merge attempt and this run.
    const source = await mkdtemp(join(tmpdir(), 'recon-clean-'))
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

describe('finishReconcile', () => {
  it('commits the rebase once the markers are gone, keeping both sides', async () => {
    const { source, clonePath, branchName } = await buildConflict()
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

  it('refuses when conflict markers survive, and leaves no rebase in progress', async () => {
    // The safety property: `git rebase --continue` does not read file contents, so
    // without this check a branch carrying `<<<<<<<` merges clean into the default
    // branch. Refusing is also an expected outcome — the persona is told to refuse
    // conflicts that encode a real disagreement.
    const { source, clonePath, branchName } = await buildConflict()
    const workspace = await prepareReconcileWorkspace(clonePath, source, 'main', branchName, 'recon-5')

    const result = await finishReconcile(workspace.clonePath)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('list.md')

    const status = (await git(workspace.clonePath, ['status', '--porcelain=v2', '--branch'])).stdout
    expect(status).not.toContain('rebase')
  })

  it('refuses a resolution that staged markers rather than removing them', async () => {
    // The dangerous shape: git considers the path resolved because it was staged, so
    // `diff --diff-filter=U` reports nothing and only the content check catches it.
    const { source, clonePath, branchName } = await buildConflict()
    const workspace = await prepareReconcileWorkspace(clonePath, source, 'main', branchName, 'recon-6')
    await git(workspace.clonePath, ['add', 'list.md'])

    const result = await finishReconcile(workspace.clonePath)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('list.md')
  })
})
