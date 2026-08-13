<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PlanReview } from '@loom/api-contract'

/**
 * A plan, before it builds.
 *
 * **Why this is the gate that matters now.** Making the teams autonomous
 * moved the human's job to two places — review the plan, merge the branch — and a plan was
 * the one expensive decision in the system with no gate at all: N runs spawn the moment a
 * model submits, and the steering only reaches them afterwards.
 *
 * Three things this surface has to do that a list of titles would not:
 *
 * - **Show the orchestration, not the roster.** What a reviewer is deciding is the *shape*:
 * which persona gets which piece, what waits for what, and who reviews whom. So the stages
 * are drawn as stages — the DAG is the thing being approved, and a flat list hides the
 * one property that makes a plan cheap or expensive.
 * - **Offer three acts, not two.** Accepting spends the plan, asking for changes spends
 * another planning turn, and rejecting spends nothing. Collapsing the last two into
 * "decline" would make the cheap one cost a model call.
 * - **Say what a change request is.** It becomes the planner's next instruction verbatim,
 * so an empty box is a planner asked to guess — and it will produce the same plan.
 *
 * Every title, task and persona name here is model-authored. Interpolated, never `v-html`
 *.
 */

const props = defineProps<{ review: PlanReview | null; busy?: boolean }>

const emit = defineEmits<{
 accept: [agentRunId: string]
 requestChanges: [input: { agentRunId: string; note: string }]
 reject: [input: { agentRunId: string; reason?: string }]
 refresh: []
}>

const note = ref('')

/**
 * The plan as the stages, which is the shape being approved.
 *
 * Computed from `dependsOn` here rather than asked of the server: the server already
 * describes the stages in prose when the plan lands (`describePlanStages`), and this is the
 * same derivation for a different medium. A stage number on the wire would be a third place
 * the DAG's shape lives.
 */
const stages = computed( => {
 const subtasks = props.review?.subtasks ?? []
 const stageOf = new Map<number, number>
 // Bounded by the subtask count: each pass must place at least one row or it stops.
 for (let pass = 0; pass < subtasks.length + 1; pass += 1) {
 let placed = false
 for (const subtask of subtasks) {
 if (stageOf.has(subtask.position)) continue
 const depths = subtask.dependsOn.map((position) => stageOf.get(position))
 if (depths.some((depth) => depth === undefined)) continue
 stageOf.set(subtask.position, depths.length === 0 ? 0: Math.max(...(depths as number[])) + 1)
 placed = true
 }
 if (!placed) break
 }
 const byStage = new Map<number, typeof subtasks>
 for (const subtask of subtasks) {
 const stage = stageOf.get(subtask.position) ?? 0
 byStage.set(stage, [...(byStage.get(stage) ?? []), subtask])
 }
 return [...byStage.entries].sort(([a], [b]) => a - b)
})

const titleAt = (position: number): string =>
 props.review?.subtasks.find((subtask) => subtask.position === position)?.title ?? `#${position}`

const send = (act: 'accept' | 'changes' | 'reject') => {
 const runId = props.review?.plannerRunId
 if (!runId) return
 const text = note.value.trim
 if (act === 'accept') emit('accept', runId)
 // Refused here as well as on the server, so the reason arrives before the round trip.
 if (act === 'changes' && text !== '') emit('requestChanges', { agentRunId: runId, note: text })
 if (act === 'reject') emit('reject', { agentRunId: runId,...(text === '' ? {}: { reason: text }) })
 if (act !== 'accept') note.value = ''
}
</script>

<template>
 <section v-if="review && review.subtasks.length > 0" class="plan">
 <div class="head">
 <h4>
 {{ review.awaitingReview ? 'This plan is waiting for you': 'Plan' }}
 <em>{{ review.plannerName }}</em>
 </h4>
 <button type="button" class="link":disabled="props.busy" @click="emit('refresh')">
 Refresh
 </button>
 </div>

 <p v-if="review.awaitingReview" class="about">
 Nothing has started. {{ review.subtasks.length }} subtask(s) in
 {{ stages.length }} stage(s) — each stage waits for the one before it.
 </p>
 <p v-else class="about">Already started. Steer it rather than re-deciding it.</p>

 <!--
 Stages, because the shape is what is being approved. A flat list would hide the
 one property that makes a plan cheap or expensive: how much of it runs at once.
 -->
 <ol class="stages">
 <li v-for="[stage, subtasks] in stages":key="stage">
 <p class="stage-head">
 Stage {{ stage + 1 }}
 <em>{{ subtasks.length }} in parallel</em>
 </p>
 <ul class="subtasks">
 <li v-for="subtask in subtasks":key="subtask.id":class="subtask.status">
 <p class="what">
 <span class="title">{{ subtask.title }}</span>
 <span class="persona">{{ subtask.personaName }}</span>
 <span v-if="subtask.reviews !== null" class="reviews">
 reviews “{{ titleAt(subtask.reviews) }}”
 </span>
 </p>
 <p class="task">{{ subtask.task }}</p>
 <p v-if="subtask.paths.length > 0" class="paths">
 owns {{ subtask.paths.join(', ') }}
 </p>
 <p v-if="subtask.detail" class="detail">{{ subtask.detail }}</p>
 </li>
 </ul>
 </li>
 </ol>

 <div v-if="review.awaitingReview" class="acts">
 <!--
 One box for both "what to change" and "why not" — they are the same sentence written
 for two different outcomes, and two boxes would ask a human to choose before typing.
 -->
 <textarea
 v-model="note"
 rows="2"
 placeholder="What to change, or why not — the planner is given this verbatim"
 aria-label="What to change about this plan"
 ></textarea>
 <div class="row">
 <button type="button" class="primary":disabled="props.busy" @click="send('accept')">
 Accept — start stage 1
 </button>
 <button
 type="button"
:disabled="props.busy || note.trim === ''"
 @click="send('changes')"
 >
 Ask for changes
 </button>
 <button type="button" class="danger":disabled="props.busy" @click="send('reject')">
 Reject
 </button>
 </div>
 <p class="hint">
 Asking for changes spends another planning turn; rejecting spends nothing. A change
 request with no words is a planner asked to guess, so that button waits for some.
 </p>
 </div>
 </section>
</template>

<style scoped>
.plan {
 display: flex;
 flex-direction: column;
 gap: 0.55rem;
 padding: 0.6rem 0.7rem;
 border: 1px solid var(--accent);
 border-radius: 0.5rem;
}

.head {
 display: flex;
 align-items: baseline;
 justify-content: space-between;
 gap: 0.6rem;
}

h4 {
 margin: 0;
 font-size: 0.85rem;
}

h4 em {
 font-style: normal;
 font-size: 0.68rem;
 color: var(--text-faint);
 margin-left: 0.3rem;
}

.about,
.hint {
 margin: 0;
 font-size: 0.72rem;
 line-height: 1.5;
 color: var(--text-faint);
}

.stages {
 display: flex;
 flex-direction: column;
 gap: 0.5rem;
 margin: 0;
 padding: 0;
 list-style: none;
}

.stage-head {
 margin: 0 0 0.25rem;
 font-size: 0.66rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
 color: var(--text-faint);
}

.stage-head em {
 font-style: normal;
 text-transform: none;
 letter-spacing: 0;
 margin-left: 0.35rem;
}

.subtasks {
 display: flex;
 flex-direction: column;
 gap: 0.3rem;
 margin: 0;
 padding: 0 0 0 0.6rem;
 border-left: 2px solid var(--border);
 list-style: none;
}

.subtasks > li.skipped,
.subtasks > li.refused {
 opacity: 0.6;
}

.what {
 display: flex;
 flex-wrap: wrap;
 align-items: baseline;
 gap: 0.35rem;
 margin: 0;
 font-size: 0.78rem;
}

.persona {
 font-size: 0.66rem;
 padding: 0.05rem 0.3rem;
 border: 1px solid var(--border);
 border-radius: 0.8rem;
 color: var(--text-faint);
}

.reviews,
.paths,
.detail {
 font-size: 0.66rem;
 color: var(--text-faint);
}

.task {
 margin: 0.15rem 0 0;
 font-size: 0.72rem;
 line-height: 1.5;
}

.paths,
.detail {
 margin: 0.15rem 0 0;
}

.acts {
 display: flex;
 flex-direction: column;
 gap: 0.35rem;
}

textarea {
 width: 100%;
 box-sizing: border-box;
 padding: 0.3rem 0.4rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
 font-size: 0.75rem;
 resize: vertical;
}

.row {
 display: flex;
 flex-wrap: wrap;
 gap: 0.35rem;
}

button {
 padding: 0.25rem 0.55rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
 font-size: 0.73rem;
 cursor: pointer;
}

button.primary {
 border-color: var(--accent);
}

button.danger {
 color: var(--danger, #b42318);
}

button.link {
 border: none;
 background: none;
 color: var(--accent);
 padding: 0.25rem 0.2rem;
}

button:disabled {
 opacity: 0.5;
 cursor: not-allowed;
}
</style>
