import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { cloneDirectory, type DepCacheConfig } from './dep-cache.js'

const execFileAsync = promisify(execFile)

/**
 * The base-image half of the base-image-and-dependency-cache story that parallel workers
 * need before they are useful.
 *
 * The cache half shipped: a run's `npm install` resolves offline in seconds instead of
 * minutes. What it does not remove is the install itself — a run still starts on a bare
 * clone with no `node_modules`, so every worker in a swarm pays it, and pays it *as a model
 * turn*: the agent has to notice, decide, and spend a tool call before it can run one test.
 * Repository binding says where this belongs — "it also needs the warm step, which is where
 * the base-image half of this bullet belongs" — so it is built there rather than as a
 * per-repository container image.
 *
 * **What is captured is decided by the repository, not by a list of directory names.**
 * After the operator's install command finishes in the warm clone, this takes the
 * top-level directories git reports as **ignored** — `node_modules`, `.venv`,
 * `vendor`, `target`, `.next`, whatever this repository's own `.gitignore` says. That
 * is the safety property and not merely a convenience:
 *
 * - A tracked file can never be captured, so materializing a prepared tree into a run
 *   can never change what `git status` reports, what `commitRunWork`'s `git add -A`
 *   commits, or what diff a human reviews. The run's branch is exactly what it would
 *   have been.
 * - It generalizes past JavaScript without a per-ecosystem table to maintain.
 *
 * **Nothing a model produced ever reaches it.** The tree is written only by the warm
 * step, which runs the *operator's* command with no agent in the loop — the same
 * argument the cache's `copy` mode rests on — and each run receives a copy-on-write
 * copy, never a shared mount, so nothing a run writes into `node_modules` is visible
 * to the next one.
 *
 * **The paths line up because the warm step runs where a run runs.** Both mount the
 * clone at `/work` and the cache at `/deps`, so an absolute path baked into an
 * install output — pnpm's symlink farm into the store, a compiled binary's rpath —
 * still resolves inside a run's container.
 */

export interface PreparedTreeConfig {
  /** Host directory holding one prepared tree per repository. */
  readonly root: string
  /** Refuse to capture a tree larger than this; 0 disables the cap. */
  readonly maxBytes: number
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024

/**
 * Derived from the dependency cache's own root rather than configured separately.
 * A prepared tree without the cache behind it is a half-measure — the run would get
 * `node_modules` and then still resolve a fresh install against an empty cache — and
 * two independent switches would let an operator reach that state without meaning to.
 */
export const preparedTreeFromEnv = (
  cache: DepCacheConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): PreparedTreeConfig | null => {
  if (!cache) return null
  if (env.LOOM_PREPARED_TREE_ENABLED === '0') return null
  const maxBytes = Number(env.LOOM_PREPARED_TREE_MAX_BYTES ?? DEFAULT_MAX_BYTES)
  return {
    root: env.LOOM_PREPARED_TREE_ROOT ?? join(cache.root, '..', 'loom-prepared'),
    maxBytes: Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : DEFAULT_MAX_BYTES,
  }
}

/** What was captured, written beside the tree so a human can see what a run will get. */
export interface PreparedTreeManifest {
  readonly repositoryId: string
  readonly capturedAt: string
  readonly directories: string[]
  readonly bytes: number
  /**
   * The install-input files as they stood when the tree was captured, by content
   * digest. A run whose clone disagrees still gets the tree — a near-miss
   * `node_modules` is what every incremental install starts from, and is strictly
   * better than an empty one — but it is *said*, because the alternative is a
   * platform quietly handing out a stale answer.
   */
  readonly lockDigest: string
}

const MANIFEST = 'manifest.json'

const treeDir = (config: PreparedTreeConfig, repositoryId: string): string =>
  join(config.root, repositoryId)

/**
 * Files whose content decides what an install produces. Hashed, not merely dated: a
 * lockfile touched by a rebase has a new mtime and identical content, and re-warming
 * a multi-gigabyte tree over that would be pure cost.
 */
const LOCK_FILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'requirements.txt',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'go.sum',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
]

export const lockDigest = async (clonePath: string): Promise<string> => {
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256')
  for (const name of LOCK_FILES) {
    try {
      hash.update(name)
      hash.update(await readFile(join(clonePath, name)))
    } catch {
      // Absent is a fact about this repository, and one that has to change the digest:
      // otherwise adding a lockfile to a repository that had none reads as unchanged.
      hash.update('\0')
    }
  }
  return hash.digest('hex')
}

/**
 * Top-level directories this repository ignores and that the install actually created.
 *
 * `git status --porcelain --ignored` rather than a name list, for the reason in this
 * file's header. Directories only: an ignored *file* (a `.env`, a build artifact) is
 * not something a run needs and is exactly the sort of thing that should not be
 * copied around, so the filter is deliberately narrow.
 */
export const capturableDirectories = async (clonePath: string): Promise<string[]> => {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', clonePath, 'status', '--porcelain', '--ignored=matching', '-z'],
    { maxBuffer: 64 * 1024 * 1024 },
  )
  const entries = stdout.split('\0').filter((line) => line.length > 0)
  const names = new Set<string>()
  for (const entry of entries) {
    // `!! node_modules/` — status code, a space, then the path.
    if (!entry.startsWith('!!')) continue
    const path = entry.slice(3)
    if (!path.endsWith('/')) continue
    const top = path.replace(/\/.*$/, '')
    // `.git` is never a dependency artifact, and copying one into a fresh clone would
    // replace the run's own branch with the warm clone's.
    if (top.length === 0 || top === '.git') continue
    names.add(top)
  }

  const present: string[] = []
  for (const name of [...names].sort()) {
    const info = await stat(join(clonePath, name)).catch(() => null)
    if (info?.isDirectory()) present.push(name)
  }
  return present
}

const directoryBytes = async (path: string): Promise<number> => {
  let total = 0
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(current, entry.name)
      // Not followed: a symlink's target is counted where it lives, and following one
      // out of the tree would both over-count and hang on a cycle.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) total += (await stat(child).catch(() => null))?.size ?? 0
    }
  }
  await walk(path)
  return total
}

export type CaptureResult =
  | { readonly ok: true; readonly manifest: PreparedTreeManifest }
  | { readonly ok: false; readonly detail: string }

/**
 * Captures the warm clone's install output as this repository's prepared tree.
 *
 * Written to a temporary directory and moved into place, so a warm that dies halfway
 * leaves the previous tree intact rather than a half-copied one that every later run
 * would inherit.
 */
export const capturePreparedTree = async (
  config: PreparedTreeConfig,
  input: {
    repositoryId: string
    clonePath: string
    /**
     * The digest as it stood **before** the install ran, which is what a run's clone
     * will look like — the install's own output is not an input to it.
     *
     * Taken by the caller rather than recomputed here, because by the time this runs
     * the install has already written its lockfile. Found live: a fixture with no
     * committed `package-lock.json` had one generated by `npm install`, so every
     * later run compared its (absent) lockfile against the generated one and every
     * prepared tree reported itself stale on the first use.
     */
    lockDigestBeforeInstall?: string
  },
): Promise<CaptureResult> => {
  const directories = await capturableDirectories(input.clonePath)
  if (directories.length === 0) {
    return {
      ok: false,
      detail:
        'the install produced no git-ignored directories, so there is nothing a run could be given ' +
        '— check that the install command writes into the repository (for example node_modules) ' +
        'and that the repository ignores what it writes',
    }
  }

  let bytes = 0
  for (const name of directories) bytes += await directoryBytes(join(input.clonePath, name))
  if (config.maxBytes > 0 && bytes > config.maxBytes) {
    return {
      ok: false,
      detail:
        `the install produced ${(bytes / 1e9).toFixed(1)} GB across ${directories.join(', ')}, ` +
        `over the ${(config.maxBytes / 1e9).toFixed(1)} GB limit — runs will install for themselves ` +
        'instead. Raise LOOM_PREPARED_TREE_MAX_BYTES if that is wanted.',
    }
  }

  await mkdir(config.root, { recursive: true })
  const staging = await mkdtemp(join(config.root, `.staging-${input.repositoryId}-`))
  try {
    for (const name of directories) {
      // Created first: `cloneDirectory` copies `source/.` into an existing target.
      await mkdir(join(staging, name), { recursive: true })
      await cloneDirectory(join(input.clonePath, name), join(staging, name))
    }
    const manifest: PreparedTreeManifest = {
      repositoryId: input.repositoryId,
      capturedAt: new Date().toISOString(),
      directories,
      bytes,
      lockDigest: input.lockDigestBeforeInstall ?? (await lockDigest(input.clonePath)),
    }
    await writeFile(join(staging, MANIFEST), JSON.stringify(manifest, null, 2))

    const destination = treeDir(config, input.repositoryId)
    // Replaced, not merged: a directory an install stopped producing must disappear
    // rather than linger in every future run.
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
    return { ok: true, manifest }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

export const readPreparedTree = async (
  config: PreparedTreeConfig,
  repositoryId: string,
): Promise<PreparedTreeManifest | null> => {
  try {
    const raw = await readFile(join(treeDir(config, repositoryId), MANIFEST), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const manifest = parsed as PreparedTreeManifest
    if (!Array.isArray(manifest.directories)) return null
    return manifest
  } catch {
    return null
  }
}

export interface MaterializeResult {
  readonly directories: string[]
  /** True when the clone's install inputs no longer match what was captured. */
  readonly stale: boolean
}

/**
 * Copies a repository's prepared tree into a fresh run clone.
 *
 * A copy per run, never a mount — the same rule the dependency cache's `copy` mode
 * follows, for the same reason: a directory shared between sandboxes is a channel
 * between them, and everything a run writes is untrusted. Copy-on-write makes this
 * cost milliseconds on APFS and reflink-capable Linux filesystems.
 *
 * A directory the clone already has is skipped rather than merged. That case is not
 * hypothetical — a repository can legitimately commit a `vendor/` — and merging into
 * one would put files under a path the run's own checkout owns.
 */
export const materializePreparedTree = async (
  config: PreparedTreeConfig,
  input: { repositoryId: string; clonePath: string },
): Promise<MaterializeResult | null> => {
  const manifest = await readPreparedTree(config, input.repositoryId)
  if (!manifest) return null

  const source = treeDir(config, input.repositoryId)
  const copied: string[] = []
  for (const name of manifest.directories) {
    const destination = join(input.clonePath, name)
    if (await stat(destination).catch(() => null)) continue
    if (!(await stat(join(source, name)).catch(() => null))) continue
    await mkdir(destination, { recursive: true })
    await cloneDirectory(join(source, name), destination)
    copied.push(name)
  }

  return {
    directories: copied,
    stale: (await lockDigest(input.clonePath)) !== manifest.lockDigest,
  }
}

/** Removes a repository's prepared tree — used when a repository is unbound. */
export const discardPreparedTree = async (
  config: PreparedTreeConfig,
  repositoryId: string,
): Promise<void> => {
  await rm(treeDir(config, repositoryId), { recursive: true, force: true })
}

/** Only for tests that need a throwaway root. */
export const temporaryPreparedRoot = (): string => join(tmpdir(), 'loom-prepared-test')
