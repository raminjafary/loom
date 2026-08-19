import { execFile } from 'node:child_process'
import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'
import { LOOM_COMMITTER_FLAGS } from './git-identity.js'

const execFileAsync = promisify(execFile)

/**
 * The two Runner capabilities beyond `checkPath`: `listDirectory`, which backs the web
 * directory-picker and the TUI equivalent alike, and repository creation via `git init`.
 *
 * Both are gated by the same boundary as everything else the Runner exposes: a path is
 * usable only if it resolves, *after symlinks*, inside one of this Runner's configured
 * allowed roots. Repository binding states the reason plainly — without it, "an agent can
 * be aimed at `~/.ssh`". A directory picker is a more tempting way in than most, since
 * browsing is the one operation that looks harmless.
 */

export interface DirectoryEntry {
  readonly name: string
  readonly path: string
  readonly isDirectory: boolean
  /** Has a `.git` directory — the picker highlights these as bindable. */
  readonly isRepository: boolean
}

export type ListDirectoryResult =
  | {
      readonly ok: true
      readonly path: string
      /** Null when going up would leave the allowed roots — the picker hides "up" then. */
      readonly parent: string | null
      readonly entries: DirectoryEntry[]
      /** True when the listing hit ENTRY_LIMIT; the picker says so rather than implying a small directory. */
      readonly truncated: boolean
    }
  | { readonly ok: false; readonly error: string }

/**
 * A home directory can hold tens of thousands of entries, and this crosses two
 * sockets to reach a browser. Truncation is reported rather than silent, because
 * a picker that quietly omits the folder someone is looking for is worse than one
 * that says it ran out.
 */
const ENTRY_LIMIT = 500

const realpathOr = async (path: string): Promise<string> => {
  try {
    return await realpath(resolvePath(path))
  } catch {
    return resolvePath(path)
  }
}

const withinRoots = (real: string, roots: readonly string[]): boolean =>
  roots.some((root) => real === root || real.startsWith(`${root}/`))

const isRepository = async (path: string): Promise<boolean> => {
  try {
    return (await stat(join(path, '.git'))).isDirectory()
  } catch {
    return false
  }
}

/**
 * Lists one directory's entries, scoped to the allowed roots.
 *
 * An empty path lists the roots themselves. That is deliberate: it gives the
 * picker a starting point it does not have to guess, and it means no client ever
 * needs to know a real filesystem path to begin browsing — the first thing it can
 * name is something the Runner already permitted.
 */
export const listDirectory = async (
  path: string,
  allowedRoots: readonly string[],
): Promise<ListDirectoryResult> => {
  const resolvedRoots = await Promise.all(allowedRoots.map(realpathOr))

  if (path.trim().length === 0) {
    const entries = await Promise.all(
      resolvedRoots.map(async (root) => ({
        name: root,
        path: root,
        isDirectory: true,
        isRepository: await isRepository(root),
      })),
    )
    return { ok: true, path: '', parent: null, entries, truncated: false }
  }

  let real: string
  try {
    real = await realpath(resolvePath(path))
  } catch {
    return { ok: false, error: `Path does not exist: ${path}` }
  }

  if (!withinRoots(real, resolvedRoots)) {
    return { ok: false, error: "Path is outside this Runner's allowed roots" }
  }

  let dirents
  try {
    dirents = await readdir(real, { withFileTypes: true })
  } catch (error) {
    return {
      ok: false,
      error: `Cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Directories first, then files, each alphabetical — a picker's rows are
  // clickable, and an unstable order moves a row out from under a click. Same
  // lesson as the run lists' ORDER BY.
  const sorted = dirents
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .sort((a, b) => {
      const aDir = a.isDirectory()
      const bDir = b.isDirectory()
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  const limited = sorted.slice(0, ENTRY_LIMIT)
  const entries = await Promise.all(
    limited.map(async (entry) => {
      const entryPath = join(real, entry.name)
      return {
        name: entry.name,
        path: entryPath,
        isDirectory: entry.isDirectory(),
        isRepository: entry.isDirectory() ? await isRepository(entryPath) : false,
      }
    }),
  )

  // Null rather than the real parent when stepping up would leave the roots: the
  // picker must not offer a door out of the boundary, even one that the server
  // would refuse on the next call.
  const parentPath = dirname(real)
  const parent =
    parentPath !== real && withinRoots(parentPath, resolvedRoots) ? parentPath : null

  return { ok: true, path: real, parent, entries, truncated: sorted.length > ENTRY_LIMIT }
}

export type InitRepositoryResult =
  | { readonly ok: true; readonly path: string; readonly defaultBranch: string }
  | { readonly ok: false; readonly error: string }

/**
 * Creates a new git repository under an allowed root, via `git init`.
 *
 * It makes an initial commit rather than leaving the repository empty. An empty
 * repository has no HEAD, so `prepareRunWorkspace`'s clone-and-branch and the
 * merge queue's `defaultBranch` fetch both fail on it — a repository you cannot
 * run anything against is not a useful thing for this to produce.
 *
 * The commit is attributed to the platform, not to the human who clicked: no
 * person authored this content, and putting their name on it would be the same
 * small dishonesty as attributing an agent's work to them.
 */
export const initRepository = async (
  parentPath: string,
  name: string,
  allowedRoots: readonly string[],
): Promise<InitRepositoryResult> => {
  // A name is a single path segment, never a path. Without this, "../../.ssh"
  // walks straight out of the root the parent was checked against.
  if (name !== basename(name) || name.length === 0 || name === '.' || name === '..') {
    return { ok: false, error: 'Repository name must be a single directory name' }
  }

  const resolvedRoots = await Promise.all(allowedRoots.map(realpathOr))

  let realParent: string
  try {
    realParent = await realpath(resolvePath(parentPath))
  } catch {
    return { ok: false, error: `Parent directory does not exist: ${parentPath}` }
  }
  if (!withinRoots(realParent, resolvedRoots)) {
    return { ok: false, error: "Parent directory is outside this Runner's allowed roots" }
  }

  const target = join(realParent, name)
  try {
    await stat(target)
    return { ok: false, error: `${target} already exists` }
  } catch {
    // Does not exist, which is what we want.
  }

  try {
    await mkdir(target)
    await execFileAsync('git', ['init', '--quiet', '-b', 'main', target])
    await writeFile(join(target, 'README.md'), `# ${name}\n`)
    await execFileAsync('git', ['-C', target, 'add', 'README.md'])
    await execFileAsync('git', [
      '-C',
      target,
      ...LOOM_COMMITTER_FLAGS,
      'commit',
      '--quiet',
      '-m',
      'Initial commit',
    ])
    return { ok: true, path: target, defaultBranch: 'main' }
  } catch (error) {
    return {
      ok: false,
      error: `Failed to create repository: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
