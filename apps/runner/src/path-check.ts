import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type PathCheckResult =
 | { readonly ok: true; readonly defaultBranch: string }
 | { readonly ok: false; readonly error: string }

/**
 * The actual security boundary from repository binding: a path is only usable if it
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

 // realpath, not just resolve: on macOS /tmp is itself a symlink to
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
 if (!gitDir.isDirectory) {
 return { ok: false, error: 'Not a git repository (.git is not a directory)' }
 }
 } catch {
 return { ok: false, error: 'Not a git repository (no.git directory)' }
 }

 try {
 const { stdout } = await execFileAsync('git', ['-C', real, 'branch', '--show-current'])
 const branch = stdout.trim
 return { ok: true, defaultBranch: branch.length > 0 ? branch: 'main' }
 } catch (error) {
 return {
 ok: false,
 error: `Failed to read git branch: ${error instanceof Error ? error.message: String(error)}`,
 }
 }
}

/**
 * Symlink-safe realpath, but tolerant of a target that doesn't exist yet —
 * `Write` routinely targets a file that isn't there yet, so realpath on the
 * full path would just throw. Walks up to the nearest existing ancestor,
 * resolves *that*, and re-appends the not-yet-created suffix; only the
 * existing prefix can hide a symlink anyway.
 */
const resolveExisting = async (target: string): Promise<string> => {
 const suffix: string[] = []
 let current = target
 for (;;) {
 try {
 const real = await realpath(current)
 return suffix.length > 0 ? join(real,...suffix.reverse): real
 } catch {
 const parent = dirname(current)
 if (parent === current) return target
 suffix.push(relative(parent, current))
 current = parent
 }
 }
}

/**
 * The resolver `classifyToolEffect` (packages/domain/src/risky-tools.ts)
 * calls to check a Write/Edit/NotebookEdit target against the run's clone —
 * domain has zero dependencies, so the actual filesystem access lives here.
 */
export const resolveWithinRoot = async (
 path: string,
 root: string,
): Promise<{ readonly withinRoot: boolean }> => {
 const targetAbs = isAbsolute(path) ? path: resolvePath(root, path)
 const [realRoot, realTarget] = await Promise.all([resolveExisting(root), resolveExisting(targetAbs)])
 const rel = relative(realRoot, realTarget)
 return { withinRoot: rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) }
}
