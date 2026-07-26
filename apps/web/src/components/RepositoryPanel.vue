<script setup lang="ts">
import type { Repository, Runner } from '@loom/api-contract'
import { ref } from 'vue'

const props = defineProps<{
  repositories: Repository[]
  runners: Runner[]
}>()

const emit = defineEmits<{
  bind: [input: { runnerId: string; path: string; displayName: string }]
}>()

const runnerId = ref('')
const path = ref('')
const displayName = ref('')

const submit = () => {
  if (!runnerId.value || !path.value.trim() || !displayName.value.trim()) return
  emit('bind', { runnerId: runnerId.value, path: path.value.trim(), displayName: displayName.value.trim() })
  path.value = ''
  displayName.value = ''
}
</script>

<template>
  <section class="panel">
    <h3>Repositories</h3>

    <ul class="list">
      <li v-for="repo in props.repositories" :key="repo.id" class="item">
        <span class="name">{{ repo.displayName }}</span>
        <span class="meta">{{ repo.absolutePath }}</span>
      </li>
      <li v-if="props.repositories.length === 0" class="empty">No repositories bound yet</li>
    </ul>

    <form class="bind-form" @submit.prevent="submit">
      <select v-model="runnerId" aria-label="Runner">
        <option value="" disabled>Select runner…</option>
        <option v-for="runner in props.runners" :key="runner.id" :value="runner.id">
          {{ runner.name }}
        </option>
      </select>
      <input v-model="path" placeholder="/absolute/path/to/repo" aria-label="Repository path" />
      <input v-model="displayName" placeholder="display name" aria-label="Display name" />
      <button type="submit" :disabled="!runnerId || !path.trim() || !displayName.trim()">
        Bind
      </button>
    </form>
  </section>
</template>

<style scoped>
.panel {
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--border);
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
  flex-direction: column;
  font-size: 0.85rem;
}

.name {
  font-weight: 600;
}

.meta {
  color: var(--text-faint);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.empty {
  color: var(--text-faint);
  font-size: 0.85rem;
}

.bind-form {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.bind-form select,
.bind-form input {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
}

.bind-form button {
  padding: 0.35rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--surface-hover);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}

.bind-form button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
