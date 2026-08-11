import type { Actor, Message } from '@loom/api-contract'

/**
 * Turning the flat activity log back into something readable.
 *
 * The server flattens every `AgentEvent` to plain text, and that text's shape —
 * `→ tool: target`, `✓ summary`, `✗ summary`, `Run completed (…)` — is stable and
 * deliberate. What it is *not* is bounded: a `tool_result` summary carries whatever
 * the tool returned, so one `Read` of a README puts twenty-one lines of prose in the
 * middle of a conversation and the reasoning around it stops being findable.
 *
 * This module is where a thread becomes rows: a call and the result it produced are
 * one row, that row has a one-line headline, and the body behind it is something a
 * reader opens rather than something they scroll past. It lives here and not in the
 * component because none of it is rendering and all of it is worth testing.
 */

export type ThreadRowKind =
 | 'text'
 | 'tool'
 | 'run-ok'
 | 'run-error'
 | 'approval'
 | 'system'

/** How much of a tool result is shown before a reader has to ask for the rest. */
export const RESULT_PREVIEW_LINES = 3
export const RESULT_PREVIEW_CHARS = 240

export interface ClampedText {
 readonly visible: string
 /** Lines hidden behind "show more"; 0 when nothing was cut. */
 readonly hiddenLines: number
 readonly truncated: boolean
}

/**
 * A run branch is `loom/run-<uuid>` — 40-odd characters of which eight identify it
 * and the rest are noise repeated on every line that mentions it.
 */
const BRANCH_PATTERN = /\bloom\/run-([0-9a-f]{8})[0-9a-f-]*\b/gi

export const shortenBranchNames = (text: string): string =>
 text.replace(BRANCH_PATTERN, (_match, head: string) => `loom/run-${head.toLowerCase}`)

/** The same shortening for a branch name held on its own, not embedded in prose. */
export const shortBranchName = (branch: string | null | undefined): string =>
 branch ? shortenBranchNames(branch): ''

export const clampText = (
 text: string,
 options: { maxLines?: number; maxChars?: number } = {},
): ClampedText => {
 const maxLines = options.maxLines ?? RESULT_PREVIEW_LINES
 const maxChars = options.maxChars ?? RESULT_PREVIEW_CHARS
 const lines = text.split('\n')

 let visible = lines.length > maxLines ? lines.slice(0, maxLines).join('\n'): text
 if (visible.length > maxChars) visible = `${visible.slice(0, maxChars).trimEnd}…`

 if (visible === text) return { visible: text, hiddenLines: 0, truncated: false }

 const shownLines = visible.split('\n').length
 return { visible, hiddenLines: Math.max(lines.length - shownLines, 0), truncated: true }
}

/**
 * MCP tool ids are `mcp__<server>__<tool>`, which is an address rather than a name.
 * A reader wants to know a worker read the notes ledger, not that it called
 * `mcp__loom_notes__read_notes`.
 */
const MCP_TOOL_LABELS: Record<string, string> = {
 'loom_notes.read_notes': 'Read worker notes',
 'loom_notes.write_note': 'Wrote a worker note',
 'loom_planner.submit_plan': 'Submitted a plan',
}

const titleCase = (value: string): string =>
 value
.split('_')
.filter((part) => part.length > 0)
.map((part, index) => (index === 0 ? part.charAt(0).toUpperCase + part.slice(1): part))
.join(' ')

export interface ToolLabel {
 /** What the tool did, in words. */
 readonly label: string
 /** The raw tool id, kept for anyone who needs to know exactly what ran. */
 readonly toolName: string
 /** True when `label` was inferred rather than looked up. */
 readonly inferred: boolean
}

export const describeToolName = (toolName: string): ToolLabel => {
 const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName)
 if (mcp) {
 const server = mcp[1] ?? ''
 const tool = mcp[2] ?? ''
 const known = MCP_TOOL_LABELS[`${server}.${tool}`]
 if (known) return { label: known, toolName, inferred: false }
 return { label: `${titleCase(tool)} (${server})`, toolName, inferred: true }
 }
 return { label: toolName, toolName, inferred: false }
}

/**
 * The headline target of a call, shortened for a 40-character column.
 *
 * Paths keep their tail — `apps/web/src/components/MessageList.vue` matters at the
 * end, not the start — while commands and queries keep their head, which is where
 * the verb is.
 */
export const shortenTarget = (target: string, max = 56): string => {
 const single = shortenBranchNames(target.replace(/\s+/g, ' ').trim)
 if (single.length <= max) return single

 if (single.includes('/') && !single.includes(' ')) {
 const parts = single.split('/')
 let tail = parts[parts.length - 1] ?? single
 for (let i = parts.length - 2; i >= 0; i -= 1) {
 const next = `${parts[i]}/${tail}`
 if (next.length > max - 1) break
 tail = next
 }
 return `…/${tail}`
 }

 return `${single.slice(0, max - 1).trimEnd}…`
}

interface ParsedEvent {
 readonly kind: 'tool-call' | 'tool-ok' | 'tool-error' | 'run-ok' | 'run-error' | 'approval' | 'text' | 'system'
 readonly toolName: string | null
 readonly detail: string
}

const parseMessage = (message: Message): ParsedEvent => {
 const text = message.body.text

 if (message.author.kind === 'agent_run') {
 const call = /^→ (\S+?):?[ \t]([\s\S]*)$/.exec(text)
 if (call) return { kind: 'tool-call', toolName: call[1] ?? null, detail: call[2] ?? '' }
 const bareCall = /^→ (\S+)$/.exec(text)
 if (bareCall) return { kind: 'tool-call', toolName: bareCall[1] ?? null, detail: '' }
 const ok = /^✓ ?([\s\S]*)$/.exec(text)
 if (ok) return { kind: 'tool-ok', toolName: null, detail: ok[1] ?? '' }
 const err = /^✗ ?([\s\S]*)$/.exec(text)
 if (err) return { kind: 'tool-error', toolName: null, detail: err[1] ?? '' }
 return { kind: 'text', toolName: null, detail: text }
 }

 if (message.author.kind === 'system') {
 if (text.startsWith('Run completed')) return { kind: 'run-ok', toolName: null, detail: text }
 if (text.startsWith('Run failed')) return { kind: 'run-error', toolName: null, detail: text }
 if (text.startsWith('Approval')) return { kind: 'approval', toolName: null, detail: text }
 return { kind: 'system', toolName: null, detail: text }
 }

 return { kind: 'text', toolName: null, detail: text }
}

export interface ToolRow {
 readonly kind: 'tool'
 readonly id: string
 readonly author: Actor
 readonly createdAt: Date
 /** Present only once a result arrived; a call still running has none. */
 readonly status: 'pending' | 'ok' | 'error'
 readonly tool: ToolLabel
 /** The call's headline argument, already shortened. */
 readonly target: string
 /** The call's argument in full, for the expanded view. */
 readonly targetFull: string
 /** The result body, when one arrived. */
 readonly result: string | null
 readonly resultPreview: ClampedText | null
 /** Message ids this row stands for — a call and its result collapse into one. */
 readonly messageIds: string[]
}

export interface PlainRow {
 readonly kind: Exclude<ThreadRowKind, 'tool'>
 readonly id: string
 readonly author: Actor
 readonly createdAt: Date
 readonly text: string
 readonly messageIds: string[]
}

export type ThreadRow = ToolRow | PlainRow

const actorKey = (actor: Actor): string => {
 switch (actor.kind) {
 case 'user':
 return `user:${actor.userId}`
 case 'agent_run':
 return `run:${actor.agentRunId}`
 case 'system':
 return 'system'
 }
}

/**
 * Pairs each tool call with the result it produced.
 *
 * **On `toolUseId` when the message carries one.** An earlier version paired "the next
 * result from this author", on the reasoning that one run's events are sequential. A
 * live run disproved it in the first minute: the model issued fourteen `Read` calls in
 * one turn and their results came back in completion order — `mod04`, `mod05`, `mod10`,
 * `mod01` — so one call was labelled with a sibling's output, thirteen results were
 * orphaned, and six calls sat on "running…" in a run that had already finished.
 * Position and authorship are both wrong answers; the harness's own correlation id is
 * the only right one, and `recordAgentEvent` now carries it through.
 *
 * The old heuristic stays as a fallback for messages written before that column
 * existed, and is deliberately kept honest about its limits: it pairs only while a
 * single call is outstanding, so an old parallel burst renders as orphans rather than
 * as confident mislabelling.
 */
export const buildThreadRows = (messages: readonly Message[]): ThreadRow[] => {
 const rows: ThreadRow[] = []
 /** Correlated calls, by the id the harness assigned them. */
 const rowIndexByToolUseId = new Map<string, number>
 /** Fallback for pre-`toolUseId` history: at most one outstanding call per author. */
 const legacyRowIndexByAuthor = new Map<string, number>

 for (const message of messages) {
 const parsed = parseMessage(message)
 const author = actorKey(message.author)

 if (parsed.kind === 'tool-call') {
 if (message.toolUseId) rowIndexByToolUseId.set(message.toolUseId, rows.length)
 else legacyRowIndexByAuthor.set(author, rows.length)
 rows.push({
 kind: 'tool',
 id: message.id,
 author: message.author,
 createdAt: message.createdAt,
 status: 'pending',
 tool: describeToolName(parsed.toolName ?? 'tool'),
 target: shortenTarget(parsed.detail),
 targetFull: parsed.detail,
 result: null,
 resultPreview: null,
 messageIds: [message.id],
 })
 continue
 }

 if (parsed.kind === 'tool-ok' || parsed.kind === 'tool-error') {
 const index = message.toolUseId
 ? rowIndexByToolUseId.get(message.toolUseId)
: legacyRowIndexByAuthor.get(author)
 const open = index === undefined ? null: rows[index]
 if (index !== undefined && open && open.kind === 'tool' && open.status === 'pending') {
 const body = shortenBranchNames(parsed.detail)
 rows[index] = {
...open,
 status: parsed.kind === 'tool-ok' ? 'ok': 'error',
 result: body,
 resultPreview: clampText(body),
 messageIds: [...open.messageIds, message.id],
 }
 if (message.toolUseId) rowIndexByToolUseId.delete(message.toolUseId)
 else legacyRowIndexByAuthor.delete(author)
 continue
 }
 // A result whose call is not in view — off the top of the loaded page, or old
 // history from a parallel burst the fallback cannot pair. Shown, because
 // dropping it would hide output, and shown *as a tool row*: routed to a plain
 // row it rendered as a paragraph, which meant no clamp and newlines collapsed
 // to spaces — one orphaned `Read` putting 782 characters of file content into
 // the middle of the conversation, which is the whole complaint this module
 // exists to answer.
 const body = shortenBranchNames(parsed.detail)
 rows.push({
 kind: 'tool',
 id: message.id,
 author: message.author,
 createdAt: message.createdAt,
 status: parsed.kind === 'tool-ok' ? 'ok': 'error',
 tool: { label: 'Result', toolName: 'unpaired result', inferred: true },
 target: '',
 targetFull: '',
 result: body,
 resultPreview: clampText(body),
 messageIds: [message.id],
 })
 continue
 }

 // Any other message from this author ends the turn of a call the *fallback* is
 // tracking: without a correlation id, prose after a call means the next result is
 // no longer safely attributable to it. A correlated call is untouched — a model
 // narrating between issuing a call and its result is ordinary, and used to be
 // enough on its own to strand the call on "running…" forever.
 legacyRowIndexByAuthor.delete(author)

 rows.push({
 kind: parsed.kind,
 id: message.id,
 author: message.author,
 createdAt: message.createdAt,
 text: shortenBranchNames(parsed.detail),
 messageIds: [message.id],
 })
 }

 return rows
}

/**
 * Whether a row repeats the row above it closely enough that its avatar and byline
 * are noise. Long agent runs are hundreds of consecutive rows from one author, and
 * a byline on each is a byline nobody reads.
 */
export const continuesPrevious = (row: ThreadRow, previous: ThreadRow | undefined): boolean => {
 if (!previous) return false
 if (actorKey(row.author) !== actorKey(previous.author)) return false
 const gapMs = row.createdAt.getTime - previous.createdAt.getTime
 return gapMs >= 0 && gapMs < 5 * 60_000
}
