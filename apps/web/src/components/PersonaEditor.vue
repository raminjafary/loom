<script setup lang="ts">
import type {
  AgentPersona,
  ApprovalMode,
  Capability,
  PersonaCapability,
  PersonaDraft,
  PersonaRevision,
  PromptTrial,
  VariantSearch,
} from '@loom/api-contract'
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
  describeRevision,
  personaHistory,
  promptWrittenByAgent,
  type PersonaFormState,
} from '@loom/client-core'
import { computed, ref, watch } from 'vue'
import ConfirmButton from './ConfirmButton.vue'

/**
 * Authoring personas.
 *
 * The product shape asks for "a persona form (name, description, model, tools, prompt)
 * writing the same markdown, with a raw-markdown toggle", and the roadmap lists it under
 * Phase 1's ship criteria. What shipped instead was the raw half alone: a textarea of YAML
 * frontmatter, with no validation, in which the way to discover that a planner may not hold
 * `Bash` was to save and read a server error.
 *
 * Two rules the form keeps, both of which are why it is not simply a set of inputs:
 *
 * - **The markdown is still the source of truth.** The form writes it, the toggle
 *   shows it, and the tab a human saves from is the one that decides what is sent.
 *   Nothing is stored that the markdown does not say.
 * - **The client never parses the format.** Coming back from the raw tab goes
 *   through `persona.parse`, which is the same parser the write path uses, so the
 *   form cannot show fields a save would not store. What the form *writes* is
 *   checked from the other end: `personaSaveDiscrepancies` compares the saved row
 *   to what was asked for and says so if they differ.
 */

const props = defineProps<{
  personas: AgentPersona[]
  capabilities: Capability[]
  attachments: PersonaCapability[]
  /**
   * Every persona's superseded prompts, workspace-wide and newest
   * first. Passed in rather than fetched here for the reason the capability lists are:
   * this component renders what a session loaded, and a component that fetched would be a
   * second place deciding when the data is stale.
   */
  revisions: PersonaRevision[]
  /**
   * What the runs say about each persona's live self-edit, by persona
   * id. Absent means nothing is being measured.
   */
  trials?: Record<string, PromptTrial>
  /**
   * The variant search running over each persona,
   * by persona id. Absent is the ordinary state.
   */
  searches?: Record<string, VariantSearch>
}>()

const emit = defineEmits<{
  'create-persona': [markdownSource: string]
  'update-persona': [input: { personaId: string; markdownSource: string }]
  'delete-persona': [personaId: string]
  /**
   * Replaces a built-in's markdown with the version this build ships.
   * The one action that resolves a `'stale'` built-in — `seedBuiltinPersonas` will not
   * touch one, because it cannot tell a tuned prompt from a row that predates the
   * recorded seed.
   */
  'reset-persona': [personaId: string]
  attach: [input: { personaId: string; capabilityId: string }]
  detach: [input: { personaId: string; capabilityId: string }]
  /** Parses a draft server-side. */
  parse: [markdownSource: string, done: (draft: PersonaDraft) => void]
  /**
   * Puts a superseded prompt back.
   *
   * The half of self-editing that makes the other half an acceptable trade: an agent
   * inside its envelope rewrites itself without asking, and a human who disagrees undoes
   * it in one gesture.
   */
  'revert-persona': [input: { personaId: string; revisionId: string }]
  /** Ends a trial by keeping the agent's edit. */
  'keep-revision': [input: { personaId: string; revisionId: string }]
  /**
   * Ends a variant search: `variantId` is the
   * candidate a human took, and null means they took none.
   *
   * Promoting is the only gesture in the loop that writes a prompt. Everything else it does
   * — proposing, dealing runs out, ranking — a run could already do inside its envelope;
   * making a candidate what every future run is told is a person's call.
   */
  'settle-search': [input: { personaId: string; variantId: string | null }]
}>()

type Mode = 'closed' | 'create' | 'edit'
type Tab = 'form' | 'markdown'

const mode = ref<Mode>('closed')
const tab = ref<Tab>('form')
const editingId = ref('')
const form = ref<PersonaFormState>({ ...EMPTY_PERSONA_FORM })
const rawMarkdown = ref('')
const rawProblems = ref<string[]>([])
const savedDiscrepancies = ref<string[]>([])

const EFFORTS = ['low', 'medium', 'high'] as const

/**
 * Labels and hints for the approval modes, duplicated from `@loom/domain`'s
 * `describeApprovalMode` for the reason every other catalogue here is: this app
 * depends on the contract, not the domain. What each mode *does* lives in the
 * domain, next to the gate that applies it.
 */
const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'accept-edits', 'auto']

const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = {
  ask: 'asks before risky calls',
  'accept-edits': 'takes file edits, asks before a shell',
  auto: 'runs unattended',
}

const APPROVAL_MODE_HINT: Record<ApprovalMode, string> = {
  ask: 'Every risky call waits for a human.',
  'accept-edits': 'Writes inside its own clone go through; Bash still asks. The path boundary applies either way.',
  auto: 'Nothing is asked. Only for a persona you trust to run with nobody watching.',
}

const editingPersona = computed(
  () => props.personas.find((persona) => persona.id === editingId.value) ?? null,
)

/** This persona's superseded prompts, newest first. Empty until something replaced one. */
const history = computed(() =>
  editingId.value === '' ? [] : personaHistory(props.revisions, editingId.value),
)

/** The trial on the persona being edited, if one of its edits is still being measured. */
const trial = computed(() =>
  editingId.value === '' ? null : (props.trials?.[editingId.value] ?? null),
)

/**
 * Whether to show the verification column at all.
 *
 * Hidden when neither arm has a failing check — in a repository with no definition of
 * done that is every trial, and a permanent "0 failed checks" against "0 failed checks"
 * would read as a measurement where there is none.
 */
const failingChecksShown = computed(() =>
  (trial.value?.arms ?? []).some((arm) => arm.verificationFailed > 0),
)

/** The search on the persona being edited, if one is running. */
const search = computed(() =>
  editingId.value === '' ? null : (props.searches?.[editingId.value] ?? null),
)

/**
 * A candidate's body and reason, by id — an arm carries only ids and numbers.
 *
 * Null is the incumbent, and the caller labels it: the prompt in use is not a candidate,
 * and a row that read "candidate: (none)" would hide the one arm a promotion displaces.
 */
/**
 * The screen row for one arm. Null when this search has no screen at all, which the
 * markup renders as a sentence rather than as "0 admitted" — see the schema's note.
 */
const screenArmOf = (variantId: string | null) =>
  search.value?.screen?.arms.find((arm) => arm.variantId === variantId) ?? null

const candidateOf = (variantId: string | null) =>
  variantId === null
    ? null
    : (search.value?.candidates.find((candidate) => candidate.variantId === variantId) ?? null)

const STANDING_LABEL: Record<string, string> = {
  undecided: 'not measured yet',
  better: 'ahead of the prompt in use',
  worse: 'behind the prompt in use',
  'no-better': 'no different',
}

const VERDICT_LABEL: Record<PromptTrial['verdict'], string> = {
  undecided: 'Still measuring',
  better: 'The agent\'s version is doing better',
  worse: 'The agent\'s version is doing worse',
  'no-better': 'No measurable difference',
}

const existingNames = computed(() => props.personas.map((persona) => persona.name))

const formProblems = computed(() =>
  personaFormProblems(form.value, {
    existingNames: existingNames.value,
    editing: mode.value === 'edit',
  }),
)

/** The markdown a save would send, from whichever tab is in front. */
const outgoingMarkdown = computed(() =>
  tab.value === 'markdown' ? rawMarkdown.value : personaFormToMarkdown(form.value),
)

const problems = computed(() => (tab.value === 'markdown' ? rawProblems.value : formProblems.value))

const close = () => {
  mode.value = 'closed'
  editingId.value = ''
  rawProblems.value = []
}

const startCreating = () => {
  if (mode.value === 'create') return close()
  mode.value = 'create'
  tab.value = 'form'
  editingId.value = ''
  form.value = { ...EMPTY_PERSONA_FORM }
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
const showMarkdown = () => {
  rawMarkdown.value = personaFormToMarkdown(form.value)
  rawProblems.value = []
  tab.value = 'markdown'
}

const showForm = () => {
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
  validateTimer = setTimeout(() => {
    emit('parse', source, (draft) => {
      rawProblems.value = draft.problems
    })
  }, 300)
})

const busy = ref(false)

const submit = () => {
  if (busy.value || problems.value.length > 0) return
  const markdown = outgoingMarkdown.value
  if (!markdown.trim()) return
  busy.value = true
  savedDiscrepancies.value = []
  const intended = form.value
  const wasCreating = mode.value === 'create'
  if (wasCreating) emit('create-persona', markdown)
  else emit('update-persona', { personaId: editingId.value, markdownSource: markdown })
  // Released on the next list update, or after a beat if the save failed and the
  // list never changes — a disabled button that never re-enables is worse than a
  // second submit the server refuses by name collision.
  setTimeout(() => (busy.value = false), 1_500)
  if (tab.value === 'form') pendingCheck.value = { name: intended.name.trim(), intended }
  close()
}

/**
 * The round-trip assertion. A save sends markdown this client wrote; when the
 * stored row arrives, what it parsed to is compared against what was asked for.
 * Only meaningful for a form save — a raw-tab save has no field-level intent to
 * compare against, since the text *is* the intent.
 */
const pendingCheck = ref<{ name: string; intended: PersonaFormState } | null>(null)
watch(
  () => props.personas,
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

/**
 * The self-modification envelope.
 *
 * **Off is the state with no envelope, and the copy has to say what that means.** An
 * operator reading an empty ceiling naturally reads "unrestricted"; it means the opposite —
 * a persona with no envelope may not rewrite itself at all. Every other off-by-default
 * control in this app is a restriction being lifted; this one is a permission being
 * granted, and a checkbox that did not say so would teach exactly the wrong model.
 *
 * Turning it on seeds the ceiling from what the persona already is, rather than from
 * nothing. An envelope narrower than its own persona is refused on save, so seeding empty
 * would hand the operator a form that cannot be saved and no clue why — and seeding from
 * the persona is also the honest default: "may become what it already is" is a real,
 * useful envelope (the tier 1, prompt edits only).
 */
const toggleEnvelope = () => {
  form.value =
    form.value.envelope === null
      ? {
          ...form.value,
          envelope: {
            tools: [...form.value.tools, ...(form.value.planner ? form.value.delegates : [])],
            model: form.value.model,
            budgetCapUsd: form.value.budgetCapUsd,
            capabilities: [],
            subagentDepth: null,
            approvalMode: form.value.approvalMode,
          },
        }
      : { ...form.value, envelope: null }
}

const toggleEnvelopeTool = (tool: string) => {
  const current = form.value.envelope
  if (!current) return
  const has = current.tools.includes(tool)
  form.value = {
    ...form.value,
    envelope: {
      ...current,
      tools: has ? current.tools.filter((entry) => entry !== tool) : [...current.tools, tool],
    },
  }
}

const patchEnvelope = (patch: Partial<NonNullable<PersonaFormState['envelope']>>) => {
  const current = form.value.envelope
  if (!current) return
  form.value = { ...form.value, envelope: { ...current, ...patch } }
}

const numberOrNull = (value: string): number | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

const attachedTo = (personaId: string) =>
  props.attachments
    .filter((attachment) => attachment.personaId === personaId)
    .map((attachment) => ({
      attachment,
      capability: props.capabilities.find((c) => c.id === attachment.capabilityId) ?? null,
    }))

const unattached = computed(() => {
  if (!editingId.value) return []
  const attached = new Set(
    props.attachments
      .filter((attachment) => attachment.personaId === editingId.value)
      .map((attachment) => attachment.capabilityId),
  )
  return props.capabilities.filter((capability) => !attached.has(capability.id))
})

const attachTarget = ref('')

const doAttach = () => {
  if (!attachTarget.value || !editingId.value) return
  emit('attach', { personaId: editingId.value, capabilityId: attachTarget.value })
  attachTarget.value = ''
}

const harnessSummary = (persona: AgentPersona): string => {
  const parts = [
    APPROVAL_MODE_LABEL[persona.harnessApprovalMode],
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
      <li v-for="persona in props.personas" :key="persona.id">
        <div class="meta">
          <strong>{{ persona.name }}</strong>
          <span class="model">{{ persona.model }}</span>
          <span class="harness">{{ harnessSummary(persona) }}</span>
          <span v-if="attachedTo(persona.id).length > 0" class="caps">
            {{ attachedTo(persona.id).length }} capability(s)
          </span>
          <!--
            Said out loud, because the consequence is not cosmetic: the shipped
            `planner` once carried `tools: []`, and a workspace holding that version
            stalls every sub-planner on the approval SLA.
          -->
          <span v-if="persona.builtinStatus === 'stale'" class="stale">
            differs from the shipped version
          </span>
          <!--
            An agent wrote the prompt this persona is running with.
            On the row rather than only inside the editor, because a self-edit nobody
            notices until they happen to open the right persona is the "correct and
            invisible" failure this project has shipped three times.
          -->
          <span v-if="promptWrittenByAgent(props.revisions, persona.id)" class="self-edited">
            prompt rewritten by an agent
          </span>
        </div>
        <div class="row-actions">
          <button type="button" class="link" @click="startEditing(persona)">Edit</button>
          <ConfirmButton
            v-if="persona.builtinStatus === 'stale'"
            variant="link"
            label="Reset"
            confirm-label="Discard this version and take the shipped one"
            @confirm="emit('reset-persona', persona.id)"
          />
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
      {{ mode === 'create' ? 'Cancel' : '+ New persona' }}
    </button>

    <p v-if="savedDiscrepancies.length > 0" class="discrepancy" role="alert">
      <strong>Saved, but not as written.</strong>
      The stored persona differs from what this form asked for — the markdown it wrote
      does not parse back to the same settings:
      <span v-for="line in savedDiscrepancies" :key="line" class="line">{{ line }}</span>
    </p>

    <form v-if="mode !== 'closed'" class="sheet" @submit.prevent="submit">
      <header class="sheet-head">
        <span class="what">
          {{ mode === 'edit' ? `Editing ${editingPersona?.name ?? ''}` : 'New persona' }}
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
              <option v-for="entry in SELECTABLE_MODELS" :key="entry.id" :value="entry.id">
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
            <!--
              Three states, not a checkbox. The
              boolean this replaced could only say "ask about everything" or "ask
              about nothing", and the middle is what an operator running a
              twenty-file edit actually wants.
            -->
            <label>
              <span>Approvals</span>
              <select
                :value="form.approvalMode"
                @change="
                  form = {
                    ...form,
                    approvalMode: ($event.target as HTMLSelectElement).value as ApprovalMode,
                  }
                "
              >
                <option v-for="mode in APPROVAL_MODES" :key="mode" :value="mode">
                  {{ APPROVAL_MODE_LABEL[mode] }}
                </option>
              </select>
              <small>{{ APPROVAL_MODE_HINT[form.approvalMode] }}</small>
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
                <option v-for="effort in EFFORTS" :key="effort" :value="effort">
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
            <label v-for="entry in SELECTABLE_TOOLS" :key="entry.name" class="chip">
              <input
                type="checkbox"
                :checked="form.delegates.includes(entry.name)"
                @change="toggleDelegate(entry.name)"
              />
              <span>{{ entry.name }}</span>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Self-modification envelope</legend>
          <label class="check">
            <input
              type="checkbox"
              :checked="form.envelope !== null"
              @change="toggleEnvelope()"
            />
            <span>This persona may change itself, within a ceiling</span>
          </label>
          <!--
            The copy carries the whole of the default. An operator who reads "no
            envelope" as "unrestricted" has it backwards, and nothing else in this app
            works that way — so it is said rather than implied.
          -->
          <p v-if="form.envelope === null" class="hint">
            Off. With no envelope this persona cannot rewrite its own prompt, tools or
            settings at all — an absent ceiling is no permission, not an unlimited one.
          </p>
          <template v-else>
            <p class="hint">
              The most this persona may ever become. It may change itself freely inside this
              and can never widen it — only you can, here. Separate from what it holds
              today: this is the ceiling, not the current setting.
            </p>
            <div class="chips">
              <label
                v-for="entry in SELECTABLE_TOOLS"
                :key="`env-${entry.name}`"
                class="chip"
                :class="{ acting: entry.acting }"
              >
                <input
                  type="checkbox"
                  :checked="form.envelope.tools.includes(entry.name)"
                  @change="toggleEnvelopeTool(entry.name)"
                />
                <span>{{ entry.name }}</span>
              </label>
            </div>
            <div class="grid">
              <label>
                <span>Model ceiling</span>
                <select
                  :value="form.envelope.model ?? ''"
                  @change="
                    patchEnvelope({
                      model: ($event.target as HTMLSelectElement).value || null,
                    })
                  "
                >
                  <option value="">no ceiling</option>
                  <option v-for="option in SELECTABLE_MODELS" :key="option.id" :value="option.id">
                    {{ option.label }}
                  </option>
                </select>
              </label>
              <label>
                <span>Spend ceiling (USD)</span>
                <input
                  :value="form.envelope.budgetCapUsd ?? ''"
                  type="number"
                  min="0"
                  step="0.5"
                  placeholder="uncapped"
                  @input="
                    patchEnvelope({
                      budgetCapUsd: Number(($event.target as HTMLInputElement).value) || null,
                    })
                  "
                />
              </label>
              <label>
                <span>Widest approvals</span>
                <select
                  :value="form.envelope.approvalMode ?? ''"
                  @change="
                    patchEnvelope({
                      approvalMode:
                        (($event.target as HTMLSelectElement).value as
                          | 'ask'
                          | 'accept-edits'
                          | 'auto') || null,
                    })
                  "
                >
                  <option value="">no ceiling</option>
                  <option value="ask">asks before risky calls</option>
                  <option value="accept-edits">accepts edits</option>
                  <option value="auto">runs unattended</option>
                </select>
              </label>
              <label>
                <span>Subagent depth</span>
                <input
                  :value="form.envelope.subagentDepth ?? ''"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="no ceiling"
                  @input="
                    patchEnvelope({
                      subagentDepth:
                        ($event.target as HTMLInputElement).value === ''
                          ? null
                          : Number(($event.target as HTMLInputElement).value),
                    })
                  "
                />
              </label>
            </div>
          </template>
        </fieldset>

        <fieldset v-if="mode === 'edit'">
          <legend>Capabilities</legend>
          <p v-if="attachedTo(editingId).length === 0 && unattached.length === 0" class="hint">
            None registered. Register an MCP server or a skill on the Capabilities tab first.
          </p>
          <ul v-if="attachedTo(editingId).length > 0" class="attached">
            <li v-for="row in attachedTo(editingId)" :key="row.attachment.capabilityId">
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
              <option v-for="capability in unattached" :key="capability.id" :value="capability.id">
                {{ capability.name }} ({{ capability.kind }})
              </option>
            </select>
            <button type="button" class="link" :disabled="!attachTarget" @click="doAttach">
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
        <li v-for="problem in problems" :key="problem">{{ problem }}</li>
      </ul>

      <div class="buttons">
        <button type="submit" :disabled="busy || problems.length > 0">
          {{ mode === 'edit' ? 'Save changes' : 'Save persona' }}
        </button>
        <button type="button" class="link" @click="close">Cancel</button>
      </div>

      <!--
        The prompt's history, above nothing and below the save
        because it is a record rather than an action — but the *revert* in it is the
        thing that makes an agent editing itself without asking an acceptable trade.
        Rendered as whole documents rather than parsed: this client does not read the
        persona format, which is the rule the raw tab follows for the same reason.
      -->
      <!--
        The measurement, above the history rather than inside it. It is
        the thing that decides what a human does with the entry below it, and this
        project has three times shipped the answer below the controls.
      -->
      <section v-if="mode === 'edit' && trial" class="trial" :class="trial.verdict">
        <h4>{{ VERDICT_LABEL[trial.verdict] }}</h4>
        <p class="detail">{{ trial.detail }}</p>
        <ul class="arms">
          <li v-for="arm in trial.arms" :key="arm.arm">
            <strong>{{ arm.arm === 'revised' ? "the agent's version" : 'the one it replaced' }}</strong>
            <span>{{ arm.merged }} merged of {{ arm.decided }} finished</span>
            <!--
              The repository's definition of done, per arm. Shown even
              at zero on an arm whose sibling has failures, so "0 failed" is a fact a human
              reads rather than a gap they interpret — the same reason `not_run` is a
              recorded check status rather than an omitted one.
            -->
            <span v-if="failingChecksShown" :class="{ broke: arm.verificationFailed > 0 }">
              {{ arm.verificationFailed }} failed checks<template v-if="arm.failingCheck">
                — mostly {{ arm.failingCheck }}</template
              >
            </span>
            <span v-if="arm.decided > 0">${{ arm.meanCostUsd.toFixed(4) }} a run</span>
          </li>
        </ul>
        <div class="trial-actions">
          <button
            type="button"
            class="link"
            @click="emit('keep-revision', { personaId: editingId, revisionId: trial.revisionId })"
          >
            Keep it
          </button>
          <ConfirmButton
            variant="link"
            label="Restore the old one"
            confirm-label="Put the previous prompt back"
            @confirm="
              emit('revert-persona', { personaId: editingId, revisionId: trial.revisionId })
            "
          />
        </div>
      </section>

      <!--
        The search, above the history for the same
        reason the trial is: it decides what a human does next, and the two buttons that
        end it are here rather than under the older list.
      -->
      <section v-if="mode === 'edit' && search" class="trial search">
        <h4>{{ search.leader ? 'A candidate is ahead' : 'Trying several prompts' }}</h4>
        <p class="detail">{{ search.detail }}</p>
        <!--
          The held-out screen. Above the arms because it is upstream of them: a candidate
          the screen refused has no arm, so a reader who met an empty row first would be looking
          for a measurement that was deliberately never taken.

          The set's version and its counts are shown rather than summarised — the "no
          silent truncation" is only worth anything if the number that was left out reaches the
          person reading the score.
        -->
        <p v-if="search.screen" class="detail screen-detail">
          Screened against held-out set v{{ search.screen.replaySetVersion }}, before any live
          run was spent: {{ search.screen.detail }}
        </p>
        <p v-else class="detail screen-detail">
          Not screened against held-out work — this persona has too little decided history to
          build a set from, so the arms below are the only measurement.
        </p>
        <ul class="arms">
          <li v-for="arm in search.arms" :key="arm.variantId ?? 'incumbent'">
            <strong>{{
              arm.variantId === null ? 'the prompt in use' : `candidate ${candidateOf(arm.variantId)?.rationale || ''}`
            }}</strong>
            <span>{{ arm.merged }} merged of {{ arm.decided }} finished</span>
            <span v-if="arm.verificationFailed > 0" class="broke">
              {{ arm.verificationFailed }} failed checks<template v-if="arm.failingCheck">
                — mostly {{ arm.failingCheck }}</template
              >
            </span>
            <span v-if="arm.decided > 0">${{ arm.meanCostUsd.toFixed(4) }} a run</span>
            <span v-if="arm.variantId !== null" class="standing">{{
              STANDING_LABEL[arm.standing]
            }}</span>
            <!--
              What the screen said, and why the arm above may be empty. `pending` is shown for
              the reason a pending verification is shown on an Inbox card: a blank where a
              verdict is coming reads as a verdict.
            -->
            <span
              v-if="screenArmOf(arm.variantId)"
              class="screen"
              :class="screenArmOf(arm.variantId)!.decision ?? 'screen-pending'"
            >
              <template v-if="screenArmOf(arm.variantId)!.pending > 0">
                screening — {{ screenArmOf(arm.variantId)!.pending }} of
                {{ search.screen!.itemCount }} held-out items still running
              </template>
              <template v-else>
                held out: {{ screenArmOf(arm.variantId)!.passed }} passed,
                {{ screenArmOf(arm.variantId)!.failed }} failed<template
                  v-if="screenArmOf(arm.variantId)!.notScored > 0"
                  >, {{ screenArmOf(arm.variantId)!.notScored }} not scored</template
                >
              </template>
            </span>
            <p v-if="screenArmOf(arm.variantId)?.reason" class="hint screen-reason">
              {{ screenArmOf(arm.variantId)!.reason }}
            </p>
            <!--
              The candidate's own text, because promoting one is agreeing to it. A panel
              that showed only its score would be asking a human to approve a document
              they had not read.
            -->
            <details v-if="arm.variantId !== null">
              <summary>read it</summary>
              <pre>{{ candidateOf(arm.variantId)?.body }}</pre>
            </details>
            <!--
              A rejected candidate can still be promoted, and that is deliberate: the screen
              gates whether the platform *measures* a candidate, never whether a human may
              choose it. The reason it was refused an arm is printed above, so the
              choice is an informed one rather than a hidden one.
            -->
            <ConfirmButton
              v-if="arm.variantId !== null"
              variant="link"
              label="Promote"
              confirm-label="Make this the prompt"
              @confirm="
                emit('settle-search', { personaId: editingId, variantId: arm.variantId })
              "
            />
          </li>
        </ul>
        <!--
          The second opinion, and the label is load-bearing: a verdict shown next to a
          measurement will be read as part of it unless the page says otherwise, and the self-improvement loop
          is explicit that fitness is run disposition and never a model's assessment.
        -->
        <div v-if="search.verifier" class="verdict">
          <strong>A second opinion, counted in nothing:</strong>
          <span>{{ search.verifier.detail }}</span>
          <blockquote>{{ search.verifier.reason }}</blockquote>
        </div>
        <div class="trial-actions">
          <ConfirmButton
            variant="link"
            label="Discard the search"
            confirm-label="Keep the prompt it has"
            @confirm="emit('settle-search', { personaId: editingId, variantId: null })"
          />
        </div>
      </section>

      <section v-if="mode === 'edit' && history.length > 0" class="history">
        <h4>Earlier prompts</h4>
        <p class="hint">
          What this persona said before. Each entry is the version that was replaced, so
          restoring one puts that text back and records the swap as its own entry.
        </p>
        <ul>
          <li v-for="revision in history" :key="revision.id">
            <div class="revision-head">
              <span :class="{ by: true, agent: revision.replacedByKind === 'agent_run' }">
                {{ describeRevision(revision) }}
              </span>
              <ConfirmButton
                variant="link"
                label="Restore"
                confirm-label="Put this prompt back"
                @confirm="
                  emit('revert-persona', { personaId: editingId, revisionId: revision.id })
                "
              />
            </div>
            <p v-if="revision.rationale" class="why">{{ revision.rationale }}</p>
            <pre>{{ revision.markdownSource }}</pre>
          </li>
        </ul>
      </section>
    </form>
  </div>
</template>

<style scoped>
.trial {
  margin-top: 1rem;
  border: 1px solid var(--line, #2a2a2a);
  border-left: 3px solid var(--accent, #7aa2f7);
  border-radius: 4px;
  padding: 0.6rem;
}

.trial.worse {
  border-left-color: var(--danger, #f7768e);
}

.trial h4 {
  margin: 0 0 0.25rem;
  font-size: 0.85rem;
}

.trial .detail {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  opacity: 0.9;
}

.trial .arms {
  margin: 0 0 0.5rem;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.2rem;
  font-size: 0.8rem;
}

.trial .arms li {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.trial .arms .broke {
  color: var(--danger, #f7768e);
}

.trial.search .arms li {
  align-items: baseline;
}

.trial.search .standing {
  opacity: 0.75;
}

/*
  The screen. `rejected` is the only state that gets the danger colour, because it is
  the only one that means a candidate was refused something — `not scored` and `pending` are
  states of the measurement, not verdicts about a prompt.
*/
.trial.search .screen {
  opacity: 0.85;
}

.trial.search .screen.rejected {
  color: var(--danger, #f7768e);
  opacity: 1;
}

.trial.search .screen.admitted {
  color: var(--ok, #9ece6a);
  opacity: 1;
}

.trial.search .screen-reason,
.trial.search .screen-detail {
  grid-column: 1 / -1;
  margin: 0.15rem 0 0;
}

.trial.search .verdict {
  margin: 0 0 0.5rem;
  padding: 0.4rem 0.6rem;
  border-left: 2px solid var(--line, #2a2a2a);
  font-size: 0.8rem;
  display: grid;
  gap: 0.2rem;
}

.trial.search .verdict blockquote {
  margin: 0;
  opacity: 0.8;
}

.trial.search pre {
  white-space: pre-wrap;
  margin: 0.35rem 0 0;
  font-size: 0.75rem;
  opacity: 0.85;
}

.trial-actions {
  display: flex;
  gap: 0.75rem;
}

.self-edited {
  color: var(--accent, #7aa2f7);
}

.history {
  margin-top: 1rem;
  border-top: 1px solid var(--line, #2a2a2a);
  padding-top: 0.75rem;
}

.history h4 {
  margin: 0 0 0.25rem;
  font-size: 0.85rem;
}

.history ul {
  margin: 0.5rem 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.75rem;
}

.history li {
  border: 1px solid var(--line, #2a2a2a);
  border-radius: 4px;
  padding: 0.5rem;
}

.revision-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.revision-head .agent {
  color: var(--accent, #7aa2f7);
}

.history .why {
  margin: 0.25rem 0 0.5rem;
  font-size: 0.85rem;
  opacity: 0.85;
}

.history pre {
  margin: 0;
  /* A superseded prompt is a whole document; it scrolls rather than stretching the sheet. */
  max-height: 12rem;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 0.8rem;
  opacity: 0.8;
}

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

.stale {
  font-size: 0.7rem;
  color: var(--danger, #b42318);
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

.discrepancy .line {
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
