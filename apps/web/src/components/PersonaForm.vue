<script setup lang="ts">
import type { PersonaSpec, Repository } from '@loom/api-contract'
import { ref } from 'vue'

const props = defineProps<{
  repositories: Repository[]
  disabled: boolean
}>()

const emit = defineEmits<{
  start: [input: { repositoryId: string; persona: PersonaSpec }]
}>()

const repositoryId = ref('')
const name = ref('')
const model = ref('claude-haiku-4-5-20251001')
const tools = ref('Read, Grep, Glob')
const systemPrompt = ref('')

const canSubmit = () =>
  !props.disabled &&
  repositoryId.value !== '' &&
  name.value.trim().length > 0 &&
  systemPrompt.value.trim().length > 0

const submit = () => {
  if (!canSubmit()) return
  const persona: PersonaSpec = {
    name: name.value.trim(),
    systemPrompt: systemPrompt.value.trim(),
    model: model.value.trim(),
    tools: tools.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  }
  emit('start', { repositoryId: repositoryId.value, persona })
}
</script>

<template>
  <section class="panel">
    <h3>Start a run</h3>

    <form class="form" @submit.prevent="submit">
      <select v-model="repositoryId" aria-label="Repository">
        <option value="" disabled>Select repository…</option>
        <option v-for="repo in props.repositories" :key="repo.id" :value="repo.id">
          {{ repo.displayName }}
        </option>
      </select>
      <input v-model="name" placeholder="persona name" aria-label="Persona name" />
      <input v-model="model" placeholder="model" aria-label="Model" />
      <input v-model="tools" placeholder="tools (comma-separated)" aria-label="Tools" />
      <textarea
        v-model="systemPrompt"
        rows="3"
        placeholder="system prompt / instructions"
        aria-label="System prompt"
      />
      <button type="submit" :disabled="!canSubmit()">Start run</button>
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

.form {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.form select,
.form input,
.form textarea {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  resize: vertical;
}

.form button {
  padding: 0.35rem 0.55rem;
  border: 0;
  border-radius: 0.375rem;
  background: var(--accent);
  color: var(--accent-contrast);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.form button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
