import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkPath } from './path-check.js'

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
