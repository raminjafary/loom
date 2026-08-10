<script setup lang="ts">
import type { AgentRun } from '@loom/api-contract'
import { ref, watch } from 'vue'

const props = defineProps<{
 run: AgentRun | null
 diff: string | null
}>

const emit = defineEmits<{
 'load-diff': [agentRunId: string]
 keep: [agentRunId: string]
 discard: [agentRunId: string]
 push: [agentRunId: string, acknowledgeCiChange: boolean]
 merge: [agentRunId: string]
 'load-raw': [agentRunId: string, done: (result: { lines: string[]; chunks: number }) => void]
}>

/**
 * The raw transcript is fetched only when asked for. It is the verbatim provider stream — far
 * larger than the thread, and the reason the event-tiering design tiers the write path at all —
 * so loading it alongside the diff would undo the point of the tiering.
 */
const raw = ref<{ lines: string[]; chunks: number } | null>(null)
const rawLoading = ref(false)

const loadRaw = => {
 if (!props.run) return
 rawLoading.value = true
 emit('load-raw', props.run.id, (result) => {
 raw.value = result
 rawLoading.value = false
 })
}

// A transcript belongs to one run; keeping it on screen while the view switches
// would attribute one run's output to another.
watch(
 => props.run?.id,
 => {
 raw.value = null
 },
)

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

const canLoadDiff = => props.run !== null && props.run.clonePath !== null

// Keep/discard/push only make sense once the run is done and undecided.
const canDecideDisposition = =>
 props.run !== null && TERMINAL_STATUSES.has(props.run.status) && props.run.branchDisposition === null
</script>

<template>
 <section v-if="props.run && props.run.clonePath" class="panel">
 <header>
 <h3>Diff — {{ props.run.branchName }}</h3>
 <button type="button":disabled="!canLoadDiff" @click="emit('load-diff', props.run.id)">
 Load diff
 </button>
 </header>
 <!-- Raw diff text only, no v-html -->
 <pre v-if="props.diff !== null" class="diff">{{ props.diff || '(no changes yet)' }}</pre>
 <details class="raw" @toggle="(e) => (e.target as HTMLDetailsElement).open && raw === null && loadRaw">
 <summary>Raw transcript</summary>
 <p v-if="rawLoading" class="raw-note">Loading…</p>
 <template v-else-if="raw">
 <p class="raw-note">{{ raw.lines.length }} lines in {{ raw.chunks }} chunk(s), redacted at write.</p>
 <!-- Plain text, never v-html: this is verbatim provider output. -->
 <pre v-if="raw.lines.length > 0" class="diff">{{ raw.lines.join('\n') }}</pre>
 <p v-else class="raw-note">Nothing was recorded for this run.</p>
 </template>
 </details>

 <p v-if="props.run.branchDisposition" class="disposition">Branch {{ props.run.branchDisposition }}.</p>
 <footer v-else-if="canDecideDisposition">
 <button type="button" @click="emit('keep', props.run.id)">Keep branch</button>
 <button type="button" class="danger" @click="emit('discard', props.run.id)">Discard branch</button>
 <!--
 Queues; it does not merge. The queue rebases in order and may reach this
 branch behind others, so a label promising a merge
 here would be describing something that has not happened yet.
 -->
 <button type="button" @click="emit('merge', props.run.id)">Queue for merge</button>
 <button type="button" @click="emit('push', props.run.id, false)">Push &amp; open PR</button>
 <button type="button" class="muted" @click="emit('push', props.run.id, true)">
 Push anyway (CI/workflow changes)
 </button>
 </footer>
 </section>
</template>

<style scoped>
.panel {
 padding: 0.85rem 1rem;
 border: 1px solid var(--border);
 border-radius: 0.6rem;
 background: var(--bg);
}

header {
 display: flex;
 align-items: center;
 justify-content: space-between;
 gap: 0.5rem;
 margin-bottom: 0.5rem;
}

h3 {
 margin: 0;
 font-size: 0.8rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
 color: var(--text-faint);
}

button {
 padding: 0.3rem 0.55rem;
 border: 1px solid var(--border);
 border-radius: 0.375rem;
 background: var(--surface-hover);
 color: var(--text);
 font: inherit;
 cursor: pointer;
}

button:disabled {
 opacity: 0.45;
 cursor: not-allowed;
}

.diff {
 margin: 0;
 padding: 0.5rem;
 max-height: 20rem;
 overflow: auto;
 background: var(--surface);
 border-radius: 0.375rem;
 font-size: 0.78rem;
 white-space: pre-wrap;
 overflow-wrap: anywhere;
}

footer {
 display: flex;
 gap: 0.5rem;
 margin-top: 0.6rem;
}

.raw {
 margin-top: 0.6rem;
 font-size: 0.78rem;
}

.raw summary {
 cursor: pointer;
 color: var(--text-faint);
 font-size: 0.72rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
}

.raw-note {
 margin: 0.35rem 0;
 font-size: 0.72rem;
 color: var(--text-faint);
}

.disposition {
 margin: 0.6rem 0 0;
 font-size: 0.8rem;
 color: var(--text-faint);
}

button.danger {
 border-color: var(--danger);
 color: var(--danger);
}

button.muted {
 opacity: 0.6;
 font-size: 0.75rem;
}
</style>
