<script setup lang="ts">
import type { AgentPersona, Capability, PersonaCapability, PersonaDraft } from '@loom/api-contract'
import {
 EMPTY_PERSONA_FORM,
 SELECTABLE_MODELS,
 SELECTABLE_TOOLS,
 isActingTool,
 personaFormFromDraft,
 personaFormFromPersona,
 personaFormProblems,
 personaFormToMarkdown,
 personaSaveDiscrepancies,
 type PersonaFormState,
} from '@loom/client-core'
import { computed, ref, watch } from 'vue'
import ConfirmButton from './ConfirmButton.vue'

/**
 * Authoring personas.
 *
 * The product shape asks for "a persona form (name, description, model, tools, prompt) writing the
 * same markdown, with a raw-markdown toggle", and the roadmap lists it under Phase 1's ship
 * criteria. What shipped instead was the raw half alone: a textarea of YAML
 * frontmatter, with no validation, in which the way to discover that a planner may
 * not hold `Bash` was to save and read a server error.
 *
 * Two rules the form keeps, both of which are why it is not simply a set of inputs:
 *
 * - **The markdown is still the source of truth.** The form writes it, the toggle
 * shows it, and the tab a human saves from is the one that decides what is sent.
 * Nothing is stored that the markdown does not say.
 * - **The client never parses the format.** Coming back from the raw tab goes
 * through `persona.parse`, which is the same parser the write path uses, so the
 * form cannot show fields a save would not store. What the form *writes* is
 * checked from the other end: `personaSaveDiscrepancies` compares the saved row
 * to what was asked for and says so if they differ.
 */

const props = defineProps<{
 personas: AgentPersona[]
 capabilities: Capability[]
 attachments: PersonaCapability[]
}>

const emit = defineEmits<{
 'create-persona': [markdownSource: string]
 'update-persona': [input: { personaId: string; markdownSource: string }]
 'delete-persona': [personaId: string]
 attach: [input: { personaId: string; capabilityId: string }]
 detach: [input: { personaId: string; capabilityId: string }]
 /** Parses a draft server-side. */
 parse: [markdownSource: string, done: (draft: PersonaDraft) => void]
}>

type Mode = 'closed' | 'create' | 'edit'
type Tab = 'form' | 'markdown'

const mode = ref<Mode>('closed')
const tab = ref<Tab>('form')
const editingId = ref('')
const form = ref<PersonaFormState>({...EMPTY_PERSONA_FORM })
const rawMarkdown = ref('')
const rawProblems = ref<string[]>([])
const savedDiscrepancies = ref<string[]>([])

const EFFORTS = ['low', 'medium', 'high'] as const

const editingPersona = computed(
 => props.personas.find((persona) => persona.id === editingId.value) ?? null,
)

const existingNames = computed( => props.personas.map((persona) => persona.name))

const formProblems = computed( =>
 personaFormProblems(form.value, {
 existingNames: existingNames.value,
 editing: mode.value === 'edit',
 }),
)

/** The markdown a save would send, from whichever tab is in front. */
const outgoingMarkdown = computed( =>
 tab.value === 'markdown' ? rawMarkdown.value: personaFormToMarkdown(form.value),
)

const problems = computed( => (tab.value === 'markdown' ? rawProblems.value: formProblems.value))

const close = => {
 mode.value = 'closed'
 editingId.value = ''
 rawProblems.value = []
}

const startCreating = => {
 if (mode.value === 'create') return close
 mode.value = 'create'
 tab.value = 'form'
 editingId.value = ''
 form.value = {...EMPTY_PERSONA_FORM }
 rawMarkdown.value = personaFormToMarkdown(form.value)
 rawProblems.value = []
 savedDiscrepancies.value = []
}

const startEditing = (persona: AgentPersona) => {
 mode.value = 'edit'
 tab.value = 'form'
 editingId.value = persona.id
 form.value = personaFormFromPersona(persona)
 // The stored text verbatim, not a re-serialization: a persona hand-authored with
 // comments or an unusual field order must not be silently rewritten by opening it.
 rawMarkdown.value = persona.markdownSource
 rawProblems.value = []
 savedDiscrepancies.value = []
}

/**
 * Switching tabs is where the two representations have to agree.
 *
 * form → markdown is a serialization, so it is immediate. markdown → form is a
 * parse, so it is a round trip; if the server cannot read the draft the form is
 * left untouched and the tab stays where it is, because silently showing stale
 * fields next to text that does not produce them is the failure this whole file
 * is arranged to avoid.
 */
const showMarkdown = => {
 rawMarkdown.value = personaFormToMarkdown(form.value)
 rawProblems.value = []
 tab.value = 'markdown'
}

const showForm = => {
 // Already here: re-parsing would overwrite live field edits with the markdown as
 // it stood when the tab was last left.
 if (tab.value === 'form') return
 emit('parse', rawMarkdown.value, (draft) => {
 const next = personaFormFromDraft(draft)
 rawProblems.value = draft.problems
 if (!next) return
 form.value = next
 tab.value = 'form'
 })
}

/** Live validation for the raw tab — the "textarea with frontmatter validation". */
let validateTimer: ReturnType<typeof setTimeout> | null = null
watch(rawMarkdown, (source) => {
 if (tab.value !== 'markdown') return
 if (validateTimer) clearTimeout(validateTimer)
 validateTimer = setTimeout( => {
 emit('parse', source, (draft) => {
 rawProblems.value = draft.problems
 })
 }, 300)
})

const busy = ref(false)

const submit = => {
 if (busy.value || problems.value.length > 0) return
 const markdown = outgoingMarkdown.value
 if (!markdown.trim) return
 busy.value = true
 savedDiscrepancies.value = []
 const intended = form.value
 const wasCreating = mode.value === 'create'
 if (wasCreating) emit('create-persona', markdown)
 else emit('update-persona', { personaId: editingId.value, markdownSource: markdown })
 // Released on the next list update, or after a beat if the save failed and the
 // list never changes — a disabled button that never re-enables is worse than a
 // second submit the server refuses by name collision.
 setTimeout( => (busy.value = false), 1_500)
 if (tab.value === 'form') pendingCheck.value = { name: intended.name.trim, intended }
 close
}

/**
 * The round-trip assertion. A save sends markdown this client wrote; when the
 * stored row arrives, what it parsed to is compared against what was asked for.
 * Only meaningful for a form save — a raw-tab save has no field-level intent to
 * compare against, since the text *is* the intent.
 */
const pendingCheck = ref<{ name: string; intended: PersonaFormState } | null>(null)
watch(
 => props.personas,
 (personas) => {
 const pending = pendingCheck.value
 if (!pending) return
 const stored = personas.find((persona) => persona.name === pending.name)
 if (!stored) return
 pendingCheck.value = null
 busy.value = false
 savedDiscrepancies.value = personaSaveDiscrepancies(pending.intended, stored)
 },
 { deep: true },
)

const toggleTool = (tool: string) => {
 const has = form.value.tools.includes(tool)
 form.value = {
...form.value,
 tools: has
 ? form.value.tools.filter((entry) => entry !== tool)
: [...form.value.tools, tool],
 }
}

const toggleDelegate = (tool: string) => {
 const has = form.value.delegates.includes(tool)
 form.value = {
...form.value,
 delegates: has
 ? form.value.delegates.filter((entry) => entry !== tool)
: [...form.value.delegates, tool],
 }
}

const numberOrNull = (value: string): number | null => {
 const trimmed = value.trim
 if (!trimmed) return null
 const parsed = Number(trimmed)
 return Number.isFinite(parsed) ? parsed: null
}

const attachedTo = (personaId: string) =>
 props.attachments
.filter((attachment) => attachment.personaId === personaId)
.map((attachment) => ({
 attachment,
 capability: props.capabilities.find((c) => c.id === attachment.capabilityId) ?? null,
 }))

const unattached = computed( => {
 if (!editingId.value) return []
 const attached = new Set(
 props.attachments
.filter((attachment) => attachment.personaId === editingId.value)
.map((attachment) => attachment.capabilityId),
)
 return props.capabilities.filter((capability) => !attached.has(capability.id))
})

const attachTarget = ref('')

const doAttach = => {
 if (!attachTarget.value || !editingId.value) return
 emit('attach', { personaId: editingId.value, capabilityId: attachTarget.value })
 attachTarget.value = ''
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
 <span v-if="attachedTo(persona.id).length > 0" class="caps">
 {{ attachedTo(persona.id).length }} capability(s)
 </span>
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

 <button type="button" class="link add" @click="startCreating">
 {{ mode === 'create' ? 'Cancel': '+ New persona' }}
 </button>

 <p v-if="savedDiscrepancies.length > 0" class="discrepancy" role="alert">
 <strong>Saved, but not as written.</strong>
 The stored persona differs from what this form asked for — the markdown it wrote
 does not parse back to the same settings:
 <span v-for="line in savedDiscrepancies":key="line" class="line">{{ line }}</span>
 </p>

 <form v-if="mode !== 'closed'" class="sheet" @submit.prevent="submit">
 <header class="sheet-head">
 <span class="what">
 {{ mode === 'edit' ? `Editing ${editingPersona?.name ?? ''}`: 'New persona' }}
 </span>
 <div class="tabs" role="tablist" aria-label="Persona editor view">
 <button
 type="button"
 role="tab"
:aria-selected="tab === 'form'"
:class="{ on: tab === 'form' }"
 @click="showForm"
 >
 Form
 </button>
 <button
 type="button"
 role="tab"
:aria-selected="tab === 'markdown'"
:class="{ on: tab === 'markdown' }"
 @click="showMarkdown"
 >
 Markdown
 </button>
 </div>
 </header>

 <template v-if="tab === 'form'">
 <div class="grid">
 <label>
 <span>Name</span>
 <input
 v-model="form.name"
 type="text"
:disabled="mode === 'edit'"
 placeholder="my-worker"
 />
 <small v-if="mode === 'edit'">
 A name cannot be changed — it is how @mention, the delegation roster and the
 merge queue address this persona.
 </small>
 </label>

 <label>
 <span>Model</span>
 <select v-model="form.model">
 <option v-for="entry in SELECTABLE_MODELS":key="entry.id":value="entry.id">
 {{ entry.label }}
 </option>
 </select>
 </label>
 </div>

 <label class="wide">
 <span>Description</span>
 <input
 v-model="form.description"
 type="text"
 placeholder="One line — a Planner is shown this when choosing who to delegate to."
 />
 </label>

 <fieldset>
 <legend>Tools</legend>
 <p class="hint">
 An acting tool is one that changes something. A planner may hold only the
 read-only three.
 </p>
 <div class="chips">
 <label
 v-for="entry in SELECTABLE_TOOLS"
:key="entry.name"
 class="chip"
:class="{ acting: entry.acting, off: form.planner && entry.acting }"
 >
 <input
 type="checkbox"
:checked="form.tools.includes(entry.name)"
:disabled="form.planner && entry.acting"
 @change="toggleTool(entry.name)"
 />
 <span>{{ entry.name }}</span>
 <small>{{ entry.summary }}</small>
 </label>
 </div>
 </fieldset>

 <fieldset>
 <legend>Harness</legend>
 <div class="grid">
 <label class="check">
 <input v-model="form.planner" type="checkbox" />
 <span>Planner — decomposes rather than acting</span>
 </label>
 <label class="check">
 <input v-model="form.autoApprove" type="checkbox" />
 <span>Auto-approve risky calls (runs unattended)</span>
 </label>
 <label>
 <span>Budget cap (USD)</span>
 <input
:value="form.budgetCapUsd ?? ''"
 type="number"
 min="0"
 step="0.01"
 placeholder="uncapped"
 @input="
 form = {
...form,
 budgetCapUsd: numberOrNull(($event.target as HTMLInputElement).value),
 }
 "
 />
 </label>
 <label>
 <span>Max turns</span>
 <input
:value="form.maxTurns ?? ''"
 type="number"
 min="1"
 step="1"
 placeholder="unlimited"
 @input="
 form = {
...form,
 maxTurns: numberOrNull(($event.target as HTMLInputElement).value),
 }
 "
 />
 </label>
 <label>
 <span>Effort</span>
 <select
:value="form.effort ?? ''"
 @change="
 form = {
...form,
 effort: ($event.target as HTMLSelectElement).value || null,
 }
 "
 >
 <option value="">default</option>
 <option v-for="effort in EFFORTS":key="effort":value="effort">
 {{ effort }}
 </option>
 </select>
 </label>
 </div>
 </fieldset>

 <fieldset v-if="form.planner">
 <legend>Delegation envelope</legend>
 <p class="hint">
 The ceiling this planner's children are attenuated against. It is
 separate from what the planner holds itself: a worker may be given a tool the
 planner cannot use, and can never be given one that is not ticked here.
 </p>
 <div class="chips">
 <label v-for="entry in SELECTABLE_TOOLS":key="entry.name" class="chip">
 <input
 type="checkbox"
:checked="form.delegates.includes(entry.name)"
 @change="toggleDelegate(entry.name)"
 />
 <span>{{ entry.name }}</span>
 </label>
 </div>
 </fieldset>

 <fieldset v-if="mode === 'edit'">
 <legend>Capabilities</legend>
 <p v-if="attachedTo(editingId).length === 0 && unattached.length === 0" class="hint">
 None registered. Register an MCP server or a skill on the Capabilities tab first.
 </p>
 <ul v-if="attachedTo(editingId).length > 0" class="attached">
 <li v-for="row in attachedTo(editingId)":key="row.attachment.capabilityId">
 <span>{{ row.capability?.name ?? row.attachment.capabilityId }}</span>
 <small>{{ row.capability?.kind ?? '' }}</small>
 <button
 type="button"
 class="link"
 @click="
 emit('detach', {
 personaId: editingId,
 capabilityId: row.attachment.capabilityId,
 })
 "
 >
 detach
 </button>
 </li>
 </ul>
 <div v-if="unattached.length > 0" class="attach-row">
 <select v-model="attachTarget" aria-label="Capability to attach">
 <option value="">Attach a capability…</option>
 <option v-for="capability in unattached":key="capability.id":value="capability.id">
 {{ capability.name }} ({{ capability.kind }})
 </option>
 </select>
 <button type="button" class="link":disabled="!attachTarget" @click="doAttach">
 Attach
 </button>
 </div>
 </fieldset>

 <label class="wide">
 <span>System prompt</span>
 <textarea v-model="form.systemPrompt" rows="10" />
 </label>
 </template>

 <template v-else>
 <p class="hint">
 The stored form. Everything above is written from this text, and this text is
 what a save sends — validated by the server's own parser as you type.
 </p>
 <textarea v-model="rawMarkdown" rows="18" aria-label="Persona markdown" />
 </template>

 <ul v-if="problems.length > 0" class="problems" role="alert">
 <li v-for="problem in problems":key="problem">{{ problem }}</li>
 </ul>

 <div class="buttons">
 <button type="submit":disabled="busy || problems.length > 0">
 {{ mode === 'edit' ? 'Save changes': 'Save persona' }}
 </button>
 <button type="button" class="link" @click="close">Cancel</button>
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
.harness,
.caps {
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

.link:disabled {
 opacity: 0.45;
 cursor: not-allowed;
}

.add {
 margin-top: 0.5rem;
}

.sheet {
 margin-top: 0.75rem;
 padding: 0.75rem;
 border: 1px solid var(--border);
 border-radius: 0.5rem;
 display: flex;
 flex-direction: column;
 gap: 0.7rem;
}

.sheet-head {
 display: flex;
 align-items: center;
 justify-content: space-between;
 gap: 0.75rem;
}

.what {
 font-size: 0.85rem;
 font-weight: 600;
}

.tabs {
 display: flex;
 gap: 0.25rem;
}

.tabs button {
 padding: 0.2rem 0.6rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text-muted);
 font: inherit;
 font-size: 0.78rem;
 cursor: pointer;
}

.tabs button.on {
 background: var(--accent);
 border-color: var(--accent);
 color: var(--accent-contrast);
}

.grid {
 display: grid;
 grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
 gap: 0.6rem;
}

label {
 display: flex;
 flex-direction: column;
 gap: 0.2rem;
 font-size: 0.78rem;
 color: var(--text-muted);
}

label.wide {
 width: 100%;
}

label.check {
 flex-direction: row;
 align-items: center;
 gap: 0.4rem;
}

label small {
 font-size: 0.7rem;
 color: var(--text-faint);
}

input[type='text'],
input[type='number'],
select,
textarea {
 font: inherit;
 font-size: 0.8rem;
 padding: 0.3rem 0.4rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text);
}

textarea {
 font-family: ui-monospace, monospace;
 line-height: 1.55;
 display: block;
}

fieldset {
 margin: 0;
 padding: 0.5rem 0.6rem 0.6rem;
 border: 1px solid var(--border);
 border-radius: 0.4rem;
}

legend {
 font-size: 0.75rem;
 font-weight: 600;
 color: var(--text-muted);
 padding: 0 0.3rem;
}

.hint {
 margin: 0 0 0.45rem;
 font-size: 0.72rem;
 color: var(--text-faint);
}

.chips {
 display: flex;
 flex-wrap: wrap;
 gap: 0.35rem;
}

.chip {
 flex-direction: row;
 align-items: center;
 gap: 0.3rem;
 padding: 0.2rem 0.45rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
}

.chip small {
 color: var(--text-faint);
}

.chip.off {
 opacity: 0.4;
}

.attached {
 margin: 0 0 0.4rem;
 padding: 0;
 list-style: none;
 display: flex;
 flex-direction: column;
 gap: 0.25rem;
}

.attached li {
 display: flex;
 align-items: center;
 gap: 0.5rem;
 font-size: 0.78rem;
}

.attach-row {
 display: flex;
 align-items: center;
 gap: 0.5rem;
}

.problems {
 margin: 0;
 padding: 0.45rem 0.6rem 0.45rem 1.4rem;
 border: 1px solid var(--danger, #b42318);
 border-radius: 0.4rem;
 font-size: 0.75rem;
 color: var(--danger, #b42318);
}

.discrepancy {
 margin: 0.6rem 0 0;
 padding: 0.5rem 0.6rem;
 border: 1px solid var(--danger, #b42318);
 border-radius: 0.4rem;
 font-size: 0.75rem;
 color: var(--danger, #b42318);
 display: flex;
 flex-direction: column;
 gap: 0.2rem;
}

.discrepancy.line {
 font-family: ui-monospace, monospace;
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
