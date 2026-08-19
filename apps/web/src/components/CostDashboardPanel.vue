<script setup lang="ts">
import { dominantModel, meanRunUsd, spendByModel, spendByPersona, spendByThread } from '@loom/client-core'
import { computed } from 'vue'
import type { CostSummary } from '@loom/api-contract'

/**
 * The cost dashboard.
 *
 * Distinct from `RunTreePanel`, which rolls up **one tree**: this is the workspace, and the
 * difference is the point. A tree answers "what did this goal cost"; the cost model asks
 * what the workspace is costing and *where the money goes* — "Cursor's 8x swing came from
 * worker model choice, so it must be visible, not buried in config".
 *
 * So model is the first grouping shown, not the last. Persona is second, carrying the
 * model each one actually ran on, because a persona is the thing a human can go and
 * change.
 *
 * Every figure is spend the egress proxy metered. Nothing here re-prices
 * anything from a token count — a dashboard that did would be a second answer quietly
 * disagreeing with the one budget caps are enforced against.
 *
 * The shaping lives in `client-core` so a TUI renders the same numbers.
 */

const props = defineProps<{
  summary: CostSummary | null
  windowHours: number | null
  /** The last spend fetch's failure — see AgentSnapshot.fetchErrors. */
  fetchError: string | null
}>()
const emit = defineEmits<{
  refresh: []
  window: [hours: number | null]
  /**
   * The drill-down this panel was missing. A human sees the run that cost $14 and
   * the id is already on the payload (`topRuns[].agentRunId`) — it just had nothing
   * attached to it, so the single highest-value question the dashboard raises was
   * also the one place it could not answer.
   */
  open: [agentRunId: string]
}>()

const byModel = computed(() => (props.summary ? spendByModel(props.summary) : []))
const byPersona = computed(() => (props.summary ? spendByPersona(props.summary) : []))
const byThread = computed(() => (props.summary ? spendByThread(props.summary) : []))
const mean = computed(() => (props.summary ? meanRunUsd(props.summary) : null))
const dominant = computed(() => (props.summary ? dominantModel(props.summary) : null))

const WINDOWS: { label: string; hours: number | null }[] = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: 'All', hours: null },
]

const money = (usd: number) => `$${usd.toFixed(4)}`
const percent = (share: number) => `${Math.round(share * 100)}%`
</script>

<template>
  <section class="panel">
    <header>
      <h3>Cost</h3>
      <div class="controls">
        <button
          v-for="option in WINDOWS"
          :key="option.label"
          type="button"
          class="window"
          :class="{ active: option.hours === windowHours }"
          @click="emit('window', option.hours)"
        >
          {{ option.label }}
        </button>
        <button type="button" @click="emit('refresh')">Refresh</button>
      </div>
    </header>

    <!--
      Three states, not one. `!summary` used to conflate "not fetched yet", "the
      fetch failed" and "genuinely zero spend" into a sentence that only the third
      makes true.
    -->
    <p v-if="props.fetchError" class="failed">
      Could not load spend — <strong>{{ props.fetchError }}</strong>
    </p>
    <p v-else-if="!summary" class="empty">No spend recorded yet.</p>

    <template v-else>
      <div class="totals">
        <span class="big">{{ money(summary.totals.totalUsd) }}</span>
        <span class="meta">
          {{ summary.totals.runCount }} run<span v-if="summary.totals.runCount !== 1">s</span>
          <template v-if="mean !== null"> · {{ money(mean) }} mean</template>
        </span>
      </div>

      <!--
        Silent unless one model genuinely dominates (see `dominantModel`). A headline
        that always says something is a headline people stop reading.
      -->
      <p v-if="dominant" class="finding">
        {{ percent(dominant.share) }} of spend is <strong>{{ dominant.label }}</strong
        >. Model choice is set per persona.
      </p>

      <!--
        Model first: the cost model names it as the swing factor, and unlike a persona a model's
        price is a fact rather than a setting someone may have since changed.
      -->
      <h4>By model</h4>
      <ol class="rows">
        <li v-for="row in byModel" :key="row.label">
          <span class="bar" :style="{ width: `${Math.max(row.share * 100, 1)}%` }" aria-hidden="true" />
          <span class="label">{{ row.label }}</span>
          <span class="runs">{{ row.runCount }}</span>
          <span class="usd">{{ money(row.totalUsd) }}</span>
          <span class="share">{{ percent(row.share) }}</span>
        </li>
      </ol>

      <h4>By persona</h4>
      <ol class="rows">
        <li v-for="row in byPersona" :key="`${row.label}/${row.sublabel}`">
          <span class="bar" :style="{ width: `${Math.max(row.share * 100, 1)}%` }" aria-hidden="true" />
          <!-- Plain interpolation, never v-html: a persona name is operator text. -->
          <span class="label">{{ row.label }}</span>
          <span class="sub">{{ row.sublabel }}</span>
          <span class="runs">{{ row.runCount }}</span>
          <span class="usd">{{ money(row.totalUsd) }}</span>
        </li>
      </ol>

      <h4>By channel</h4>
      <ol class="rows">
        <li v-for="row in byThread" :key="row.label">
          <span class="bar" :style="{ width: `${Math.max(row.share * 100, 1)}%` }" aria-hidden="true" />
          <span class="label">{{ row.label }}</span>
          <span class="runs">{{ row.runCount }}</span>
          <span class="usd">{{ money(row.totalUsd) }}</span>
        </li>
      </ol>

      <h4>Most expensive runs</h4>
      <ol class="rows">
        <li v-for="run in summary.topRuns" :key="run.agentRunId" class="clickable">
          <button
            type="button"
            class="rowbtn"
            :title="`Open this run`"
            @click="emit('open', run.agentRunId)"
          >
            <span class="sr">Open run</span>
          </button>
          <span class="label">{{ run.personaName }}</span>
          <span class="sub">{{ run.model }}</span>
          <span v-if="run.relation" class="relation">{{ run.relation }}</span>
          <span class="status" :class="run.status">{{ run.status }}</span>
          <span class="usd">{{ money(run.totalUsd) }}</span>
        </li>
      </ol>
    </template>
  </section>
</template>

<style scoped>
/* The row is a grid of spans; the button is stretched over it rather than wrapping
   the content, so the existing layout is untouched and the whole row is one hit
   target with a real focus ring. */
.clickable {
  position: relative;
}

.rowbtn {
  position: absolute;
  inset: 0;
  width: 100%;
  border: 0;
  background: none;
  cursor: pointer;
}

.rowbtn:hover {
  background: var(--accent-soft);
}

.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
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

h4 {
  margin: 0.7rem 0 0.25rem;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}

.controls {
  display: flex;
  gap: 0.25rem;
}

button {
  padding: 0.15rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--surface-hover);
  color: var(--text);
  font: inherit;
  font-size: 0.7rem;
  cursor: pointer;
}

button.window.active {
  border-color: var(--accent, #6aa);
  color: var(--accent, #6aa);
}

.empty {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-faint);
}

.totals {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.big {
  font-size: 1.3rem;
  font-variant-numeric: tabular-nums;
}

.meta,
.finding {
  font-size: 0.75rem;
  color: var(--text-faint);
}

.finding {
  margin: 0.3rem 0 0;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.rows li {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.2rem 0.3rem;
  font-size: 0.78rem;
  overflow: hidden;
}

/* Behind the text rather than beside it, so the row stays readable at any width. */
.bar {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--surface-hover);
  z-index: 0;
}

.rows li > :not(.bar) {
  position: relative;
  z-index: 1;
}

/**
 * The label keeps its width and the model id gives way, not the other way round.
 *
 * `flex: 1` alone sets a zero basis, so the label shrank below its own text while the
 * model id — much longer, and sized to content — rendered in full: live, the panel read
 * `sweep-...  claude-haiku-4-5-20251001`. Backwards, because the persona name is what a
 * human identifies the row by and the only part of it they can go and change; the whole
 * point is that model choice is *per persona*, so the persona has to be readable.
 */
.label {
  flex: 1 1 auto;
  min-width: 7rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub,
.relation,
.runs,
.share {
  color: var(--text-faint);
  font-size: 0.7rem;
}

.sub {
  flex: 0 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.usd {
  font-variant-numeric: tabular-nums;
}
</style>
