<script setup lang="ts">
import type { AgentRun, ApprovalRequest } from '@loom/api-contract'
import { attentionReason, describeAge, shortBranchName } from '@loom/client-core'
import ApprovalCard from './ApprovalCard.vue'
import DiffView from './DiffView.vue'

const props = defineProps<{
 runs: AgentRun[]
 selectedRun: AgentRun | null
 approvals: ApprovalRequest[]
 diff: string | null
}>

const emit = defineEmits<{
 select: [agentRunId: string]
 decide: [approvalRequestId: string, decision: 'approve' | 'deny']
 'load-diff': [agentRunId: string]
 keep: [agentRunId: string]
 discard: [agentRunId: string]
 push: [agentRunId: string, acknowledgeCiChange: boolean]
 merge: [agentRunId: string]
 'load-raw': [agentRunId: string, done: (result: { lines: string[]; chunks: number }) => void]
 /**
 * Hands this run to the board and the graph.
 *
 * Those panels hang off the *watched* run, and nothing could set one to a finished
 * run: `agentRun.getActive` is null once nothing is running, and every other way in
 * — the board, the tree, the graph — is a panel that needs a watched run before it
 * renders at all. So a swarm became unreachable the moment it finished, which is
 * exactly when a human wants to read its shape.
 *
 * Deliberately a button rather than a side effect of `select`: the two are kept
 * independent so that reviewing a finished branch does not yank the board away from
 * a swarm still running.
 */
 watch: [agentRunId: string]
}>

/**
 * Every row used to read "swe · COMPLETED · branch ready to review", which for five
 * queued reviews is five identical rows: nothing to choose between them, and no sign
 * that the list is ordered by how long each has been waiting. Cost and age are what
 * make the ordering legible and the choice possible, and both are already on the run.
 */
const money = (usd: number | null) => (usd === null ? null: `$${usd.toFixed(4)}`)

const finishedAt = (run: AgentRun): Date => run.completedAt ?? run.createdAt
</script>

<template>
 <div class="inbox">
 <ul class="list">
 <li v-if="props.runs.length === 0" class="empty">Nothing needs you right now.</li>
 <li
 v-for="run in props.runs"
:key="run.id"
 class="row"
:class="[attentionReason(run).kind, { selected: run.id === props.selectedRun?.id }]"
 @click="emit('select', run.id)"
 >
 <div class="line">
 <strong>{{ run.persona.name }}</strong>
 <span class="age">{{ describeAge(finishedAt(run)) }}</span>
 </div>
 <span class="reason">{{ attentionReason(run).summary }}</span>
 <div class="line meta">
 <span v-if="run.branchName" class="branch":title="run.branchName">{{
 shortBranchName(run.branchName)
 }}</span>
 <span v-if="money(run.totalCostUsd)" class="cost">{{ money(run.totalCostUsd) }}</span>
 </div>
 </li>
 </ul>

 <div class="detail">
 <p v-if="!props.selectedRun" class="hint">Select a run to review it.</p>
 <template v-else>
 <!--
 A header, because selecting a run used to show only a branch name and a Review
 button: everything that says *why this is here* was in the row you just
 clicked away from, and the diff's own summary does not exist until the diff is
 loaded. This is the run's own account of itself.
 -->
 <header class="run-head">
 <div class="titles">
 <h2>{{ props.selectedRun.persona.name }}</h2>
 <p class="reason">{{ attentionReason(props.selectedRun).summary }}</p>
 </div>
 <dl class="facts">
 <div>
 <dt>Status</dt>
 <dd>{{ props.selectedRun.status }}</dd>
 </div>
 <div>
 <dt>Cost</dt>
 <!-- Never re-derived from tokens: proxy-metered spend is the figure caps are enforced against. -->
 <dd>{{ money(props.selectedRun.totalCostUsd) ?? 'not metered' }}</dd>
 </div>
 <div>
 <dt>Finished</dt>
 <dd>{{ describeAge(finishedAt(props.selectedRun)) }}</dd>
 </div>
 </dl>
 <button class="watch" type="button" @click="emit('watch', props.selectedRun.id)">
 Open the swarm board
 </button>
 </header>

 <!--
 A failed run is in this list because it left a branch behind, so the reason it
 failed is the first thing a human needs in order to decide about that branch.
 Plain interpolation: the message can carry model output.
 -->
 <p v-if="props.selectedRun.errorMessage" class="failure">
 {{ props.selectedRun.errorMessage }}
 </p>

 <ApprovalCard:approvals="props.approvals" @decide="(id, decision) => emit('decide', id, decision)" />
 <DiffView
:run="props.selectedRun"
:diff="props.diff"
 @load-diff="(agentRunId) => emit('load-diff', agentRunId)"
 @keep="(agentRunId) => emit('keep', agentRunId)"
 @discard="(agentRunId) => emit('discard', agentRunId)"
 @push="(agentRunId, ack) => emit('push', agentRunId, ack)"
 @merge="(agentRunId) => emit('merge', agentRunId)"
 @load-raw="(agentRunId, done) => emit('load-raw', agentRunId, done)"
 />
 </template>
 </div>
 </div>
</template>

<style scoped>
.inbox {
 display: flex;
 height: 100%;
 min-height: 0;
}

.list {
 width: 20rem;
 flex-shrink: 0;
 margin: 0;
 padding: 0;
 list-style: none;
 overflow-y: auto;
 border-right: 1px solid var(--border);
}

.empty,
.hint {
 padding: 1rem 1.25rem;
 color: var(--text-faint);
 font-size: 0.85rem;
}

.row {
 display: flex;
 flex-direction: column;
 gap: 0.2rem;
 padding: 0.6rem 1rem;
 border-bottom: 1px solid var(--border);
 /* The reason a row is here, as a colour, so the list is scannable before it is read. */
 border-left: 3px solid transparent;
 cursor: pointer;
}

.row.approval {
 border-left-color: var(--warn);
}

.row.failed-branch {
 border-left-color: var(--danger);
}

.row:hover {
 background: var(--surface-hover);
}

.row.selected {
 background: color-mix(in oklab, var(--accent) 12%, transparent);
}

.line {
 display: flex;
 align-items: baseline;
 justify-content: space-between;
 gap: 0.5rem;
}

.line.meta {
 justify-content: flex-start;
 gap: 0.6rem;
}

.reason {
 font-size: 0.8rem;
}

.age,
.branch,
.cost {
 font-size: 0.72rem;
 color: var(--text-faint);
 white-space: nowrap;
}

.branch {
 overflow: hidden;
 text-overflow: ellipsis;
}

.detail {
 flex: 1;
 min-width: 0;
 overflow-y: auto;
 padding: 0.75rem 1rem;
 display: flex;
 flex-direction: column;
 gap: 0.75rem;
}

.run-head {
 display: flex;
 align-items: flex-start;
 justify-content: space-between;
 gap: 1rem;
 flex-wrap: wrap;
 padding-bottom: 0.6rem;
 border-bottom: 1px solid var(--border);
}

.titles h2 {
 margin: 0;
 font-size: 1.05rem;
}

/*
 Secondary to Review, which is what this pane is for. This is the way *back* to the
 swarm a run belonged to, wanted often enough to be one click and not often enough to
 compete with the disposition.
*/
.watch {
 align-self: center;
 padding: 0.35rem 0.7rem;
 font: inherit;
 font-size: 0.85rem;
 color: var(--text-muted);
 background: transparent;
 border: 1px solid var(--border);
 border-radius: 6px;
 cursor: pointer;
}

.watch:hover {
 color: var(--text);
 border-color: var(--accent);
}

.titles.reason {
 margin: 0.15rem 0 0;
 color: var(--text-muted);
}

.facts {
 display: flex;
 gap: 1.25rem;
 margin: 0;
}

.facts dt {
 font-size: 0.66rem;
 text-transform: uppercase;
 letter-spacing: 0.06em;
 color: var(--text-faint);
}

.facts dd {
 margin: 0.1rem 0 0;
 font-size: 0.85rem;
 font-variant-numeric: tabular-nums;
}

.failure {
 margin: 0;
 padding: 0.5rem 0.7rem;
 border-left: 3px solid var(--danger);
 border-radius: 0 0.4rem 0.4rem 0;
 background: color-mix(in oklab, var(--danger) 8%, var(--surface));
 font-size: 0.85rem;
 overflow-wrap: anywhere;
}
</style>
