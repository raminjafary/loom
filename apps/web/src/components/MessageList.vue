<script setup lang="ts">
import type { Actor, Message } from '@loom/api-contract'
import {
 buildThreadRows,
 continuesPrevious,
 parseMarkdown,
 type Block,
 type ThreadRow,
 type ToolRow,
} from '@loom/client-core'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import MarkdownText from './MarkdownText.vue'

const props = defineProps<{
 messages: Message[]
 /** Persona name for whichever agent run this client currently knows about (client-side only, not a full run history index). */
 personaNameByRunId?: Record<string, string>
 /** Who this client is, so its own messages read as "You" rather than as an opaque id. */
 currentActor?: Actor | null
 hasMoreHistory?: boolean
 loadingHistory?: boolean
 /**
 * Message id → the area thread hanging off it.
 *
 * A sub-planner runs in its own thread, announced by a message here. This is what
 * turns that announcement from a dead end into the way in.
 */
 areaThreadByMessageId?: Record<string, string>
}>

const emit = defineEmits<{
 (e: 'load-earlier'): void
 /** Authors this thread shows that the client cannot yet name. */
 (e: 'unknown-authors', agentRunIds: string[]): void
 (e: 'open-thread', threadId: string): void
}>

const scroller = ref<HTMLElement | null>(null)
const atBottom = ref(true)
/** Messages that arrived while the reader was somewhere else in the thread. */
const unseenBelow = ref(0)

const BOTTOM_SLACK_PX = 80

const measureBottom = => {
 const el = scroller.value
 if (!el) return true
 return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX
}

const scrollToBottom = => {
 const el = scroller.value
 if (!el) return
 el.scrollTop = el.scrollHeight
 atBottom.value = true
 unseenBelow.value = 0
}

const onScroll = => {
 atBottom.value = measureBottom
 if (atBottom.value) unseenBelow.value = 0
}

/**
 * Two things happen when the message list grows, and they are opposites.
 *
 * Appended at the bottom: follow, but only for a reader who was already there —
 * yanking the viewport out from under someone reading history is worse than a
 * missed message, and the count on the jump button is how they learn there is
 * something to come back to.
 *
 * Prepended at the top ("load earlier"): hold the reader's place. The browser
 * keeps `scrollTop` while the content above it grows, which silently scrolls the
 * page — so the height the page grew by has to be added back.
 *
 * The trigger is the message count and the *count* is rows, which is not
 * pedantry: a result merges into the row its call already occupies, so during a
 * burst of parallel calls a message-based tally reads "28 new" where fourteen
 * lines appeared. Watching rows alone would not do either — a result that
 * arrives for an existing row changes no length at all, and a reader sitting at
 * the bottom still needs to be carried down as that row grows a body.
 */
let firstMessageId: string | null = null
let lastRowCount = 0

watch(
 => props.messages.length,
 async (next, previous) => {
 const el = scroller.value
 const grewAtTop = next > previous && props.messages[0]?.id !== firstMessageId
 const heightBefore = el?.scrollHeight ?? 0
 const wasAtBottom = previous === 0 || measureBottom
 firstMessageId = props.messages[0]?.id ?? null

 const rowsBefore = lastRowCount
 const rowsNow = rows.value.length
 lastRowCount = rowsNow

 await nextTick
 if (!scroller.value) return

 if (grewAtTop) {
 scroller.value.scrollTop += scroller.value.scrollHeight - heightBefore
 } else if (wasAtBottom) {
 scrollToBottom
 } else {
 unseenBelow.value += Math.max(rowsNow - rowsBefore, 0)
 }
 },
)

const loadEarlier = => emit('load-earlier')

/**
 * A human-readable author.
 *
 * A raw `userId` is what this rendered before, and in a single-operator workspace that
 * meant every message you wrote was labelled with a 32-character opaque string — the one
 * piece of information in the line that carried none. There is no user *directory* on
 * the wire, so the honest options are "You" for yourself and a short id for anyone else,
 * which is exactly what a workspace with one human needs and degrades sensibly for more.
 */
const authorLabel = (actor: Actor): string => {
 switch (actor.kind) {
 case 'user':
 return props.currentActor?.kind === 'user' && props.currentActor.userId === actor.userId
 ? 'You'
: `user ${actor.userId.slice(0, 6)}`
 case 'agent_run':
 return props.personaNameByRunId?.[actor.agentRunId] ?? `agent ${actor.agentRunId.slice(0, 8)}`
 case 'system':
 return 'system'
 }
}

const initial = (actor: Actor): string => authorLabel(actor).slice(0, 1).toUpperCase

const time = (value: Date): string =>
 value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const rows = computed( => {
 const built = buildThreadRows(props.messages)
 return built.map((row, index) => ({
 row,
 grouped: continuesPrevious(row, built[index - 1]),
 }))
})

// A thread mounted with messages already loaded has rows nobody arrived late for.
onMounted( => {
 lastRowCount = rows.value.length
})

/**
 * A thread outlives the runs in it, so history is full of authors this client has
 * no name for — and an opaque run id is the least useful thing a byline can say.
 * Asking is cheap and idempotent; the session dedupes and bounds it.
 */
watch(
 => props.messages,
 (messages) => {
 const unnamed = new Set<string>
 for (const message of messages) {
 if (message.author.kind !== 'agent_run') continue
 if (props.personaNameByRunId?.[message.author.agentRunId] === undefined) {
 unnamed.add(message.author.agentRunId)
 }
 }
 if (unnamed.size > 0) emit('unknown-authors', [...unnamed])
 },
 { immediate: true },
)

/**
 * Disclosure is per row and remembered by message id, so a result that scrolls away
 * and comes back is still open — and so a rebuild of the row list (every incoming
 * message rebuilds it) does not silently close what someone is reading.
 */
const disclosure = ref<Record<string, boolean>>({})
const showingAll = ref<Set<string>>(new Set)

/**
 * A failure nobody clicked is a failure nobody read, so an errored call opens
 * itself — but that is only the default, which a reader can close like any other.
 */
const open = (row: ToolRow): boolean => disclosure.value[row.id] ?? row.status === 'error'

const toggle = (row: ToolRow) => {
 disclosure.value = {...disclosure.value, [row.id]: !open(row) }
}

const showAll = (row: ToolRow) => {
 showingAll.value = new Set(showingAll.value).add(row.id)
}

const resultText = (row: ToolRow): string => {
 if (row.result === null) return ''
 if (showingAll.value.has(row.id) || !row.resultPreview?.truncated) return row.result
 return row.resultPreview.visible
}

/**
 * Parsed once per message rather than once per render: every incoming message
 * rebuilds the row list, and re-parsing the markdown of a thread's whole history
 * on each of those is work with no change to show for it.
 */
const markdownCache = new Map<string, Block[]>

const blocksFor = (id: string, text: string): Block[] => {
 const cached = markdownCache.get(id)
 if (cached) return cached
 if (markdownCache.size > 2_000) markdownCache.clear
 const parsed = parseMarkdown(text)
 markdownCache.set(id, parsed)
 return parsed
}

const STATUS_GLYPH: Record<ToolRow['status'], string> = { pending: '·', ok: '✓', error: '✗' }

const PLAIN_BADGE: Record<string, string> = {
 'run-ok': '✓',
 'run-error': '✗',
 approval: '⏸',
 system: '·',
}

const isTool = (row: ThreadRow): row is ToolRow => row.kind === 'tool'
</script>

<template>
 <div class="thread">
 <div ref="scroller" class="messages" @scroll.passive="onScroll">
 <p v-if="props.messages.length === 0" class="empty">Nothing here yet. Say something.</p>

 <div v-if="props.hasMoreHistory" class="earlier">
 <button type="button":disabled="props.loadingHistory" @click="loadEarlier">
 {{ props.loadingHistory ? 'Loading…': 'Load earlier messages' }}
 </button>
 </div>

 <article
 v-for="{ row, grouped } in rows"
:key="row.id"
 v-memo="[
 row.kind,
 isTool(row) ? row.status: '',
 isTool(row) ? row.result: '',
 isTool(row) && open(row),
 isTool(row) && showingAll.has(row.id),
 grouped,
 props.areaThreadByMessageId?.[row.id] ?? '',
 ]"
 class="row"
:class="[row.kind, { grouped }]"
 >
 <div v-if="grouped" class="gutter" aria-hidden="true"></div>
 <div v-else class="avatar":class="{ agent: row.author.kind === 'agent_run' }">
 {{ initial(row.author) }}
 </div>

 <div class="content">
 <header v-if="!grouped">
 <span class="author">{{ authorLabel(row.author) }}</span>
 <span class="time">{{ time(row.createdAt) }}</span>
 </header>

 <!-- A tool call and the result it produced, as one line until asked otherwise. -->
 <template v-if="isTool(row)">
 <button
 type="button"
 class="tool-line"
:class="row.status"
:aria-expanded="open(row)"
 @click="toggle(row)"
 >
 <span class="glyph">{{ STATUS_GLYPH[row.status] }}</span>
 <span class="tool-label">{{ row.tool.label }}</span>
 <span class="target">{{ row.target }}</span>
 <span v-if="row.status === 'pending'" class="meta running">running…</span>
 <span v-else-if="row.resultPreview?.truncated" class="meta">
 {{ row.resultPreview.hiddenLines + 1 }} lines
 </span>
 <span class="chevron":class="{ open: open(row) }">›</span>
 </button>

 <div v-if="open(row)" class="tool-body">
 <p v-if="row.targetFull && row.targetFull !== row.target" class="argument">
 {{ row.targetFull }}
 </p>
 <pre v-if="row.result !== null" class="result">{{ resultText(row) }}</pre>
 <button
 v-if="row.resultPreview?.truncated && !showingAll.has(row.id)"
 type="button"
 class="more"
 @click="showAll(row)"
 >
 Show all {{ row.resultPreview.hiddenLines + 1 }} lines
 </button>
 <p class="tool-id">{{ row.tool.toolName }}</p>
 </div>
 </template>

 <!-- Markdown as tokens, rendered to real elements — never v-html. -->
 <div v-else-if="row.kind === 'text'" class="bubble">
 <MarkdownText:blocks="blocksFor(row.id, row.text)" />
 </div>

 <div v-else class="event">
 <span class="badge">{{ PLAIN_BADGE[row.kind] ?? '' }}</span>
 <p class="detail">{{ row.text }}</p>
 </div>

 <!--
 The way into an area. A sub-planner's whole subtree lives
 in its own thread; this line is the only thing in the parent conversation
 that leads there, so without it the split hides work rather than organizing
 it.
 -->
 <button
 v-if="props.areaThreadByMessageId?.[row.id]"
 type="button"
 class="open-area"
 @click="emit('open-thread', props.areaThreadByMessageId[row.id]!)"
 >
 Open this area's thread →
 </button>
 </div>
 </article>
 </div>

 <button v-if="!atBottom" type="button" class="jump" @click="scrollToBottom">
 <span v-if="unseenBelow > 0" class="count">{{ unseenBelow }}</span>
 {{ unseenBelow > 0 ? 'new': 'Jump to latest' }} ↓
 </button>
 </div>
</template>

<style scoped>
.thread {
 position: relative;
 flex: 1;
 min-height: 0;
 display: flex;
 flex-direction: column;
}

.messages {
 flex: 1;
 overflow-y: auto;
 overflow-anchor: none;
 padding: 1rem 1.25rem;
 display: flex;
 flex-direction: column;
 gap: 0.35rem;
}

.empty {
 margin: auto;
 color: var(--text-faint);
}

.earlier {
 display: flex;
 justify-content: center;
 padding-bottom: 0.5rem;
}

.earlier button {
 padding: 0.25rem 0.7rem;
 border: 1px solid var(--border);
 border-radius: 999px;
 background: var(--surface);
 color: var(--text-muted);
 font: inherit;
 font-size: 0.78rem;
 cursor: pointer;
}

.open-area {
 align-self: flex-start;
 margin-top: 0.3rem;
 padding: 0.25rem 0.55rem;
 font: inherit;
 font-size: 0.82rem;
 color: var(--text-muted);
 background: transparent;
 border: 1px solid var(--border);
 border-radius: 6px;
 cursor: pointer;
}

.open-area:hover {
 color: var(--text);
 border-color: var(--accent);
}

.row {
 display: flex;
 gap: 0.65rem;
 align-items: flex-start;
}

.row.grouped {
 margin-top: -0.2rem;
}

.avatar,
.gutter {
 flex-shrink: 0;
 width: 1.75rem;
}

.avatar {
 height: 1.75rem;
 border-radius: 50%;
 display: flex;
 align-items: center;
 justify-content: center;
 font-size: 0.75rem;
 font-weight: 700;
 background: var(--surface-hover);
 color: var(--text-muted);
}

.avatar.agent {
 background: var(--accent-soft);
 color: var(--accent);
}

.content {
 min-width: 0;
 flex: 1;
}

header {
 display: flex;
 align-items: baseline;
 gap: 0.5rem;
 margin-bottom: 0.2rem;
}

.author {
 font-weight: 600;
 font-size: 0.85rem;
}

.time {
 color: var(--text-faint);
 font-size: 0.72rem;
}

.bubble {
 overflow-wrap: anywhere;
}

/* One tool call, one line. The whole line is the control, so there is no
 separate affordance to find before a result can be opened. */
.tool-line {
 display: flex;
 align-items: baseline;
 gap: 0.45rem;
 width: 100%;
 padding: 0.2rem 0.5rem;
 border: 0;
 border-left: 2px solid var(--border);
 border-radius: 0.3rem;
 background: none;
 color: var(--text-muted);
 font: inherit;
 font-size: 0.82rem;
 text-align: left;
 cursor: pointer;
}

.tool-line:hover {
 background: var(--surface-hover);
}

.tool-line.glyph {
 font-weight: 700;
 color: var(--text-faint);
}

.tool-line.ok.glyph {
 color: var(--ok);
}

.tool-line.error {
 border-left-color: var(--danger);
}

.tool-line.error.glyph {
 color: var(--danger);
}

.tool-line.pending {
 border-left-color: var(--accent);
}

.tool-label {
 font-weight: 600;
 color: var(--text);
 white-space: nowrap;
}

.target {
 font-family: ui-monospace, monospace;
 font-size: 0.78rem;
 overflow: hidden;
 text-overflow: ellipsis;
 white-space: nowrap;
 flex: 1 1 auto;
 min-width: 0;
}

.meta {
 font-size: 0.72rem;
 color: var(--text-faint);
 white-space: nowrap;
}

.meta.running {
 color: var(--accent);
}

.chevron {
 color: var(--text-faint);
 transition: transform 120ms ease;
}

.chevron.open {
 transform: rotate(90deg);
}

.tool-body {
 margin: 0.15rem 0 0.35rem 0.5rem;
 padding: 0.4rem 0.6rem;
 border-left: 2px solid var(--border);
 border-radius: 0 0.3rem 0.3rem 0;
 background: var(--surface);
}

.argument,
.result {
 margin: 0 0 0.35rem;
 font-family: ui-monospace, monospace;
 font-size: 0.78rem;
 line-height: 1.45;
 color: var(--text-muted);
 white-space: pre-wrap;
 overflow-wrap: anywhere;
}

.result {
 /* A result a reader chose to open still must not own the viewport. */
 max-height: 24rem;
 overflow: auto;
}

.more {
 padding: 0.1rem 0.45rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text-muted);
 font: inherit;
 font-size: 0.72rem;
 cursor: pointer;
}

.tool-id {
 margin: 0.35rem 0 0;
 font-family: ui-monospace, monospace;
 font-size: 0.68rem;
 color: var(--text-faint);
}

/* Run status and approvals: still a card, because these are the lines a reader
 is scanning for. */
.event {
 display: flex;
 align-items: baseline;
 gap: 0.4rem;
 padding: 0.35rem 0.6rem;
 border-radius: 0.5rem;
 border-left: 3px solid var(--border);
 background: var(--surface);
 font-size: 0.83rem;
}

.badge {
 font-weight: 700;
}

.detail {
 margin: 0;
 overflow-wrap: anywhere;
}

.run-ok.event {
 border-left-color: var(--ok);
}

.run-ok.badge {
 color: var(--ok);
}

.run-error.event {
 border-left-color: var(--danger);
 background: color-mix(in oklab, var(--danger) 8%, var(--surface));
}

.run-error.badge {
 color: var(--danger);
}

.approval.event {
 border-left-color: var(--warn);
 background: color-mix(in oklab, var(--warn) 10%, var(--surface));
}

.approval.badge {
 color: var(--warn);
}

.jump {
 position: absolute;
 right: 1.25rem;
 bottom: 0.75rem;
 display: flex;
 align-items: center;
 gap: 0.35rem;
 padding: 0.3rem 0.7rem;
 border: 1px solid var(--border);
 border-radius: 999px;
 background: var(--bg);
 color: var(--text-muted);
 font: inherit;
 font-size: 0.78rem;
 box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
 cursor: pointer;
}

.jump.count {
 padding: 0.05rem 0.4rem;
 border-radius: 999px;
 background: var(--accent);
 color: var(--accent-contrast);
 font-weight: 600;
}
</style>
