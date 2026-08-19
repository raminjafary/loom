import { execFile } from 'node:child_process'
import { isAbsolute, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * A mastery run's measured coverage.
 *
 * The server already holds the checkpoint table, the progress computation and flat-yield
 * detection, and every one of them read zero because **nothing ever sent the numbers**.
 * Coverage read "not measured" on every real run — a built surface promising more than
 * it showed.
 *
 * Both figures are the Runner's to compute and nobody else's, which is why they are
 * here rather than on the server:
 *
 * - The **numerator** is the files the run actually opened, observed from the tool calls
 *   the Runner is already relaying. Not a figure the agent reports: mastery is explicit
 *   that an agent's own estimate of its progress is model output, and may be a remark but
 *   never the number.
 * - The **denominator** is the tree at the mastered revision, which exists only on the
 *   Runner's machine — the same reason the revision itself has to be reported rather
 *   than resolved server-side.
 */

/**
 * Which tools count as reading a file, and the omissions are the design.
 *
 * `Grep` and `Glob` are deliberately absent. They *search* a tree and return paths, and
 * counting a glob that matched four hundred files as four hundred files read would make
 * coverage a measure of how wide a search was — the run would hit 100% having read
 * nothing, which is worse than reporting nothing at all. `Bash` is absent for the
 * neighbouring reason: `cat`, `head`, `sed -n` and a dozen others really do read a file,
 * and no parse of a shell line distinguishes them from `ls` reliably enough to put the
 * result in a percentage.
 *
 * A write counts as a read of the same file, because it is one — the agent had to open
 * it. Mastery runs are read-only in practice, so this is a rule about correctness rather
 * than a path that carries traffic.
 */
const FILE_ARGUMENT_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
}

/**
 * The repository-relative path a tool call opened, or null.
 *
 * Relative to the clone, because the denominator is `git ls-files` and the two have to
 * be counted in the same units — an absolute path and a tracked path that name one file
 * would otherwise be two entries in the set. A path outside the clone (the agent's HOME,
 * a temp file it wrote) is not in the denominator either, so it is dropped rather than
 * counted: coverage is a statement about the subject, and a run cannot cover the
 * repository by reading its own scratch directory.
 */
export const fileReadByToolCall = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  clonePath: string,
): string | null => {
  const fields = FILE_ARGUMENT_BY_TOOL[toolName]
  if (!fields) return null

  for (const field of fields) {
    const value = input[field]
    if (typeof value !== 'string' || value.trim().length === 0) continue
    const raw = value.trim()
    const rel = isAbsolute(raw) ? relative(clonePath, raw) : raw
    // `..` means it climbed out of the clone; an absolute result means `relative` gave up
    // because the two paths share no root.
    if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) continue
    return rel.split(sep).join('/')
  }
  return null
}

/**
 * How many files there are to read, at the revision being mastered.
 *
 * `git ls-files` rather than a directory walk, and that is what makes "minus what is
 * ignored" true without a second ignore parser: the tree's own `.gitignore` has
 * already been applied to what git tracks. `node_modules` and build output are therefore
 * out of the denominator for free, which is the difference between a coverage figure a
 * human can read and one that is asymptotically zero on any real repository.
 */
export const countFilesInScope = async (clonePath: string): Promise<number> => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', clonePath, 'ls-files'], {
      // A large monorepo's file list is megabytes; the default 1MB buffer would reject it
      // and the run would report a denominator of zero, which reads as "not measured".
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout.split('\n').filter((line) => line.trim().length > 0).length
  } catch {
    // A tree git cannot list still runs, and its map is still worth having. Zero is the
    // honest answer, and `computeMasteryProgress` renders it as no coverage rather than
    // as a percentage of nothing.
    return 0
  }
}

export interface CoverageTracker {
  /** Records a tool call; true when it opened a file this run had not opened before. */
  observe(toolName: string, input: Readonly<Record<string, unknown>>): boolean
  readonly filesRead: number
}

export const createCoverageTracker = (clonePath: string): CoverageTracker => {
  const seen = new Set<string>()
  return {
    observe(toolName, input) {
      const path = fileReadByToolCall(toolName, input, clonePath)
      if (path === null || seen.has(path)) return false
      seen.add(path)
      return true
    },
    get filesRead() {
      return seen.size
    },
  }
}

/**
 * How long to wait between checkpoints.
 *
 * A checkpoint is a row, and mastery wants a finished run reviewable as a *curve* — so one
 * per file read would make the curve unreadable on a run that opens four hundred of
 * them, and one per minute would give a ten-minute run ten points. Ten seconds is the
 * compromise, and the rule that matters more is the one in the caller: the last
 * checkpoint is sent unconditionally when the loop ends, so a run that finishes inside
 * one interval still reports its coverage rather than none.
 */
export const CHECKPOINT_INTERVAL_MS = 10_000

/**
 * Whether this tool call is the one that earns a checkpoint.
 *
 * A function rather than a condition inline in the run loop, because it is the whole
 * rule and it had no test: the loop that holds it has none at all, and the server's
 * integration test injects the frame the Runner would have produced — which proves the
 * handler and says nothing about whether anything sends one. Three handoffs recorded this
 * path as missing after it had shipped, for want of somewhere the claim could fail.
 *
 * Both halves matter. A call that opened nothing new is not progress, so a run re-reading
 * one file would otherwise checkpoint on a timer while coverage stood still. And the
 * interval is what keeps a curve readable on a run that opens four hundred files.
 */
export const shouldCheckpoint = (input: {
  openedSomethingNew: boolean
  now: number
  lastCheckpointAt: number
}): boolean =>
  input.openedSomethingNew && input.now - input.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS
