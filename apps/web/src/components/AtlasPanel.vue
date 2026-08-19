<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AtlasEdge } from '@loom/api-contract'

/**
 * The atlas's write side, where the human act happens.
 *
 * **There is no way to propose one from here, and that is the design.** A relation
 * reaches this queue from a run that asked the atlas, opened the subject it was pointed
 * at, and found the thing really there. A form on this panel would let somebody record a
 * relation nobody checked wearing the same status as one that was — and the only thing
 * this artifact is *for* is the difference between those two.
 *
 * Three things this surface has to say that a list of rows would not:
 *
 * - **What promotion costs.** A promoted relation is rendered to every run that asks
 *   about a matching concept, above the leads, saying somebody checked. So the button
 *   says what it does rather than "Approve".
 * - **Whether anyone argued.** A proposal that went through the venue comes with a
 *   transcript; one that did not comes with one agent's word. Those are different things
 *   to decide on, and the row says which it is.
 * - **When an end has gone stale.** A map can retire a concept under a relation, and a
 *   relation whose endpoint no longer exists is not promotable — the map has withdrawn
 *   the claim it rests on.
 *
 * Every label, summary and rationale here is model-authored. Interpolated, never
 * `v-html`.
 */

const props = defineProps<{
  proposals: AtlasEdge[]
  busy?: boolean
}>()

const emit = defineEmits<{
  refresh: []
  contend: [edgeId: string]
  decide: [input: { edgeId: string; decision: 'promoted' | 'rejected'; note?: string }]
}>()

const notes = ref<Record<string, string>>({})

const RELATION_PHRASE: Record<AtlasEdge['relation'], string> = {
  same_concept: 'is the same concept as',
  analogous_to: 'is analogous to',
  contradicts: 'contradicts',
}

/**
 * Undecided first, and within that the contended ones — they are the ones with something
 * to read. Decided rows stay on the panel rather than disappearing: a rejection is the
 * only place the reason a plausible relation is wrong is written down, and hiding it is
 * how the same proposal gets made again.
 */
const RANK: Record<AtlasEdge['status'], number> = {
  contended: 0,
  proposed: 1,
  promoted: 2,
  rejected: 3,
}

const ordered = computed(() =>
  [...props.proposals].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || b.createdAt.getTime() - a.createdAt.getTime(),
  ),
)

const waiting = computed(
  () => props.proposals.filter((edge) => edge.status === 'proposed' || edge.status === 'contended')
    .length,
)

const stale = (edge: AtlasEdge) => !edge.from.live || !edge.to.live

const decide = (edge: AtlasEdge, decision: 'promoted' | 'rejected') => {
  const note = (notes.value[edge.id] ?? '').trim()
  emit('decide', { edgeId: edge.id, decision, ...(note === '' ? {} : { note }) })
  notes.value = { ...notes.value, [edge.id]: '' }
}
</script>

<template>
  <section class="atlas">
    <div class="head">
      <h4>Relations across projects</h4>
      <button type="button" class="link" :disabled="props.busy" @click="emit('refresh')">
        Refresh
      </button>
    </div>

    <p class="about">
      Agents propose these after following a lead into another project and finding the thing
      really there. Nothing acts on one until you confirm it — and once you do, every run
      asking about either concept is told, with your name on it.
    </p>

    <p v-if="proposals.length === 0" class="hint">
      Nothing proposed yet. A relation arrives when a run asks the atlas, goes and looks, and
      comes back convinced — there is no way to add one from here, on purpose.
    </p>

    <p v-else class="hint">
      {{ waiting }} waiting on you, {{ proposals.length - waiting }} decided.
    </p>

    <ul v-if="ordered.length > 0" class="rows">
      <li v-for="edge in ordered" :key="edge.id" :class="['row', edge.status]">
        <p class="claim">
          <span class="side">
            <em>{{ edge.from.subjectRef }}</em> {{ edge.from.label }}
          </span>
          <span class="rel">{{ RELATION_PHRASE[edge.relation] }}</span>
          <span class="side">
            <em>{{ edge.to.subjectRef }}</em> {{ edge.to.label }}
          </span>
        </p>

        <p class="why">{{ edge.rationale }}</p>

        <p class="meta">
          proposed by {{ edge.proposedByPersonaName || 'an agent that has since gone' }} ·
          <template v-if="edge.status === 'contended'">
            argued over in the venue — read the session before you decide
          </template>
          <template v-else-if="edge.status === 'proposed'">
            nobody has argued over it — one agent's word
          </template>
          <template v-else-if="edge.status === 'promoted'">
            <strong>confirmed by {{ edge.decidedByName || 'a human here' }}</strong>
          </template>
          <template v-else>
            <strong>rejected by {{ edge.decidedByName || 'a human here' }}</strong>
          </template>
          <template v-if="edge.decisionNote"> — {{ edge.decisionNote }}</template>
        </p>

        <!--
          A map can retire a concept under a relation. The claim this rests on has been
          withdrawn by its own source, so confirming it would put a human's name on
          something nobody believes any more.
        -->
        <p v-if="stale(edge)" class="warn">
          One end is no longer in its map — the subject has moved on from the claim this
          rests on.
        </p>

        <div v-if="edge.status === 'proposed' || edge.status === 'contended'" class="acts">
          <input
            :value="notes[edge.id] ?? ''"
            type="text"
            placeholder="why — read by whoever finds this next"
            :aria-label="`Why you decided about ${edge.from.label}`"
            @input="notes = { ...notes, [edge.id]: ($event.target as HTMLInputElement).value }"
          />
          <button
            type="button"
            class="primary"
            :disabled="props.busy || stale(edge)"
            @click="decide(edge, 'promoted')"
          >
            Confirm — every run sees this
          </button>
          <button type="button" :disabled="props.busy" @click="decide(edge, 'rejected')">
            Reject
          </button>
          <button
            v-if="edge.status === 'proposed'"
            type="button"
            class="link"
            :disabled="props.busy"
            @click="emit('contend', edge.id)"
          >
            Put it to both experts first
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.atlas {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
}

h4 {
  margin: 0;
  font-size: 0.9rem;
}

.about,
.hint {
  margin: 0;
  font-size: 0.72rem;
  color: var(--text-faint);
  line-height: 1.5;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
}

/* Decided rows stay, and recede. The reason a relation was refused is worth keeping. */
.row.promoted,
.row.rejected {
  opacity: 0.72;
}

.row.contended {
  border-color: var(--accent);
}

.claim {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.35rem;
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.5;
}

.side em {
  font-style: normal;
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  margin-right: 0.2rem;
}

.rel {
  font-size: 0.72rem;
  color: var(--text-faint);
}

.why {
  margin: 0.3rem 0 0;
  font-size: 0.75rem;
  line-height: 1.55;
}

.meta {
  margin: 0.3rem 0 0;
  font-size: 0.68rem;
  color: var(--text-faint);
}

.warn {
  margin: 0.3rem 0 0;
  font-size: 0.7rem;
  color: var(--danger, #b42318);
}

.acts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  margin: 0.45rem 0 0;
}

.acts input {
  flex: 1 1 14rem;
  min-width: 0;
  padding: 0.25rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 0.75rem;
}

button {
  padding: 0.25rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 0.73rem;
  cursor: pointer;
}

button.primary {
  border-color: var(--accent);
}

button.link {
  border: none;
  background: none;
  color: var(--accent);
  padding: 0.25rem 0.2rem;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
