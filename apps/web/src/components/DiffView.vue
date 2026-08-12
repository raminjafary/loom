<script setup lang="ts">
import type { AgentRun } from '@loom/api-contract'
import { parseUnifiedDiff, shortBranchName } from '@loom/client-core'
import { computed, ref, watch } from 'vue'
import ConfirmButton from './ConfirmButton.vue'
import DiffFileView from './DiffFileView.vue'

const props = defineProps<{
 run: AgentRun | null
 diff: string | null
 /** The last diff fetch's failure — see AgentSnapshot.fetchErrors. */
 fetchError: string | null
}>

const emit = defineEmits<{
 'load-diff': [agentRunId: string]
 keep: [agentRunId: string]
 discard: [agentRunId: string]
 push: [agentRunId: string, acknowledgeCiChange: boolean]
 /**
 * Queues the branch. `override` answers a reviewer's blocker,
 * and `done` carries the server's refusal back *here* rather than into the app's
 * error banner: the refusal is a question — "your reviewer says do not merge this" —
 * and it has to be readable next to the button that asked it.
 */
 merge: [
 agentRunId: string,
 override: boolean,
 done: (result: { ok: boolean; reason: string | null }) => void,
 ]
 'load-raw': [agentRunId: string, done: (result: { lines: string[]; chunks: number }) => void]
}>

/**
 * Why the last queue attempt was refused — a reviewer's blockers, in the reviewer's own
 * words. Cleared on any new attempt and when the run changes, so a
 * previous run's objection can never be read as this one's.
 */
const mergeRefusal = ref<string | null>(null)

const queueForMerge = (override: boolean) => {
 if (!props.run) return
 mergeRefusal.value = null
 emit('merge', props.run.id, override, (result) => {
 mergeRefusal.value = result.ok ? null: result.reason
 })
}

/**
 * The raw transcript is fetched only when asked for. It is the verbatim provider stream — far
 * larger than the thread, and the reason the event-tiering design tiers the write path at all —
 * so loading it alongside the diff would undo the point of the tiering.
 */
const raw = ref<{ lines: string[]; chunks: number } | null>(null)
const rawLoading = ref(false)

const loadRaw = => {
 if (!props.run) return
 rawLoading.value = true
 emit('load-raw', props.run.id, (result) => {
 raw.value = result
 rawLoading.value = false
 })
}

// A transcript belongs to one run; keeping it on screen while the view switches
// would attribute one run's output to another.
watch(
 => props.run?.id,
 => {
 raw.value = null
 mergeRefusal.value = null
 },
)

/**
 * The diff, as files and hunks rather than as a wall of text.
 *
 * Parsed in `client-core` so a TUI reviews the same structure, and parsed here
 * rather than server-side because the server already sends the canonical thing — a
 * unified diff — and a second, view-shaped payload would be a second thing to keep true.
 */
const parsed = computed( => (props.diff === null ? null: parseUnifiedDiff(props.diff)))

/**
 * Unified by default, side-by-side on request.
 *
 * Unified reads better for the mostly-additive changes these branches usually are;
 * split earns its space when a removal is replaced by an addition, so it is one click
 * away rather than absent.
 */
const split = ref(false)

/**
 * Review happens in a full-viewport overlay, not in the sidebar.
 *
 * This panel lives in a ~240px column, and a diff rendered there is unreadable at any
 * quality of rendering — every line is truncated, and the columns a diff depends on have
 * nowhere to line up. Reviewing a branch is also the single highest-stakes thing a human
 * does here (repository binding: keep / discard / queue / push all follow from it), so it gets the
 * screen while it is happening and gives it back afterwards.
 *
 * The sidebar keeps the summary — branch, counts, disposition — because that is what is
 * worth seeing *without* stopping to review.
 */
const reviewing = ref(false)

const openReview = => {
 if (!props.run) return
 reviewing.value = true
 if (props.diff === null) emit('load-diff', props.run.id)
}

// A diff belongs to one run; leaving the overlay open across a switch would show one
// run's changes under another's name.
watch(
 => props.run?.id,
 => {
 reviewing.value = false
 },
)

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

const canLoadDiff = => props.run !== null && props.run.clonePath !== null

// Keep/discard/push only make sense once the run is done and undecided.
const canDecideDisposition = =>
 props.run !== null && TERMINAL_STATUSES.has(props.run.status) && props.run.branchDisposition === null
</script>

<template>
 <section v-if="props.run && props.run.clonePath" class="panel">
 <header>
 <h3>Changes</h3>
 <button type="button":disabled="!canLoadDiff" @click="openReview">Review</button>
 </header>

 <p class="branch":title="props.run.branchName ?? ''">{{ shortBranchName(props.run.branchName) }}</p>
 <div v-if="parsed && parsed.files.length > 0" class="summary">
 <span>{{ parsed.files.length }} file<span v-if="parsed.files.length !== 1">s</span></span>
 <span class="adds">+{{ parsed.additions }}</span>
 <span class="dels">−{{ parsed.deletions }}</span>
 </div>

 <p v-if="props.run.branchDisposition" class="disposition">Branch {{ props.run.branchDisposition }}.</p>

 <details class="raw" @toggle="(e) => (e.target as HTMLDetailsElement).open && raw === null && loadRaw">
 <summary>Raw transcript</summary>
 <p v-if="rawLoading" class="raw-note">Loading…</p>
 <template v-else-if="raw">
 <p class="raw-note">{{ raw.lines.length }} lines in {{ raw.chunks }} chunk(s), redacted at write.</p>
 <!-- Plain text, never v-html: this is verbatim provider output. -->
 <pre v-if="raw.lines.length > 0" class="rawtext">{{ raw.lines.join('\n') }}</pre>
 <p v-else class="raw-note">Nothing was recorded for this run.</p>
 </template>
 </details>

 <!--
 Teleported so the overlay is a child of <body> rather than of a sidebar column
 that clips and scrolls it.
 -->
 <Teleport to="body">
 <div v-if="reviewing" class="scrim" @click.self="reviewing = false">
 <section class="review" role="dialog" aria-label="Review changes">
 <header class="review-head">
 <div class="titles">
 <h2>Review changes</h2>
 <p class="branch-name":title="props.run.branchName ?? ''">
 {{ shortBranchName(props.run.branchName) }}
 </p>
 </div>
 <div v-if="parsed && parsed.files.length > 0" class="stats">
 <span>{{ parsed.files.length }} file<span v-if="parsed.files.length !== 1">s</span></span>
 <span class="adds">+{{ parsed.additions }}</span>
 <span class="dels">−{{ parsed.deletions }}</span>
 </div>
 <button type="button" class="toggle" @click="split = !split">
 {{ split ? 'Unified': 'Side by side' }}
 </button>
 <button type="button" class="close" aria-label="Close review" @click="reviewing = false">
 ✕
 </button>
 </header>

 <div class="review-body">
 <!--
 The error branch comes first, because `parsed === null` is also what a
 failed load looks like — so without it this panel says "Loading the
 diff…" forever while the real reason sits in a banner behind the scrim.
 -->
 <p v-if="props.fetchError" class="failed">
 Could not load the diff — <strong>{{ props.fetchError }}</strong>
 <button type="button" class="retry" @click="props.run && emit('load-diff', props.run.id)">
 Try again
 </button>
 </p>
 <p v-else-if="parsed === null" class="loading">Loading the diff…</p>
 <p v-else-if="parsed.files.length === 0" class="loading">
 No changes on this branch yet.
 </p>
 <!--
 Structure, never markup: every field below is plain text a diff produced,
 interpolated rather than injected.
 -->
 <DiffFileView
 v-for="file in parsed?.files ?? []"
:key="file.path"
:file="file"
:split="split"
 />
 </div>

 <footer v-if="canDecideDisposition" class="review-foot">
 <button type="button" @click="emit('keep', props.run.id)">Keep branch</button>
 <!-- Irreversible: this deletes the branch and the clone the work is in. -->
 <ConfirmButton
 label="Discard branch"
 confirm-label="Delete this work permanently"
 @confirm="emit('discard', props.run.id)"
 />
 <!--
 Queues; it does not merge. The queue rebases in order and may reach this
 branch behind others, so a label promising a merge
 here would describe something that has not happened.
 -->
 <button type="button" class="primary" @click="queueForMerge(false)">
 Queue for merge
 </button>
 <button type="button" @click="emit('push', props.run.id, false)">Push &amp; open PR</button>
 <button type="button" class="muted" @click="emit('push', props.run.id, true)">
 Push anyway (CI/workflow changes)
 </button>
 </footer>
 <!--
 A reviewer's blocker refusing the queue — the one place
 the swarm's notes ledger gates an action rather than informing one. Rendered
 where the refused button is, with the override beside it: the blocker is a
 model's judgement, so overriding it is the human's to do, and it is stated
 here rather than buried in a banner. Plain interpolation, never markup — the
 text quotes an agent's own note.
 -->
 <p v-if="mergeRefusal" class="blocked">
 {{ mergeRefusal }}
 <ConfirmButton
 label="Queue anyway"
 confirm-label="Merge past the reviewer's objection"
 @confirm="queueForMerge(true)"
 />
 </p>
 <p v-else-if="props.run.branchDisposition" class="review-foot note">
 Branch {{ props.run.branchDisposition }}.
 </p>
 </section>
 </div>
 </Teleport>
 </section>
</template>

<style scoped>
.panel {
 padding: 0.85rem 1rem;
 border: 1px solid var(--border);
 border-radius: 0.6rem;
 background: var(--bg);
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
 font-size: 0.8rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
 color: var(--text-faint);
}

button {
 padding: 0.3rem 0.55rem;
 border: 1px solid var(--border);
 border-radius: 0.375rem;
 background: var(--surface-hover);
 color: var(--text);
 font: inherit;
 cursor: pointer;
}

button:disabled {
 opacity: 0.45;
 cursor: not-allowed;
}

/* The branch name is long and its tail is the identifying part. */
.branch {
 margin: 0;
 font-family: ui-monospace, monospace;
 font-size: 0.72rem;
 color: var(--text-faint);
 white-space: nowrap;
 overflow: hidden;
 direction: rtl;
 text-align: left;
}

.summary {
 display: flex;
 gap: 0.6rem;
 margin-top: 0.3rem;
 font-size: 0.78rem;
 color: var(--text-faint);
}

.adds {
 color: #4ac07a;
}

.dels {
 color: #d4736a;
}

.disposition {
 margin: 0.5rem 0 0;
 font-size: 0.8rem;
 color: var(--text-faint);
}

.raw {
 margin-top: 0.6rem;
 font-size: 0.78rem;
}

.raw summary {
 cursor: pointer;
 color: var(--text-faint);
 font-size: 0.72rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
}

.raw-note {
 margin: 0.35rem 0;
 font-size: 0.72rem;
 color: var(--text-faint);
}

.rawtext {
 margin: 0;
 padding: 0.5rem;
 max-height: 16rem;
 overflow: auto;
 background: var(--surface);
 border-radius: 0.375rem;
 font-size: 0.72rem;
 white-space: pre-wrap;
 overflow-wrap: anywhere;
}

/* ---- the review overlay ---- */

.scrim {
 position: fixed;
 inset: 0;
 z-index: 50;
 display: flex;
 align-items: center;
 justify-content: center;
 padding: 2.5vh 2vw;
 background: rgba(0, 0, 0, 0.55);
}

.review {
 display: flex;
 flex-direction: column;
 width: min(1400px, 100%);
 height: 95vh;
 border: 1px solid var(--border);
 border-radius: 0.6rem;
 background: var(--bg);
 overflow: hidden;
}

.review-head {
 display: flex;
 align-items: center;
 gap: 0.75rem;
 padding: 0.7rem 0.9rem;
 border-bottom: 1px solid var(--border);
}

.titles {
 flex: 1 1 auto;
 min-width: 0;
}

.review-head h2 {
 margin: 0;
 font-size: 0.95rem;
}

.branch-name {
 margin: 0.1rem 0 0;
 font-family: ui-monospace, monospace;
 font-size: 0.72rem;
 color: var(--text-faint);
 white-space: nowrap;
 overflow: hidden;
 text-overflow: ellipsis;
}

.stats {
 display: flex;
 gap: 0.6rem;
 font-size: 0.8rem;
 color: var(--text-faint);
}

.close {
 padding: 0.25rem 0.5rem;
}

.review-body {
 flex: 1 1 auto;
 overflow-y: auto;
 padding: 0.7rem 0.9rem;
}

.loading {
 margin: 0;
 font-size: 0.85rem;
 color: var(--text-faint);
}

.review-foot {
 display: flex;
 flex-wrap: wrap;
 gap: 0.5rem;
 padding: 0.7rem 0.9rem;
 border-top: 1px solid var(--border);
}

.review-foot.note {
 margin: 0;
 font-size: 0.85rem;
 color: var(--text-faint);
}

/**
 * `pre-wrap`, because the refusal is a list of a reviewer's objections and its newlines
 * are its structure — collapsed, three blockers read as one sentence.
 */
.blocked {
 display: flex;
 flex-direction: column;
 align-items: flex-start;
 gap: 0.5rem;
 margin: 0;
 padding: 0.7rem 0.9rem;
 border-top: 1px solid var(--border);
 font-size: 0.85rem;
 line-height: 1.45;
 white-space: pre-wrap;
 color: var(--text);
 background: color-mix(in oklab, var(--warn) 8%, transparent);
}

button.primary {
 border-color: var(--accent);
 background: var(--accent);
 color: var(--accent-contrast);
 font-weight: 600;
}

button.danger {
 border-color: var(--danger);
 color: var(--danger);
}

button.muted {
 opacity: 0.6;
 font-size: 0.75rem;
}
</style>
