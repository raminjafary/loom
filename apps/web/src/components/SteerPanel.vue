<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SwarmBoard } from '@loom/api-contract'

/**
 * The re-planning turn.
 *
 * A human writes a message, a Planner is re-entered with it alongside its own plan
 * and the tree's state, and it emits a delta — a change to one subtask, not a new
 * decomposition.
 *
 * **Deliberately not the thread composer.** Posting in the thread is free; this
 * starts a frontier-model run, and a control that looks like ordinary chat would have
 * people spending a run on "thanks". The button says what it does, and the note under
 * it says what happens even if the Planner decides nothing should change — because
 * that is the honest floor: the message lands in the ledger either way.
 *
 * Only Planners are offered, because a delta is a change to a plan. The refusal for a
 * worker exists server-side too; keeping it out of the picker means a human does not
 * have to discover it by being refused.
 */

const props = defineProps<{ board: SwarmBoard | null; busy: boolean }>
const emit = defineEmits<{ steer: [agentRunId: string, message: string] }>

const message = ref('')
const target = ref<string | null>(null)

const planners = computed( =>
 (props.board?.cards ?? []).filter((card) => card.planner && card.relation !== 'steer'),
)

const chosen = computed( => target.value ?? planners.value[0]?.runId ?? null)

/**
 * The select showed blank while `chosen` had already silently defaulted to the first
 * planner — so the control named a different target than the button would use, on the
 * one form in the app that spends a frontier-model run per press. Keeping `target`
 * pinned to `chosen` makes the displayed answer the real one.
 *
 * Re-pinned when the roster changes, not only on mount: a steered planner leaves the
 * list (it is `relation: 'steer'`), and the selection it held would otherwise point at
 * a run that is no longer offered.
 */
watch(
 planners,
 (cards) => {
 if (cards.length === 0) {
 target.value = null
 return
 }
 if (target.value === null || !cards.some((card) => card.runId === target.value)) {
 target.value = cards[0]?.runId ?? null
 }
 },
 { immediate: true },
)

const submit = => {
 const runId = chosen.value
 const text = message.value.trim
 if (!runId || text === '') return
 emit('steer', runId, text)
 message.value = ''
}
</script>

<template>
 <section class="panel">
 <header>
 <h3>Steer</h3>
 </header>

 <p v-if="planners.length === 0" class="empty">
 No planner in this tree to re-enter.
 </p>

 <form v-else @submit.prevent="submit">
 <select v-if="planners.length > 1" v-model="target" aria-label="Planner to re-enter">
 <option v-for="card in planners":key="card.runId":value="card.runId">
 {{ card.personaName }}
 </option>
 </select>
 <textarea
 v-model="message"
 rows="3"
 maxlength="4000"
 placeholder="What should change? e.g. drop the migration subtask — we are not changing the schema after all"
 />
 <div class="actions">
 <button type="submit":disabled="props.busy || message.trim === ''">
 Re-plan with this
 </button>
 </div>
 <p class="hint">
 Starts one planner run. It sees the plan, where every subtask stands, and this
 message — and changes at most a few subtasks. Your message is recorded for the
 whole swarm either way, so it reaches the workers even if the plan stays as it is.
 </p>
 </form>
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

.empty {
 margin: 0;
 font-size: 0.8rem;
 color: var(--text-faint);
}

form {
 display: flex;
 flex-direction: column;
 gap: 0.35rem;
}

select,
textarea {
 width: 100%;
 padding: 0.3rem 0.4rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--surface);
 color: var(--text);
 font: inherit;
 font-size: 0.75rem;
 resize: vertical;
}

.actions {
 display: flex;
 gap: 0.4rem;
}

.actions button {
 padding: 0.2rem 0.5rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--surface-hover);
 color: var(--text);
 font: inherit;
 font-size: 0.7rem;
 cursor: pointer;
}

.actions button:disabled {
 opacity: 0.5;
 cursor: default;
}

.hint {
 margin: 0;
 font-size: 0.68rem;
 line-height: 1.35;
 color: var(--text-faint);
}
</style>
