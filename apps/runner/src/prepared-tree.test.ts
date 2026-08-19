import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  capturableDirectories,
  capturePreparedTree,
  lockDigest,
  materializePreparedTree,
  preparedTreeFromEnv,
  readPreparedTree,
  type PreparedTreeConfig,
} from './prepared-tree.js'

const execFileAsync = promisify(execFile)

/**
 * The base-image half. The property that matters most is the one about *what* gets
 * captured: only directories the repository itself ignores, so a prepared tree can
 * never change a run's `git status`, its commit, or the diff a human reviews.
 */

const roots: string[] = []

const scratch = async (prefix: string): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), `loom-prepared-test-${prefix}-`))
  roots.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** A git repository with a `.gitignore`, a tracked file, and an install-shaped output. */
const repository = async (options: { ignore?: string; lock?: string } = {}): Promise<string> => {
  const path = await scratch('repo')
  const git = (args: string[]) => execFileAsync('git', ['-C', path, ...args])
  await git(['init', '--quiet'])
  await git(['config', 'user.email', 'test@loom.invalid'])
  await git(['config', 'user.name', 'test'])
  await writeFile(join(path, '.gitignore'), options.ignore ?? 'node_modules/\n')
  await writeFile(join(path, 'index.js'), 'module.exports = 1\n')
  if (options.lock !== undefined) await writeFile(join(path, 'package-lock.json'), options.lock)
  await git(['add', '-A'])
  await git(['commit', '--quiet', '-m', 'initial'])
  return path
}

const installOutput = async (repoPath: string): Promise<void> => {
  await mkdir(join(repoPath, 'node_modules', 'left-pad'), { recursive: true })
  await writeFile(join(repoPath, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 2\n')
}

const config = async (): Promise<PreparedTreeConfig> => ({
  root: await scratch('root'),
  maxBytes: 0,
})

describe('preparedTreeFromEnv', () => {
  const cache = { root: '/tmp/loom-dep-cache', mode: 'copy' as const }

  it('is null without a dependency cache, because half of it would be worse than neither', () => {
    expect(preparedTreeFromEnv(null, {})).toBeNull()
  })

  it('follows the cache on by default, and can be turned off alone', () => {
    expect(preparedTreeFromEnv(cache, {})).not.toBeNull()
    expect(preparedTreeFromEnv(cache, { LOOM_PREPARED_TREE_ENABLED: '0' })).toBeNull()
  })

  it('falls back to the default cap rather than to no cap on a malformed one', () => {
    // A typo must not remove a limit; the safe reading of "8gb" is the default.
    const parsed = preparedTreeFromEnv(cache, { LOOM_PREPARED_TREE_MAX_BYTES: '8gb' })
    expect(parsed?.maxBytes).toBeGreaterThan(0)
  })
})

describe('capturableDirectories', () => {
  it('takes what the repository ignores, and nothing it tracks', async () => {
    const repo = await repository()
    await installOutput(repo)
    await mkdir(join(repo, 'src'), { recursive: true })
    await writeFile(join(repo, 'src', 'app.js'), '')

    expect(await capturableDirectories(repo)).toEqual(['node_modules'])
  })

  it('generalizes past node_modules without a per-ecosystem list', async () => {
    const repo = await repository({ ignore: '.venv/\ntarget/\n' })
    await mkdir(join(repo, '.venv', 'lib'), { recursive: true })
    await writeFile(join(repo, '.venv', 'lib', 'x'), 'x')
    await mkdir(join(repo, 'target', 'debug'), { recursive: true })
    await writeFile(join(repo, 'target', 'debug', 'bin'), 'x')

    expect(await capturableDirectories(repo)).toEqual(['.venv', 'target'])
  })

  it('never offers .git, which would replace a run\'s own branch', async () => {
    const repo = await repository({ ignore: '.git\nnode_modules/\n' })
    await installOutput(repo)
    expect(await capturableDirectories(repo)).not.toContain('.git')
  })

  it('ignores an ignored file, which is not something a run needs', async () => {
    const repo = await repository({ ignore: 'node_modules/\n.env\n' })
    await installOutput(repo)
    await writeFile(join(repo, '.env'), 'SECRET=1')
    expect(await capturableDirectories(repo)).toEqual(['node_modules'])
  })
})

describe('capturePreparedTree', () => {
  it('captures the install output and records what it captured', async () => {
    const repo = await repository()
    await installOutput(repo)
    const cfg = await config()

    const result = await capturePreparedTree(cfg, { repositoryId: 'r1', clonePath: repo })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.manifest.directories).toEqual(['node_modules'])
    expect(result.manifest.bytes).toBeGreaterThan(0)
    expect(await readPreparedTree(cfg, 'r1')).toEqual(result.manifest)
  })

  it('says so rather than reporting an empty tree as prepared', async () => {
    const repo = await repository()
    const result = await capturePreparedTree(await config(), { repositoryId: 'r1', clonePath: repo })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('no git-ignored directories')
  })

  it('refuses a tree over its size cap, naming the limit', async () => {
    const repo = await repository()
    await installOutput(repo)
    const cfg = { root: await scratch('root'), maxBytes: 1 }

    const result = await capturePreparedTree(cfg, { repositoryId: 'r1', clonePath: repo })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('LOOM_PREPARED_TREE_MAX_BYTES')
    expect(await readPreparedTree(cfg, 'r1')).toBeNull()
  })

  /**
   * A directory the install stopped producing has to disappear. Merging instead would
   * leave every future run inheriting an artifact of a build that no longer exists.
   */
  it('replaces a previous capture rather than merging into it', async () => {
    const cfg = await config()
    const first = await repository({ ignore: 'node_modules/\nold/\n' })
    await installOutput(first)
    await mkdir(join(first, 'old'), { recursive: true })
    await writeFile(join(first, 'old', 'stale'), 'x')
    await capturePreparedTree(cfg, { repositoryId: 'r1', clonePath: first })

    const second = await repository()
    await installOutput(second)
    await capturePreparedTree(cfg, { repositoryId: 'r1', clonePath: second })

    expect((await readPreparedTree(cfg, 'r1'))?.directories).toEqual(['node_modules'])
    expect(await stat(join(cfg.root, 'r1', 'old')).catch(() => null)).toBeNull()
  })
})

describe('materializePreparedTree', () => {
  it('gives a fresh clone the install output without touching what git tracks', async () => {
    const cfg = await config()
    const source = await repository()
    await installOutput(source)
    await capturePreparedTree(cfg, { repositoryId: 'r1', clonePath: source })

    const clone = await scratch('clone')
    await execFileAsync('git', ['clone', '--quiet', source, clone])

    const before = await execFileAsync('git', ['-C', clone, 'status', '--porcelain'])
    const result = await materializePreparedTree(cfg, { repositoryId: 'r1', clonePath: clone })

    expect(result?.directories).toEqual(['node_modules'])
    expect(await readFile(join(clone, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toContain(
      'module.exports = 2',
    )

    /**
     * The property the whole design rests on: what a run commits and what a human
     * reviews are exactly what they would have been without a prepared tree.
     */
    const after = await execFileAsync('git', ['-C', clone, 'status', '--porcelain'])
    expect(after.stdout).toBe(before.stdout)
    expect(after.stdout.trim()).toBe('')
  })

  it('is null when this repository has never been warmed', async () => {
    const clone = await scratch('clone')
    expect(await materializePreparedTree(await config(), { repositoryId: 'r1', clonePath: clone })).toBeNull()
  })

  /**
   * A repository can legitimately commit a `vendor/`. Merging into one would put
   * files under a path the run's own checkout owns.
   */
  it('leaves a directory the clone already has alone', async () => {
    const cfg = await config()
    const source = await repository()
    await installOutput(source)
    await capturePreparedTree(cfg, { repositoryId: 'r1', clonePath: source })

    const clone = await scratch('clone')
    await mkdir(join(clone, 'node_modules'), { recursive: true })
    await writeFile(join(clone, 'node_modules', 'mine'), 'ours')

    const result = await materializePreparedTree(cfg, { repositoryId: 'r1', clonePath: clone })
    expect(result?.directories).toEqual([])
    expect(await stat(join(clone, 'node_modules', 'left-pad')).catch(() => null)).toBeNull()
  })

  it('still hands over a stale tree, and says that it is stale', async () => {
    const cfg = await config()
    const source = await repository({ lock: '{"v":1}' })
    await installOutput(source)
    await capturePreparedTree(cfg, { repositoryId: 'r1', clonePath: source })

    const clone = await scratch('clone')
    await execFileAsync('git', ['clone', '--quiet', source, clone])
    await writeFile(join(clone, 'package-lock.json'), '{"v":2}')

    const result = await materializePreparedTree(cfg, { repositoryId: 'r1', clonePath: clone })
    // Handed over anyway: a near-miss node_modules is what every incremental install
    // starts from, and is strictly better than an empty one.
    expect(result?.directories).toEqual(['node_modules'])
    expect(result?.stale).toBe(true)
  })
})

describe('lockDigest', () => {
  it('changes when a lockfile appears, not only when one changes', async () => {
    const repo = await repository()
    const without = await lockDigest(repo)
    await writeFile(join(repo, 'package-lock.json'), '{}')
    expect(await lockDigest(repo)).not.toBe(without)
  })

  it('is unchanged by a touched-but-identical lockfile', async () => {
    const repo = await repository({ lock: '{"v":1}' })
    const first = await lockDigest(repo)
    await writeFile(join(repo, 'package-lock.json'), '{"v":1}')
    expect(await lockDigest(repo)).toBe(first)
  })
})
