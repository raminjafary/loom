/**
 * Unified-diff parsing.
 *
 * Pure and in client-core rather than in the Vue component, for the reason the rest of
 * this package exists: reviewing a branch is the moment a human decides whether an
 * agent's work is any good, and a TUI has to be able to render the same review without
 * reimplementing what a hunk is.
 *
 * **Nothing here is ever rendered as HTML**. A diff is agent-produced content
 * quoting repository content, so every field below is plain text a view must interpolate,
 * never inject. The parser deliberately produces structure — files, hunks, line numbers,
 * counts — rather than marked-up strings, so a view has nothing to unescape.
 */

export type DiffLineKind = 'context' | 'add' | 'del'

export interface DiffLine {
  readonly kind: DiffLineKind
  /** Line number on the left (pre-change) side; null on an added line. */
  readonly oldNumber: number | null
  /** Line number on the right (post-change) side; null on a removed line. */
  readonly newNumber: number | null
  /** The line's content, without its leading +/-/space marker. */
  readonly text: string
}

export interface DiffHunk {
  readonly oldStart: number
  readonly newStart: number
  /** The text after the closing `@@`, which git fills with the enclosing function. */
  readonly context: string
  readonly lines: DiffLine[]
}

export type DiffFileStatus = 'added' | 'deleted' | 'renamed' | 'modified'

export interface DiffFile {
  /** What to show as the file's name — the new path, or the old one for a deletion. */
  readonly path: string
  readonly oldPath: string | null
  readonly newPath: string | null
  readonly status: DiffFileStatus
  readonly additions: number
  readonly deletions: number
  /** Git said the contents are binary, so there are no hunks to show. */
  readonly binary: boolean
  readonly hunks: DiffHunk[]
}

export interface ParsedDiff {
  readonly files: DiffFile[]
  readonly additions: number
  readonly deletions: number
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` → null, which is how add/delete are detected. */
const stripPrefix = (raw: string): string | null => {
  const path = raw.trim()
  if (path === '/dev/null') return null
  return path.replace(/^[ab]\//, '')
}

/**
 * Parses `git diff` output into files and hunks.
 *
 * Tolerant on purpose. This renders whatever a Runner produced, and a diff that fails to
 * parse must degrade to "no structure" rather than throw inside a render — a human trying
 * to review a branch is worse off with a blank panel than with an odd-looking one. Any
 * line that does not fit the grammar is skipped rather than rejected.
 */
export const parseUnifiedDiff = (raw: string): ParsedDiff => {
  const files: DiffFile[] = []
  if (raw.trim().length === 0) return { files, additions: 0, deletions: 0 }

  let file: {
    oldPath: string | null
    newPath: string | null
    binary: boolean
    hunks: DiffHunk[]
    additions: number
    deletions: number
    headerPath: string | null
  } | null = null
  let hunk: { oldStart: number; newStart: number; context: string; lines: DiffLine[] } | null = null
  let oldNumber = 0
  let newNumber = 0

  const closeFile = () => {
    if (!file) return
    if (hunk) file.hunks.push(hunk)
    hunk = null
    const path = file.newPath ?? file.oldPath ?? file.headerPath ?? '(unknown)'
    const status: DiffFileStatus =
      file.oldPath === null && file.newPath !== null
        ? 'added'
        : file.newPath === null && file.oldPath !== null
          ? 'deleted'
          : file.oldPath !== null && file.newPath !== null && file.oldPath !== file.newPath
            ? 'renamed'
            : 'modified'
    files.push({
      path,
      oldPath: file.oldPath,
      newPath: file.newPath,
      status,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      hunks: file.hunks,
    })
    file = null
  }

  /**
   * The trailing newline every diff ends with splits into a final empty string, and an
   * empty string is otherwise a legitimate context line — some producers strip the
   * leading space from a blank one. Dropping exactly the artifact keeps both true;
   * without this, every file gained a phantom trailing context line and every line
   * number after it was right only by luck.
   */
  const rawLines = raw.split('\n')
  if (rawLines.at(-1) === '') rawLines.pop()

  for (const line of rawLines) {
    if (line.startsWith('diff --git ')) {
      closeFile()
      // Falls back to the `diff --git` line's own paths, which is all a binary or
      // mode-only change gives us — there are no ---/+++ lines in those.
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      file = {
        oldPath: null,
        newPath: null,
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
        headerPath: match ? (match[2] ?? match[1] ?? null) : null,
      }
      continue
    }
    if (!file) continue

    if (line.startsWith('--- ')) {
      file.oldPath = stripPrefix(line.slice(4))
      continue
    }
    if (line.startsWith('+++ ')) {
      file.newPath = stripPrefix(line.slice(4))
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true
      continue
    }

    const hunkMatch = HUNK.exec(line)
    if (hunkMatch) {
      if (hunk) file.hunks.push(hunk)
      oldNumber = Number(hunkMatch[1])
      newNumber = Number(hunkMatch[3])
      hunk = {
        oldStart: oldNumber,
        newStart: newNumber,
        context: hunkMatch[5] ?? '',
        lines: [],
      }
      continue
    }
    if (!hunk) continue

    // "\ No newline at end of file" annotates the previous line and is not content.
    if (line.startsWith('\\')) continue

    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', oldNumber: null, newNumber, text: line.slice(1) })
      newNumber += 1
      file.additions += 1
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', oldNumber, newNumber: null, text: line.slice(1) })
      oldNumber += 1
      file.deletions += 1
    } else if (line.startsWith(' ') || line.length === 0) {
      hunk.lines.push({ kind: 'context', oldNumber, newNumber, text: line.slice(1) })
      oldNumber += 1
      newNumber += 1
    }
  }
  closeFile()

  return {
    files,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  }
}

/**
 * One hunk as aligned left/right rows, for a side-by-side view.
 *
 * A removal and the addition that replaces it are the same *edit*, and a unified view
 * makes a human scan two places to see one change. Pairing them is the whole value of a
 * split view, so consecutive del/add blocks are zipped rather than merely concatenated;
 * an unmatched line gets a null on the other side.
 */
export interface SplitRow {
  readonly left: DiffLine | null
  readonly right: DiffLine | null
}

export const splitHunk = (hunk: DiffHunk): SplitRow[] => {
  const rows: SplitRow[] = []
  let index = 0
  while (index < hunk.lines.length) {
    const line = hunk.lines[index]
    if (!line) break
    if (line.kind === 'context') {
      rows.push({ left: line, right: line })
      index += 1
      continue
    }
    // Collect the whole run of removals then the whole run of additions, then zip: git
    // emits them as two blocks, not interleaved.
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (hunk.lines[index]?.kind === 'del') {
      const l = hunk.lines[index]
      if (l) dels.push(l)
      index += 1
    }
    while (hunk.lines[index]?.kind === 'add') {
      const l = hunk.lines[index]
      if (l) adds.push(l)
      index += 1
    }
    const pairs = Math.max(dels.length, adds.length)
    for (let i = 0; i < pairs; i += 1) {
      rows.push({ left: dels[i] ?? null, right: adds[i] ?? null })
    }
  }
  return rows
}
