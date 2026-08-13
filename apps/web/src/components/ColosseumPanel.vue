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
</script>

<template>
 <section class="colosseum">
 <header class="head">
 <div>
 <h3>The Colosseum</h3>
 <p class="sub">
 A bounded, recorded session with a fixed roster. Nothing here is settled by vote —
 a claim is settled by a check the repository can answer, and a recorded
 disagreement is a successful outcome.
 </p>
 </div>
 <button type="button" @click="emit('refresh')">Refresh</button>
 </header>

 <form class="convene" @submit.prevent="convene">
 <div class="row">
 <select v-model="purpose" aria-label="Why this session is being convened">
 <option value="consultation">consultation — one asks, one answers</option>
 <option value="contention">contention — two disagree</option>
 <option value="crunching">crunching — reconcile a shared subsystem</option>
 <option value="warm_up">warm-up — brief a successor</option>
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

 <ul v-if="sessions.length > 0" class="sessions">
 <li v-for="entry in sessions":key="entry.id">
 <button
 type="button"
:class="{ active: view?.session.id === entry.id }"
 @click="emit('select', entry.id)"
 >
 <span class="subject">{{ entry.subject }}</span>
 <span class="meta">
 {{ entry.purpose }} · {{ entry.status }} ·
 {{ entry.distinctSubjects }} subject(s), {{ entry.distinctModels }} model(s)
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
 <div class="outcome">
 <p class="question">{{ view.session.question }}</p>
 <dl>
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
 <dt>Unsettled</dt>
 <dd>{{ view.outcome.unsettled }}</dd>
 </div>
 <div v-if="view.outcome.dropped > 0">
 <dt>Dropped</dt>
 <dd>{{ view.outcome.dropped }}</dd>
 </div>
 </dl>
 <p v-if="view.outcome.lostGround" class="warn">
 This session dropped more claims than it settled. That is the shape of a
 conversation that talked itself out of what it knew — the measured failure mode of
 multi-agent debate, not a sign that it went well.
 </p>
 <p class="sub">
 Roster: {{ view.participants.map((p) => p.personaName).join(', ') }} ·
 turn cap {{ view.session.turnCap }}
 </p>
 </div>

 <form v-if="view.session.status === 'convened'" class="claim" @submit.prevent="addClaim">
 <!--
 Opening claims only. A claim entered after the first exchange cannot be told
 apart from one the conversation produced, and that distinction is the only thing
 that makes attrition measurable.
 -->
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
 held at the opening by {{ personaName(claim.originalHolderPersonaId) }} ·
 <strong>{{ claim.verdict }}</strong>
 <template v-if="claim.citation"> — {{ claim.citation }}</template>
 </p>
 <div v-if="claim.verdict === 'unsettled' && claim.droppedAt === null" class="settle">
 <input
:value="citation[claim.id] ?? ''"
 type="text"
 placeholder="the check that settles it — a test, a command, a commit"
:aria-label="`What settles ${claim.statement}`"
 @input="citation = {...citation, [claim.id]: ($event.target as HTMLInputElement).value }"
 />
 <button type="button" @click="settle(claim.id, 'upheld')">Upheld</button>
 <button type="button" @click="settle(claim.id, 'refuted')">Refuted</button>
 </div>
 </li>
 </ul>

 <ol v-if="view.turns.length > 0" class="turns">
 <li v-for="turn in view.turns":key="turn.seq">
 <span class="who">{{ turn.personaName }}</span>
 <span class="said">{{ turn.text }}</span>
 </li>
 </ol>

 <!--
 The exchange itself. One turn is one ordinary agent run — same sandbox, same
 metering, same kill switch — so the turn counter beside it is the spend bound a
 human actually reads, and the named participant buttons are there because a
 session where one voice takes every turn is the roster check undone at exchange
 time.
 -->
 <div v-if="view.session.status !== 'concluded' && view.session.status !== 'abandoned'" class="floor">
 <div class="row">
 <button
 type="button"
 class="primary"
:disabled="props.busy || turnBlocker !== null"
 @click="emit('takeTurn', { sessionId: view.session.id })"
 >
 Take a turn
 </button>
 <span class="meta">{{ view.turns.length }} of {{ view.session.turnCap }} turns</span>
 </div>
 <div class="roster" role="group" aria-label="Ask one participant to speak">
 <button
 v-for="participant in view.participants"
:key="participant.personaId"
 type="button"
:disabled="props.busy || turnBlocker !== null"
 @click="emit('takeTurn', { sessionId: view.session.id, personaId: participant.personaId })"
 >
 {{ participant.personaName }}
 </button>
 </div>
 <p v-if="turnBlocker" class="empty">Nobody can speak: {{ turnBlocker }}.</p>
 </div>

 <button
 v-if="view.session.status !== 'concluded' && view.session.status !== 'abandoned'"
 type="button"
 class="link"
:disabled="props.busy"
 @click="emit('conclude', view.session.id)"
 >
 Conclude this session
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

.sub {
 margin: 0.15rem 0 0;
 font-size: 0.72rem;
 color: var(--text-faint);
 line-height: 1.5;
}

.convene,
.claim {
 display: flex;
 flex-direction: column;
 gap: 0.35rem;
 padding: 0.55rem 0.6rem;
 border: 1px solid var(--border);
 border-radius: 0.4rem;
}

.claim {
 flex-direction: row;
 flex-wrap: wrap;
 align-items: center;
}

.row {
 display: flex;
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

.floor button:disabled {
 opacity: 0.5;
 cursor: default;
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

.meta {
 font-size: 0.68rem;
 color: var(--text-faint);
}

.outcome dl {
 display: flex;
 flex-wrap: wrap;
 gap: 0.8rem;
 margin: 0.3rem 0;
}

.outcome dt {
 font-size: 0.65rem;
 color: var(--text-faint);
 text-transform: uppercase;
 letter-spacing: 0.04em;
}

.outcome dd {
 margin: 0;
 font-size: 0.85rem;
}

.question {
 margin: 0;
 font-size: 0.8rem;
}

.warn {
 margin: 0;
 font-size: 0.72rem;
 color: var(--danger, #b42318);
 line-height: 1.5;
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

.turns {
 margin: 0;
 padding-left: 1.1rem;
 font-size: 0.74rem;
 display: flex;
 flex-direction: column;
 gap: 0.2rem;
}

.who {
 color: var(--text-faint);
 margin-right: 0.35rem;
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
