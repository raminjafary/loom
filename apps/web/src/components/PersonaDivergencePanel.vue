<script setup lang="ts">
import { ref, watch } from 'vue'
import type { PersonaDivergence } from '@loom/client-core'

/**
 * Where a persona's humans and its repository's checks disagree.
 *
 * Two directions, kept apart because they are different evidence: a branch whose checks
 * passed and a person discarded, and a branch whose checks failed and a person merged
 * anyway. The first says the definition of done is missing something a reviewer can see;
 * the second says it is testing something that did not matter here. Neither is a defect.
 *
 * **Nothing here scores anything.** The sentence is the domain's `describeDivergence`, which
 * writes prose rather than a number for exactly this reason: a platform that treated "the
 * human discarded a passing branch" as a mistake would be grading a review.
 *
 * The denominator is *comparable* runs — those with both a verdict and a disposition — not
 * decided runs. A run nobody ruled on cannot disagree with anything, and counting it would
 * make a repository with no checks look like one whose humans always agree.
 */
const props = defineProps<{
  personas: { id: string; name: string }[]
  read: (personaId: string) => Promise<PersonaDivergence | null>
  /** A callback rather than an emit — see `SettingsOverlay`'s `openRun`. */
  open: (agentRunId: string) => void
}>()

const personaId = ref('')
const report = ref<PersonaDivergence | null>(null)
const loading = ref(false)
const asked = ref(false)

watch(personaId, async (next) => {
  report.value = null
  asked.value = false
  if (next === '') return
  loading.value = true
  try {
    report.value = await props.read(next)
    asked.value = true
  } finally {
    loading.value = false
  }
})

const KIND_LABEL: Record<string, string> = {
  'passed-and-discarded': 'passed, discarded',
  'failed-and-merged': 'failed, merged',
}
</script>

<template>
  <section class="panel">
    <h3>Disagreement</h3>
    <p class="lead">
      Where this agent's branches were ruled on twice and the two rulings differed. Not a
      score — a disagreement is not a mistake by either side.
    </p>

    <label class="field">
      <span>Agent</span>
      <select v-model="personaId" aria-label="Persona to read disagreement for">
        <option value="">Choose an agent…</option>
        <option v-for="persona in props.personas" :key="persona.id" :value="persona.id">
          {{ persona.name }}
        </option>
      </select>
    </label>

    <p v-if="loading" class="detail">Reading…</p>

    <template v-else-if="report">
      <!-- The domain's sentence, unedited: it carries the rate, the denominator and the lean. -->
      <p class="detail">{{ report.detail }}</p>

      <ul v-if="report.runs.length > 0" class="runs">
        <li v-for="entry in report.runs" :key="entry.runId">
          <button type="button" class="run" @click="props.open(entry.runId)">
            <span class="kind" :class="entry.kind">{{ KIND_LABEL[entry.kind] ?? entry.kind }}</span>
            <span class="task">{{ entry.task }}</span>
            <span v-if="entry.failingCheck" class="check">{{ entry.failingCheck }}</span>
          </button>
        </li>
      </ul>
      <!--
        The list is bounded and the counts above are not, so a reader who sees five rows under
        a sentence saying forty is not looking at a contradiction.
      -->
      <p v-if="report.runs.length > 0" class="bound">
        The newest {{ report.runs.length }}, out of
        {{ report.passedAndDiscarded + report.failedAndMerged }}.
      </p>
    </template>

    <p v-else-if="asked" class="detail">Nothing to show for that agent.</p>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--surface);
}

h3 {
  margin: 0;
  font-size: 0.85rem;
}

.lead {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--text-muted);
}

.field {
  display: flex;
  max-width: 22rem;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.72rem;
  color: var(--text-muted);
}

.detail {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--text);
}

.runs {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.run {
  display: flex;
  width: 100%;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 0.75rem;
  text-align: left;
  cursor: pointer;
}

/*
  Both directions are marked, and neither is marked as wrong: one is the checks being narrower
  than a reviewer, the other is a reviewer being narrower than the checks.
*/
.kind {
  flex: none;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-muted);
}

.task {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check {
  flex: none;
  font-family: ui-monospace, monospace;
  font-size: 0.68rem;
  color: var(--text-faint);
}

.bound {
  margin: 0;
  font-size: 0.7rem;
  color: var(--text-faint);
}
</style>
