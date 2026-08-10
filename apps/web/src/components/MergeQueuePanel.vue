<script setup lang="ts">
import type { MergeQueueEntry } from '@loom/api-contract'

/**
 * The serialized merge queue. Renders the order, because the
 * order is the feature: entry N+1 is rebased onto the result of entry N, and a
 * human looking at three queued branches should be able to see which one is about
 * to be built on.
 *
 * There is no "merge now" button, on purpose. Queueing is the only human action —
 * a way to jump the queue would be the race the queue replaces.
 */

const props = defineProps<{ entries: MergeQueueEntry[] }>
const emit = defineEmits<{ cancel: [entryId: string]; refresh: [] }>

// Only a still-queued entry can be called back: once it is merging, a rebase is
// already running on the Runner.
const canCancel = (entry: MergeQueueEntry) => entry.status === 'queued'

const detailOf = (entry: MergeQueueEntry): string | null => {
 if (entry.status === 'merged') {
 return `${entry.mergedCommitSha?.slice(0, 8) ?? ''} · ${entry.verified ? 'verified': 'unverified'}`
 }
 if (entry.status === 'failed') return entry.failureReason ?? 'failed'
 return null
}
</script>

<template>
 <section class="panel">
 <header>
 <h3>Merge queue</h3>
 <button type="button" @click="emit('refresh')">Refresh</button>
 </header>
 <p v-if="props.entries.length === 0" class="empty">Nothing queued.</p>
 <ul v-else class="list">
 <li v-for="entry in props.entries":key="entry.id" class="row":class="entry.status">
 <div class="line">
 <span class="branch">{{ entry.branchName }}</span>
 <span class="status">{{ entry.status }}</span>
 <button
 v-if="canCancel(entry)"
 type="button"
 class="cancel"
 @click="emit('cancel', entry.id)"
 >
 Cancel
 </button>
 </div>
 <p v-if="detailOf(entry)" class="detail">{{ detailOf(entry) }}</p>
 <!-- Plain text, never v-html: this carries git output. -->
 <pre v-if="entry.status === 'failed' && entry.detail" class="reason">{{ entry.detail }}</pre>
 </li>
 </ul>
 </section>
</template>

<style scoped>
.panel {
 border: 1px solid var(--border);
 border-radius: 0.5rem;
 padding: 0.6rem 0.7rem;
}

header {
 display: flex;
 align-items: center;
 justify-content: space-between;
 gap: 0.5rem;
 margin-bottom: 0.4rem;
}

h3 {
 margin: 0;
 font-size: 0.7rem;
 text-transform: uppercase;
 letter-spacing: 0.06em;
 color: var(--text-faint);
}

header button {
 padding: 0.15rem 0.4rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--surface-hover);
 color: var(--text);
 font: inherit;
 font-size: 0.7rem;
 cursor: pointer;
}

.empty {
 margin: 0;
 font-size: 0.8rem;
 color: var(--text-faint);
}

.list {
 margin: 0;
 padding: 0;
 list-style: none;
 display: flex;
 flex-direction: column;
 gap: 0.35rem;
}

.line {
 display: flex;
 align-items: baseline;
 gap: 0.4rem;
}

.branch {
 font-size: 0.8rem;
 overflow-wrap: anywhere;
}

.status {
 font-size: 0.68rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
 color: var(--text-faint);
}

.row.merging.status {
 color: var(--accent);
}

.row.failed.status {
 color: var(--danger);
}

.cancel {
 margin-left: auto;
 padding: 0.1rem 0.35rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: none;
 color: var(--text-faint);
 font: inherit;
 font-size: 0.7rem;
 cursor: pointer;
}

.detail {
 margin: 0.1rem 0 0;
 font-size: 0.72rem;
 color: var(--text-faint);
}

.reason {
 margin: 0.2rem 0 0;
 padding: 0.3rem 0.4rem;
 max-height: 6rem;
 overflow: auto;
 background: var(--surface);
 border-radius: 0.3rem;
 font-size: 0.7rem;
 white-space: pre-wrap;
 overflow-wrap: anywhere;
}
</style>
