<script setup lang="ts">
import type { AgentRun, ApprovalRequest } from '@loom/api-contract'
import ApprovalCard from './ApprovalCard.vue'
import DiffView from './DiffView.vue'

const props = defineProps<{
  runs: AgentRun[]
  selectedRun: AgentRun | null
  approvals: ApprovalRequest[]
  diff: string | null
}>()

const emit = defineEmits<{
  select: [agentRunId: string]
  decide: [approvalRequestId: string, decision: 'approve' | 'deny']
  'load-diff': [agentRunId: string]
  keep: [agentRunId: string]
  discard: [agentRunId: string]
  push: [agentRunId: string, acknowledgeCiChange: boolean]
  merge: [agentRunId: string]
  'load-raw': [agentRunId: string, done: (result: { lines: string[]; chunks: number }) => void]
}>()

const reasonFor = (run: AgentRun): string =>
  run.status === 'awaiting_approval' ? 'awaiting your approval' : 'branch ready to review'
</script>

<template>
  <div class="inbox">
    <ul class="list">
      <li v-if="props.runs.length === 0" class="empty">Nothing needs you right now.</li>
      <li
        v-for="run in props.runs"
        :key="run.id"
        class="row"
        :class="{ selected: run.id === props.selectedRun?.id }"
        @click="emit('select', run.id)"
      >
        <strong>{{ run.persona.name }}</strong>
        <span class="status">{{ run.status }}</span>
        <span class="reason">{{ reasonFor(run) }}</span>
        <span v-if="run.branchName" class="branch">{{ run.branchName }}</span>
      </li>
    </ul>

    <div class="detail">
      <p v-if="!props.selectedRun" class="hint">Select a run to review it.</p>
      <template v-else>
        <ApprovalCard :approvals="props.approvals" @decide="(id, decision) => emit('decide', id, decision)" />
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
  width: 18rem;
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
  gap: 0.15rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}

.row:hover {
  background: var(--surface-hover);
}

.row.selected {
  background: color-mix(in oklab, var(--accent) 12%, transparent);
}

.status {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}

.reason {
  font-size: 0.8rem;
}

.branch {
  font-size: 0.75rem;
  color: var(--text-faint);
  overflow-wrap: anywhere;
}

.detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 0.75rem 1rem;
}
</style>
