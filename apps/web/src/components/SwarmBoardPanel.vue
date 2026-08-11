<script setup lang="ts">
import type { SwarmBoard } from '@loom/api-contract'
import {
 activityLabel,
 describeAge,
 describeCardActivity,
 shortBranchName,
 type BoardCard,
} from '@loom/client-core'
import { computed, onUnmounted, ref } from 'vue'

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

/**
 * The live fields are *ages*, and an age goes stale on its own — a card saying
 * "quiet 30s" is wrong a minute later even though nothing arrived to re-render it. This
 * clock is what makes silence visibly lengthen without asking the server anything, which
 * matters because silence is exactly the state no event will ever announce.
 */
const tick = ref(new Date)
const clock = setInterval( => (tick.value = new Date), 5_000)
onUnmounted( => clearInterval(clock))

const activityOf = (card: BoardCard) => describeCardActivity(card, tick.value)

/** A cap is only worth drawing once it is close enough to bite. */
const CAP_WARN_RATIO = 0.75

/**
 * Live swarm observability: "A worker at 90% of its context is about to compact and get worse." Drawn from
 * half-full — early enough to see pressure building, late enough that an idle worker's
 * card stays quiet.
 */
const CONTEXT_SHOW_RATIO = 0.5
const CONTEXT_WARN_RATIO = 0.85

const capPercent = (ratio: number) => `${Math.min(Math.round(ratio * 100), 100)}%`

/**
 * The one thing on this panel that is a *summary* rather than a card: how much of the
 * swarm is actually moving. Without it a human counts running cards by eye.
 */
const workingCount = computed(
 => (props.board?.cards ?? []).filter((card) => activityOf(card).kind === 'working').length,
)
</script>

<template>
 <section class="panel">
 <header>
 <h3>Swarm board</h3>
 <span v-if="workingCount > 0" class="live">{{ workingCount }} working</span>
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
 <!--
 What this worker is doing at this second. A tool name is the platform's own record of the call it
 dispatched, not a model's account of itself, which is why this line sits
 above the agent-note line and carries no "claimed" tag.
 -->
 <p v-if="activityOf(card).kind !== 'finished'" class="activity":class="activityOf(card).kind">
 <span class="pulse" aria-hidden="true"></span>
 <span class="verb">{{ activityLabel(activityOf(card)) }}</span>
 <code v-if="activityOf(card).target" class="target">{{ activityOf(card).target }}</code>
 <!--
 Silence is the one state no event announces, so it is stated outright
 rather than left as an absence — and stated as a duration, because how
 long it has been is the whole of what the platform knows about it.
 -->
 <span v-if="activityOf(card).kind === 'quiet' && card.lastEventAt" class="since">
 since {{ describeAge(card.lastEventAt, tick) }}
 </span>
 </p>

 <!--
 Cost against this run's own cap (the cost model — the cap is what stops the run, so
 approaching it is the actionable fact). Drawn only near the ceiling: a
 meter that is always present is a meter nobody reads.
 -->
 <p
 v-if="(activityOf(card).capUsedRatio ?? 0) >= CAP_WARN_RATIO"
 class="cap"
:class="{ spent: (activityOf(card).capUsedRatio ?? 0) >= 1 }"
 >
 <span class="bar" aria-hidden="true">
 <span class="fill":style="{ width: capPercent(activityOf(card).capUsedRatio ?? 0) }"></span>
 </span>
 {{ capPercent(activityOf(card).capUsedRatio ?? 0) }} of
 {{ money(card.budgetCapUsd) }} cap
 </p>

 <!--
 Context pressure. A percentage of the model's real window, sampled
 by the Runner from the SDK — the platform's own measurement, not the
 model's account of itself, which is why it sits with the cap meter rather
 than under the agent-note tag.
 -->
 <p
 v-if="(activityOf(card).contextUsedRatio ?? 0) >= CONTEXT_SHOW_RATIO"
 class="cap context"
:class="{ spent: (activityOf(card).contextUsedRatio ?? 0) >= CONTEXT_WARN_RATIO }"
 >
 <span class="bar" aria-hidden="true">
 <span
 class="fill"
:style="{ width: capPercent(activityOf(card).contextUsedRatio ?? 0) }"
 ></span>
 </span>
 {{ capPercent(activityOf(card).contextUsedRatio ?? 0) }} of context
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

.live {
 margin-left: auto;
 padding: 0.05rem 0.4rem;
 border-radius: 999px;
 background: var(--accent-soft);
 color: var(--accent);
 font-size: 0.66rem;
 font-weight: 600;
}

/* The activity line: monospaced target, so a path reads as a path. */
.activity {
 display: flex;
 align-items: baseline;
 gap: 0.3rem;
 margin: 0.2rem 0 0;
 font-size: 0.68rem;
 color: var(--text-muted);
 min-width: 0;
}

.activity.verb {
 font-weight: 600;
 white-space: nowrap;
}

.activity.target {
 font-family: ui-monospace, monospace;
 font-size: 0.66rem;
 overflow: hidden;
 text-overflow: ellipsis;
 white-space: nowrap;
 min-width: 0;
}

.activity.since {
 white-space: nowrap;
 color: var(--text-faint);
}

.activity.pulse {
 flex-shrink: 0;
 width: 0.4rem;
 height: 0.4rem;
 border-radius: 50%;
 background: var(--text-faint);
}

.activity.working.pulse {
 background: var(--accent);
 /* A dot that breathes only while something is genuinely in flight. The product shape deprioritises
 flow-pulse animation as a screenshot feature; one dot on the card that is actually
 executing is the cheap version of the same information. */
 animation: breathe 1.6s ease-in-out infinite;
}

.activity.working.verb {
 color: var(--accent);
}

.activity.quiet.pulse {
 background: var(--warn);
}

.activity.quiet {
 color: var(--warn);
}

@keyframes breathe {
 0%,
 100% {
 opacity: 1;
 }
 50% {
 opacity: 0.35;
 }
}

@media (prefers-reduced-motion: reduce) {
.activity.working.pulse {
 animation: none;
 }
}

.cap {
 display: flex;
 align-items: center;
 gap: 0.35rem;
 margin: 0.25rem 0 0;
 font-size: 0.66rem;
 color: var(--warn);
}

.cap.spent {
 color: var(--danger);
}

/* Context is a different pressure from spend, so it reads in a different colour until
 it is near the ceiling — at which point both mean "this is about to stop being good". */
.cap.context {
 color: var(--text-muted);
}

.cap.context.spent {
 color: var(--warn);
}

.cap.bar {
 flex: 0 0 3rem;
 height: 0.25rem;
 border-radius: 999px;
 background: var(--surface-hover);
 overflow: hidden;
}

.cap.fill {
 display: block;
 height: 100%;
 background: currentColor;
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
