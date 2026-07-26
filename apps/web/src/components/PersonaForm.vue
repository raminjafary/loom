<script setup lang="ts">
import type { AgentPersona, Repository } from '@loom/api-contract'
import { ref } from 'vue'

const props = defineProps<{
  repositories: Repository[]
  personas: AgentPersona[]
  disabled: boolean
}>()

const emit = defineEmits<{
  start: [input: { repositoryId: string; personaId: string }]
  'create-persona': [markdownSource: string]
}>()

const repositoryId = ref('')
const personaId = ref('')

const canSubmit = () => !props.disabled && repositoryId.value !== '' && personaId.value !== ''

const submit = () => {
  if (!canSubmit()) return
  emit('start', { repositoryId: repositoryId.value, personaId: personaId.value })
}

const DEFAULT_MARKDOWN = `---
name: my-worker
description: One-line description of what this persona does.
model: claude-haiku-4-5-20251001
tools: [Read, Grep, Glob]
---

System prompt / instructions for the agent go here.`

const showNewPersona = ref(false)
const draftMarkdown = ref(DEFAULT_MARKDOWN)

const submitNewPersona = () => {
  if (!draftMarkdown.value.trim()) return
  emit('create-persona', draftMarkdown.value)
  draftMarkdown.value = DEFAULT_MARKDOWN
  showNewPersona.value = false
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
      <select v-model="personaId" aria-label="Persona">
        <option value="" disabled>Select persona…</option>
        <option v-for="persona in props.personas" :key="persona.id" :value="persona.id">
          {{ persona.name }}
        </option>
      </select>
      <button type="submit" :disabled="!canSubmit()">Start run</button>
    </form>

    <button type="button" class="toggle-new" @click="showNewPersona = !showNewPersona">
      {{ showNewPersona ? 'Cancel' : '+ New persona' }}
    </button>

    <form v-if="showNewPersona" class="new-persona" @submit.prevent="submitNewPersona">
      <textarea
        v-model="draftMarkdown"
        rows="8"
        aria-label="Persona markdown (frontmatter + system prompt)"
      />
      <button type="submit" :disabled="!draftMarkdown.trim()">Save persona</button>
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

.form,
.new-persona {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.form select,
.new-persona textarea {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  resize: vertical;
}

.new-persona textarea {
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
}

.form button,
.new-persona button {
  padding: 0.35rem 0.55rem;
  border: 0;
  border-radius: 0.375rem;
  background: var(--accent);
  color: var(--accent-contrast);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.form button:disabled,
.new-persona button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.toggle-new {
  margin-top: 0.5rem;
  padding: 0.3rem 0;
  border: 0;
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}

.new-persona {
  margin-top: 0.5rem;
}
</style>
