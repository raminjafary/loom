<script setup lang="ts">
import type { Runner } from '@loom/api-contract'
import { ref } from 'vue'

const props = defineProps<{
 runners: Runner[]
 lastPairing: { runnerId: string; name: string; rawToken: string } | null
}>

const emit = defineEmits<{ 'create-pairing-token': [name: string] }>

const draft = ref('')

const submit = => {
 const name = draft.value.trim
 if (!name) return
 emit('create-pairing-token', name)
 draft.value = ''
}

const copied = ref(false)

const copyToken = async (token: string) => {
 try {
 await navigator.clipboard.writeText(token)
 copied.value = true
 setTimeout( => {
 copied.value = false
 }, 1500)
 } catch {
 // Clipboard denied — the token is selectable, which is how this worked before.
 }
}

const relativeTime = (value: Date | null): string => {
 if (!value) return 'never'
 return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
 <section class="panel">
 <h3>Runners</h3>

 <ul class="list">
 <li v-for="runner in props.runners":key="runner.id" class="item">
 <span class="dot":class="{ connected: runner.connected }" />
 <span class="name">{{ runner.name }}</span>
 <span class="meta">{{ runner.connected ? 'connected': `seen ${relativeTime(runner.lastSeenAt)}` }}</span>
 </li>
 <li v-if="props.runners.length === 0" class="empty">No runners paired yet</li>
 </ul>

 <form class="pair-form" @submit.prevent="submit">
 <input v-model="draft" placeholder="runner name" aria-label="New runner name" />
 <button type="submit":disabled="!draft.trim">Mint pairing token</button>
 </form>

 <!-- Single-use and shown once, so it says which machine it is
 for by name and offers the one action anyone takes on it. -->
 <div v-if="props.lastPairing" class="pairing-token" role="status">
 <p>
 Token for <strong>{{ props.lastPairing.name }}</strong> — copy now, it is shown once:
 </p>
 <div class="token-row">
 <code>{{ props.lastPairing.rawToken }}</code>
 <button type="button" @click="copyToken(props.lastPairing.rawToken)">
 {{ copied ? 'Copied': 'Copy' }}
 </button>
 </div>
 </div>
 </section>
</template>

<style scoped>
.panel {
 padding: 0.85rem 1rem;
 border: 1px solid var(--border);
 border-radius: 0.6rem;
 background: var(--bg);
}

h3 {
 margin: 0 0 0.5rem;
 font-size: 0.8rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
 color: var(--text-faint);
}

.list {
 list-style: none;
 margin: 0 0 0.6rem;
 padding: 0;
 display: flex;
 flex-direction: column;
 gap: 0.3rem;
}

.item {
 display: flex;
 align-items: center;
 gap: 0.4rem;
 font-size: 0.85rem;
}

.dot {
 width: 0.5rem;
 height: 0.5rem;
 border-radius: 50%;
 background: var(--danger);
 flex-shrink: 0;
}

.dot.connected {
 background: var(--ok);
}

.name {
 font-weight: 600;
}

.meta {
 color: var(--text-faint);
 font-size: 0.75rem;
}

.empty {
 color: var(--text-faint);
 font-size: 0.85rem;
}

.pair-form {
 display: flex;
 gap: 0.35rem;
}

.pair-form input {
 flex: 1;
 min-width: 0;
 padding: 0.35rem 0.5rem;
 border: 1px solid var(--border);
 border-radius: 0.375rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
}

.pair-form button {
 padding: 0.35rem 0.55rem;
 border: 1px solid var(--border);
 border-radius: 0.375rem;
 background: var(--surface-hover);
 color: var(--text);
 font: inherit;
 cursor: pointer;
}

.pair-form button:disabled {
 opacity: 0.45;
 cursor: not-allowed;
}

.pairing-token {
 margin: 0.5rem 0 0;
 font-size: 0.78rem;
 color: var(--text-muted);
 word-break: break-all;
}

.pairing-token p {
 margin: 0;
}

.token-row {
 display: flex;
 align-items: flex-start;
 gap: 0.4rem;
 margin-top: 0.25rem;
}

.pairing-token code {
 flex: 1;
 padding: 0.3rem 0.4rem;
 background: var(--surface);
 border-radius: 0.3rem;
 font-size: 0.75rem;
}

.token-row button {
 flex-shrink: 0;
 padding: 0.3rem 0.55rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
 font-size: 0.75rem;
 cursor: pointer;
}
</style>
