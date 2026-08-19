import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_INTERVAL_MS,
  shouldCheckpoint,
  countFilesInScope,
  createCoverageTracker,
  fileReadByToolCall,
} from './mastery-progress.js'

const execFileAsync = promisify(execFile)

/**
 * A mastery run's measured coverage.
 *
 * The failure these are written against is not a wrong number, it is *no* number: the
 * checkpoint table, the progress computation and flat-yield detection were all built and
 * tested, and coverage read "not measured" on every real run because nothing counted.
 */
describe('fileReadByToolCall', () => {
  const clone = '/tmp/clone'

  it('counts a read, by the path relative to the clone', () => {
    expect(fileReadByToolCall('Read', { file_path: '/tmp/clone/src/app.ts' }, clone)).toBe(
      'src/app.ts',
    )
    expect(fileReadByToolCall('Read', { file_path: 'src/app.ts' }, clone)).toBe('src/app.ts')
  })

  /**
   * The omission that keeps coverage meaningful. A glob matching four hundred files is
   * not four hundred files read — counting it would let a run reach 100% having read
   * nothing, which is worse than reporting nothing.
   */
  it('does not count a search as a read', () => {
    expect(fileReadByToolCall('Grep', { pattern: 'x', path: 'src' }, clone)).toBeNull()
    expect(fileReadByToolCall('Glob', { pattern: '**/*.ts' }, clone)).toBeNull()
    expect(fileReadByToolCall('Bash', { command: 'cat src/app.ts' }, clone)).toBeNull()
  })

  it('drops a path outside the clone, which is not in the denominator either', () => {
    expect(fileReadByToolCall('Read', { file_path: '/home/agent/.bashrc' }, clone)).toBeNull()
    expect(fileReadByToolCall('Read', { file_path: '../secrets.env' }, clone)).toBeNull()
  })

  it('ignores a call with no usable path rather than counting an empty one', () => {
    expect(fileReadByToolCall('Read', {}, clone)).toBeNull()
    expect(fileReadByToolCall('Read', { file_path: '   ' }, clone)).toBeNull()
  })
})

describe('createCoverageTracker', () => {
  it('counts each file once, however many times it is opened', () => {
    const tracker = createCoverageTracker('/tmp/clone')

    expect(tracker.observe('Read', { file_path: '/tmp/clone/a.ts' })).toBe(true)
    expect(tracker.observe('Read', { file_path: '/tmp/clone/a.ts' })).toBe(false)
    // The same file by a relative path is the same file — the two have to agree, or the
    // numerator counts one file twice against a denominator that counted it once.
    expect(tracker.observe('Read', { file_path: 'a.ts' })).toBe(false)
    expect(tracker.observe('Read', { file_path: 'b.ts' })).toBe(true)

    expect(tracker.filesRead).toBe(2)
  })
})

describe('countFilesInScope', () => {
  it('counts what git tracks, so what is ignored is out of the denominator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-scope-'))
    await execFileAsync('git', ['-C', dir, 'init', '-q'])
    await writeFile(join(dir, '.gitignore'), 'node_modules\n')
    await writeFile(join(dir, 'a.ts'), 'export const a = 1\n')
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 2\n')
    await mkdir(join(dir, 'node_modules'))
    await writeFile(join(dir, 'node_modules', 'huge.js'), 'module.exports = {}\n')
    await execFileAsync('git', ['-C', dir, 'add', '-A'])

    // .gitignore, a.ts, src/b.ts — and not the dependency tree, which is the difference
    // between a coverage figure a human can read and one that is asymptotically zero.
    expect(await countFilesInScope(dir)).toBe(3)
  })

  it('answers zero rather than throwing for a tree git cannot list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-scope-none-'))
    expect(await countFilesInScope(dir)).toBe(0)
  })
})

/**
 * The rule the run loop applies per tool call.
 *
 * Its own function and its own tests because the loop holding it has neither, and the
 * server's integration test injects the frame the Runner would have produced — proving
 * the handler while saying nothing about whether anything sends one. That gap is why
 * three handoffs recorded this path as missing after it had shipped.
 */
describe('shouldCheckpoint', () => {
  it('checkpoints when a new file is opened and the interval has passed', () => {
    expect(
      shouldCheckpoint({
        openedSomethingNew: true,
        now: CHECKPOINT_INTERVAL_MS,
        lastCheckpointAt: 0,
      }),
    ).toBe(true)
  })

  /** A run re-reading one file would otherwise checkpoint on a timer while coverage stood still. */
  it('does not checkpoint on a call that opened nothing new', () => {
    expect(
      shouldCheckpoint({
        openedSomethingNew: false,
        now: CHECKPOINT_INTERVAL_MS * 10,
        lastCheckpointAt: 0,
      }),
    ).toBe(false)
  })

  /** One row per file would make the curve unreadable on a run that opens four hundred. */
  it('does not checkpoint again inside the interval', () => {
    expect(
      shouldCheckpoint({
        openedSomethingNew: true,
        now: CHECKPOINT_INTERVAL_MS - 1,
        lastCheckpointAt: 0,
      }),
    ).toBe(false)
  })
})
