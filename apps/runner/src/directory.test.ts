import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initRepository, listDirectory } from './directory.js'

const execFileAsync = promisify(execFile)

/**
 * The allowed-root boundary, applied to the two capabilities that browse
 * and create rather than merely validate. Repository binding states the stakes directly: without
 * the boundary, "an agent can be aimed at `~/.ssh`". A picker is the most tempting
 * way past it, because listing a directory looks like it does nothing.
 */

let root: string
let allowed: string
let forbidden: string

beforeEach(async => {
 // realpath, not just mkdtemp's answer: on macOS /var is a symlink to /private/var,
 // so an unresolved fixture path never equals what the implementation returns —
 // the same trap `checkPath` documents.
 root = await realpath(await mkdtemp(join(tmpdir, 'loom-dir-test-')))
 allowed = join(root, 'allowed')
 forbidden = join(root, 'forbidden')
 await mkdir(allowed)
 await mkdir(forbidden)
 await writeFile(join(forbidden, 'id_rsa'), 'a secret\n')
})

afterEach(async => {
 await rm(root, { recursive: true, force: true })
})

describe('listDirectory', => {
 it('lists the allowed roots when given no path, so a client never has to guess one', async => {
 const result = await listDirectory('', [allowed])
 expect(result.ok).toBe(true)
 if (!result.ok) return
 expect(result.entries.map((e) => e.name)).toEqual([allowed])
 // No way up from the roots — the boundary shows as an absence, not an error.
 expect(result.parent).toBeNull
 })

 it('lists directories before files, each alphabetical', async => {
 await mkdir(join(allowed, 'zeta'))
 await mkdir(join(allowed, 'alpha'))
 await writeFile(join(allowed, 'a-file.txt'), '')
 await writeFile(join(allowed, 'b-file.txt'), '')

 const result = await listDirectory(allowed, [allowed])
 expect(result.ok).toBe(true)
 if (!result.ok) return
 // Unstable order moves a clickable row out from under a click — the same
 // lesson the run lists' ORDER BY came from.
 expect(result.entries.map((e) => e.name)).toEqual(['alpha', 'zeta', 'a-file.txt', 'b-file.txt'])
 expect(result.entries.map((e) => e.isDirectory)).toEqual([true, true, false, false])
 })

 it('flags which directories are git repositories', async => {
 const repo = join(allowed, 'a-repo')
 await mkdir(repo)
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', repo])
 await mkdir(join(allowed, 'b-plain'))

 const result = await listDirectory(allowed, [allowed])
 expect(result.ok).toBe(true)
 if (!result.ok) return
 expect(result.entries.find((e) => e.name === 'a-repo')?.isRepository).toBe(true)
 expect(result.entries.find((e) => e.name === 'b-plain')?.isRepository).toBe(false)
 })

 it('refuses a path outside the allowed roots', async => {
 const result = await listDirectory(forbidden, [allowed])
 expect(result.ok).toBe(false)
 if (result.ok) return
 expect(result.error).toContain('allowed roots')
 })

 /**
 * The one that matters. A symlink inside an allowed root pointing out of it is
 * the obvious way to make a scoped listing unscoped, and `resolve` alone does
 * not catch it — only realpath does.
 */
 it('refuses a symlink that escapes the allowed roots', async => {
 const escape = join(allowed, 'escape')
 await symlink(forbidden, escape)

 const result = await listDirectory(escape, [allowed])
 expect(result.ok).toBe(false)
 if (result.ok) return
 expect(result.error).toContain('allowed roots')
 })

 it('reports no parent when stepping up would leave the roots', async => {
 const nested = join(allowed, 'nested')
 await mkdir(nested)

 const inner = await listDirectory(nested, [allowed])
 expect(inner.ok).toBe(true)
 if (!inner.ok) return
 expect(inner.parent).toBe(allowed)

 const outer = await listDirectory(allowed, [allowed])
 expect(outer.ok).toBe(true)
 if (!outer.ok) return
 // `root` is the real parent on disk, but it is outside the boundary, so the
 // picker is given nothing to render rather than a door it would be refused at.
 expect(outer.parent).toBeNull
 })

 it('reports truncation rather than quietly showing a short directory', async => {
 for (let i = 0; i < 520; i += 1) {
 await writeFile(join(allowed, `f${String(i).padStart(4, '0')}.txt`), '')
 }
 const result = await listDirectory(allowed, [allowed])
 expect(result.ok).toBe(true)
 if (!result.ok) return
 expect(result.entries).toHaveLength(500)
 expect(result.truncated).toBe(true)
 })

 it('reports a missing path rather than throwing', async => {
 const result = await listDirectory(join(allowed, 'nope'), [allowed])
 expect(result.ok).toBe(false)
 })
})

describe('initRepository', => {
 it('creates a repository with an initial commit, not an empty one', async => {
 const result = await initRepository(allowed, 'fresh', [allowed])
 expect(result.ok).toBe(true)
 if (!result.ok) return
 expect(result.defaultBranch).toBe('main')

 // An empty repository has no HEAD, so clone-and-branch and the merge queue's
 // defaultBranch fetch both fail against it — a repo you cannot run anything
 // against is not a useful thing to produce.
 const { stdout } = await execFileAsync('git', ['-C', result.path, 'log', '--oneline'])
 expect(stdout.trim).toContain('Initial commit')
 })

 it('attributes the initial commit to the platform, not to a person', async => {
 const result = await initRepository(allowed, 'attributed', [allowed])
 expect(result.ok).toBe(true)
 if (!result.ok) return
 const { stdout } = await execFileAsync('git', ['-C', result.path, 'log', '-1', '--pretty=%an <%ae>'])
 expect(stdout.trim).toBe('Loom <loom@loom.invalid>')
 })

 /** Otherwise the name walks straight out of the root the parent was checked against. */
 it('refuses a name that is a path rather than a single segment', async => {
 for (const name of ['../escape', 'a/b', '..', '.']) {
 const result = await initRepository(allowed, name, [allowed])
 expect(result.ok).toBe(false)
 }
 })

 it('refuses a parent outside the allowed roots', async => {
 const result = await initRepository(forbidden, 'nope', [allowed])
 expect(result.ok).toBe(false)
 if (result.ok) return
 expect(result.error).toContain('allowed roots')
 })

 it('refuses to overwrite something that already exists', async => {
 await mkdir(join(allowed, 'taken'))
 const result = await initRepository(allowed, 'taken', [allowed])
 expect(result.ok).toBe(false)
 if (result.ok) return
 expect(result.error).toContain('already exists')
 })
})
