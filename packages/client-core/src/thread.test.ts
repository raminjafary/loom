import type { Actor, Message } from '@loom/api-contract'
import { describe, expect, it } from 'vitest'
import {
  buildThreadRows,
  clampText,
  continuesPrevious,
  describeToolName,
  shortBranchName,
  shortenBranchNames,
  shortenTarget,
  type ToolRow,
} from './thread.js'

const RUN_A: Actor = { kind: 'agent_run', agentRunId: 'run-a' }
const RUN_B: Actor = { kind: 'agent_run', agentRunId: 'run-b' }
const SYSTEM: Actor = { kind: 'system' }
const USER: Actor = { kind: 'user', userId: 'user-1' }

let seq = 0
/** A message from before `toolUseId` was recorded, which is what most history is. */
const message = (author: Actor, text: string, atMs = ++seq * 1000): Message => ({
  id: `m${seq}`,
  workspaceId: 'w',
  threadId: 't',
  author,
  body: { kind: author.kind === 'system' ? 'system' : 'text', text },
  toolUseId: null,
  createdAt: new Date(atMs),
  editedAt: null,
})

/** A message as the platform writes it now: correlated to the call it belongs to. */
const correlated = (author: Actor, text: string, toolUseId: string): Message => ({
  ...message(author, text),
  toolUseId,
})

describe('shortenBranchNames', () => {
  it('keeps the eight characters that identify a run branch', () => {
    expect(shortenBranchNames('pushed loom/run-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d to origin')).toBe(
      'pushed loom/run-1a2b3c4d to origin',
    )
  })

  it('rewrites every occurrence in a line, and leaves other branches alone', () => {
    const text = 'merge loom/run-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee into feature/loom-run-notes'
    expect(shortenBranchNames(text)).toBe('merge loom/run-aaaaaaaa into feature/loom-run-notes')
  })

  it('leaves an already-short branch untouched, so shortening is idempotent', () => {
    expect(shortenBranchNames('loom/run-1a2b3c4d')).toBe('loom/run-1a2b3c4d')
    expect(shortBranchName(null)).toBe('')
  })
})

describe('clampText', () => {
  it('reports nothing hidden when the text already fits', () => {
    expect(clampText('one line')).toEqual({ visible: 'one line', hiddenLines: 0, truncated: false })
  })

  it('counts the lines it hid, which is what a "show more" has to say', () => {
    const twenty = Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join('\n')
    const clamped = clampText(twenty, { maxLines: 3 })
    expect(clamped.truncated).toBe(true)
    expect(clamped.visible).toBe('line 1\nline 2\nline 3')
    expect(clamped.hiddenLines).toBe(18)
  })

  it('clamps a single enormous line by characters, not only by newlines', () => {
    const clamped = clampText('x'.repeat(1000), { maxChars: 40 })
    expect(clamped.truncated).toBe(true)
    expect(clamped.visible).toHaveLength(41)
    expect(clamped.hiddenLines).toBe(0)
  })
})

describe('describeToolName', () => {
  it('renders an MCP address as what it did', () => {
    expect(describeToolName('mcp__loom_notes__read_notes')).toEqual({
      label: 'Read worker notes',
      toolName: 'mcp__loom_notes__read_notes',
      inferred: false,
    })
  })

  it('falls back to a readable form for an MCP tool it has never seen', () => {
    const described = describeToolName('mcp__github__create_pull_request')
    expect(described.label).toBe('Create pull request (github)')
    expect(described.inferred).toBe(true)
  })

  it('leaves a built-in tool name alone', () => {
    expect(describeToolName('Read').label).toBe('Read')
  })
})

describe('shortenTarget', () => {
  it('keeps the end of a path, where the filename is', () => {
    const shortened = shortenTarget('/very/long/root/apps/web/src/components/MessageList.vue', 40)
    expect(shortened.endsWith('components/MessageList.vue')).toBe(true)
    expect(shortened.startsWith('…/')).toBe(true)
    expect(shortened.length).toBeLessThanOrEqual(41)
  })

  it('keeps the head of a command, where the verb is', () => {
    expect(shortenTarget('npm test -- --reporter=verbose --run some/very/long/path', 20)).toBe(
      'npm test -- --repor…',
    )
  })

  it('collapses newlines so a multi-line argument stays one line', () => {
    expect(shortenTarget('git commit -m "one\ntwo"')).toBe('git commit -m "one two"')
  })
})

describe('buildThreadRows', () => {
  it('collapses a call and its result into one row', () => {
    const rows = buildThreadRows([
      message(RUN_A, '→ Read: /repo/README.md'),
      message(RUN_A, `✓ ${Array.from({ length: 21 }, (_, i) => `readme line ${i}`).join('\n')}`),
    ])

    expect(rows).toHaveLength(1)
    const row = rows[0] as ToolRow
    expect(row.kind).toBe('tool')
    expect(row.status).toBe('ok')
    expect(row.tool.label).toBe('Read')
    expect(row.target).toBe('/repo/README.md')
    // The 21 lines that started this: kept, but behind a preview.
    expect(row.result).toContain('readme line 20')
    expect(row.resultPreview?.truncated).toBe(true)
    expect(row.resultPreview?.hiddenLines).toBe(18)
    // Both messages are accounted for, so nothing is silently dropped.
    expect(row.messageIds).toHaveLength(2)
  })

  /**
   * The reason pairing is per-author. Two workers post into one thread concurrently, so the
   * message after a call is routinely someone else's result — positional pairing would
   * attach it to the wrong call and mislabel both.
   */
  it('pairs interleaved calls with the right author\'s result', () => {
    const rows = buildThreadRows([
      message(RUN_A, '→ Read: a.ts'),
      message(RUN_B, '→ Bash: npm test'),
      message(RUN_B, '✗ 1 test failed'),
      message(RUN_A, '✓ file contents'),
    ])

    expect(rows).toHaveLength(2)
    const [a, b] = rows as ToolRow[]
    expect(a!.target).toBe('a.ts')
    expect(a!.status).toBe('ok')
    expect(a!.result).toBe('file contents')
    expect(b!.target).toBe('npm test')
    expect(b!.status).toBe('error')
    expect(b!.result).toBe('1 test failed')
  })

  it('leaves a call with no result yet pending, which is how a live call reads', () => {
    const rows = buildThreadRows([message(RUN_A, '→ Bash: pnpm build')])
    const row = rows[0] as ToolRow
    expect(row.status).toBe('pending')
    expect(row.result).toBeNull()
  })

  /**
   * An orphan is shown, and shown clamped. Routed to a plain row it rendered as a
   * paragraph — no preview, and newlines collapsed to spaces by the browser — so a
   * single orphaned `Read` dumped hundreds of characters of file content into the
   * conversation. That was observed live, on eleven rows at once.
   */
  it('keeps a result whose call is not in the loaded page, clamped like any other', () => {
    const body = Array.from({ length: 30 }, (_, i) => `orphan line ${i}`).join('\n')
    const rows = buildThreadRows([message(RUN_A, `✓ ${body}`)])

    expect(rows).toHaveLength(1)
    const row = rows[0] as ToolRow
    expect(row.kind).toBe('tool')
    expect(row.status).toBe('ok')
    expect(row.resultPreview?.truncated).toBe(true)
    expect(row.result).toContain('orphan line 29')
    // No call to name, and it must not pretend otherwise.
    expect(row.target).toBe('')
  })

  describe('pairing on the harness correlation id', () => {
    /**
     * The live case that broke the old heuristic: one turn issuing fourteen reads,
     * whose results return in completion order. Reduced to four here; the failure is
     * identical at any width above one.
     */
    it('pairs a parallel burst whose results come back out of order', () => {
      const rows = buildThreadRows([
        correlated(RUN_A, '→ Read: /work/src/mod01.js', 'tu_01'),
        correlated(RUN_A, '→ Read: /work/src/mod02.js', 'tu_02'),
        correlated(RUN_A, '→ Read: /work/src/mod03.js', 'tu_03'),
        correlated(RUN_A, '→ Read: /work/src/mod04.js', 'tu_04'),
        correlated(RUN_A, '✓ step04', 'tu_04'),
        correlated(RUN_A, '✓ step01', 'tu_01'),
        correlated(RUN_A, '✓ step03', 'tu_03'),
        correlated(RUN_A, '✓ step02', 'tu_02'),
      ])

      expect(rows).toHaveLength(4)
      for (const [index, row] of (rows as ToolRow[]).entries()) {
        const n = String(index + 1).padStart(2, '0')
        expect(row.target).toBe(`/work/src/mod${n}.js`)
        // Each call carries its own output — the assertion the old pairing failed.
        expect(row.result).toBe(`step${n}`)
        expect(row.status).toBe('ok')
      }
    })

    /**
     * A model narrating between issuing a call and its result is ordinary, and used to
     * strand the call on "running…" for the life of the thread.
     */
    it('pairs across prose spoken between the call and its result', () => {
      const rows = buildThreadRows([
        correlated(RUN_A, '→ Bash: pnpm test', 'tu_9'),
        message(RUN_A, 'Running the suite now.'),
        correlated(RUN_A, '✓ 526 passed', 'tu_9'),
      ])

      expect(rows).toHaveLength(2)
      const tool = rows.find((row) => row.kind === 'tool') as ToolRow
      expect(tool.status).toBe('ok')
      expect(tool.result).toBe('526 passed')
    })

    it('keeps two runs\' identical calls apart, since ids are unique and targets are not', () => {
      const rows = buildThreadRows([
        correlated(RUN_A, '→ Read: shared.ts', 'tu_a'),
        correlated(RUN_B, '→ Read: shared.ts', 'tu_b'),
        correlated(RUN_B, '✓ B saw this', 'tu_b'),
        correlated(RUN_A, '✓ A saw this', 'tu_a'),
      ])

      expect(rows).toHaveLength(2)
      const [a, b] = rows as ToolRow[]
      expect(a!.result).toBe('A saw this')
      expect(b!.result).toBe('B saw this')
    })

    it('orphans a result whose call is off the page instead of stealing another call\'s', () => {
      const rows = buildThreadRows([
        correlated(RUN_A, '→ Read: visible.ts', 'tu_here'),
        correlated(RUN_A, '✓ from a call above the page', 'tu_elsewhere'),
      ])

      expect(rows).toHaveLength(2)
      const [call, orphan] = rows as ToolRow[]
      expect(call!.status).toBe('pending')
      expect(orphan!.tool.toolName).toBe('unpaired result')
    })
  })

  it('does not attach a result to a call the author has already spoken past', () => {
    const rows = buildThreadRows([
      message(RUN_A, '→ Read: a.ts'),
      message(RUN_A, 'Now I will run the tests.'),
      message(RUN_A, '✓ stray'),
    ])
    expect((rows[0] as ToolRow).status).toBe('pending')
    expect(rows).toHaveLength(3)
  })

  it('classifies run and approval system messages', () => {
    const rows = buildThreadRows([
      message(SYSTEM, 'Run completed ($0.0110): done'),
      message(SYSTEM, 'Run failed: exploded'),
      message(SYSTEM, 'Approval needed for Bash'),
      message(USER, 'hello'),
    ])
    expect(rows.map((r) => r.kind)).toEqual(['run-ok', 'run-error', 'approval', 'text'])
  })

  it('shortens run branches inside message text, not just inside results', () => {
    const rows = buildThreadRows([
      message(SYSTEM, 'Run completed ($0.01): pushed loom/run-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d'),
    ])
    expect((rows[0] as { text: string }).text).toContain('loom/run-1a2b3c4d')
    expect((rows[0] as { text: string }).text).not.toContain('5e6f')
  })
})

describe('continuesPrevious', () => {
  it('groups consecutive rows from one author', () => {
    const rows = buildThreadRows([
      message(RUN_A, 'first', 1_000),
      message(RUN_A, 'second', 2_000),
    ])
    expect(continuesPrevious(rows[1]!, rows[0])).toBe(true)
    expect(continuesPrevious(rows[0]!, undefined)).toBe(false)
  })

  it('breaks the group across authors and across a long pause', () => {
    const rows = buildThreadRows([
      message(RUN_A, 'first', 1_000),
      message(RUN_B, 'second', 2_000),
      message(RUN_B, 'much later', 2_000 + 10 * 60_000),
    ])
    expect(continuesPrevious(rows[1]!, rows[0])).toBe(false)
    expect(continuesPrevious(rows[2]!, rows[1])).toBe(false)
  })
})
