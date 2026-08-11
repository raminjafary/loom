<script setup lang="ts">
import type { AgentPersona, Repository, ResponseStyle } from '@loom/api-contract'
import { computed, ref, watch } from 'vue'

/**
 * The sidebar's one primary action.
 *
 * Split out of the persona editor it used to share a panel with: starting a run is
 * something a human does many times a day, and authoring a persona is something they
 * do rarely — giving them equal weight in the same card is how the sidebar came to
 * have no primary action at all. The editor now lives in Settings.
 */

const props = defineProps<{
 repositories: Repository[]
 personas: AgentPersona[]
 disabled: boolean
}>

const emit = defineEmits<{
 start: [input: { repositoryId: string; personaId: string; responseStyle: ResponseStyle }]
 'open-settings': []
}>

const repositoryId = ref('')
const personaId = ref('')

/**
 * Style choices, duplicated from `@loom/domain`'s catalogue for the same reason the
 * wire schema is: this app depends on the contract, not the domain. The labels are a
 * view concern either way — what a style *does* lives in the domain, next to the
 * directive it appends.
 */
const STYLES: ReadonlyArray<{ value: ResponseStyle; label: string; hint: string }> = [
 { value: 'default', label: 'Default', hint: 'The persona’s own voice.' },
 { value: 'concise', label: 'Concise', hint: 'Short answers, no preamble.' },
 { value: 'explanatory', label: 'Explanatory', hint: 'Says why, not just what.' },
 { value: 'caveman', label: 'Caveman', hint: 'Grug words only. Code stays correct.' },
]

const STYLE_KEY = 'loom:response-style'

const stored = : ResponseStyle => {
 const saved = localStorage.getItem(STYLE_KEY)
 return STYLES.some((style) => style.value === saved) ? (saved as ResponseStyle): 'default'
}

const responseStyle = ref<ResponseStyle>(stored)

// Remembered, because it is a preference about how you like to be talked to, not a
// property of one run — re-picking it every time is how a setting gets abandoned.
watch(responseStyle, (next) => localStorage.setItem(STYLE_KEY, next))

const styleHint = computed(
 => STYLES.find((style) => style.value === responseStyle.value)?.hint ?? '',
)

/** Auto-select when there is no choice to make. */
watch(
 => props.repositories,
 (repositories) => {
 if (repositoryId.value === '' && repositories.length === 1) {
 repositoryId.value = repositories[0]?.id ?? ''
 }
 },
 { immediate: true },
)

const selected = computed(
 => props.personas.find((persona) => persona.id === personaId.value) ?? null,
)

const canSubmit = computed(
 => !props.disabled && repositoryId.value !== '' && personaId.value !== '',
)

const submit = => {
 if (!canSubmit.value) return
 emit('start', {
 repositoryId: repositoryId.value,
 personaId: personaId.value,
 responseStyle: responseStyle.value,
 })
}

/** What the harness will do, read off the saved persona — not off an unsaved draft. */
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
 <section class="launcher">
 <form class="form" @submit.prevent="submit">
 <div class="row">
 <select v-model="personaId" aria-label="Persona" class="grow">
 <option value="" disabled>Choose an agent…</option>
 <option v-for="persona in props.personas":key="persona.id":value="persona.id">
 {{ persona.name }}
 </option>
 </select>
 <select v-model="repositoryId" aria-label="Repository" class="grow">
 <option value="" disabled>Repository…</option>
 <option v-for="repo in props.repositories":key="repo.id":value="repo.id">
 {{ repo.displayName }}
 </option>
 </select>
 </div>

 <!-- How much prose the run produces. Behaviour is the persona's; this is voice. -->
 <div class="row styles" role="radiogroup" aria-label="Response style">
 <button
 v-for="style in STYLES"
:key="style.value"
 type="button"
 class="style"
:class="{ on: responseStyle === style.value }"
 role="radio"
:aria-checked="responseStyle === style.value"
 @click="responseStyle = style.value"
 >
 {{ style.label }}
 </button>
 </div>
 <p class="hint">{{ styleHint }}</p>

 <button type="submit" class="go":disabled="!canSubmit">Start run</button>
 </form>

 <p v-if="selected" class="harness">
 <strong>{{ selected.name }}</strong> · {{ selected.model }}<br />
 {{ harnessSummary(selected) }}
 </p>

 <p v-if="props.repositories.length === 0" class="empty">
 No repository bound yet.
 <button type="button" class="link" @click="emit('open-settings')">Bind one in Settings</button>
 </p>
 </section>
</template>

<style scoped>
.launcher {
 padding: 0.8rem 0.9rem;
 border: 1px solid color-mix(in oklab, var(--accent) 35%, var(--border));
 border-radius: 0.6rem;
 background: color-mix(in oklab, var(--accent) 6%, var(--bg));
}

.form {
 display: flex;
 flex-direction: column;
 gap: 0.4rem;
}

.row {
 display: flex;
 gap: 0.35rem;
}

.grow {
 flex: 1 1 0;
 min-width: 0;
}

select {
 font-size: 0.82rem;
}

.styles {
 gap: 0.25rem;
}

.style {
 flex: 1 1 0;
 padding: 0.22rem 0.1rem;
 border: 1px solid var(--border);
 border-radius: 0.35rem;
 background: var(--bg);
 color: var(--text-muted);
 font: inherit;
 font-size: 0.72rem;
 cursor: pointer;
}

.style.on {
 border-color: var(--accent);
 background: var(--accent-soft);
 color: var(--accent);
 font-weight: 600;
}

.hint {
 margin: 0;
 font-size: 0.7rem;
 color: var(--text-faint);
}

.go {
 margin-top: 0.15rem;
 padding: 0.42rem 0.55rem;
 border: 0;
 border-radius: 0.375rem;
 background: var(--accent);
 color: var(--accent-contrast);
 font: inherit;
 font-weight: 600;
 cursor: pointer;
}

.go:disabled {
 opacity: 0.4;
 cursor: not-allowed;
}

.harness {
 margin: 0.55rem 0 0;
 font-size: 0.75rem;
 line-height: 1.45;
 color: var(--text-muted);
}

.empty {
 margin: 0.55rem 0 0;
 font-size: 0.75rem;
 color: var(--text-faint);
}

.link {
 border: 0;
 padding: 0;
 background: none;
 color: var(--accent);
 font: inherit;
 font-size: inherit;
 text-decoration: underline;
 cursor: pointer;
}
</style>
