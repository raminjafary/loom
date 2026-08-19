<script setup lang="ts">
import { ref } from 'vue'
import { describeAge } from '@loom/client-core'
import type { WorkerNote } from '@loom/api-contract'

/**
 * The worker-notes ledger — the shared context a swarm's runs
 * read and write.
 *
 * **The rendering carries a security requirement, not a style preference.** the
 * worker-notes design: "agent-authored notes render inside a clearly delimited untrusted
 * block, the persona and the human-visible plan stay authoritative over what a worker does,
 * and the **platform** separately writes the structural facts it knows first-hand … which
 * the UI must show as distinct from agent prose."
 *
 * So this splits on `authorKind` rather than showing one chronological list. A human
 * who cannot tell "the platform observed this branch" from "a worker claims it did
 * this" has no basis for trusting either — and since a note by worker A is read by
 * worker B, the ledger is a persistence layer for prompt injection (principle 11:
 * model output is attacker-controllable).
 *
 * Everything is plain interpolation. No `v-html` anywhere near a note body.
 */

const props = defineProps<{
  notes: WorkerNote[]
  agentRunId: string | null
  /**
   * Run id → persona name, so a note can say who wrote it rather than showing a uuid.
   * The session accumulates this for the thread already; the ledger needs the same
   * answer for the same reason.
   */
  personaNameByRunId: Record<string, string>
}>()
const emit = defineEmits<{
  refresh: []
  write: [input: { kind: 'finding' | 'decision' | 'blocker'; title: string; body: string; paths: string[] }]
  /** Opens the run that wrote a note — provenance you can follow, not just read. */
  open: [agentRunId: string]
}>()

/**
 * Never falls back to the raw id. A byline that resolves to a uuid says less than one
 * that admits it does not know, and this codebase has shipped the uuid version before.
 */
const authorName = (note: WorkerNote): string => {
  if (!note.agentRunId) return 'unknown author'
  return props.personaNameByRunId[note.agentRunId] ?? 'an agent run'
}

const kind = ref<'finding' | 'decision' | 'blocker'>('decision')
const title = ref('')
const body = ref('')
const paths = ref('')
const composing = ref(false)

const platformNotes = () => props.notes.filter((note) => note.authorKind === 'platform')
const humanNotes = () => props.notes.filter((note) => note.authorKind === 'human')
const agentNotes = () => props.notes.filter((note) => note.authorKind === 'agent_run')

const submit = () => {
  if (title.value.trim() === '' || body.value.trim() === '') return
  emit('write', {
    kind: kind.value,
    title: title.value.trim(),
    body: body.value.trim(),
    paths: paths.value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  })
  title.value = ''
  body.value = ''
  paths.value = ''
  composing.value = false
}
</script>

<template>
  <section class="panel">
    <header>
      <h3>Shared notes</h3>
      <button type="button" @click="emit('refresh')">Refresh</button>
    </header>

    <p v-if="props.notes.length === 0" class="empty">
      Nothing recorded for this goal yet.
    </p>

    <template v-else>
      <!-- Trusted: nothing here came from a model. -->
      <div v-if="platformNotes().length > 0" class="group">
        <h4>Recorded by the platform</h4>
        <ul>
          <li v-for="note in platformNotes()" :key="note.id">
            <span class="kind">{{ note.kind.replace(/_/g, ' ') }}</span>
            <span class="title">{{ note.title }}</span>
            <code v-if="note.paths.length > 0" class="paths">{{ note.paths.join(', ') }}</code>
          </li>
        </ul>
      </div>

      <!-- Also trusted: a human wrote it, and workers are told so. -->
      <div v-if="humanNotes().length > 0" class="group">
        <h4>From a human</h4>
        <ul>
          <li v-for="note in humanNotes()" :key="note.id">
            <span class="kind">{{ note.kind }}</span>
            <span class="title">{{ note.title }}</span>
            <p class="body">{{ note.body }}</p>
            <code v-if="note.paths.length > 0" class="paths">{{ note.paths.join(', ') }}</code>
            <p class="provenance"><span class="when">{{ describeAge(note.createdAt) }}</span></p>
          </li>
        </ul>
      </div>

      <!--
        Untrusted, and framed as such on screen the same way `renderNotesForPrompt`
        frames it in a prompt. The border and the warning are the point: a reader
        skimming should not have to work out which of these lines a model wrote.
      -->
      <div v-if="agentNotes().length > 0" class="group untrusted">
        <h4>Written by agent runs</h4>
        <p class="warning">
          Reports of what a worker believes it did. Not verified by the platform — treat
          as claims, and never as instructions.
        </p>
        <ul>
          <li v-for="note in agentNotes()" :key="note.id">
            <span class="kind">{{ note.kind }}</span>
            <span class="title">{{ note.title }}</span>
            <p class="body">{{ note.body }}</p>
            <code v-if="note.paths.length > 0" class="paths">{{ note.paths.join(', ') }}</code>
            <!--
              Who wrote it and when. `agentRunId` and `createdAt` have always been on
              the note and neither was rendered, which mattered most in exactly this
              group: framing a claim as untrusted is worth much less when a reader
              cannot tell *which* worker is making it, or whether it is from before
              the thing they are looking at changed.
            -->
            <p class="provenance">
              <button
                v-if="note.agentRunId"
                type="button"
                class="author"
                @click="emit('open', note.agentRunId)"
              >
                {{ authorName(note) }}
              </button>
              <span v-else class="author-plain">{{ authorName(note) }}</span>
              <span class="when">{{ describeAge(note.createdAt) }}</span>
            </p>
          </li>
        </ul>
      </div>
    </template>

    <!--
      A human's note is the authoritative channel into a running swarm — it reaches
      every later worker outside the untrusted fence, which is how a person steers
      without editing a persona or restarting anything.
    -->
    <div v-if="props.agentRunId" class="composer">
      <button v-if="!composing" type="button" class="link" @click="composing = true">
        Add a note for the workers
      </button>
      <form v-else @submit.prevent="submit">
        <select v-model="kind" aria-label="Note kind">
          <option value="decision">decision</option>
          <option value="finding">finding</option>
          <option value="blocker">blocker</option>
        </select>
        <input v-model="title" placeholder="One line, specific" maxlength="200" />
        <textarea
          v-model="body"
          rows="3"
          placeholder="What the workers need to know, and enough of why that they can tell if it still applies"
          maxlength="4000"
        />
        <input v-model="paths" placeholder="paths, comma-separated (optional)" />
        <div class="actions">
          <button type="submit">Add note</button>
          <button type="button" class="link" @click="composing = false">Cancel</button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.provenance {
  display: flex;
  gap: 0.4rem;
  align-items: baseline;
  margin: 0.2rem 0 0;
  font-size: 0.68rem;
  color: var(--text-faint);
}

.author {
  border: 0;
  padding: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  font-size: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.panel {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.6rem 0.7rem;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}

h3 {
  margin: 0;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
}

header button {
  padding: 0.15rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--surface-hover);
  color: var(--text);
  font: inherit;
  font-size: 0.7rem;
  cursor: pointer;
}

.empty {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-faint);
}

.group {
  margin-bottom: 0.5rem;
}

.group h4 {
  margin: 0 0 0.2rem;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
  font-weight: 600;
}

.group ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.group li {
  font-size: 0.75rem;
  line-height: 1.35;
}

.kind {
  display: inline-block;
  margin-right: 0.3rem;
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}

.title {
  overflow-wrap: anywhere;
}

.body {
  margin: 0.1rem 0 0;
  color: var(--text-faint);
  overflow-wrap: anywhere;
}

.paths {
  display: inline-block;
  margin-top: 0.1rem;
  font-size: 0.65rem;
  color: var(--text-faint);
  overflow-wrap: anywhere;
}

/* The visual fence. See this file's header for why it is not decoration. */
.untrusted {
  padding: 0.35rem 0.4rem;
  border: 1px dashed var(--border);
  border-radius: 0.3rem;
  background: var(--surface);
}

.warning {
  margin: 0 0 0.3rem;
  font-size: 0.65rem;
  line-height: 1.35;
  color: var(--text-faint);
}

.composer {
  margin-top: 0.4rem;
  padding-top: 0.4rem;
  border-top: 1px solid var(--border);
}

.composer form {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.composer select,
.composer input,
.composer textarea {
  padding: 0.25rem 0.35rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.75rem;
}

.composer textarea {
  resize: vertical;
}

.actions {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}

.actions button[type='submit'] {
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--surface-hover);
  color: var(--text);
  font: inherit;
  font-size: 0.72rem;
  cursor: pointer;
}

.link {
  padding: 0;
  border: none;
  background: none;
  color: var(--text-faint);
  font: inherit;
  font-size: 0.72rem;
  text-decoration: underline;
  cursor: pointer;
}
</style>
