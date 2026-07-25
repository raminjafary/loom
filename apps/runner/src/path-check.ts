import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type PathCheckResult =
  | { readonly ok: true; readonly defaultBranch: string }
  | { readonly ok: false; readonly error: string }

/**
 * The actual security boundary from PLAN.md §5a: a path is only usable if it
 * resolves (after symlinks) inside one of this Runner's configured allowed
 * roots. Without this, a compromised or careless server request could point
 * the Runner at `~/.ssh` or `/`.
 */
export const checkPath = async (
  path: string,
  allowedRoots: readonly string[],
): Promise<PathCheckResult> => {
  let real: string
  try {
    real = await realpath(resolvePath(path))
  } catch {
    return { ok: false, error: `Path does not exist: ${path}` }
  }

  // realpath, not just resolve(): on macOS /tmp is itself a symlink to
  // /private/tmp, so comparing against an unresolved root silently fails
  // every check whose target happened to realpath-resolve through it.
  const resolvedRoots = await Promise.all(
    allowedRoots.map(async (root) => {
      try {
        return await realpath(resolvePath(root))
      } catch {
        return resolvePath(root)
      }
    }),
  )

  const withinAllowedRoot = resolvedRoots.some(
    (root) => real === root || real.startsWith(`${root}/`),
  )
  if (!withinAllowedRoot) {
    return { ok: false, error: "Path is outside this Runner's allowed roots" }
  }

  try {
    const gitDir = await stat(`${real}/.git`)
    if (!gitDir.isDirectory()) {
      return { ok: false, error: 'Not a git repository (.git is not a directory)' }
    }
  } catch {
    return { ok: false, error: 'Not a git repository (no .git directory)' }
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', real, 'branch', '--show-current'])
    const branch = stdout.trim()
    return { ok: true, defaultBranch: branch.length > 0 ? branch : 'main' }
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read git branch: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
