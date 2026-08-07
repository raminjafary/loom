<script setup lang="ts">
import type { AgentRun } from '@loom/api-contract'

/**
 * What is running right now (PLAN.md §7 Phase 2 — a workspace may have several).
 * Deliberately not the Inbox: that answers "what is blocked on me", which with
 * concurrency is a different and usually shorter list. This one exists so a human
 * arbitrating N agents can see the N, and switch which one they are watching.
 *
 * Not the tree view either — that is the graph canvas from §3's Views, still Phase
 * 2 work. A child run shows here as an indented row, which is as much structure as
 * a flat list can honestly convey.
 */

const props = defineProps<{ runs: AgentRun[]; watchedRunId: string | null }>()
const emit = defineEmits<{ watch: [agentRunId: string] }>()
</script>

<template>
  <section class="panel">
    <h3>Active runs</h3>
    <p v-if="props.runs.length === 0" class="empty">Nothing running.</p>
    <ul v-else class="list">
      <li
        v-for="run in props.runs"
        :key="run.id"
        class="row"
        :class="{ watched: run.id === props.watchedRunId, child: run.parentRunId !== null }"
      >
        <button type="button" @click="emit('watch', run.id)">
          <span class="name">{{ run.persona.name }}</span>
          <span class="status">{{ run.status }}</span>
          <span v-if="run.relation" class="relation">{{ run.relation }}</span>
        </button>
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

h3 {
  margin: 0 0 0.4rem;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
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
  gap: 0.2rem;
}

.row.child {
  padding-left: 0.9rem;
}

.row button {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  width: 100%;
  padding: 0.25rem 0.4rem;
  border: 1px solid transparent;
  border-radius: 0.3rem;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 0.8rem;
  text-align: left;
  cursor: pointer;
}

.row button:hover {
  background: var(--surface-hover);
}

.row.watched button {
  border-color: color-mix(in oklab, var(--accent) 45%, transparent);
  background: color-mix(in oklab, var(--accent) 12%, transparent);
}

.status,
.relation {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}
</style>
