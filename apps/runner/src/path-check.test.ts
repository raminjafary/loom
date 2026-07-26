import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkPath, resolveWithinRoot } from './path-check.js'

const execFileAsync = promisify(execFile)

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loom-runner-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('checkPath', () => {
  it('accepts a real git repo inside an allowed root', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    await execFileAsync('git', ['init', '-q', '-b', 'main', repoPath])

    const result = await checkPath(repoPath, [root])
    expect(result).toEqual({ ok: true, defaultBranch: 'main' })
  })

  it('rejects a path outside every allowed root — the actual security boundary', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'loom-outside-'))
    try {
      await execFileAsync('git', ['init', '-q', outside])
      const result = await checkPath(outside, [root])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/allowed roots/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a directory that is not a git repo', async () => {
    const notRepo = join(root, 'plain-dir')
    await mkdir(notRepo)
    const result = await checkPath(notRepo, [root])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/git repository/)
  })

  it('rejects a path that does not exist', async () => {
    const result = await checkPath(join(root, 'nope'), [root])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/does not exist/)
  })

  it('resolves symlinks before the allowed-root check, not after', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'loom-symlink-target-'))
    try {
      await execFileAsync('git', ['init', '-q', outside])
      const { symlink } = await import('node:fs/promises')
      const linkPath = join(root, 'escape-link')
      await symlink(outside, linkPath)

      // A naive check on the raw (unresolved) path would see it "inside"
      // root; realpath must resolve it to `outside` first.
      const result = await checkPath(linkPath, [root])
      expect(result.ok).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('resolveWithinRoot', () => {
  it('accepts a path inside the root', async () => {
    const result = await resolveWithinRoot(join(root, 'file.txt'), root)
    expect(result.withinRoot).toBe(true)
  })

  it('accepts a not-yet-existing target inside the root — Write creates new files', async () => {
    const result = await resolveWithinRoot(join(root, 'nested', 'new-file.txt'), root)
    expect(result.withinRoot).toBe(true)
  })

  it('rejects a path outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'loom-outside-'))
    try {
      const result = await resolveWithinRoot(join(outside, 'file.txt'), root)
      expect(result.withinRoot).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a relative path that escapes the root via ..', async () => {
    const result = await resolveWithinRoot('../escape.txt', root)
    expect(result.withinRoot).toBe(false)
  })

  it('resolves a symlinked root before comparing — the same escape checkPath guards against', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'loom-symlink-target-'))
    try {
      const linkedRoot = join(root, 'linked-root')
      await symlink(outside, linkedRoot)
      const result = await resolveWithinRoot(join(linkedRoot, 'file.txt'), linkedRoot)
      expect(result.withinRoot).toBe(true)

      const escaping = await resolveWithinRoot(join(outside, '..', 'other', 'file.txt'), linkedRoot)
      expect(escaping.withinRoot).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects an existing file that symlinks outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'loom-symlink-file-'))
    try {
      const realFile = join(outside, 'secret.txt')
      await writeFile(realFile, 'secret')
      const linkPath = join(root, 'escape-link.txt')
      await symlink(realFile, linkPath)

      const result = await resolveWithinRoot(linkPath, root)
      expect(result.withinRoot).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
