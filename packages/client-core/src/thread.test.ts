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
const message = (author: Actor, text: string, atMs = ++seq * 1000): Message => ({
 id: `m${seq}`,
 workspaceId: 'w',
 threadId: 't',
 author,
 body: { kind: author.kind === 'system' ? 'system': 'text', text },
 createdAt: new Date(atMs),
 editedAt: null,
})

describe('shortenBranchNames', => {
 it('keeps the eight characters that identify a run branch', => {
 expect(shortenBranchNames('pushed loom/run-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d to origin')).toBe(
 'pushed loom/run-1a2b3c4d to origin',
)
 })

 it('rewrites every occurrence in a line, and leaves other branches alone', => {
 const text = 'merge loom/run-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee into feature/loom-run-notes'
 expect(shortenBranchNames(text)).toBe('merge loom/run-aaaaaaaa into feature/loom-run-notes')
 })

 it('leaves an already-short branch untouched, so shortening is idempotent', => {
 expect(shortenBranchNames('loom/run-1a2b3c4d')).toBe('loom/run-1a2b3c4d')
 expect(shortBranchName(null)).toBe('')
 })
})

describe('clampText', => {
 it('reports nothing hidden when the text already fits', => {
 expect(clampText('one line')).toEqual({ visible: 'one line', hiddenLines: 0, truncated: false })
 })

 it('counts the lines it hid, which is what a "show more" has to say', => {
 const twenty = Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join('\n')
 const clamped = clampText(twenty, { maxLines: 3 })
 expect(clamped.truncated).toBe(true)
 expect(clamped.visible).toBe('line 1\nline 2\nline 3')
 expect(clamped.hiddenLines).toBe(18)
 })

 it('clamps a single enormous line by characters, not only by newlines', => {
 const clamped = clampText('x'.repeat(1000), { maxChars: 40 })
 expect(clamped.truncated).toBe(true)
 expect(clamped.visible).toHaveLength(41)
 expect(clamped.hiddenLines).toBe(0)
 })
})

describe('describeToolName', => {
 it('renders an MCP address as what it did', => {
 expect(describeToolName('mcp__loom_notes__read_notes')).toEqual({
 label: 'Read worker notes',
 toolName: 'mcp__loom_notes__read_notes',
 inferred: false,
 })
 })

 it('falls back to a readable form for an MCP tool it has never seen', => {
 const described = describeToolName('mcp__github__create_pull_request')
 expect(described.label).toBe('Create pull request (github)')
 expect(described.inferred).toBe(true)
 })

 it('leaves a built-in tool name alone', => {
 expect(describeToolName('Read').label).toBe('Read')
 })
})

describe('shortenTarget', => {
 it('keeps the end of a path, where the filename is', => {
 const shortened = shortenTarget('/very/long/root/apps/web/src/components/MessageList.vue', 40)
 expect(shortened.endsWith('components/MessageList.vue')).toBe(true)
 expect(shortened.startsWith('…/')).toBe(true)
 expect(shortened.length).toBeLessThanOrEqual(41)
 })

 it('keeps the head of a command, where the verb is', => {
 expect(shortenTarget('npm test -- --reporter=verbose --run some/very/long/path', 20)).toBe(
 'npm test -- --repor…',
)
 })

 it('collapses newlines so a multi-line argument stays one line', => {
 expect(shortenTarget('git commit -m "one\ntwo"')).toBe('git commit -m "one two"')
 })
})

describe('buildThreadRows', => {
 it('collapses a call and its result into one row', => {
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
 * The reason pairing is per-author. Two workers post into one thread concurrently
 *, so the message after a call is routinely someone else's result —
 * positional pairing would attach it to the wrong call and mislabel both.
 */
 it('pairs interleaved calls with the right author\'s result', => {
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

 it('leaves a call with no result yet pending, which is how a live call reads', => {
 const rows = buildThreadRows([message(RUN_A, '→ Bash: pnpm build')])
 const row = rows[0] as ToolRow
 expect(row.status).toBe('pending')
 expect(row.result).toBeNull
 })

 it('keeps a result whose call is not in the loaded page rather than dropping it', => {
 const rows = buildThreadRows([message(RUN_A, '✓ orphaned result')])
 expect(rows).toHaveLength(1)
 expect(rows[0]!.kind).not.toBe('tool')
 })

 it('does not attach a result to a call the author has already spoken past', => {
 const rows = buildThreadRows([
 message(RUN_A, '→ Read: a.ts'),
 message(RUN_A, 'Now I will run the tests.'),
 message(RUN_A, '✓ stray'),
 ])
 expect((rows[0] as ToolRow).status).toBe('pending')
 expect(rows).toHaveLength(3)
 })

 it('classifies run and approval system messages', => {
 const rows = buildThreadRows([
 message(SYSTEM, 'Run completed ($0.0110): done'),
 message(SYSTEM, 'Run failed: exploded'),
 message(SYSTEM, 'Approval needed for Bash'),
 message(USER, 'hello'),
 ])
 expect(rows.map((r) => r.kind)).toEqual(['run-ok', 'run-error', 'approval', 'text'])
 })

 it('shortens run branches inside message text, not just inside results', => {
 const rows = buildThreadRows([
 message(SYSTEM, 'Run completed ($0.01): pushed loom/run-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d'),
 ])
 expect((rows[0] as { text: string }).text).toContain('loom/run-1a2b3c4d')
 expect((rows[0] as { text: string }).text).not.toContain('5e6f')
 })
})

describe('continuesPrevious', => {
 it('groups consecutive rows from one author', => {
 const rows = buildThreadRows([
 message(RUN_A, 'first', 1_000),
 message(RUN_A, 'second', 2_000),
 ])
 expect(continuesPrevious(rows[1]!, rows[0])).toBe(true)
 expect(continuesPrevious(rows[0]!, undefined)).toBe(false)
 })

 it('breaks the group across authors and across a long pause', => {
 const rows = buildThreadRows([
 message(RUN_A, 'first', 1_000),
 message(RUN_B, 'second', 2_000),
 message(RUN_B, 'much later', 2_000 + 10 * 60_000),
 ])
 expect(continuesPrevious(rows[1]!, rows[0])).toBe(false)
 expect(continuesPrevious(rows[2]!, rows[1])).toBe(false)
 })
})
