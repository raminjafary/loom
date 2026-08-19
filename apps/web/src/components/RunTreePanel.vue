<script setup lang="ts">
import { buildRunTree, costByRelation, totalCostUsd } from '@loom/client-core'
import { computed } from 'vue'
import type { SwarmBoard } from '@loom/api-contract'

/**
 * The swarm tree and its cost rollup.
 *
 * Built from the **board's own payload**, not a second endpoint. The hierarchy is already
 * in the data — `parentRunId` and `relation` are columns on `agent_run` — and a separate
 * tree query would be a second source of truth for what a swarm's shape is, which is the
 * thing the worker-notes design refuses. The board and this panel disagreeing about a run
 * would be worse than not having the tree.
 *
 * The board answers "what state is everything in"; this answers "who asked for what,
 * and what did it cost". Same cards, two questions.
 */

const props = defineProps<{ board: SwarmBoard | null }>()
const emit = defineEmits<{ refresh: []; watch: [agentRunId: string] }>()

/**
 * The shape lives in client-core, not here: the contract-first rule means a TUI must be
 * able to render the same tree without reimplementing how a parent, a subtotal or a root is
 * decided.
 */
const nodes = computed(() => buildRunTree(props.board?.cards ?? []))
const totalUsd = computed(() => totalCostUsd(props.board?.cards ?? []))
const byRelation = computed(() => costByRelation(props.board?.cards ?? []))

const money = (usd: number) => `$${usd.toFixed(4)}`

/**
 * How many times this tree has been handed over, against the bound.
 *
 * Counted from the cards rather than fetched, for the same reason the tree itself is:
 * `relation` is already on every card, and a second source for "how many handoffs" would
 * be one more thing that can disagree with the tree a human is looking at.
 *
 * Shown only once one has happened. The honest failure mode here is thrash — agents
 * passing work back and forth, each briefing the other — so the count next to its limit
 * is the number that tells a human whether that is what they are watching.
 */
const handoffs = computed(
  () => (props.board?.cards ?? []).filter((card) => card.relation === 'handoff').length,
)
</script>

<template>
  <section class="panel">
    <header>
      <h3>Run tree</h3>
      <button type="button" @click="emit('refresh')">Refresh</button>
    </header>

    <p v-if="nodes.length === 0" class="empty">
      No tree to show. Start a planner, or watch a run.
    </p>

    <template v-else>
      <ol class="tree">
        <li
          v-for="node in nodes"
          :key="node.card.runId"
          class="row"
          :class="{ blocked: node.card.blockerCount > 0 }"
          :style="{ paddingLeft: `${node.depth * 0.9 + 0.4}rem` }"
          role="button"
          tabindex="0"
          @click="emit('watch', node.card.runId)"
          @keydown.enter.prevent="emit('watch', node.card.runId)"
          @keydown.space.prevent="emit('watch', node.card.runId)"
        >
          <span class="branchline" aria-hidden="true">{{ node.depth === 0 ? '' : '└' }}</span>
          <!--
            Plain interpolation, never v-html: a title comes from a
            run's task and is model-adjacent text.
          -->
          <span class="title">{{ node.card.title }}</span>
          <span class="persona">{{ node.card.personaName }}</span>
          <!--
            A reconciler or reviewer is not a worker the planner asked for, so the
            relation is shown wherever it is not plain delegation.
          -->
          <span v-if="node.card.relation && node.card.relation !== 'delegation'" class="relation">
            {{ node.card.relation }}
          </span>
          <span class="status" :class="node.card.status">{{ node.card.status }}</span>
          <span class="cost">
            {{ money(node.card.totalCostUsd ?? 0) }}
            <!--
              A parent's own cost says little about what the goal cost — a Planner
              holds `tools: []` and spends almost nothing while its children spend
              everything. The subtree total is the honest number.
            -->
            <em v-if="node.childCount > 0" class="subtotal">
              ({{ money(node.subtotalUsd) }} with {{ node.childCount }} child<span
                v-if="node.childCount > 1"
                >ren</span
              >)
            </em>
          </span>
        </li>
      </ol>

      <footer>
        <span class="total">{{ money(totalUsd) }} total</span>
        <span
          v-if="handoffs > 0"
          class="slice handoffs"
          title="A run handed its work to a fresh one on the same branch and budget. Past the workspace's limit, nobody takes over."
        >
          {{ handoffs }} handoff<span v-if="handoffs > 1">s</span>
        </span>
        <span v-for="[relation, usd] in byRelation" :key="relation" class="slice">
          {{ relation }} {{ money(usd) }}
        </span>
      </footer>
    </template>
  </section>
</template>

<style scoped>
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

.tree {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
  padding: 0.25rem 0.4rem;
  border: 1px solid transparent;
  border-radius: 0.3rem;
  font-size: 0.75rem;
  cursor: pointer;
}

.row:hover {
  background: var(--surface-hover);
  border-color: var(--border);
}

.row.blocked {
  border-color: var(--danger);
}

.branchline {
  color: var(--text-faint);
}

.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}

.persona,
.handoffs {
  color: var(--warn, var(--text-faint));
}

.relation,
.status,
.cost {
  flex: 0 0 auto;
  font-size: 0.68rem;
  color: var(--text-faint);
}

.relation {
  padding: 0 0.25rem;
  border: 1px solid var(--border);
  border-radius: 0.2rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.status.running {
  color: var(--accent, inherit);
}

.status.failed,
.status.cancelled {
  color: var(--danger);
}

.subtotal {
  font-style: normal;
  opacity: 0.75;
}

footer {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.45rem;
  padding-top: 0.35rem;
  border-top: 1px solid var(--border);
  font-size: 0.68rem;
  color: var(--text-faint);
}

.total {
  font-weight: 600;
  color: var(--text);
}
</style>
