<script setup lang="ts">
import type {
  AgentRun,
  ApprovalRequest,
  MergeQueueEntry,
  Prosecution,
  RunVerification,
} from '@loom/api-contract'
import {
  attentionReason,
  buildInboxBoard,
  describeAge,
  shortBranchName,
} from '@loom/client-core'
import { describeVerification, summariseProsecution, verificationFailureOutput } from '@loom/domain'
import { computed, onMounted, ref, watch } from 'vue'
import ApprovalCard from './ApprovalCard.vue'
import DiffView from './DiffView.vue'

const props = defineProps<{
  runs: AgentRun[]
  /**
   * What the swarm produced and a human already decided about.
   *
   * The half the Inbox never had. "What is waiting on me" gets someone through a day;
   * "what came out" is the question anyone supervising a swarm actually has, and it was
   * answerable only by opening runs one at a time.
   */
  settled: AgentRun[]
  /**
   * What each branch did against its repository's definition of done. On the card rather
   * than in a lane of its own: a branch that failed its checks is still one a human decides
   * about, and the next action is unchanged — what changed is what they will find when they
   * open it.
   */
  verifications: RunVerification[]
  /**
   * What a prosecutor found in these runs' diffs. A separate prop from the verifications
   * for the reason they are separate rows: a verdict and a piece of evidence are different
   * kinds of thing, and a component handed them as one list would render them as one.
   */
  prosecutions?: Prosecution[]
  mergeQueue: MergeQueueEntry[]
  selectedRun: AgentRun | null
  approvals: ApprovalRequest[]
  diff: string | null
  /**
   * The last Inbox fetch's failure, if it failed.
   *
   * Without it this list renders "Nothing needs you right now" whenever the fetch
   * errored — telling a human that nothing is waiting on them at the exact moment the
   * app cannot know that. It is the one false statement here that costs something.
   */
  fetchError: string | null
  /** The diff overlay's own failure — passed through to DiffView. */
  diffError: string | null
  /** Distinguishes "not fetched yet" from "fetched, and genuinely empty". */
  loading: boolean
}>()

const emit = defineEmits<{
  select: [agentRunId: string]
  decide: [approvalRequestId: string, decision: 'approve' | 'deny', answer?: string]
  'load-diff': [agentRunId: string]
  keep: [agentRunId: string]
  discard: [agentRunId: string]
  push: [agentRunId: string, acknowledgeCiChange: boolean]
  merge: [
    agentRunId: string,
    override: boolean,
    done: (result: { ok: boolean; reason: string | null }) => void,
  ]
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
  /** Dismisses the review overlay. */
  close: []
  refresh: []
}>()

/**
 * Every row used to read "swe · COMPLETED · branch ready to review", which for five
 * queued reviews is five identical rows: nothing to choose between them, and no sign
 * that the list is ordered by how long each has been waiting. Cost and age are what
 * make the ordering legible and the choice possible, and both are already on the run.
 */
const money = (usd: number | null) => (usd === null ? null : `$${usd.toFixed(4)}`)

const finishedAt = (run: AgentRun): Date => run.completedAt ?? run.createdAt

/**
 * The board. Lanes are *what a human does next*, not what status a row is
 * in — see `buildInboxBoard`, where the derivation lives so a TUI reaches the same board.
 */
const lanes = computed(() =>
  buildInboxBoard({
    needsAttention: props.runs,
    settled: props.settled,
    mergeQueue: props.mergeQueue,
    verifications: props.verifications,
    prosecutions: props.prosecutions,
  }),
)

/**
 * Columns, left to right, in the order work moves through them: blocked, reviewable,
 * stopped, queued, landed, dropped.
 *
 * Side by side rather than stacked, because the question the board answers is a
 * *comparison* — how much is waiting against how much has landed — and a stack answers it
 * only for whoever scrolls to the bottom. It is also why nothing collapses: a column with
 * nothing in it is an answer, and hiding it turns "nothing is blocked" into "I did not
 * check".
 */
const total = computed(() => lanes.value.reduce((sum, lane) => sum + lane.cards.length, 0))

/**
 * Review opens over the board, not beside it.
 *
 * A side panel had to be paid for out of the board's width, and the columns paid — six of
 * them squeezed until the last one was unreadable. The board is the thing a human is
 * comparing; the review is one card at a time, and one-at-a-time is what an overlay is for.
 *
 * The same shape as the settings and graph overlays, including the part this repository
 * got wrong once: the Escape handler sits on an element that is actually focused, or it
 * never fires and the dialog claims `aria-modal` while being closable only by its ✕.
 */
/**
 * What the definition of done said about the run being reviewed, and what the check that
 * failed actually printed.
 *
 * The card names the check — "the tests check failed" — and stops there, so the next move
 * for a human deciding about this branch was to re-run a command the platform had already
 * run and stored the tail of. The overlay is where it belongs rather than the card: a
 * board is for comparing six lanes at a glance, and a wall of command output in a column
 * destroys exactly that, while a review is one run at a time and has the room.
 */
const selectedVerification = computed(
  () => props.verifications.find((record) => record.agentRunId === props.selectedRun?.id) ?? null,
)

const selectedProsecution = computed(
  () =>
    (props.prosecutions ?? []).find(
      (record) => record.agentRunId === props.selectedRun?.id,
    ) ?? null,
)

const selectedFailureOutput = computed(() =>
  selectedVerification.value ? verificationFailureOutput(selectedVerification.value) : null,
)

const scrim = ref<HTMLElement | null>(null)
const focusScrim = () => scrim.value?.focus()
onMounted(focusScrim)
watch(() => props.selectedRun?.id, focusScrim)

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') emit('close')
}
</script>

<template>
  <div class="inbox">
    <div class="board">
      <p v-if="props.fetchError" class="notice failed">
        Could not load the inbox — <strong>{{ props.fetchError }}</strong>
        <button type="button" class="retry" @click="emit('refresh')">Try again</button>
      </p>
      <p v-else-if="props.loading && total === 0" class="notice empty">Loading…</p>
      <p v-else-if="total === 0" class="notice empty">
        Nothing has come out of this workspace yet. Start a run and its branch will land
        here.
      </p>

      <!--
        Lanes are what a human does next, not what status a row is in. A failed run with a
        branch and a completed run with a branch have different statuses and the same next
        action; a merged run and a discarded run share a status and have nothing left to do.
      -->
      <div class="columns">
      <section
        v-for="lane in lanes"
        :key="lane.id"
        class="lane"
        :class="lane.id"
      >
        <header class="lane-head">
          <span class="lane-title">{{ lane.title }}</span>
          <span class="count">{{ lane.cards.length }}</span>
        </header>

        <ul class="cards">
          <li
            v-for="card in lane.cards"
            :key="card.run.id"
            class="row"
            :class="{ selected: card.run.id === props.selectedRun?.id }"
            role="button"
            tabindex="0"
            :aria-current="card.run.id === props.selectedRun?.id ? 'true' : undefined"
            @click="emit('select', card.run.id)"
            @keydown.enter.prevent="emit('select', card.run.id)"
            @keydown.space.prevent="emit('select', card.run.id)"
          >
            <div class="line">
              <strong>{{ card.run.persona.name }}</strong>
              <span class="age">{{ describeAge(finishedAt(card.run)) }}</span>
            </div>
            <span class="reason">{{ card.summary }}</span>
            <!--
              Named, never a bare tick or cross: "the build check failed" sends a human
              to the build, and "verification failed" sends them to open a log. `pending`
              is shown too, because a blank where a verdict is coming reads as a pass.
            -->
            <span
              v-if="card.verification"
              class="verdict"
              :class="card.verification.status"
              :title="card.verification.reason ?? undefined"
            >
              {{
                describeVerification({
                  status: card.verification.status,
                  checks: card.verification.checks,
                  reason: card.verification.reason,
                })
              }}
            </span>
            <div class="line meta">
              <span v-if="card.run.branchName" class="branch" :title="card.run.branchName">{{
                shortBranchName(card.run.branchName)
              }}</span>
              <span v-if="money(card.run.totalCostUsd)" class="cost">{{
                money(card.run.totalCostUsd)
              }}</span>
            </div>
          </li>
          <li v-if="lane.cards.length === 0" class="lane-empty">{{ lane.empty }}</li>
        </ul>
      </section>
      </div>
    </div>

    <!--
      Review opens over the board rather than beside it. A side panel is paid for out of
      the board's width, and the columns paid it — six of them squeezed until the last was
      unreadable. The board is what a human compares; a review is one card at a time.
    -->
    <div
      v-if="props.selectedRun"
      ref="scrim"
      class="scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Review this run"
      tabindex="-1"
      @keydown="onKeydown"
      @click.self="emit('close')"
    >
      <section class="sheet">
        <button type="button" class="close" aria-label="Close review" @click="emit('close')">
          ✕
        </button>

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

        <!--
          The verdict, and underneath it the tail of the check that failed. Plain
          interpolation into a <pre>: this is command output from a repository, so it is
          text to display and never markup to render.
        -->
        <section v-if="selectedVerification" class="verification">
          <p class="verdict" :class="selectedVerification.status">
            {{
              describeVerification({
                status: selectedVerification.status,
                checks: selectedVerification.checks,
                reason: selectedVerification.reason,
              })
            }}
          </p>
          <pre v-if="selectedFailureOutput" class="check-output">{{
            selectedFailureOutput.output
          }}</pre>
        </section>

        <!--
          The prosecutor's evidence, deliberately *below* the verdict and deliberately not
          styled like one. It is a test somebody wrote because of this diff and then ran, and
          it decides nothing: the repository's checks above are what a merge turns on. The
          heading says so in words rather than relying on the reader to know, because "test
          failed" is a phrase that carries authority whether or not it has any.
        -->
        <section v-if="selectedProsecution" class="prosecution">
          <h3>
            Probes written for this diff
            <span class="not-a-verdict">evidence — nothing here blocks a merge</span>
          </h3>
          <p class="summary">{{ summariseProsecution(selectedProsecution) }}</p>
          <ul v-if="selectedProsecution.observations.length > 0" class="observations">
            <li
              v-for="(observation, index) in selectedProsecution.observations"
              :key="index"
              :class="observation.outcome"
            >
              <span class="outcome">{{ observation.outcome === 'broke' ? 'broke' : 'held' }}</span>
              <span class="name">{{ observation.name }}</span>
              <pre v-if="observation.detail" class="check-output">{{ observation.detail }}</pre>
            </li>
          </ul>
        </section>

        <ApprovalCard :approvals="props.approvals" @decide="(id, decision, answer) => emit('decide', id, decision, answer)" />
        <DiffView
          :run="props.selectedRun"
          :diff="props.diff"
          :fetch-error="props.diffError"
          @load-diff="(agentRunId) => emit('load-diff', agentRunId)"
          @keep="(agentRunId) => emit('keep', agentRunId)"
          @discard="(agentRunId) => emit('discard', agentRunId)"
          @push="(agentRunId, ack) => emit('push', agentRunId, ack)"
          @merge="(agentRunId, override, done) => emit('merge', agentRunId, override, done)"
          @load-raw="(agentRunId, done) => emit('load-raw', agentRunId, done)"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.inbox {
  display: flex;
  height: 100%;
  min-height: 0;
}

/*
 * The board fills the region and its columns run left to right in the order work moves
 * through them. Horizontal overflow scrolls rather than wrapping: a column that wrapped
 * onto a second row stops being comparable with the ones beside it, which is the only
 * thing this layout is for.
 */
.board {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.6rem;
  overflow: hidden;
}

.columns {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 0.5rem;
  overflow-x: auto;
  overflow-y: hidden;
}

.lane {
  /*
   * Fixed width, and the row scrolls. Columns that shrank to fit stayed on screen and
   * stopped being readable — a card three words wide is not a card — and there is nothing
   * to be gained by seeing all six at once if none of them can be read. Now the board is
   * the width it needs and the last column is a scroll away, which is what a board is.
   */
  flex: 0 0 17rem;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: var(--surface-hover, transparent);
}

.notice {
  margin: 0;
  padding: 0.2rem 0.1rem;
}

.lane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  padding: 0.4rem 0.55rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 0.66rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.lane-title {
  flex: 1;
}

/* The two lanes that are actually asking for something read louder than the record. */
.lane.needs-you .lane-head,
.lane.review .lane-head {
  color: var(--text);
}

.lane.needs-you .count {
  color: var(--warn, var(--accent));
}

.count {
  font-variant-numeric: tabular-nums;
}

.cards {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0.35rem;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  overflow-y: auto;
}

/*
  The verdict reads as information on every card and as a warning on exactly one — a
  failed definition of done is the only one that contradicts what the lane already said.
*/
.verdict {
  margin-top: 0.15rem;
  font-size: 0.7rem;
  color: var(--text-faint);
}

.verdict.failed {
  color: var(--danger, #c66);
}

.verdict.passed {
  color: var(--text-muted);
}

.lane-empty {
  padding: 0.2rem 0.25rem;
  font-size: 0.68rem;
  color: var(--text-faint);
  line-height: 1.5;
}

.failed .retry {
  margin-left: 0.4rem;
}

.empty,
.hint {
  padding: 1rem 1.25rem;
  color: var(--text-faint);
  font-size: 0.85rem;
}

/* Deliberately not styled like `.empty`: the whole point is that it must not read
   as "all clear". */
.failed {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 1rem 1.25rem;
  color: var(--danger, #b4443a);
  font-size: 0.85rem;
}

.retry {
  border: 0;
  padding: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  /*
   * A card, and the lane it sits in carries the meaning — the flat list had to encode
   * "why is this here" as a stripe per row because there was nothing else to say it.
   */
  border-left-width: 3px;
  border-left-color: transparent;
  cursor: pointer;
}

.lane.needs-you .row {
  border-left-color: var(--warn, var(--accent));
}

.lane.stopped .row {
  border-left-color: var(--danger, #b42318);
}

.lane.review .row {
  border-left-color: var(--accent);
}

.lane.landed .row {
  border-left-color: var(--ok);
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

/*
 * The review, over the board. Same shape as the settings and graph overlays.
 *
 * `position: fixed` so it escapes the board's own `overflow: hidden` — the board clips its
 * columns on purpose, and a panel that lived inside that clip was laid out as a flex item
 * beside them, at whatever width its content happened to want.
 */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  /* A drawer off the right edge, not a modal in the middle: the board stays where it was,
     so closing the review puts a human back exactly where they were reading. */
  align-items: stretch;
  justify-content: flex-end;
  background: rgba(0, 0, 0, 0.45);
}

/*
 * One width, whatever is in it. Sized by content, the panel was a different shape for
 * every card — wide for a long error, narrow for a short one — so nothing on it ever sat
 * where it had been a moment before.
 */
.sheet {
  position: relative;
  width: min(34rem, 100%);
  height: 100%;
  overflow-y: auto;
  padding: 1.1rem 1.2rem;
  border-left: 1px solid var(--border);
  background: var(--bg);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.sheet .close {
  position: absolute;
  top: 0.5rem;
  right: 0.6rem;
  border: 0;
  padding: 0.15rem 0.35rem;
  background: none;
  color: var(--text-faint);
  font: inherit;
  font-size: 0.95rem;
  cursor: pointer;
}

.run-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.6rem 1rem;
  flex-wrap: wrap;
  /* Room for the close button, which is pinned to the sheet's corner and would otherwise
     sit on top of whichever fact happened to be last. */
  padding: 0 1.6rem 0.6rem 0;
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

.titles .reason {
  margin: 0.15rem 0 0;
  color: var(--text-muted);
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.25rem;
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

/*
 * The verdict block in the review, which is not the one on a card: there the verdict is a
 * seventh line under six others, here it is a section a human is reading on purpose. The
 * output is monospaced and scrolls rather than wrapping — the tail is at most twelve lines
 * of a command's own formatting, and rewrapping it turns a column of test names into prose.
 */
.verification {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.verification .verdict {
  margin: 0;
  font-size: 0.85rem;
}

/*
  Quieter than the verdict above it, on purpose. This section is a reviewer's reading
  material, and giving it the weight of the thing that decides is how a reader starts
  treating it as one.
*/
.prosecution {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border);
}

.prosecution h3 {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0;
  font-size: 0.8rem;
  font-weight: 600;
}

.prosecution .not-a-verdict {
  color: var(--text-faint);
  font-size: 0.7rem;
  font-weight: 400;
}

.prosecution .summary {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.8rem;
}

.prosecution .observations {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.prosecution .observations li {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.8rem;
}

.prosecution .outcome {
  padding: 0 0.35rem;
  border-radius: 999px;
  background: var(--surface-hover);
  color: var(--text-muted);
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/*
  A broken probe is worth looking at and is still not a failure, so it is marked rather
  than coloured with `--danger` — that colour in this app means something was refused.
*/
.prosecution .observations li.broke .outcome {
  background: var(--accent-soft);
  color: var(--accent);
}

.prosecution .observations li .check-output {
  grid-column: 1 / -1;
}

.check-output {
  margin: 0;
  padding: 0.5rem 0.7rem;
  max-height: 14rem;
  overflow: auto;
  border-radius: 0.4rem;
  background: var(--surface-hover, var(--surface));
  color: var(--text-muted);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.75rem;
  line-height: 1.45;
  white-space: pre;
  tab-size: 2;
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
