<script setup lang="ts">
import type { AgentRun } from '@loom/api-contract'

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
}>

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
