<script setup lang="ts">
import type { AgentPersona } from '@loom/api-contract'
import { computed, ref } from 'vue'
import ConfirmButton from './ConfirmButton.vue'

/**
 * Authoring personas. Split out of the run launcher and moved into
 * Settings: this is a rare, deliberate act, and it was previously sharing a card with
 * the thing a human does twenty times a day.
 *
 * `markdownSource` is the persona's source of truth — the parsed columns are derived
 * from it on every write — so the editor round-trips that text rather than offering a
 * field per setting. It is also the only way to change a shipped persona's harness
 * settings, `harness.autoApprove` above all, without forking it under a new name.
 *
 * Built-ins are safe to edit rather than merely allowed to be: `seedBuiltinPersonas`
 * inserts one only when no persona of that name exists, so an edit is not reverted by
 * the next seed.
 */

const props = defineProps<{ personas: AgentPersona[] }>

const emit = defineEmits<{
 'create-persona': [markdownSource: string]
 'update-persona': [input: { personaId: string; markdownSource: string }]
 'delete-persona': [personaId: string]
}>

const DEFAULT_MARKDOWN = `---
name: my-worker
description: One-line description of what this persona does.
model: claude-haiku-4-5-20251001
tools: [Read, Grep, Glob]
---

System prompt / instructions for the agent go here.`

const showNewPersona = ref(false)
const draftMarkdown = ref(DEFAULT_MARKDOWN)

const submitNewPersona = => {
 if (!draftMarkdown.value.trim) return
 emit('create-persona', draftMarkdown.value)
 draftMarkdown.value = DEFAULT_MARKDOWN
 showNewPersona.value = false
}

const editingId = ref('')
const editDraft = ref('')

const editing = computed(
 => props.personas.find((persona) => persona.id === editingId.value) ?? null,
)

const startEditing = (persona: AgentPersona) => {
 editingId.value = persona.id
 editDraft.value = persona.markdownSource
 showNewPersona.value = false
}

const cancelEditing = => {
 editingId.value = ''
 editDraft.value = ''
}

const submitEdit = => {
 if (!editingId.value || !editDraft.value.trim) return
 emit('update-persona', { personaId: editingId.value, markdownSource: editDraft.value })
 cancelEditing
}

const harnessSummary = (persona: AgentPersona): string => {
 const parts = [
 persona.harnessAutoApprove ? 'auto-approves edits': 'asks before risky calls',
 persona.harnessBudgetCapUsd === null
 ? 'no budget cap'
: `cap $${persona.harnessBudgetCapUsd.toFixed(2)}`,
 ]
 if (persona.harnessPlanner) parts.push('planner')
 return parts.join(' · ')
}
</script>

<template>
 <div class="editor">
 <ul class="personas">
 <li v-for="persona in props.personas":key="persona.id">
 <div class="meta">
 <strong>{{ persona.name }}</strong>
 <span class="model">{{ persona.model }}</span>
 <span class="harness">{{ harnessSummary(persona) }}</span>
 </div>
 <div class="row-actions">
 <button type="button" class="link" @click="startEditing(persona)">Edit</button>
 <!-- Loses no history: a run snapshots its persona, so past runs keep theirs. -->
 <ConfirmButton
 variant="link"
 label="Delete"
 confirm-label="Delete persona"
 @confirm="emit('delete-persona', persona.id)"
 />
 </div>
 </li>
 </ul>

 <button type="button" class="link add" @click="showNewPersona = !showNewPersona">
 {{ showNewPersona ? 'Cancel': '+ New persona' }}
 </button>

 <form v-if="editing" class="source" @submit.prevent="submitEdit">
 <label>
 Editing <strong>{{ editing.name }}</strong> — built-ins included; an edit is kept across
 restarts.
 </label>
 <textarea v-model="editDraft" rows="16" aria-label="Persona markdown" />
 <div class="buttons">
 <button type="submit":disabled="!editDraft.trim">Save changes</button>
 <button type="button" class="link" @click="cancelEditing">Cancel</button>
 </div>
 </form>

 <form v-if="showNewPersona" class="source" @submit.prevent="submitNewPersona">
 <textarea v-model="draftMarkdown" rows="14" aria-label="Persona markdown" />
 <div class="buttons">
 <button type="submit":disabled="!draftMarkdown.trim">Save persona</button>
 </div>
 </form>
 </div>
</template>

<style scoped>
.personas {
 margin: 0;
 padding: 0;
 list-style: none;
 display: flex;
 flex-direction: column;
 gap: 0.3rem;
}

.personas li {
 display: flex;
 align-items: center;
 justify-content: space-between;
 gap: 0.75rem;
 padding: 0.4rem 0.55rem;
 border: 1px solid var(--border);
 border-radius: 0.4rem;
 background: var(--bg);
}

.meta {
 display: flex;
 flex-wrap: wrap;
 align-items: baseline;
 gap: 0.5rem;
 min-width: 0;
 font-size: 0.85rem;
}

.model,
.harness {
 font-size: 0.72rem;
 color: var(--text-faint);
}

.model {
 font-family: ui-monospace, monospace;
}

.row-actions {
 display: flex;
 align-items: center;
 gap: 0.6rem;
 flex-shrink: 0;
}

.link {
 border: 0;
 padding: 0;
 background: none;
 color: var(--accent);
 font: inherit;
 font-size: 0.8rem;
 cursor: pointer;
}

.add {
 margin-top: 0.5rem;
}

.source {
 margin-top: 0.6rem;
 display: flex;
 flex-direction: column;
 gap: 0.4rem;
}

.source label {
 font-size: 0.78rem;
 color: var(--text-muted);
}

textarea {
 font-family: ui-monospace, monospace;
 font-size: 0.8rem;
 line-height: 1.55;
}

.buttons {
 display: flex;
 align-items: center;
 gap: 0.75rem;
}

.buttons button[type='submit'] {
 padding: 0.35rem 0.7rem;
 border: 0;
 border-radius: 0.375rem;
 background: var(--accent);
 color: var(--accent-contrast);
 font: inherit;
 font-weight: 600;
 cursor: pointer;
}

.buttons button:disabled {
 opacity: 0.45;
 cursor: not-allowed;
}
</style>
