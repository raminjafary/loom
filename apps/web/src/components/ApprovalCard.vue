<script setup lang="ts">
import type { ApprovalRequest } from '@loom/api-contract'
import { ref } from 'vue'

defineProps<{ approvals: ApprovalRequest[] }>()

const emit = defineEmits<{
  decide: [approvalRequestId: string, decision: 'approve' | 'deny', answer?: string]
}>()

/**
 * Draft answers to clarifying questions, keyed by
 * request id: several runs can be blocked on questions at once, and a single `ref`
 * would put one run's answer in another run's box.
 */
const answers = ref<Record<string, string>>({})

const answer = (approval: ApprovalRequest) => {
  const text = (answers.value[approval.id] ?? '').trim()
  if (text.length === 0) return
  emit('decide', approval.id, 'approve', text)
  delete answers.value[approval.id]
}
</script>

<template>
  <div v-if="approvals.length > 0" class="approvals">
    <!-- The exact argv, never a model-authored summary -->
    <article v-for="approval in approvals" :key="approval.id" class="card" role="alert">
      <header>
        <strong>{{ approval.question === null ? approval.toolName : 'A question for you' }}</strong>
        <span class="badge">{{ approval.question === null ? 'awaiting approval' : 'run is waiting' }}</span>
      </header>

      <!--
        A question is composed by a model, so it is attacker-controllable text, and gets the
        same fence as any agent prose. An agent that could ask "paste your token here" in a
        box wearing the platform's own chrome is the same injection risk in a different
        shape — hence the explicit label, and hence plain interpolation rather than any
        markup path.
      -->
      <template v-if="approval.question !== null">
        <p class="fence-note">Asked by the agent — treat it as its words, not the platform's:</p>
        <blockquote class="question">{{ approval.question }}</blockquote>
        <textarea
          v-model="answers[approval.id]"
          class="answer"
          rows="3"
          placeholder="Your answer — the run resumes with exactly this text."
          @keydown.enter.meta="answer(approval)"
        ></textarea>
        <div class="actions">
          <button
            type="button"
            class="approve"
            :disabled="!(answers[approval.id] ?? '').trim()"
            @click="answer(approval)"
          >
            Send answer
          </button>
          <!--
            "Decline" rather than "Deny": the run is told nobody answered and continues
            on its own judgement, which is not the same as refusing a tool call.
          -->
          <button type="button" class="deny" @click="emit('decide', approval.id, 'deny')">
            Decline to answer
          </button>
        </div>
      </template>

      <!-- The exact argv, never a model-authored summary -->
      <template v-else>
        <pre class="argv">{{ JSON.stringify(approval.input, null, 2) }}</pre>
        <div class="actions">
          <button type="button" class="approve" @click="emit('decide', approval.id, 'approve')">
            Approve
          </button>
          <button type="button" class="deny" @click="emit('decide', approval.id, 'deny')">
            Deny
          </button>
        </div>
      </template>
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

.fence-note {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.question {
  margin: 0.25rem 0 0;
  padding: 0.5rem 0.7rem;
  border-left: 3px solid var(--border);
  background: var(--surface-alt, transparent);
  white-space: pre-wrap;
}

.answer {
  width: 100%;
  padding: 0.45rem 0.6rem;
  font: inherit;
  color: var(--text);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  resize: vertical;
}

.approve:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
