<script setup lang="ts">
import type { AgentPersona, Repository } from '@loom/api-contract'
import { computed, ref } from 'vue'

const props = defineProps<{
 repositories: Repository[]
 personas: AgentPersona[]
 disabled: boolean
}>

const emit = defineEmits<{
 start: [input: { repositoryId: string; personaId: string }]
 'create-persona': [markdownSource: string]
 'update-persona': [input: { personaId: string; markdownSource: string }]
}>

const repositoryId = ref('')
const personaId = ref('')

const canSubmit = => !props.disabled && repositoryId.value !== '' && personaId.value !== ''

/** The persona chosen above — what the harness summary and the edit button act on. */
const selected = computed( =>
 props.personas.find((persona) => persona.id === personaId.value) ?? null,
)

const submit = => {
 if (!canSubmit) return
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

const submitNewPersona = => {
 if (!draftMarkdown.value.trim) return
 emit('create-persona', draftMarkdown.value)
 draftMarkdown.value = DEFAULT_MARKDOWN
 showNewPersona.value = false
}

/**
 * Editing an existing persona, built-ins included.
 *
 * `markdownSource` is the persona's source of truth — the parsed columns are derived
 * from it on every write — so the editor round-trips that text rather than offering a
 * field per setting. It is also the only way to change a shipped persona's harness
 * settings, and `harness.autoApprove` in particular, without forking it under a new
 * name.
 *
 * Built-ins are safe to edit rather than merely allowed to be: `seedBuiltinPersonas`
 * inserts a built-in only when no persona of that name exists, so an edit is not
 * reverted by the next seed.
 */
const editingId = ref('')
const editDraft = ref('')

const editing = computed( =>
 props.personas.find((persona) => persona.id === editingId.value) ?? null,
)

const startEditing = => {
 const persona = selected.value
 if (!persona) return
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

/** What the harness will do, read off the saved persona — not off the unsaved draft. */
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
 <section class="panel">
 <h3>Start a run</h3>

 <form class="form" @submit.prevent="submit">
 <select v-model="repositoryId" aria-label="Repository">
 <option value="" disabled>Select repository…</option>
 <option v-for="repo in props.repositories":key="repo.id":value="repo.id">
 {{ repo.displayName }}
 </option>
 </select>
 <select v-model="personaId" aria-label="Persona">
 <option value="" disabled>Select persona…</option>
 <option v-for="persona in props.personas":key="persona.id":value="persona.id">
 {{ persona.name }}
 </option>
 </select>
 <button type="submit":disabled="!canSubmit">Start run</button>
 </form>

 <!--
 Shown for whichever persona is selected above, so the harness settings a run will
 actually use are visible *before* starting it rather than only inside its markdown.
 -->
 <p v-if="selected" class="harness">
 <strong>{{ selected.name }}</strong> · {{ selected.model }}<br />
 {{ harnessSummary(selected) }}
 </p>

 <div class="actions">
 <button type="button" class="toggle-new" @click="showNewPersona = !showNewPersona">
 {{ showNewPersona ? 'Cancel': '+ New persona' }}
 </button>
 <button
 type="button"
 class="toggle-new"
:disabled="personaId === ''"
 @click="editingId ? cancelEditing: startEditing"
 >
 {{ editingId ? 'Cancel edit': 'Edit persona' }}
 </button>
 </div>

 <form v-if="editing" class="new-persona" @submit.prevent="submitEdit">
 <label class="editing-label">
 Editing <strong>{{ editing.name }}</strong> — built-ins included; an edit is kept
 across restarts.
 </label>
 <textarea
 v-model="editDraft"
 rows="10"
 aria-label="Persona markdown (frontmatter + system prompt)"
 />
 <button type="submit":disabled="!editDraft.trim">Save changes</button>
 </form>

 <form v-if="showNewPersona" class="new-persona" @submit.prevent="submitNewPersona">
 <textarea
 v-model="draftMarkdown"
 rows="8"
 aria-label="Persona markdown (frontmatter + system prompt)"
 />
 <button type="submit":disabled="!draftMarkdown.trim">Save persona</button>
 </form>
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

.actions {
 display: flex;
 gap: 0.75rem;
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

.toggle-new:disabled {
 opacity: 0.45;
 cursor: not-allowed;
}

.harness {
 margin: 0.5rem 0 0;
 font-size: 0.75rem;
 line-height: 1.45;
 color: var(--text-muted);
}

.editing-label {
 font-size: 0.75rem;
 color: var(--text-muted);
}

.new-persona {
 margin-top: 0.5rem;
}
</style>
