<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentPersona, ColosseumSession, ColosseumView } from '@loom/api-contract'

/**
 * The venue, made visible — "a session is a thing on the board with participants, a
 * subject, a cost and an outcome, not a gap in the record where tokens went".
 *
 * Two things this surface has to say that a list of sessions would not, and both are
 * rules rather than decoration:
 *
 * - **An unsettled claim is not an unfinished one.** mastery: "an unsettled disagreement is
 * recorded as one — both claims kept, both scores lowered — and that is a *successful*
 * outcome." Rendering it as pending would train a human to want it resolved, which is
 * exactly the pressure that produces manufactured agreement.
 * - **A session can lose ground**, and it says so. Factual attrition is the measured
 * failure mode of multi-agent debate, so a session that dropped more than it settled is
 * marked rather than left to look productive for having fewer open questions.
 *
 * Every claim, citation and turn is model-authored. Interpolated, never `v-html`.
 */

const props = defineProps<{
 personas: AgentPersona[]
 sessions: ColosseumSession[]
 view: ColosseumView | null
 busy?: boolean
}>

const emit = defineEmits<{
 select: [sessionId: string]
 refresh: []
 convene: [
 input: {
 purpose: 'consultation' | 'contention' | 'crunching' | 'warm_up'
 subject: string
 question: string
 personaIds: string[]
 },
 ]
 claim: [input: { sessionId: string; personaId: string; statement: string }]
 settle: [input: { claimId: string; verdict: 'upheld' | 'refuted'; citation: string }]
 takeTurn: [input: { sessionId: string; personaId?: string }]
 conclude: [sessionId: string]
}>

const purpose = ref<'consultation' | 'contention' | 'crunching' | 'warm_up'>('contention')
const subject = ref('')
const question = ref('')
const roster = ref<string[]>([])

const claimText = ref('')
const claimHolder = ref('')
const citation = ref<Record<string, string>>({})

const canConvene = computed(
 => subject.value.trim !== '' && question.value.trim !== '' && roster.value.length >= 2,
)

const toggleMember = (personaId: string) => {
 roster.value = roster.value.includes(personaId)
 ? roster.value.filter((id) => id !== personaId)
: [...roster.value, personaId]
}

const convene = => {
 if (!canConvene.value) return
 emit('convene', {
 purpose: purpose.value,
 subject: subject.value.trim,
 question: question.value.trim,
 personaIds: [...roster.value],
 })
 question.value = ''
 roster.value = []
}

const addClaim = => {
 const session = props.view?.session
 if (!session || claimHolder.value === '' || claimText.value.trim === '') return
 emit('claim', {
 sessionId: session.id,
 personaId: claimHolder.value,
 statement: claimText.value.trim,
 })
 claimText.value = ''
}

const settle = (claimId: string, verdict: 'upheld' | 'refuted') => {
 const cited = (citation.value[claimId] ?? '').trim
 // Refused here as well as on the server, so the reason arrives before the round trip:
 // the arbiter is the repository, and a verdict with no check is the conversation
 // marking its own homework.
 if (cited === '') return
 emit('settle', { claimId, verdict, citation: cited })
 citation.value = {...citation.value, [claimId]: '' }
}

const personaName = (personaId: string) =>
 props.personas.find((persona) => persona.id === personaId)?.name ?? personaId

const openingClaims = computed( => props.view?.claims ?? [])

/**
 * Whether a turn can be asked for at all, and every reason it cannot — said here rather
 * than only discovered by clicking.
 *
 * The refusals are the venue's own bounds, so they read as facts about the session and not
 * as errors: someone has the floor, the cap is used up, there is no repository for an
 * answer to be checked against.
 */
const speaking = computed( =>
 props.view === null || props.view.session.speakingPersonaId === null
 ? null
: (props.view.participants.find(
 (participant) => participant.personaId === props.view?.session.speakingPersonaId,
)?.personaName ?? 'a participant'),
)

const turnBlocker = computed( => {
 const session = props.view?.session
 if (!session) return 'no session'
 if (session.status === 'concluded' || session.status === 'abandoned') return 'this session has ended'
 if (speaking.value !== null) return `${speaking.value} is speaking`
 if (session.repositoryId === null) {
 return 'this session has no repository, so there is nothing to answer from'
 }
 if ((props.view?.turns.length ?? 0) >= session.turnCap) {
 return `all ${session.turnCap} turns are used`
 }
 return null
})

/** Collapsed by default: convening is rare, and reading a session is why this is open. */
const conveneOpen = ref(false)

const PURPOSE_BLURB: Record<string, string> = {
 consultation: 'one asks, one answers',
 contention: 'two disagree, and that is the point',
 crunching: 'reconcile a subsystem several agents touch',
 warm_up: 'a predecessor briefs its successor',
}

/**
 * What this session came to, in one sentence a human can act on.
 *
 * The wording carries the two rules that a count alone would lose. An unsettled claim
 * is **not** an unfinished one — "an unsettled disagreement is recorded as one, and that
 * is a *successful* outcome" — so it is never phrased as work remaining. And a session
 * that dropped more than it settled is called out, because otherwise it looks productive
 * for having produced *fewer* open questions.
 */
const outcomeLine = computed( => {
 const view = props.view
 if (!view) return ''
 const { upheld, refuted, unsettled, dropped, lostGround } = view.outcome
 if (upheld + refuted + unsettled + dropped === 0) {
 return 'No claims were recorded before this session started, so there is nothing to measure attrition against.'
 }
 if (lostGround) {
 return `This session dropped ${dropped} claim(s) and settled ${upheld + refuted}. It talked itself out of more than it checked.`
 }
 const settled = upheld + refuted
 if (settled === 0) {
 return `${unsettled} claim(s) stand unsettled, and nothing was refuted. That is a recorded disagreement, which is a result.`
 }
 return `${settled} claim(s) settled against a check, ${unsettled} left standing as disagreements.`
})

/**
 * Where the diversity of the roster is stated plainly rather than as two integers.
 *
 * Correlated errors are the mechanism the roster rule exists for, so "one model" is the
 * fact a reader needs — not a number they have to interpret.
 */
const rosterLine = computed( => {
 const session = props.view?.session
 if (!session) return ''
 const subjects =
 session.distinctSubjects === 0
 ? 'nobody brought a map'
: `${session.distinctSubjects} subject${session.distinctSubjects > 1 ? 's': ''}`
 const models =
 session.distinctModels > 1
 ? `${session.distinctModels} models`
: 'one model, so their mistakes correlate'
 return `${subjects} · ${models}`
})

const turnsUsed = computed( => props.view?.turns.length ?? 0)
</script>

<template>
 <section class="colosseum">
 <header class="head">
 <div>
 <h3>The Colosseum</h3>
 <p class="sub">
 Where agents put questions to each other, on the record. Nothing here is settled
 by vote — a claim is settled by a check the repository can answer, and a recorded
 disagreement is a result rather than a loose end.
 </p>
 </div>
 <button type="button" class="ghost" @click="emit('refresh')">Refresh</button>
 </header>

 <!--
 Convening is rare and reading a session is why this panel is open, so the form is
 folded away rather than stacked on top of the thing a human came to look at.
 -->
 <details class="fold":open="conveneOpen || sessions.length === 0">
 <summary @click="conveneOpen = !conveneOpen">Convene a session</summary>
 <form class="convene" @submit.prevent="convene">
 <div class="row">
 <select v-model="purpose" aria-label="Why this session is being convened">
 <option v-for="(blurb, id) in PURPOSE_BLURB":key="id":value="id">
 {{ id.replace('_', '-') }} — {{ blurb }}
 </option>
 </select>
 <input v-model="subject" type="text" placeholder="subject" aria-label="Subject" />
 </div>
 <input
 v-model="question"
 type="text"
 placeholder="the question this session is convened for"
 aria-label="Question"
 />
 <!--
 Roster diversity is a parameter of convening, so the roster is picked here
 and refused server-side when it cannot disagree — two of one persona, or a room
 where nobody holds a map of anything.
 -->
 <p class="hint">
 Pick at least two. A roster whose members bring the same knowledge on the same
 model will be wrong in the same places, so their agreement carries no
 information — the server refuses one.
 </p>
 <div class="roster" role="group" aria-label="Roster">
 <button
 v-for="persona in personas"
:key="persona.id"
 type="button"
:class="{ chosen: roster.includes(persona.id) }"
 @click="toggleMember(persona.id)"
 >
 {{ persona.name }}
 </button>
 </div>
 <button type="submit" class="primary":disabled="!canConvene || props.busy">
 Convene
 </button>
 </form>
 </details>

 <ul v-if="sessions.length > 0" class="sessions">
 <li v-for="entry in sessions":key="entry.id">
 <button
 type="button"
:class="{ active: view?.session.id === entry.id }"
 @click="emit('select', entry.id)"
 >
 <span class="subject">
 {{ entry.subject }}
 <em:class="['status', entry.status]">{{ entry.status }}</em>
 </span>
 <span class="meta">
 {{ entry.purpose.replace('_', '-') }} ·
 {{ entry.distinctSubjects }} subject(s), {{ entry.distinctModels }} model(s)
 <template v-if="entry.speakingRunId"> · someone is speaking</template>
 </span>
 </button>
 </li>
 </ul>
 <p v-else class="empty">
 No session has been convened. Two agents that mastered different parts of a system
 know different things, and the edge between their subjects is what neither can see
 alone.
 </p>

 <template v-if="view">
 <article class="session">
 <!--
 The question first. Everything under it is an answer to it, and a panel that led
 with counters would bury what the room was actually asked.
 -->
 <h4 class="question">{{ view.session.question }}</h4>
 <p class="about">
 {{ view.session.purpose.replace('_', '-') }} on
 <strong>{{ view.session.subject }}</strong> · {{ rosterLine }}
 </p>

 <p:class="['verdict-line', { warn: view.outcome.lostGround }]">{{ outcomeLine }}</p>

 <dl class="tally">
 <div>
 <dt>Upheld</dt>
 <dd>{{ view.outcome.upheld }}</dd>
 </div>
 <div>
 <dt>Refuted</dt>
 <dd>{{ view.outcome.refuted }}</dd>
 </div>
 <div>
 <!-- Not "pending". Mastery: an unsettled disagreement is a successful outcome. -->
 <dt>Standing</dt>
 <dd>{{ view.outcome.unsettled }}</dd>
 </div>
 <div v-if="view.outcome.dropped > 0" class="warnish">
 <dt>Dropped</dt>
 <dd>{{ view.outcome.dropped }}</dd>
 </div>
 <div>
 <dt>Turns</dt>
 <dd>{{ turnsUsed }}<span class="of">/{{ view.session.turnCap }}</span></dd>
 </div>
 </dl>

 <p class="roster-line">
 <span v-for="participant in view.participants":key="participant.personaId" class="who-chip">
 {{ participant.personaName }}
 <em v-if="participant.subjectRef">{{ participant.subjectRef }}</em>
 <em v-else class="brings-nothing">brings no map</em>
 </span>
 </p>
 </article>

 <!--
 The transcript, as a conversation. Every word of it is another model's output, so
 it is interpolated and never `v-html` — and the speaker is named on every
 turn, because a wall of prose with no attribution is what makes one voice taking
 every turn invisible.
 -->
 <section v-if="view.turns.length > 0" class="transcript">
 <h5>What was said</h5>
 <ol>
 <li v-for="turn in view.turns":key="turn.seq">
 <p class="who">
 <span class="n">{{ turn.seq }}</span>{{ turn.personaName }}
 </p>
 <p class="said">{{ turn.text }}</p>
 </li>
 </ol>
 </section>

 <!--
 The exchange itself. One turn is one ordinary agent run — same sandbox, same
 metering, same kill switch — so the turn counter beside it is the spend bound a
 human actually reads, and the named participant buttons are there because a
 session where one voice takes every turn is the roster check undone at exchange
 time.
 -->
 <div
 v-if="view.session.status !== 'concluded' && view.session.status !== 'abandoned'"
 class="floor"
 >
 <div class="row">
 <button
 type="button"
 class="primary"
:disabled="props.busy || turnBlocker !== null"
 @click="emit('takeTurn', { sessionId: view.session.id })"
 >
 {{ turnsUsed === 0 ? 'Open the session': 'Next to speak' }}
 </button>
 <span class="or">or ask one of them:</span>
 <span class="roster" role="group" aria-label="Ask one participant to speak">
 <button
 v-for="participant in view.participants"
:key="participant.personaId"
 type="button"
:disabled="props.busy || turnBlocker !== null"
 @click="
 emit('takeTurn', { sessionId: view.session.id, personaId: participant.personaId })
 "
 >
 {{ participant.personaName }}
 </button>
 </span>
 </div>
 <p v-if="turnBlocker" class="hint">Nobody can speak: {{ turnBlocker }}.</p>
 <p v-else class="hint">
 A turn is an ordinary run — sandboxed, metered, and stoppable by the kill switch.
 </p>
 </div>

 <!--
 Opening claims only. A claim entered after the first exchange cannot be told apart
 from one the conversation produced, and that distinction is the only thing that
 makes attrition measurable.
 -->
 <section class="claims-block">
 <h5>
 Claims held before anyone spoke
 <em v-if="view.session.status !== 'convened'">— closed, the session has started</em>
 </h5>

 <form v-if="view.session.status === 'convened'" class="claim" @submit.prevent="addClaim">
 <select v-model="claimHolder" aria-label="Who holds this claim">
 <option value="" disabled>who holds it…</option>
 <option
 v-for="participant in view.participants"
:key="participant.personaId"
:value="participant.personaId"
 >
 {{ participant.personaName }}
 </option>
 </select>
 <input
 v-model="claimText"
 type="text"
 placeholder="what they hold, before anyone speaks"
 aria-label="Opening claim"
 />
 <button type="submit":disabled="props.busy">Record</button>
 </form>

 <ul v-if="openingClaims.length > 0" class="claims">
 <li v-for="claim in openingClaims":key="claim.id":class="claim.verdict">
 <p class="statement">{{ claim.statement }}</p>
 <p class="held">
 {{ personaName(claim.originalHolderPersonaId) }} ·
 <strong>{{ claim.verdict === 'unsettled' ? 'standing': claim.verdict }}</strong>
 <template v-if="claim.citation"> — {{ claim.citation }}</template>
 <template v-else-if="claim.verdict === 'unsettled'">
 — nothing outside the conversation has checked it, and that is a result
 </template>
 </p>
 <div v-if="claim.verdict === 'unsettled' && claim.droppedAt === null" class="settle">
 <input
:value="citation[claim.id] ?? ''"
 type="text"
 placeholder="the check that settles it — a test, a command, a commit"
:aria-label="`What settles ${claim.statement}`"
 @input="
 citation = {...citation, [claim.id]: ($event.target as HTMLInputElement).value }
 "
 />
 <button type="button" @click="settle(claim.id, 'upheld')">Upheld</button>
 <button type="button" @click="settle(claim.id, 'refuted')">Refuted</button>
 </div>
 </li>
 </ul>
 <p v-else class="hint">
 Nothing was recorded. Without an opening position there is no way to tell a claim
 the room abandoned from one nobody ever made.
 </p>
 </section>

 <button
 v-if="view.session.status !== 'concluded' && view.session.status !== 'abandoned'"
 type="button"
 class="link"
:disabled="props.busy"
 @click="emit('conclude', view.session.id)"
 >
 Conclude this session — it writes no map and promotes nothing
 </button>
 </template>
 </section>
</template>

<style scoped>
.colosseum {
 display: flex;
 flex-direction: column;
 gap: 0.7rem;
}

.head {
 display: flex;
 align-items: flex-start;
 justify-content: space-between;
 gap: 0.6rem;
}

h3 {
 margin: 0;
 font-size: 0.85rem;
}

h4 {
 margin: 0;
 font-size: 0.85rem;
 line-height: 1.4;
}

h5 {
 margin: 0 0 0.35rem;
 font-size: 0.68rem;
 font-weight: 600;
 text-transform: uppercase;
 letter-spacing: 0.05em;
 color: var(--text-faint);
}

h5 em {
 font-style: normal;
 font-weight: 400;
 text-transform: none;
 letter-spacing: 0;
}

.sub,
.hint {
 margin: 0.15rem 0 0;
 font-size: 0.72rem;
 color: var(--text-faint);
 line-height: 1.55;
}

.ghost {
 padding: 0.2rem 0.5rem;
 border: 1px solid var(--border);
 border-radius: 0.35rem;
 background: var(--bg);
 color: var(--text-muted);
 font: inherit;
 font-size: 0.72rem;
 cursor: pointer;
}

/* Convening is rare; reading a session is why this panel is open. */
.fold > summary {
 cursor: pointer;
 font-size: 0.75rem;
 color: var(--accent);
 list-style: none;
}

.fold > summary::before {
 content: '+ ';
}

.fold[open] > summary::before {
 content: '− ';
}

.convene,
.claim {
 display: flex;
 flex-direction: column;
 gap: 0.35rem;
 margin-top: 0.4rem;
 padding: 0.55rem 0.6rem;
 border: 1px solid var(--border);
 border-radius: 0.4rem;
}

.claim {
 flex-direction: row;
 flex-wrap: wrap;
 align-items: center;
 margin-top: 0;
}

.row {
 display: flex;
 flex-wrap: wrap;
 gap: 0.35rem;
}

.convene input,
.convene select,
.claim input,
.claim select {
 flex: 1 1 8rem;
 min-width: 0;
 padding: 0.25rem 0.35rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
 font-size: 0.75rem;
}

.roster {
 display: flex;
 flex-wrap: wrap;
 gap: 0.3rem;
}

.roster button,
.settle button,
.claim button {
 padding: 0.12rem 0.45rem;
 border: 1px solid var(--border);
 border-radius: 0.8rem;
 background: var(--bg);
 color: var(--text-muted);
 font: inherit;
 font-size: 0.7rem;
 cursor: pointer;
}

.roster button.chosen {
 border-color: var(--accent);
 color: var(--accent);
}

.roster button:disabled {
 opacity: 0.45;
 cursor: default;
}

.primary {
 align-self: flex-start;
 padding: 0.25rem 0.6rem;
 border: 0;
 border-radius: 0.35rem;
 background: var(--accent);
 color: var(--accent-contrast);
 font: inherit;
 font-size: 0.75rem;
 font-weight: 600;
 cursor: pointer;
}

.primary:disabled {
 opacity: 0.45;
 cursor: default;
}

.sessions,
.claims {
 margin: 0;
 padding: 0;
 list-style: none;
 display: flex;
 flex-direction: column;
 gap: 0.3rem;
}

.sessions button {
 width: 100%;
 display: flex;
 flex-direction: column;
 align-items: flex-start;
 gap: 0.1rem;
 padding: 0.3rem 0.4rem;
 border: 1px solid var(--border);
 border-radius: 0.35rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
 text-align: left;
 cursor: pointer;
}

.sessions button.active {
 border-color: var(--accent);
}

.subject {
 display: flex;
 align-items: baseline;
 gap: 0.4rem;
 font-size: 0.78rem;
}

.status {
 font-style: normal;
 font-size: 0.62rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
 color: var(--text-faint);
}

.status.running {
 color: var(--accent);
}

.status.abandoned {
 color: var(--danger, #b42318);
}

.meta {
 font-size: 0.68rem;
 color: var(--text-faint);
}

/* The open session: the question first, because everything under it answers it. */
.session {
 padding: 0.6rem 0.7rem;
 border: 1px solid var(--border);
 border-radius: 0.45rem;
 background: var(--surface-hover, transparent);
}

.about {
 margin: 0.2rem 0 0;
 font-size: 0.7rem;
 color: var(--text-faint);
}

.verdict-line {
 margin: 0.45rem 0 0;
 font-size: 0.75rem;
 line-height: 1.55;
}

.verdict-line.warn {
 color: var(--danger, #b42318);
}

.tally {
 display: flex;
 flex-wrap: wrap;
 gap: 0.9rem;
 margin: 0.5rem 0 0;
}

.tally dt {
 font-size: 0.62rem;
 color: var(--text-faint);
 text-transform: uppercase;
 letter-spacing: 0.05em;
}

.tally dd {
 margin: 0;
 font-size: 0.9rem;
}

.tally.of {
 font-size: 0.7rem;
 color: var(--text-faint);
}

.tally.warnish dd {
 color: var(--danger, #b42318);
}

.roster-line {
 display: flex;
 flex-wrap: wrap;
 gap: 0.3rem;
 margin: 0.5rem 0 0;
}

.who-chip {
 display: inline-flex;
 align-items: baseline;
 gap: 0.25rem;
 padding: 0.1rem 0.4rem;
 border: 1px solid var(--border);
 border-radius: 0.8rem;
 font-size: 0.7rem;
}

.who-chip em {
 font-style: normal;
 font-size: 0.64rem;
 color: var(--text-faint);
}

.who-chip.brings-nothing {
 opacity: 0.7;
}

/* A conversation, not a list. Every word of it is another model's output. */
.transcript ol {
 margin: 0;
 padding: 0;
 list-style: none;
 display: flex;
 flex-direction: column;
 gap: 0.5rem;
}

.transcript li {
 padding: 0.4rem 0.5rem;
 border-left: 2px solid var(--border);
}

.transcript.who {
 margin: 0;
 display: flex;
 align-items: baseline;
 gap: 0.4rem;
 font-size: 0.7rem;
 font-weight: 600;
 color: var(--text-muted);
}

.transcript.n {
 font-weight: 400;
 font-size: 0.62rem;
 color: var(--text-faint);
}

.transcript.said {
 margin: 0.2rem 0 0;
 font-size: 0.74rem;
 line-height: 1.6;
 white-space: pre-wrap;
}

.floor {
 display: flex;
 flex-direction: column;
 gap: 0.35rem;
 padding: 0.55rem 0.6rem;
 border: 1px solid var(--border);
 border-radius: 0.4rem;
}

.floor.row {
 align-items: center;
 gap: 0.5rem;
}

.or {
 font-size: 0.7rem;
 color: var(--text-faint);
}

.claims-block {
 display: flex;
 flex-direction: column;
 gap: 0.35rem;
}

.claims li {
 padding: 0.4rem 0.5rem;
 border: 1px solid var(--border);
 border-radius: 0.35rem;
}

.claims li.upheld {
 border-color: var(--ok);
}

.claims li.refuted {
 border-color: var(--danger, #b42318);
}

.statement {
 margin: 0;
 font-size: 0.78rem;
}

.held {
 margin: 0.1rem 0 0;
 font-size: 0.68rem;
 color: var(--text-faint);
}

.settle {
 display: flex;
 flex-wrap: wrap;
 gap: 0.3rem;
 margin-top: 0.3rem;
}

.settle input {
 flex: 1 1 12rem;
 min-width: 0;
 padding: 0.2rem 0.3rem;
 border: 1px solid var(--border);
 border-radius: 0.3rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
 font-size: 0.72rem;
}

.empty {
 margin: 0;
 font-size: 0.75rem;
 color: var(--text-faint);
 line-height: 1.5;
}

.link {
 align-self: flex-start;
 border: 0;
 padding: 0;
 background: none;
 color: var(--accent);
 font: inherit;
 font-size: 0.75rem;
 cursor: pointer;
}
</style>
