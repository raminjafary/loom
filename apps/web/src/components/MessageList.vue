<script setup lang="ts">
import type { Actor, Message } from '@loom/api-contract'
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps<{
 messages: Message[]
 /** Persona name for whichever agent run this client currently knows about (client-side only, not a full run history index). */
 personaNameByRunId?: Record<string, string>
}>

const scroller = ref<HTMLElement | null>(null)

/**
 * Only auto-scroll when the reader is already at the bottom — yanking the
 * viewport while someone is reading history is worse than a missed message.
 */
const stickToBottom = => {
 const el = scroller.value
 if (!el) return true
 return el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

watch(
 => props.messages.length,
 async (_next, previous) => {
 const shouldScroll = previous === 0 || stickToBottom
 await nextTick
 if (shouldScroll && scroller.value) {
 scroller.value.scrollTop = scroller.value.scrollHeight
 }
 },
)

const authorLabel = (actor: Actor): string => {
 switch (actor.kind) {
 case 'user':
 return actor.userId
 case 'agent_run':
 return props.personaNameByRunId?.[actor.agentRunId] ?? `agent ${actor.agentRunId.slice(0, 8)}`
 case 'system':
 return 'system'
 }
}

const initial = (actor: Actor): string => authorLabel(actor).slice(0, 1).toUpperCase

const time = (value: Date): string =>
 value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * The server flattens every AgentEvent to plain text —
 * these prefixes (→/✓/✗, "Run completed"/"Run failed"/"Approval needed")
 * are that text's own stable shape, not a parsing hack layered on top of it.
 * Classifying them client-side is what turns a flat activity log back into
 * something scannable, without inventing a second wire format.
 */
type MessageKind = 'tool-call' | 'tool-ok' | 'tool-error' | 'run-ok' | 'run-error' | 'approval' | 'text'

interface Classified {
 kind: MessageKind
 toolName: string | null
 detail: string
}

const classify = (message: Message): Classified => {
 const text = message.body.text

 if (message.author.kind === 'agent_run') {
 const call = /^→ (\S+):?\s?([\s\S]*)$/.exec(text)
 if (call) return { kind: 'tool-call', toolName: call[1] ?? null, detail: call[2] ?? '' }
 const ok = /^✓ ?([\s\S]*)$/.exec(text)
 if (ok) return { kind: 'tool-ok', toolName: null, detail: ok[1] ?? '' }
 const err = /^✗ ?([\s\S]*)$/.exec(text)
 if (err) return { kind: 'tool-error', toolName: null, detail: err[1] ?? '' }
 }

 if (message.author.kind === 'system') {
 if (text.startsWith('Run completed')) return { kind: 'run-ok', toolName: null, detail: text }
 if (text.startsWith('Run failed')) return { kind: 'run-error', toolName: null, detail: text }
 if (text.startsWith('Approval needed')) return { kind: 'approval', toolName: null, detail: text }
 }

 return { kind: 'text', toolName: null, detail: text }
}

const BADGE: Record<MessageKind, string> = {
 'tool-call': '→',
 'tool-ok': '✓',
 'tool-error': '✗',
 'run-ok': '✓',
 'run-error': '✗',
 approval: '⏸',
 text: '',
}

const rows = computed( => props.messages.map((message) => ({ message, classified: classify(message) })))
</script>

<template>
 <div ref="scroller" class="messages">
 <p v-if="props.messages.length === 0" class="empty">Nothing here yet. Say something.</p>

 <article
 v-for="{ message, classified } in rows"
:key="message.id"
 class="row"
:class="classified.kind"
 >
 <div class="avatar":class="{ agent: message.author.kind === 'agent_run' }">
 {{ initial(message.author) }}
 </div>

 <div class="content">
 <header>
 <span class="author">{{ authorLabel(message.author) }}</span>
 <span class="time">{{ time(message.createdAt) }}</span>
 </header>

 <div v-if="classified.kind === 'text'" class="bubble">
 <!-- Model output is untrusted: text interpolation only, never v-html. -->
 <p class="body">{{ message.body.text }}</p>
 </div>

 <div v-else class="event">
 <span class="badge">{{ BADGE[classified.kind] }}</span>
 <span v-if="classified.toolName" class="tool-name">{{ classified.toolName }}</span>
 <p class="detail">{{ classified.detail }}</p>
 </div>
 </div>
 </article>
 </div>
</template>

<style scoped>
.messages {
 flex: 1;
 overflow-y: auto;
 padding: 1rem 1.25rem;
 display: flex;
 flex-direction: column;
 gap: 0.6rem;
}

.empty {
 margin: auto;
 color: var(--text-faint);
}

.row {
 display: flex;
 gap: 0.65rem;
 align-items: flex-start;
}

.avatar {
 flex-shrink: 0;
 width: 1.75rem;
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

.bubble.body {
 margin: 0;
 white-space: pre-wrap;
 overflow-wrap: anywhere;
 line-height: 1.5;
}

/* Activity events (tool calls/results, run status, approvals) get a tinted,
 left-accented card — visually distinct from plain conversation so the
 feed reads as "log + chat", not one undifferentiated wall of text. */
.event {
 display: grid;
 grid-template-columns: auto auto 1fr;
 align-items: baseline;
 column-gap: 0.4rem;
 row-gap: 0.15rem;
 padding: 0.4rem 0.6rem;
 border-radius: 0.5rem;
 border-left: 3px solid var(--border);
 background: var(--surface);
 font-size: 0.83rem;
}

.badge {
 font-weight: 700;
}

.tool-name {
 font-family: ui-monospace, monospace;
 font-weight: 600;
 padding: 0.05rem 0.4rem;
 border-radius: 0.3rem;
 background: var(--surface-hover);
}

.detail {
 grid-column: 1 / -1;
 margin: 0;
 font-family: ui-monospace, monospace;
 font-size: 0.8rem;
 color: var(--text-muted);
 white-space: pre-wrap;
 overflow-wrap: anywhere;
 line-height: 1.45;
}

.tool-call.event,
.tool-call.badge {
 border-left-color: var(--accent);
 color: var(--accent);
}

.tool-ok.event,
.run-ok.event {
 border-left-color: var(--ok);
}

.tool-ok.badge,
.run-ok.badge {
 color: var(--ok);
}

.tool-error.event,
.run-error.event {
 border-left-color: var(--danger);
 background: color-mix(in oklab, var(--danger) 8%, var(--surface));
}

.tool-error.badge,
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
</style>
