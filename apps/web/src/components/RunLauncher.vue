<script setup lang="ts">
import type {
 AgentPersona,
 ApprovalMode,
 DelegationPreview,
 Repository,
 ResponseStyle,
} from '@loom/api-contract'
import { findSelectableModel, SELECTABLE_MODELS } from '@loom/client-core'
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
 start: [
 input: {
 repositoryId: string
 personaId: string
 responseStyle: ResponseStyle
 /**
 * What the agent is actually being asked to do.
 *
 * This control had no task field at all, so every run started from the
 * sidebar — the app's one primary action — reached the Runner with nothing
 * to do but the fixed "begin working now" prompt. `agentRun.start` has
 * accepted a task the whole time; only the `@mention` path ever sent one.
 */
 task?: string
 /** Absent means "whatever the persona's own model is". */
 model?: string
 /** Absent keeps the persona's cap; null is a deliberate "uncapped". */
 budgetCapUsd?: number | null
 },
 ]
 'open-settings': []
 /**
 * Asks the server who this planner could delegate to under the overrides
 * currently selected.
 */
 'preview-delegation': [
 input: { personaId: string; model?: string; budgetCapUsd?: number | null },
 done: (preview: DelegationPreview) => void,
 ]
}>

const repositoryId = ref('')
const personaId = ref('')
const task = ref('')

/**
 * Style choices, duplicated from `@loom/domain`'s catalogue for the same reason the
 * wire schema is: this app depends on the contract, not the domain. The labels are a
 * view concern either way — what a style *does* lives in the domain, next to the
 * directive it appends.
 */
/** Duplicated from the domain for the same reason `STYLES` is — see below. */
const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = {
 ask: 'asks before risky calls',
 'accept-edits': 'takes file edits, asks before a shell',
 auto: 'runs unattended',
}

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

/**
 * The task is required here, unlike on the wire where it is optional.
 *
 * A run with no task is legal — the Runner falls back to a generic prompt — but it
 * is never what a human at this form meant, and shipping it as optional is how the
 * field goes unfilled and the run comes back having done something adjacent.
 */
const canSubmit = computed(
 =>
 !props.disabled &&
 repositoryId.value !== '' &&
 personaId.value !== '' &&
 task.value.trim !== '',
)

/**
 * Empty means the persona's own model.
 *
 * A persona still carries a default; this overrides it for one run. The cost model names model
 * choice as *the* cost swing factor and requires it be visible rather than buried in
 * config — and editing the persona was the only way to change it, which changed it
 * for everyone and for every run after.
 */
const model = ref('')

// Reset on persona change: an override chosen against one agent's default is not a
// choice about the next one.
watch(personaId, => {
 model.value = ''
})

const effectiveModel = computed( => model.value || selected.value?.model || '')

const modelPrice = computed( => {
 const match = findSelectableModel(effectiveModel.value)
 return match ? `$${match.inputPerMTok}/$${match.outputPerMTok} per Mtok`: null
})

/**
 * Empty means the persona's own cap. A cap only an operator could change by editing the persona is a cap
 * nobody adjusts for the one expensive run that warrants it.
 */
const budgetCap = ref('')

watch(personaId, => {
 budgetCap.value = ''
})

const budgetCapUsd = computed<number | null | undefined>( => {
 if (budgetCap.value === '') return undefined
 if (budgetCap.value === 'none') return null
 const parsed = Number.parseFloat(budgetCap.value)
 return Number.isFinite(parsed) && parsed > 0 ? parsed: undefined
})

const capLabel = computed( => {
 if (budgetCapUsd.value === null) return 'uncapped — this run can spend without limit'
 if (typeof budgetCapUsd.value === 'number') return `stops at $${budgetCapUsd.value.toFixed(2)}`
 const persona = selected.value
 if (!persona) return ''
 return persona.harnessBudgetCapUsd === null
 ? 'uncapped — this agent has no limit set'
: `stops at $${persona.harnessBudgetCapUsd.toFixed(2)}`
})

/**
 * What choosing this model and cap does to a planner's roster.
 *
 * A planner cannot start a worker on a higher model tier, so moving a planner down
 * to save money can leave it with nobody to delegate to — every persona correct,
 * the whole roster empty, and nothing saying so anywhere. That was measured by
 * paying for a live run which planned nothing and replied that "the only available
 * persona is sweep-probe". The roadmap calls showing the attenuation envelope at design time
 * the composition canvas's highest-value job; this is the same insight one control
 * earlier, where the choice that causes it is actually made.
 *
 * Server-side, like every other answer about attenuation: a client that computed
 * this itself could reassure a human about a run the gate then refuses.
 */
const preview = ref<DelegationPreview | null>(null)
let previewToken = 0

watch(
 [personaId, model, budgetCap],
 => {
 preview.value = null
 if (!selected.value?.harnessPlanner) return
 const token = (previewToken += 1)
 emit(
 'preview-delegation',
 {
 personaId: personaId.value,
...(model.value === '' ? {}: { model: model.value }),
...(budgetCapUsd.value === undefined ? {}: { budgetCapUsd: budgetCapUsd.value }),
 },
 (result) => {
 // Dropped if the human has changed something since — a late answer about a
 // model nobody has selected any more is worse than none.
 if (token === previewToken) preview.value = result
 },
)
 },
 { immediate: true },
)

const rosterLabel = computed( => {
 const current = preview.value
 if (!current?.planner) return null
 const total = current.delegatable.length + current.refused.length
 if (total === 0) return 'No other personas exist to delegate to.'
 if (current.delegatable.length === 0) {
 return `This planner cannot delegate to any of the ${total} other personas — every one is refused.`
 }
 return `${current.delegatable.length} of ${total} personas are delegatable at this model and cap.`
})

/** The single most common cause, named rather than left to the inspector. */
const rosterReason = computed( => {
 const current = preview.value
 if (!current?.planner || current.refused.length === 0) return null
 const counts = new Map<string, number>
 for (const entry of current.refused) {
 for (const refusal of entry.refusals) {
 counts.set(refusal.rule, (counts.get(refusal.rule) ?? 0) + 1)
 }
 }
 const [rule, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? []
 if (!rule || !count) return null
 const because =
 rule === 'model'
 ? 'a higher model tier than this planner'
: rule === 'budget'
 ? 'a budget cap above this planner’s'
: rule === 'autoApprove'
 ? 'auto-approve, which this planner does not have'
: rule === 'tools'
 ? 'tools outside this planner’s delegation envelope'
: rule === 'depth'
 ? 'no delegation hops left below them'
: `a ${rule} refusal`
 return `${count} refused for ${because}.`
})

const submit = => {
 if (!canSubmit.value) return
 emit('start', {
 repositoryId: repositoryId.value,
 personaId: personaId.value,
 responseStyle: responseStyle.value,
 task: task.value.trim,
...(model.value === '' ? {}: { model: model.value }),
...(budgetCapUsd.value === undefined ? {}: { budgetCapUsd: budgetCapUsd.value }),
 })
 // Cleared because the next run is a different question; the repository, agent and
 // voice are preferences and deliberately survive.
 task.value = ''
}

const startLabel = computed( => {
 const persona = selected.value?.name
 const repo = props.repositories.find((r) => r.id === repositoryId.value)?.displayName
 return persona && repo ? `Start ${persona} on ${repo}`: 'Start run'
})

/** What the harness will do, read off the saved persona — not off an unsaved draft. */
const harnessSummary = (persona: AgentPersona): string => {
 // The cap is shown by `capLabel`, which knows about this run's override.
 const parts = [APPROVAL_MODE_LABEL[persona.harnessApprovalMode]]
 if (persona.harnessPlanner) parts.push('planner')
 return parts.join(' · ')
}
</script>

<template>
 <section class="launcher">
 <header class="head">
 <h3>Put an agent to work</h3>
 <p class="what">
 One agent, one repository, on its own branch. You review the diff before anything
 merges.
 </p>
 </header>

 <form class="form" @submit.prevent="submit">
 <label class="field">
 <span>Agent</span>
 <select v-model="personaId" aria-label="Agent">
 <option value="" disabled>Choose an agent…</option>
 <option v-for="persona in props.personas":key="persona.id":value="persona.id">
 {{ persona.name }} — {{ persona.description }}
 </option>
 </select>
 </label>

 <!-- The instruction itself. First, because it is the thing being decided. -->
 <label class="field">
 <span>Task</span>
 <textarea
 v-model="task"
 class="task"
 rows="3"
 aria-label="Task"
 placeholder="What should this agent do? Be specific — this is the whole instruction it gets."
 ></textarea>
 </label>

 <label class="field">
 <span>Repository</span>
 <select v-model="repositoryId" aria-label="Repository">
 <option value="" disabled>Choose a repository…</option>
 <option v-for="repo in props.repositories":key="repo.id":value="repo.id">
 {{ repo.displayName }}
 </option>
 </select>
 </label>

 <!-- the cost model: model choice is the cost swing factor, so it is on screen, not in config. -->
 <label class="field">
 <span>Model</span>
 <select v-model="model" aria-label="Model":disabled="personaId === ''">
 <option value="">
 {{ selected ? `${selected.name}'s default — ${selected.model}`: 'Agent default' }}
 </option>
 <option v-for="entry in SELECTABLE_MODELS":key="entry.id":value="entry.id">
 {{ entry.label }} — ${{ entry.inputPerMTok }}/${{ entry.outputPerMTok }} per Mtok
 </option>
 </select>
 </label>

 <!--
 The roster this model choice leaves, said under the control that decides it.
 A planner on a cheap model cannot start a worker on a higher tier, so this is
 where "correct and completely unusable" becomes visible.
 -->
 <p v-if="rosterLabel" class="roster":class="{ empty: preview?.delegatable.length === 0 }">
 {{ rosterLabel }}
 <span v-if="rosterReason"> {{ rosterReason }}</span>
 </p>

 <!-- the security model: caps are enforced, not advisory — so they belong where a run is started. -->
 <label class="field">
 <span>Spend cap</span>
 <select v-model="budgetCap" aria-label="Spend cap":disabled="personaId === ''">
 <option value="">Agent default</option>
 <option value="0.50">$0.50</option>
 <option value="1.00">$1.00</option>
 <option value="5.00">$5.00</option>
 <option value="20.00">$20.00</option>
 <option value="none">No cap</option>
 </select>
 </label>

 <!-- How much prose the run produces. Behaviour is the persona's; this is voice. -->
 <div class="field">
 <span>Voice</span>
 <div class="styles" role="radiogroup" aria-label="Response style">
 <button
 v-for="style in STYLES"
:key="style.value"
 type="button"
 class="style"
:class="{ on: responseStyle === style.value }"
 role="radio"
:aria-checked="responseStyle === style.value"
:title="style.hint"
 @click="responseStyle = style.value"
 >
 {{ style.label }}
 </button>
 </div>
 </div>
 <p class="hint">{{ styleHint }}</p>

 <button type="submit" class="go":disabled="!canSubmit">{{ startLabel }}</button>
 </form>

 <p v-if="selected" class="harness">
 {{ capLabel }}<span v-if="modelPrice"> · {{ modelPrice }}</span><br />
 {{ harnessSummary(selected) }}
 </p>

 <p v-if="props.repositories.length === 0" class="empty">
 No repository bound yet.
 <button type="button" class="link" @click="emit('open-settings')">Bind one in Settings</button>
 </p>
 </section>
</template>

<style scoped>
.roster {
 margin: -0.2rem 0 0;
 font-size: 0.72rem;
 color: var(--text-faint);
}

.roster.empty {
 color: var(--danger, #b42318);
}

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

.head {
 margin-bottom: 0.6rem;
}

h3 {
 margin: 0;
 font-size: 0.85rem;
}

.what {
 margin: 0.15rem 0 0;
 font-size: 0.72rem;
 line-height: 1.4;
 color: var(--text-faint);
}

.field {
 display: flex;
 flex-direction: column;
 gap: 0.15rem;
}

.field > span {
 font-size: 0.68rem;
 text-transform: uppercase;
 letter-spacing: 0.06em;
 color: var(--text-faint);
}

select {
 font-size: 0.82rem;
}

.task {
 padding: 0.35rem 0.4rem;
 border: 1px solid var(--border);
 border-radius: 0.35rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
 font-size: 0.82rem;
 line-height: 1.4;
 resize: vertical;
}

.styles {
 display: flex;
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
