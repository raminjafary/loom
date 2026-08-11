<script setup lang="ts">
import type { SwarmBoard } from '@loom/api-contract'
import { shortBranchName } from '@loom/client-core'

/**
 * The kanban, which the worker-notes design insists is the same object as the
 * worker-notes ledger: "building them separately would produce two sources of truth
 * for what a swarm is doing." So a card here *is* a run — there is no task table
 * behind this, and nothing on screen can disagree with the runs themselves.
 *
 * Columns are run statuses rather than human-assigned lanes. A human cannot drag a
 * card to a different column, deliberately: the column is a fact about a run, and a
 * board where it could be set by hand would be a board that lies.
 *
 * `pathCollisions` is the part worth looking at. The worker-notes design calls path ownership "the
 * cheapest available attack on the assumption" — that the main cause of merge
 * conflict is two workers independently deciding to touch the same file — so the
 * collisions a swarm is heading for belong on the board *before* the merge queue
 * discovers them.
 */

const props = defineProps<{ board: SwarmBoard | null }>
const emit = defineEmits<{ refresh: []; watch: [agentRunId: string] }>

/** Ordered so a reader's eye travels the way work does. */
const COLUMNS = [
 { key: 'pending', label: 'Pending', statuses: ['pending'] },
 { key: 'running', label: 'Running', statuses: ['running'] },
 { key: 'blocked', label: 'Needs a human', statuses: ['awaiting_approval'] },
 { key: 'done', label: 'Finished', statuses: ['completed'] },
 { key: 'failed', label: 'Failed', statuses: ['failed', 'cancelled'] },
] as const

const cardsIn = (statuses: readonly string[]) =>
 (props.board?.cards ?? []).filter((card) => statuses.includes(card.status))

const money = (usd: number | null) => (usd === null ? null: `$${usd.toFixed(4)}`)
</script>

<template>
 <section class="panel">
 <header>
 <h3>Swarm board</h3>
 <button type="button" @click="emit('refresh')">Refresh</button>
 </header>

 <p v-if="!props.board || props.board.cards.length === 0" class="empty">
 No swarm to show. Start a planner, or watch a run.
 </p>

 <template v-else>
 <!--
 Above the columns, not beside them: a collision is the thing a human can still
 act on cheaply, and putting it in a corner would make it something they find
 out about from the merge queue instead.
 -->
 <ul v-if="props.board.pathCollisions.length > 0" class="collisions">
 <li v-for="(collision, index) in props.board.pathCollisions":key="index">
 <strong>{{ collision.titles[0] }}</strong> and
 <strong>{{ collision.titles[1] }}</strong> both claim
 <code>{{ collision.paths.join(', ') }}</code> — expect the second to rebase onto
 the first.
 </li>
 </ul>

 <div class="columns">
 <div v-for="column in COLUMNS":key="column.key" class="column">
 <h4>{{ column.label }} <span class="count">{{ cardsIn(column.statuses).length }}</span></h4>
 <ul>
 <li
 v-for="card in cardsIn(column.statuses)"
:key="card.runId"
 class="card"
:class="{ blocked: card.blockerCount > 0 }"
 @click="emit('watch', card.runId)"
 >
 <!--
 Plain interpolation, never v-html: a card's title comes from a run's
 task and its subtitle from a model's own note.
 -->
 <p class="title">{{ card.title }}</p>
 <p class="meta">
 <span class="persona">{{ card.personaName }}</span>
 <span v-if="card.relation && card.relation !== 'delegation'" class="relation">
 {{ card.relation }}
 </span>
 <span v-if="money(card.totalCostUsd)" class="cost">{{ money(card.totalCostUsd) }}</span>
 </p>
 <p v-if="card.branchName" class="branch":title="card.branchName">
 {{ shortBranchName(card.branchName) }}
 </p>
 <p v-if="card.ownedPaths.length > 0" class="paths">
 owns <code>{{ card.ownedPaths.join(', ') }}</code>
 </p>
 <!--
 Labelled as claimed, not stated as fact. This line is a model's own
 summary of its work, and a board that printed it unlabelled would be inviting
 a human to trust it the way they trust the branch name above.
 -->
 <p v-if="card.latestNoteTitle" class="note">
 <span class="tag">agent note</span>{{ card.latestNoteTitle }}
 </p>
 <p v-if="card.blockerCount > 0" class="blockers">
 {{ card.blockerCount }} blocker(s) reported
 </p>
 </li>
 </ul>
 </div>
 </div>
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

.collisions {
 margin: 0 0 0.5rem;
 padding: 0.35rem 0.5rem 0.35rem 1.3rem;
 border: 1px solid var(--danger);
 border-radius: 0.3rem;
 font-size: 0.72rem;
 line-height: 1.4;
}

.collisions code {
 overflow-wrap: anywhere;
}

.columns {
 display: grid;
 grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
 gap: 0.4rem;
}

.column h4 {
 margin: 0 0 0.25rem;
 font-size: 0.65rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
 color: var(--text-faint);
 font-weight: 600;
}

.count {
 color: var(--text-faint);
 font-weight: 400;
}

.column ul {
 margin: 0;
 padding: 0;
 list-style: none;
 display: flex;
 flex-direction: column;
 gap: 0.3rem;
}

.card {
 padding: 0.35rem 0.4rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--surface);
 cursor: pointer;
}

.card.blocked {
 border-color: var(--danger);
}

.card p {
 margin: 0;
}

.title {
 font-size: 0.75rem;
 line-height: 1.3;
 overflow-wrap: anywhere;
}

.meta {
 display: flex;
 flex-wrap: wrap;
 gap: 0.3rem;
 margin-top: 0.15rem;
 font-size: 0.65rem;
 color: var(--text-faint);
}

.relation {
 text-transform: uppercase;
 letter-spacing: 0.04em;
}

.branch,
.paths {
 margin-top: 0.15rem;
 font-size: 0.65rem;
 color: var(--text-faint);
 overflow-wrap: anywhere;
}

.note {
 margin-top: 0.25rem;
 font-size: 0.68rem;
 line-height: 1.35;
 overflow-wrap: anywhere;
}

/*
 * The visual half of "agent-authored notes are data, not instructions". A human
 * skimming a board must be able to see which line a model wrote without reading
 * carefully — see the worker-notes design.
 */
.tag {
 display: inline-block;
 margin-right: 0.25rem;
 padding: 0 0.2rem;
 border: 1px dashed var(--border);
 border-radius: 0.2rem;
 font-size: 0.58rem;
 text-transform: uppercase;
 letter-spacing: 0.04em;
 color: var(--text-faint);
}

.blockers {
 margin-top: 0.15rem;
 font-size: 0.65rem;
 color: var(--danger);
}
</style>
