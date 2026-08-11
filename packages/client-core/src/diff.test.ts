import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff, splitHunk } from './diff.js'

const DIFF = `diff --git a/src/registry.js b/src/registry.js
index e92541a..5553b2c 100644
--- a/src/registry.js
+++ b/src/registry.js
@@ -1,4 +1,5 @@ export const middlewares
 // Middlewares applied in order.
 export const middlewares = [
-  { name: 'logger' },
+  { name: 'logger', wrap: (h) => h },
+  { name: 'etag', wrap: (h) => h },
 ]
`

describe('parseUnifiedDiff', () => {
  it('splits into files, hunks and numbered lines', () => {
    const parsed = parseUnifiedDiff(DIFF)
    expect(parsed.files).toHaveLength(1)
    const file = parsed.files[0]!
    expect(file.path).toBe('src/registry.js')
    expect(file.status).toBe('modified')
    expect(file.additions).toBe(2)
    expect(file.deletions).toBe(1)
    expect(parsed.additions).toBe(2)
    expect(parsed.deletions).toBe(1)

    const hunk = file.hunks[0]!
    // git puts the enclosing symbol after the closing @@ — worth showing, so worth keeping.
    expect(hunk.context).toBe('export const middlewares')
    expect(hunk.oldStart).toBe(1)
    expect(hunk.newStart).toBe(1)
  })

  /**
   * The numbering is the whole reason to parse rather than print. A removed line has no
   * line number on the right and an added line none on the left; getting that wrong puts
   * every subsequent line against the wrong number, which is worse than showing none.
   */
  it('numbers each side independently', () => {
    const lines = parseUnifiedDiff(DIFF).files[0]!.hunks[0]!.lines
    expect(lines.map((l) => [l.kind, l.oldNumber, l.newNumber])).toEqual([
      ['context', 1, 1],
      ['context', 2, 2],
      ['del', 3, null],
      ['add', null, 3],
      ['add', null, 4],
      ['context', 4, 5],
    ])
  })

  it('strips the a/ and b/ prefixes but not a directory called a', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/a/thing.ts b/a/thing.ts\n--- a/a/thing.ts\n+++ b/a/thing.ts\n@@ -1 +1 @@\n-x\n+y\n',
    )
    expect(parsed.files[0]!.path).toBe('a/thing.ts')
  })

  it('recognises an added file by its /dev/null source', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n',
    )
    expect(parsed.files[0]).toMatchObject({ status: 'added', path: 'new.txt', additions: 1 })
  })

  it('recognises a deleted file, and names it by its old path', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/gone.txt b/gone.txt\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n',
    )
    expect(parsed.files[0]).toMatchObject({ status: 'deleted', path: 'gone.txt', deletions: 1 })
  })

  it('recognises a rename', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-x\n+y\n',
    )
    expect(parsed.files[0]).toMatchObject({ status: 'renamed', oldPath: 'old.ts', newPath: 'new.ts' })
  })

  it('marks a binary file rather than pretending it has no changes', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
    )
    expect(parsed.files[0]).toMatchObject({ binary: true, path: 'logo.png' })
  })

  it('handles several files in one diff', () => {
    const parsed = parseUnifiedDiff(
      DIFF + 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n x\n+y\n',
    )
    expect(parsed.files.map((f) => f.path)).toEqual(['src/registry.js', 'README.md'])
    expect(parsed.additions).toBe(3)
  })

  /**
   * A diff is agent-produced text. Anything that does not parse must render as nothing
   * rather than throw inside a component — a blank review panel is worse than an odd one.
   */
  it('never throws on input that is not a diff', () => {
    expect(parseUnifiedDiff('').files).toEqual([])
    expect(parseUnifiedDiff('total nonsense\n@@ not a hunk @@\n+++').files).toEqual([])
    expect(() => parseUnifiedDiff('diff --git\n@@ -x +y @@\n+a')).not.toThrow()
  })

  it('ignores the no-newline marker, which is an annotation and not content', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n',
    )
    expect(parsed.files[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual(['a', 'b'])
  })
})

describe('splitHunk', () => {
  /**
   * A removal and the addition replacing it are one edit. Pairing them is the only
   * reason a side-by-side view beats a unified one.
   */
  it('pairs each removal with the addition that replaces it', () => {
    const hunk = parseUnifiedDiff(DIFF).files[0]!.hunks[0]!
    const rows = splitHunk(hunk)
    expect(rows.map((r) => [r.left?.kind ?? null, r.right?.kind ?? null])).toEqual([
      ['context', 'context'],
      ['context', 'context'],
      ['del', 'add'],
      [null, 'add'],
      ['context', 'context'],
    ])
  })

  it('leaves the other side empty for an unmatched removal', () => {
    const hunk = parseUnifiedDiff(
      'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n-a\n-b\n+c\n',
    ).files[0]!.hunks[0]!
    expect(splitHunk(hunk).map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'c'],
      ['b', null],
    ])
  })
})
