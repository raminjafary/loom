<script setup lang="ts">
import { computed } from 'vue'
import type { SupervisionLedger } from '@loom/api-contract'

/**
 * How much human judgement this workspace is spending, against the work that needed it.
 *
 * The other half of the pair the sidebar already had: Spend is what the swarm cost, this is
 * what attending to it cost. A platform that measures its agents and never measures the
 * supervision they consume is only reporting half of what it takes to run.
 *
 * **There is deliberately no target and no verdict.** The sentence comes from the domain's
 * `describeSupervision`, which names what a falling ratio could mean in both directions and
 * picks neither, and this panel adds nothing to it: a ratio falling while the work rises is
 * either trust being earned or attention being withdrawn, and nothing here can tell them
 * apart. Scoring an operator on it would be optimising the thing it is supposed to measure.
 *
 * The breakdown is below the sentence rather than instead of it, because the counts alone
 * mislead in the direction people already lean — forty acts is close attention over ten runs
 * and near-abdication over four hundred.
 */
const props = defineProps<{
  ledger: SupervisionLedger | null
  /** The last read's failure — an empty ledger and a failed fetch look identical otherwise. */
  fetchError: string | null
}>()
const emit = defineEmits<{ refresh: [] }>()

/**
 * Singular and plural both, because the counts are small enough to hit one regularly and
 * "1 branch decisions" is the kind of thing a reader trusts a little less afterwards.
 */
const KINDS = [
  { key: 'approval', one: 'approval', many: 'approvals' },
  { key: 'disposition', one: 'branch decision', many: 'branch decisions' },
  { key: 'promotion', one: 'promotion', many: 'promotions' },
  { key: 'veto', one: 'veto', many: 'vetoes' },
  { key: 'envelope', one: 'envelope change', many: 'envelope changes' },
] as const

const counted = computed(() =>
  props.ledger === null
    ? []
    : KINDS.map((kind) => {
        const count = props.ledger!.byKind[kind.key]
        return { key: kind.key, count, label: count === 1 ? kind.one : kind.many }
      }).filter((kind) => kind.count > 0),
)

/**
 * The window, said plainly. A rate with no window is not a rate, and "since 3 September" is
 * the form a person can check against their own memory of the week.
 */
const since = computed(() =>
  props.ledger === null
    ? ''
    : new Date(props.ledger.since).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }),
)
</script>

<template>
  <section class="panel">
    <header>
      <h3>Supervision</h3>
      <button type="button" class="refresh" @click="emit('refresh')">Refresh</button>
    </header>

    <p v-if="fetchError" class="failed">{{ fetchError }}</p>

    <template v-else-if="ledger">
      <p class="since">since {{ since }}</p>
      <!-- The domain's sentence, unedited. This panel has no opinion to add to it. -->
      <p class="detail">{{ ledger.detail }}</p>

      <ul v-if="counted.length > 0" class="kinds">
        <li v-for="kind in counted" :key="kind.key">
          <span class="count">{{ kind.count }}</span>
          <span class="label">{{ kind.label }}</span>
        </li>
      </ul>

      <!--
        The rate's own bound, on screen rather than implied: acts the ledger did not count and
        acts the platform took itself. A reader who cannot see these has to trust that
        everything was counted, which is the one thing a measurement should never ask for.
      -->
      <p v-if="ledger.uncounted > 0 || ledger.automatic > 0" class="bound">
        <template v-if="ledger.uncounted > 0">
          {{ ledger.uncounted }} audited human
          {{ ledger.uncounted === 1 ? 'act was' : 'acts were' }} not supervision of an agent's
          work and outside this rate.
        </template>
        <template v-if="ledger.automatic > 0">
          {{ ledger.automatic }} {{ ledger.automatic === 1 ? 'act was' : 'acts were' }} the
          platform's own.
        </template>
      </p>
    </template>

    <p v-else class="detail">Nothing read yet.</p>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.6rem 0.7rem;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

h3 {
  margin: 0;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.refresh {
  padding: 0.15rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--bg);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.7rem;
  cursor: pointer;
}

.since {
  margin: 0;
  font-size: 0.7rem;
  color: var(--text-faint);
}

.detail {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--text);
}

.failed {
  margin: 0;
  font-size: 0.78rem;
  color: var(--danger, #c66);
}

.kinds {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 0.7rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.kinds li {
  display: flex;
  align-items: baseline;
  gap: 0.25rem;
  font-size: 0.75rem;
}

.kinds .count {
  font-weight: 600;
  color: var(--text);
}

.kinds .label {
  color: var(--text-muted);
}

.bound {
  margin: 0;
  font-size: 0.7rem;
  line-height: 1.45;
  color: var(--text-faint);
}
</style>
