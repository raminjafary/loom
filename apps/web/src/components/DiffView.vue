<script setup lang="ts">
import type { AgentRun } from '@loom/api-contract'

const props = defineProps<{
  run: AgentRun | null
  diff: string | null
}>()

const emit = defineEmits<{ 'load-diff': [agentRunId: string] }>()

const canLoadDiff = () => props.run !== null && props.run.clonePath !== null
</script>

<template>
  <section v-if="props.run && props.run.clonePath" class="panel">
    <header>
      <h3>Diff — {{ props.run.branchName }}</h3>
      <button type="button" :disabled="!canLoadDiff()" @click="emit('load-diff', props.run.id)">
        Load diff
      </button>
    </header>
    <!-- Raw diff text only, no v-html (PLAN.md §6 A8) -->
    <pre v-if="props.diff !== null" class="diff">{{ props.diff || '(no changes yet)' }}</pre>
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
</style>
