<script setup lang="ts">
import type { ApprovalRequest } from '@loom/api-contract'

defineProps<{ approvals: ApprovalRequest[] }>

const emit = defineEmits<{
 decide: [approvalRequestId: string, decision: 'approve' | 'deny']
}>
</script>

<template>
 <div v-if="approvals.length > 0" class="approvals">
 <!-- The exact argv, never a model-authored summary -->
 <article v-for="approval in approvals":key="approval.id" class="card" role="alert">
 <header>
 <strong>{{ approval.toolName }}</strong>
 <span class="badge">awaiting approval</span>
 </header>
 <pre class="argv">{{ JSON.stringify(approval.input, null, 2) }}</pre>
 <div class="actions">
 <button type="button" class="approve" @click="emit('decide', approval.id, 'approve')">
 Approve
 </button>
 <button type="button" class="deny" @click="emit('decide', approval.id, 'deny')">
 Deny
 </button>
 </div>
 </article>
 </div>
</template>

<style scoped>
.approvals {
 display: flex;
 flex-direction: column;
 gap: 0.5rem;
 padding: 0.75rem 1.25rem 0;
}

.card {
 border: 1px solid color-mix(in oklab, var(--warn) 40%, var(--border));
 border-radius: 0.5rem;
 padding: 0.6rem 0.75rem;
 background: color-mix(in oklab, var(--warn) 8%, transparent);
}

.card header {
 display: flex;
 align-items: center;
 gap: 0.5rem;
 margin-bottom: 0.4rem;
}

.badge {
 font-size: 0.7rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
 color: var(--warn);
}

.argv {
 margin: 0 0 0.5rem;
 padding: 0.5rem;
 background: var(--surface);
 border-radius: 0.375rem;
 font-size: 0.8rem;
 overflow-x: auto;
 white-space: pre-wrap;
 overflow-wrap: anywhere;
}

.actions {
 display: flex;
 gap: 0.5rem;
}

.actions button {
 padding: 0.35rem 0.7rem;
 border: 0;
 border-radius: 0.375rem;
 font: inherit;
 font-weight: 600;
 cursor: pointer;
}

.approve {
 background: var(--ok);
 color: var(--accent-contrast);
}

.deny {
 background: var(--danger);
 color: var(--accent-contrast);
}
</style>
