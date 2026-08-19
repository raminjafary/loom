import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeRunBranch } from './merge.js'
import { buildVerifyArgs } from './verify.js'

const execFileAsync = promisify(execFile)

/**
 * The merge queue's git, against real repositories. Mocking
 * git here would test nothing: every property that matters — that a rebase lands
 * on the current tip, that a conflict leaves the branch untouched, that a human's
 * uncommitted work is never moved — is a statement about what git actually did.
 *
 * Verification is left unconfigured throughout (`checks: []`), so these
 * exercise the ordering and safety rules without needing a container. The decision
 * of *whether* verification may run is `planMergeVerification`, unit-tested in the
 * domain.
 */

let root: string
let source: string

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

const commitFile = async (cwd: string, name: string, body: string, message: string) => {
  await writeFile(join(cwd, name), body)
  await git(cwd, ['add', '-A'])
  await git(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-m', message])
}

/** A clone on its own branch, exactly as `prepareRunWorkspace` produces one. */
const makeRunClone = async (branchName: string): Promise<string> => {
  const clone = await mkdtemp(join(root, 'clone-'))
  await execFileAsync('git', ['clone', '--quiet', source, clone])
  await git(clone, ['checkout', '-b', branchName])
  return clone
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loom-merge-test-'))
  source = await mkdtemp(join(root, 'source-'))
  await git(source, ['init', '--quiet', '--initial-branch=main'])
  await commitFile(source, 'README.md', 'base\n', 'base')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const merge = (clonePath: string, branchName: string) =>
  mergeRunBranch({
    sourcePath: source,
    clonePath,
    branchName,
    defaultBranch: 'main',
    checks: [],
  })

describe('mergeRunBranch', () => {
  it('fast-forwards the default branch onto the run\'s work', async () => {
    const clone = await makeRunClone('loom/run-1')
    await commitFile(clone, 'feature.txt', 'one\n', 'add feature')

    const result = await merge(clone, 'loom/run-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(await git(source, ['rev-parse', 'main'])).toBe(result.commitSha)
    expect(await git(source, ['log', '-1', '--pretty=%s'])).toBe('add feature')
    // Nothing verified this one, and the result says so rather than defaulting true.
    expect(result.verified).toBe(false)
    expect(result.note).toContain('no verification checks')
  })

  /**
   * The queue's whole reason for existing (repository binding: "sibling branches converge
   * through the merge queue, not a race"). Both clones were taken from the same base, so
   * the second only merges cleanly because it is rebased onto the first's result at merge
   * time rather than at enqueue time.
   */
  it('rebases each branch onto the previous merge, not onto the base it was cloned from', async () => {
    const first = await makeRunClone('loom/run-a')
    const second = await makeRunClone('loom/run-b')
    await commitFile(first, 'a.txt', 'a\n', 'add a')
    await commitFile(second, 'b.txt', 'b\n', 'add b')

    expect((await merge(first, 'loom/run-a')).ok).toBe(true)
    const result = await merge(second, 'loom/run-b')
    expect(result.ok).toBe(true)

    // Both files present, and b sits on top of a rather than beside it.
    expect(await git(source, ['log', '--pretty=%s'])).toBe('add b\nadd a\nbase')
  })

  /**
   * A host with no git identity is not a broken host — a CI runner and a freshly
   * provisioned machine both look like this, because git can only auto-detect an
   * address when the hostname has a domain. Until the committer was pinned, the
   * rebase above failed on exactly those machines and the queue reported it as a
   * merge failure, which names the symptom and not the cause.
   */
  it('rebases on a host that has no git identity to auto-detect', async () => {
    const identityless = join(root, 'no-identity-gitconfig')
    await writeFile(identityless, '[user]\n\tuseConfigOnly = true\n')
    const previous = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM }
    process.env.GIT_CONFIG_GLOBAL = identityless
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'

    try {
      const first = await makeRunClone('loom/run-c')
      const second = await makeRunClone('loom/run-d')
      await commitFile(first, 'c.txt', 'c\n', 'add c')
      await commitFile(second, 'd.txt', 'd\n', 'add d')

      expect((await merge(first, 'loom/run-c')).ok).toBe(true)
      expect((await merge(second, 'loom/run-d')).ok).toBe(true)
      expect(await git(source, ['log', '--pretty=%s'])).toBe('add d\nadd c\nbase')
    } finally {
      if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous.global
      if (previous.system === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = previous.system
    }
  })

  it('reports a conflict with the conflicting paths, and leaves the branch as its run produced it', async () => {
    const first = await makeRunClone('loom/run-c')
    const second = await makeRunClone('loom/run-d')
    await commitFile(first, 'shared.txt', 'from first\n', 'first writes shared')
    await commitFile(second, 'shared.txt', 'from second\n', 'second writes shared')

    expect((await merge(first, 'loom/run-c')).ok).toBe(true)
    const secondHeadBefore = await git(second, ['rev-parse', 'HEAD'])

    const result = await merge(second, 'loom/run-d')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('conflict')
    expect(result.detail).toContain('shared.txt')

    // Aborted, not left mid-rebase: the branch must stay reviewable and re-queueable.
    expect(await git(second, ['rev-parse', 'HEAD'])).toBe(secondHeadBefore)
    expect(await git(second, ['status', '--porcelain'])).toBe('')
    // And the failed merge changed nothing in the repository.
    expect(await git(source, ['log', '-1', '--pretty=%s'])).toBe('first writes shared')
  })

  it("refuses rather than disturbing a human's uncommitted work on the target branch", async () => {
    const clone = await makeRunClone('loom/run-e')
    await commitFile(clone, 'feature.txt', 'one\n', 'add feature')
    await writeFile(join(source, 'README.md'), 'edited by a human, not committed\n')

    const result = await merge(clone, 'loom/run-e')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('dirty_target')

    // The edit is still there, unstaged and unstashed.
    expect(await git(source, ['status', '--porcelain'])).toContain('README.md')
    expect(await git(source, ['log', '-1', '--pretty=%s'])).toBe('base')
  })

  /**
   * A dirty working tree only matters when the target branch is the one checked
   * out. On any other branch the merge moves a ref, which touches no files — so
   * refusing there would block merges for no reason.
   */
  it('merges into a target branch that is not checked out, without touching the working tree', async () => {
    const clone = await makeRunClone('loom/run-f')
    await commitFile(clone, 'feature.txt', 'one\n', 'add feature')

    await git(source, ['checkout', '--quiet', '-b', 'scratch'])
    await writeFile(join(source, 'README.md'), 'human work in progress\n')

    const result = await merge(clone, 'loom/run-f')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(await git(source, ['rev-parse', 'main'])).toBe(result.commitSha)
    // Still on scratch, still dirty, and the merged file never appeared here.
    expect(await git(source, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('scratch')
    expect(await git(source, ['status', '--porcelain'])).toContain('README.md')
  })

  it('merges a branch that has no commits of its own as a no-op, not a failure', async () => {
    const clone = await makeRunClone('loom/run-g')

    const result = await merge(clone, 'loom/run-g')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await git(source, ['rev-parse', 'main'])).toBe(result.commitSha)
    expect(await git(source, ['log', '--pretty=%s'])).toBe('base')
  })

  it('runs a configured verification command and merges when it passes', async () => {
    const clone = await makeRunClone('loom/run-h')
    await commitFile(clone, 'feature.txt', 'one\n', 'add feature')

    // Unsandboxed on purpose: this asserts the *plumbing* — that a command runs
    // against the rebased tree and its exit code decides the merge. Whether host
    // execution is permitted at all is `planMergeVerification`'s call, and the
    // acknowledgement below is what it requires.
    process.env.LOOM_SANDBOX_ENABLED = '0'
    process.env.LOOM_ALLOW_UNSANDBOXED = 'i-understand-the-agent-gets-my-privileges'
    try {
      const result = await mergeRunBranch({
        sourcePath: source,
        clonePath: clone,
        branchName: 'loom/run-h',
        defaultBranch: 'main',
        checks: [{ name: 'tests', command: 'test -f feature.txt' }],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.verified).toBe(true)
      expect(await git(source, ['rev-parse', 'main'])).toBe(result.commitSha)
    } finally {
      delete process.env.LOOM_SANDBOX_ENABLED
      delete process.env.LOOM_ALLOW_UNSANDBOXED
    }
  })

  it('merges nothing when verification fails, and hands the branch back', async () => {
    const clone = await makeRunClone('loom/run-i')
    await commitFile(clone, 'feature.txt', 'one\n', 'add feature')

    process.env.LOOM_SANDBOX_ENABLED = '0'
    process.env.LOOM_ALLOW_UNSANDBOXED = 'i-understand-the-agent-gets-my-privileges'
    try {
      const result = await mergeRunBranch({
        sourcePath: source,
        clonePath: clone,
        branchName: 'loom/run-i',
        defaultBranch: 'main',
        checks: [{ name: 'tests', command: 'echo "3 tests failed" && exit 1' }],
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('verification_failed')
      expect(result.detail).toContain('3 tests failed')
      expect(await git(source, ['log', '-1', '--pretty=%s'])).toBe('base')
    } finally {
      delete process.env.LOOM_SANDBOX_ENABLED
      delete process.env.LOOM_ALLOW_UNSANDBOXED
    }
  })

  /**
   * Found live, by the merge queue catching a reconciler that had merged two branches
   * over a limit the tests held (tools/reconcile-queue-check.mts, `over-budget-union`).
   *
   * The catch worked and the explanation did not: a real runner prints the assertion,
   * then its stack, then a dump of the error object, so the last twelve lines were
   * frames and field names and the thread message opened mid-stack. A safety net that
   * cannot say what it caught leaves the human worse off than the conflict did.
   */
  it('reports why verification failed rather than where, when the output ends in a stack', async () => {
    const clone = await makeRunClone('loom/run-i2')
    await commitFile(clone, 'feature.txt', 'one\n', 'add feature')

    process.env.LOOM_SANDBOX_ENABLED = '0'
    process.env.LOOM_ALLOW_UNSANDBOXED = 'i-understand-the-agent-gets-my-privileges'
    try {
      const noisy = [
        'echo "  AssertionError: the chain must stay at 4 or fewer"',
        ...Array.from({ length: 20 }, (_, i) => `echo "      at frame${i} (node:internal/x:${i}:1)"`),
        'exit 1',
      ].join(' && ')
      const result = await mergeRunBranch({
        sourcePath: source,
        clonePath: clone,
        branchName: 'loom/run-i2',
        defaultBranch: 'main',
        checks: [{ name: 'tests', command: noisy }],
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.detail).toContain('the chain must stay at 4 or fewer')
      expect(result.detail).not.toContain('node:internal')
    } finally {
      delete process.env.LOOM_SANDBOX_ENABLED
      delete process.env.LOOM_ALLOW_UNSANDBOXED
    }
  })

  /**
   * The boundary, at the one point the merge queue could quietly cross it: the
   * verification command executes code from the agent's own branch, so with no
   * sandbox it is agent code with the Runner's privileges. Refused before any git
   * runs, so a refusal never leaves a branch rewritten.
   */
  it('refuses to verify on the host without the explicit acknowledgement', async () => {
    const clone = await makeRunClone('loom/run-j')
    await commitFile(clone, 'feature.txt', 'one\n', 'add feature')
    const headBefore = await git(clone, ['rev-parse', 'HEAD'])

    process.env.LOOM_SANDBOX_ENABLED = '0'
    delete process.env.LOOM_ALLOW_UNSANDBOXED
    try {
      const result = await mergeRunBranch({
        sourcePath: source,
        clonePath: clone,
        branchName: 'loom/run-j',
        defaultBranch: 'main',
        checks: [{ name: 'tests', command: 'echo whatever' }],
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('verification_refused')
      expect(await git(clone, ['rev-parse', 'HEAD'])).toBe(headBefore)
      expect(await git(source, ['log', '-1', '--pretty=%s'])).toBe('base')
    } finally {
      delete process.env.LOOM_SANDBOX_ENABLED
    }
  })

  /**
   * The dependency cache under verification.
   *
   * `--network none` plus a bare `git clone` means a verification command can only run
   * what was committed, which excludes every project whose suite needs an install step.
   * The cache is what makes an offline install possible without opening the network,
   * and it is the difference between `verifyCommand` working on a real repository and
   * being a setting that only suits fixtures.
   */
  describe('with a dependency cache', () => {
    let cacheRoot: string

    beforeEach(async () => {
      cacheRoot = await mkdtemp(join(root, 'dep-cache-'))
      await writeFile(join(cacheRoot, 'warmed.txt'), 'from the warm step\n')
      process.env.LOOM_DEP_CACHE_ENABLED = '1'
      process.env.LOOM_DEP_CACHE_ROOT = cacheRoot
      process.env.LOOM_SANDBOX_ENABLED = '0'
      process.env.LOOM_ALLOW_UNSANDBOXED = 'i-understand-the-agent-gets-my-privileges'
    })

    afterEach(() => {
      delete process.env.LOOM_DEP_CACHE_ENABLED
      delete process.env.LOOM_DEP_CACHE_ROOT
      delete process.env.LOOM_DEP_CACHE_MODE
      delete process.env.LOOM_SANDBOX_ENABLED
      delete process.env.LOOM_ALLOW_UNSANDBOXED
    })

    it('gives the verification command the warmed cache', async () => {
      const clone = await makeRunClone('loom/run-k')
      await commitFile(clone, 'feature.txt', 'one\n', 'add feature')

      const result = await mergeRunBranch({
        sourcePath: source,
        clonePath: clone,
        branchName: 'loom/run-k',
        defaultBranch: 'main',
        // What an offline `npm ci` needs: the cache env pointing somewhere real, with
        // the warm step's contents in it.
        checks: [{ name: 'tests', command: 'test -f "$(dirname "$npm_config_cache")/warmed.txt"' }],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.verified).toBe(true)
    })

    /**
     * The property that makes this safe to mount at all. Verification executes code
     * from the branch under review, so anything it writes into its cache must die with
     * it — otherwise the cache is a channel from an agent's branch into whatever runs
     * next, which is exactly what `copy` mode exists to prevent.
     */
    it('discards what verification wrote into the cache, and never touches the warmed one', async () => {
      const clone = await makeRunClone('loom/run-l')
      await commitFile(clone, 'feature.txt', 'one\n', 'add feature')

      const result = await mergeRunBranch({
        sourcePath: source,
        clonePath: clone,
        branchName: 'loom/run-l',
        defaultBranch: 'main',
        checks: [{ name: 'tests', command: 'echo planted > "$(dirname "$npm_config_cache")/planted.txt"' }],
      })
      expect(result.ok).toBe(true)

      const survivors = await execFileAsync('ls', [cacheRoot]).then((r) => r.stdout)
      expect(survivors).toContain('warmed.txt')
      expect(survivors).not.toContain('planted.txt')
    })

    it('leaves the network closed and mounts the cache in the sandboxed path', () => {
      const config = {
        runtime: 'docker',
        image: 'loom-agent-sandbox:latest',
        network: 'loom-net',
        memory: '4g',
        cpus: '2',
        pidsLimit: '512',
      } as Parameters<typeof buildVerifyArgs>[0]

      const withCache = buildVerifyArgs(config, '/clone', 'npm test', '/host/deps')
      expect(withCache.join(' ')).toContain('--network none')
      expect(withCache).toContain('/host/deps:/deps:rw')
      expect(withCache.join(' ')).toContain('npm_config_cache=/deps/npm')

      // And nothing extra when no cache is configured — the mount is the opt-in, the
      // isolation is not.
      const without = buildVerifyArgs(config, '/clone', 'npm test', null)
      expect(without.join(' ')).toContain('--network none')
      expect(without.join(' ')).not.toContain('/deps')
    })
  })
})
