<script setup lang="ts">
import type { Actor, Message } from '@loom/api-contract'
import { nextTick, ref, watch } from 'vue'

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

const isAgent = (actor: Actor): boolean => actor.kind === 'agent_run'

const time = (value: Date): string =>
 value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
</script>

<template>
 <div ref="scroller" class="messages">
 <p v-if="props.messages.length === 0" class="empty">Nothing here yet. Say something.</p>

 <article v-for="message in props.messages":key="message.id" class="message">
 <header>
 <span class="author":class="{ agent: isAgent(message.author) }">
 {{ authorLabel(message.author) }}
 </span>
 <span class="time">{{ time(message.createdAt) }}</span>
 </header>
 <!-- Model output is untrusted: text interpolation only, never v-html. -->
 <p class="body">{{ message.body.text }}</p>
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
 gap: 0.75rem;
}

.empty {
 margin: auto;
 color: var(--text-faint);
}

.message header {
 display: flex;
 align-items: baseline;
 gap: 0.5rem;
 margin-bottom: 0.15rem;
}

.author {
 font-weight: 600;
 font-size: 0.9rem;
}

.author.agent {
 color: var(--accent);
}

.time {
 color: var(--text-faint);
 font-size: 0.75rem;
}

.body {
 margin: 0;
 white-space: pre-wrap;
 overflow-wrap: anywhere;
 line-height: 1.5;
}
</style>
