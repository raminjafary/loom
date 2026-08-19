<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  buildMapGraph,
  coveragePercent,
  describeMasteryState,
  undrawnNodeCount,
  type MapGraphNode,
} from '@loom/client-core'
import { FOCUS_BY_SUBJECT } from '@loom/domain'
import type {
  AgentPersona,
  MasteryView,
  Repository,
  SubjectMap,
  SubjectMapListing,
} from '@loom/api-contract'

/**
 * A persona's expertise, drawn.
 *
 * **The provenance split is a security requirement here, not a style choice**, exactly
 * as the author split is in WorkerNotesPanel. Mastery: the map's trusted half is parsed and
 * its untrusted half is a model's conclusion, and "an inferred edge must not look like a
 * parsed one". So parsed claims are solid and plain; inferred ones are dashed, tinted,
 * and labelled as conclusions wherever they appear. A viewer who cannot tell them apart
 * has no basis for trusting either.
 *
 * Everything is interpolation. No `v-html` near a label or a summary — a node's
 * text is model-authored in the general case.
 */

const props = defineProps<{
  /** What the last curation pass did, when a human ran one from here. */
  curation?: {
    checked: number
    kept: number
    retired: number
    proposed: number
    withdrawn: number
  } | null
  personas: AgentPersona[]
  personaId: string | null
  repositories: Repository[]
  maps: SubjectMapListing[]
  view: MasteryView | null
  loading: boolean
  error: string | null
  /** Repository id → display name, so a map says which codebase it is of. */
  repositoryNames: Record<string, string>
  /** The repository this persona's team works on, for the "is this expertise live here". */
  activeRepositoryId: string | null
}>()

const emit = defineEmits<{
  'select-persona': [personaId: string]
  select: [mapId: string]
  refresh: []
  master: [
    input: {
      repositoryId: string
      subjectKind: 'repository' | 'author'
      subjectRef: string
      focus: string[]
      guidance: string
    },
  ]
  /**
   * A human's standing answer about whether a map is used. `null`
   * hands the decision back to the measurement, which is a third act and a real state.
   */
  'set-retrieval': [input: { mapId: string; override: 'on' | 'off' | null }]
  /** One curation pass over this map. */
  curate: [mapId: string]
}>()

/**
 * What the platform is doing with a map right now, in three words.
 *
 * The badge the operator asked for, at the honest reading. "Expert in this repository" is
 * what a map's *existence* says; this says whether any run is actually being handed it,
 * which is the difference between an expertise and a row in a table.
 */
const RETRIEVAL_LABEL: Record<string, string> = {
  on: 'in use',
  trial: 'on trial',
  off: 'withheld',
}

const RETRIEVAL_TITLE: Record<string, string> = {
  on: 'Runs against this subject are handed this map — it beat the unaided baseline, or a human said so.',
  trial: 'Being measured: some runs are handed this map and some are deliberately not, so the two can be compared.',
  off: 'Not handed to any run. It did not beat the unaided baseline, or a human turned it off.',
}

const masterTarget = ref('')

/**
 * What to master, and what to look for.
 *
 * The focus list is a closed vocabulary because free text does not fix the failure mastery
 * names — a model told to "learn this repository" and then "focus on payments" produces
 * the same directory listing about payments. Each focus carries what *earns a node* for
 * the thing being asked, which is a paragraph written once in the domain rather than one
 * a human has to write correctly every time.
 */
const subjectKind = ref<'repository' | 'author'>('repository')
const authorRef = ref('')
const chosenFocus = ref<string[]>([])
const guidance = ref('')

const FOCUS_LABEL: Record<string, string> = {
  architecture: 'architecture',
  conventions: 'conventions',
  hazards: 'hazards',
  tests: 'tests & how to run them',
  domain: 'domain concepts',
  'review-stance': 'what they insist on in review',
  habits: 'habits in their own changes',
}

/**
 * Offered per subject, because a focus a subject has no record to satisfy is refused by
 * the server — and an option that reads as a promise and is then refused is the failure
 * the delegation roster exists to prevent, one surface over.
 */
const focusOptions = computed(() =>
  subjectKind.value === 'author'
    ? (FOCUS_BY_SUBJECT.author as readonly string[])
    : (FOCUS_BY_SUBJECT.repository as readonly string[]),
)

watch(subjectKind, () => {
  chosenFocus.value = chosenFocus.value.filter((focus) => focusOptions.value.includes(focus))
})

const toggleFocus = (focus: string) => {
  chosenFocus.value = chosenFocus.value.includes(focus)
    ? chosenFocus.value.filter((entry) => entry !== focus)
    : [...chosenFocus.value, focus]
}

const canStart = computed(
  () => masterTarget.value !== '' && (subjectKind.value !== 'author' || authorRef.value.trim() !== ''),
)

const startMastery = () => {
  if (!canStart.value) return
  emit('master', {
    repositoryId: masterTarget.value,
    subjectKind: subjectKind.value,
    subjectRef: subjectKind.value === 'author' ? authorRef.value.trim() : '',
    focus: [...chosenFocus.value],
    guidance: guidance.value.trim(),
  })
}

const selectedKey = ref<string | null>(null)

const graph = computed(() => (props.view ? buildMapGraph(props.view) : null))
const undrawn = computed(() => (props.view ? undrawnNodeCount(props.view) : 0))
const coverage = computed(() => (props.view ? coveragePercent(props.view) : null))
const state = computed(() => (props.view ? describeMasteryState(props.view) : ''))

/**
 * Claims a pass intends to retire. Live only — a proposal against something already
 * retired would be work nobody can do, resurfacing in every report.
 */
const proposed = computed(() =>
  (props.view?.nodes ?? []).filter(
    (node) => node.invalidatedAt === null && node.retirementProposedAt !== null,
  ),
)

const selected = computed<MapGraphNode | null>(
  () => graph.value?.nodes.find((node) => node.key === selectedKey.value) ?? null,
)

const repositoryName = (map: SubjectMap): string =>
  map.repositoryId ? (props.repositoryNames[map.repositoryId] ?? 'a repository') : 'no repository'

/**
 * Portable expertise: "a team's canvas must show, per member, which of its subjects are
 * live for the repository this team merges into", because an expert on the wrong codebase
 * is an ordinary agent with a misleading name. This is the same statement at the map level.
 */
const liveHere = (map: SubjectMap): boolean =>
  props.activeRepositoryId === null || map.repositoryId === props.activeRepositoryId

/**
 * What this claim has been cited into, and what became of those runs.
 *
 * "Not yet read by any run" rather than "0 merged", for the reason coverage renders null
 * rather than zero: no evidence and bad evidence send a reader to different places, and a
 * claim nobody has been shown has not failed at anything.
 */
const citationLine = (nodeId: string): string => {
  const outcomes = props.view?.claimOutcomes[nodeId]
  if (!outcomes || outcomes.decided === 0) {
    return 'No finished run has been shown this claim yet, so nothing ranks it either way.'
  }
  const parts = [`${outcomes.merged} merged`, `${outcomes.discarded} discarded`]
  if (outcomes.failed > 0) parts.push(`${outcomes.failed} failed`)
  return (
    `Shown to ${outcomes.decided} finished run(s): ${parts.join(', ')}. ` +
    'This decides what a worker reads first when the map does not fit — never what is ' +
    'believed without checking.'
  )
}

/** Collapsed by default: teaching is occasional, and reading what was learned is not. */
const teachOpen = ref(false)

/**
 * Whether this expertise is worth having, in one sentence.
 *
 * The trial answers this and the panel used to make a human read a two-row table to
 * find out. The sentence has to survive the case the table hid: *undecided* is not "no",
 * and a map on trial is being measured rather than found wanting — Phase 3b makes this
 * the gate on everything after the map, and "improves over time" is the claim most likely
 * to be believed without evidence, because a growing map *looks* like progress.
 */
const worthLine = computed(() => {
  const view = props.view
  if (!view) return ''
  const { retrieved, withheld, verdict } = view.effect
  const decided = retrieved.decided + withheld.decided
  if (decided === 0) {
    return 'Nothing has finished with this map yet, so nothing says whether it helps.'
  }
  if (verdict === 'helps') {
    return `Runs handed this map do better than runs deliberately denied it — ${retrieved.merged}/${retrieved.decided} against ${withheld.merged}/${withheld.decided}.`
  }
  if (verdict === 'no-better') {
    return `Runs handed this map do no better than runs deliberately denied it — ${retrieved.merged}/${retrieved.decided} against ${withheld.merged}/${withheld.decided}. It is not earning its place.`
  }
  return `Still measuring: ${retrieved.decided} run(s) read it, ${withheld.decided} were deliberately denied it. Undecided is not the same as no.`
})

/**
 * The claims a worker would actually be shown first, best-scored first.
 *
 * The map's *head*, not all of it. A ranking nobody can see is a ranking nobody can argue
 * with, and this one decides which claims survive the context budget — so the few that
 * win are worth naming, with the runs they earned it from beside them.
 */
const bestClaims = computed(() => {
  const view = props.view
  if (!view) return []
  return view.nodes
    .filter((node) => node.invalidatedAt === null)
    .map((node) => ({ node, outcomes: view.claimOutcomes[node.id] }))
    .filter((entry) => (entry.outcomes?.decided ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.outcomes!.merged - b.outcomes!.discarded) - (a.outcomes!.merged - a.outcomes!.discarded),
    )
    .slice(0, 5)
})

const strokeFor = (provenance: string): string =>
  provenance === 'extracted' ? 'var(--map-parsed)' : 'var(--map-inferred)'

const dashFor = (provenance: string): string | undefined =>
  provenance === 'extracted' ? undefined : '5 4'
</script>

<template>
  <section class="mastery">
    <header class="head">
      <div>
        <h3>Expertise</h3>
        <p class="sub">
          What this agent has learned about a subject, and how much of it is checkable.
        </p>
      </div>
      <div class="actions">
        <select
          :value="personaId ?? ''"
          aria-label="Agent"
          @change="emit('select-persona', ($event.target as HTMLSelectElement).value)"
        >
          <option value="" disabled>Choose an agent…</option>
          <option v-for="persona in personas" :key="persona.id" :value="persona.id">
            {{ persona.name }}
          </option>
        </select>
        <button type="button" :disabled="!personaId" @click="emit('refresh')">Refresh</button>
      </div>
    </header>

    <!--
      Teaching an agent is occasional; reading what it has learned is why this panel is
      open. The form is folded away rather than stacked on top of the answer — it was
      three selects, a chip row and a textarea between a human and the thing they came to
      look at.
    -->
    <details v-if="personaId" class="fold" :open="teachOpen || maps.length === 0">
      <summary @click="teachOpen = !teachOpen">Teach this agent a subject</summary>
      <div class="start">
      <div class="row">
        <select v-model="masterTarget" aria-label="Repository to master">
          <option value="" disabled>Repository to learn…</option>
          <option v-for="repository in repositories" :key="repository.id" :value="repository.id">
            {{ repository.displayName }}
          </option>
        </select>
        <!--
          The subjects. `corpus` is deliberately absent: the bar for a subject kind
          is an extractor plus something checkable to serve as the revision, and prose has
          neither yet — offering it would be a control the runtime ignores.
        -->
        <select v-model="subjectKind" aria-label="What to master">
          <option value="repository">the codebase</option>
          <option value="author">a person's practice in it</option>
        </select>
        <input
          v-if="subjectKind === 'author'"
          v-model="authorRef"
          type="text"
          class="author"
          placeholder="name or email in git history"
          aria-label="Whose practice to learn"
        />
      </div>

      <!--
        What kind of expertise to grasp. The operator's ask, and the reason it is a
        vocabulary rather than a text box: each of these carries what *earns a node* for
        the thing being asked, which is what stops a mastery run producing a directory
        listing with a theme.
      -->
      <div class="focus" role="group" aria-label="What to concentrate on">
        <button
          v-for="focus in focusOptions"
          :key="focus"
          type="button"
          :class="{ chosen: chosenFocus.includes(focus) }"
          @click="toggleFocus(focus)"
        >
          {{ FOCUS_LABEL[focus] ?? focus }}
        </button>
      </div>

      <textarea
        v-model="guidance"
        class="guidance"
        rows="2"
        maxlength="2000"
        placeholder="Anything the list above cannot say — e.g. “the parts that bill customers”"
        aria-label="Extra guidance for the mastery run"
      ></textarea>

      <div class="row">
        <button type="button" class="primary" :disabled="!canStart" @click="startMastery">
          Start a mastery run
        </button>
      </div>
      <!--
        Said before it is started, not after. Mastery: a mastery run is a normal run — same
        sandbox, same metering, same cap — and a human authorising one should know it
        costs money and produces no diff.
      -->
      <p class="sub">
        <template v-if="subjectKind === 'author'">
          Reads this repository's history for that person and records the practices that
          <em>recur</em> — a preference seen once is refused, because personalization built
          from single observations measurably performs worse than none. What comes out is
          informed by that person and is never presented as them.
        </template>
        <template v-else>
          Reads the repository and records what it learns.
        </template>
        It changes no code, and it spends against this agent's budget cap like any other run.
      </p>
    </div>

    </details>

    <p v-if="error" class="error">{{ error }}</p>

    <p v-else-if="!personaId" class="empty">
      Choose an agent to see what it has learned.
    </p>

    <p v-else-if="maps.length === 0 && !loading" class="empty">
      This agent has mastered nothing yet. A mastery run reads a repository and records a
      map of it — it changes no code, and later runs are handed what it found.
    </p>

    <ul v-if="maps.length > 0" class="subjects">
      <li v-for="listing in maps" :key="listing.map.id">
        <button
          type="button"
          :class="{ active: view?.map.id === listing.map.id }"
          @click="
            () => {
              selectedKey = null
              emit('select', listing.map.id)
            }
          "
        >
          <span class="ref">
            {{ listing.map.subjectRef }}
            <!--
              portable expertise: an expertise has to be legible *before* it is used. A row that
              said "expert in this repository" while the platform was quietly withholding
              the map would be the surface lying, which is the same class of dishonesty as
              a canvas drawing an edge the runtime refuses.
            -->
            <em
              :class="['retrieval', listing.retrievalState]"
              :title="RETRIEVAL_TITLE[listing.retrievalState]"
              >{{ RETRIEVAL_LABEL[listing.retrievalState] }}</em
            >
          </span>
          <span class="meta">
            {{ listing.map.subjectKind }} · {{ repositoryName(listing.map) }} ·
            <span :class="['status', listing.map.status]">{{ listing.map.status }}</span>
            <template v-if="listing.decided.retrieved + listing.decided.withheld > 0">
              · {{ listing.decided.retrieved }} with / {{ listing.decided.withheld }} without
            </template>
          </span>
          <!--
            Stated rather than implied. Putting the flight expert on a team bound to the
            hotel repository is not an error and must not look like one — it just means
            this expertise contributes nothing here, and a human should know that before
            reading a confident-looking graph.
          -->
          <span v-if="!liveHere(listing.map)" class="not-live">
            not used on the repository in view
          </span>
        </button>
      </li>
    </ul>

    <p v-if="loading" class="empty">Loading the map…</p>

    <template v-if="view && graph">
      <!--
        The answer first. Phase 3b makes the trial the gate on everything after the map,
        and it used to be a two-row table below three other blocks — so the question a
        human opens this to ask ("is this worth having?") was the last thing they reached.
      -->
      <div :class="['worth', view.retrievalState]">
        <p class="badge">
          <strong :title="RETRIEVAL_TITLE[view.retrievalState]">
            {{ RETRIEVAL_LABEL[view.retrievalState] }}
          </strong>
          <span class="of">{{ view.map.subjectRef }}</span>
        </p>
        <p class="worth-line">{{ worthLine }}</p>
      </div>

      <div class="summary">
        <p class="state">{{ state }}</p>
        <dl>
          <div>
            <dt>Coverage</dt>
            <!--
              Null is "not measured yet", never 0% — see coveragePercent. The counts sit
              under the percentage because a 0% cannot be read on its own: a run that
              mapped a repository entirely from search results really did open no files,
              and that is a different fact from a denominator nobody could compute.
            -->
            <dd>
              {{ coverage === null ? 'not measured' : `${coverage}%` }}
              <span v-if="view.progress" class="files">
                {{ view.progress.filesRead }} of {{ view.progress.filesInScope }} files opened
              </span>
            </dd>
          </div>
          <div>
            <dt>Parsed</dt>
            <dd>{{ graph.counts.extracted }}</dd>
          </div>
          <div>
            <dt>Concluded</dt>
            <dd>{{ graph.counts.inferred }}</dd>
          </div>
          <div v-if="graph.counts.ambiguous > 0">
            <dt>Unresolved</dt>
            <dd>{{ graph.counts.ambiguous }}</dd>
          </div>
          <div v-if="graph.invalidated > 0">
            <dt>Retired</dt>
            <dd>{{ graph.invalidated }}</dd>
          </div>
          <div v-if="view.progress">
            <dt>Spend</dt>
            <dd>${{ view.progress.spendUsd.toFixed(4) }}</dd>
          </div>
        </dl>
        <p v-if="view.progress?.yieldFlat" class="flat">
          Coverage is still climbing but nothing new is being recorded — it is reading
          without learning.
        </p>
      </div>

      <!--
        The gate, where the human who cares about it is already looking. Phase 3b
        makes this the gate on curation, the Colosseum and handoff, and "improves over
        time" is the claim most likely to be believed without evidence — a growing map
        *looks* like progress.
      -->
      <details :class="['trial', 'fold', view.retrievalState]">
        <summary>How that was measured, and overriding it</summary>
        <p class="sub">{{ view.effect.detail }}</p>
        <table class="arms">
          <thead>
            <tr>
              <th>arm</th>
              <th>decided</th>
              <th>merged</th>
              <th>mean cost</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">read the map</th>
              <td>{{ view.effect.retrieved.decided }}</td>
              <td>{{ view.effect.retrieved.merged }}</td>
              <td>${{ view.effect.retrieved.meanCostUsd.toFixed(4) }}</td>
            </tr>
            <tr>
              <th scope="row">denied it</th>
              <td>{{ view.effect.withheld.decided }}</td>
              <td>{{ view.effect.withheld.merged }}</td>
              <td>${{ view.effect.withheld.meanCostUsd.toFixed(4) }}</td>
            </tr>
          </tbody>
        </table>
        <!--
          Promotion is a human act, and so is demotion — an operator watching a map
          produce bad advice should not have to wait for five more runs to agree.
          "Let the measurement decide" is a third button because it is a third state.
        -->
        <div class="overrides">
          <button
            type="button"
            :class="{ chosen: view.map.retrievalOverride === 'on' }"
            @click="emit('set-retrieval', { mapId: view.map.id, override: 'on' })"
          >
            Always use it
          </button>
          <button
            type="button"
            :class="{ chosen: view.map.retrievalOverride === 'off' }"
            @click="emit('set-retrieval', { mapId: view.map.id, override: 'off' })"
          >
            Never use it
          </button>
          <button
            type="button"
            :class="{ chosen: view.map.retrievalOverride === null }"
            @click="emit('set-retrieval', { mapId: view.map.id, override: null })"
          >
            Let the measurement decide
          </button>
        </div>
      </details>

      <!--
        The curation, where the map is being read. The proposals are the point: deleting
        memory is the one self-modification with no diff to review, so what a pass *means*
        to drop is shown before it drops it — a proposal nobody can see is the same as no
        proposal at all.
      -->
      <!--
        The head of the ranking, where a human can argue with it. A score that only
        reorders a prompt is a score nobody can check; these are the claims that actually
        win the context budget, with the runs they earned it from beside them.
      -->
      <section v-if="bestClaims.length > 0" class="earned">
        <h5>Read first, and why</h5>
        <ul>
          <li v-for="entry in bestClaims" :key="entry.node.id">
            <span class="pkey">{{ entry.node.label }}</span>
            <span class="preason">
              {{ entry.outcomes!.merged }} merged / {{ entry.outcomes!.discarded }} discarded
              across {{ entry.outcomes!.decided }} finished run(s)
            </span>
          </li>
        </ul>
        <p class="sub">
          This orders what a worker sees when the map does not fit. It never changes what is
          believed without checking.
        </p>
      </section>

      <details class="curation fold">
        <summary>
          Upkeep<template v-if="proposed.length > 0"> — {{ proposed.length }} proposed for retirement</template>
        </summary>
        <div class="curation-head">
          <button type="button" @click="emit('curate', view.map.id)">Re-check now</button>
        </div>
        <p v-if="proposed.length > 0" class="sub">
          {{ proposed.length }} claim(s) are proposed for retirement and will be retired on
          the next pass unless something contradicts that first:
        </p>
        <ul v-if="proposed.length > 0" class="proposals">
          <li v-for="node in proposed" :key="node.id">
            <span class="pkey">{{ node.label }}</span>
            <span class="preason">{{ node.retirementReason }}</span>
          </li>
        </ul>
        <p v-else class="sub">Nothing is proposed for retirement.</p>
        <p v-if="curation" class="sub">
          Last pass: {{ curation.checked }} checked, {{ curation.kept }} kept,
          {{ curation.retired }} retired, {{ curation.proposed }} newly proposed,
          {{ curation.withdrawn }} withdrawn.
        </p>
      </details>

      <div class="legend">
        <span><i class="swatch parsed"></i> parsed from the source — reliable</span>
        <span><i class="swatch inferred"></i> concluded by an agent — check before relying on it</span>
      </div>

      <div class="canvas">
        <svg :viewBox="`0 0 ${graph.width} ${graph.height}`" role="img" aria-label="Subject map">
          <line
            v-for="edge in graph.edges"
            :key="edge.id"
            :x1="edge.x1"
            :y1="edge.y1"
            :x2="edge.x2"
            :y2="edge.y2"
            :stroke="strokeFor(edge.provenance)"
            :stroke-dasharray="dashFor(edge.provenance)"
            stroke-width="1.4"
            opacity="0.55"
          />
          <g
            v-for="node in graph.nodes"
            :key="node.key"
            :class="['node', node.provenance, { picked: node.key === selectedKey }]"
            @click="selectedKey = node.key === selectedKey ? null : node.key"
          >
            <circle
              :cx="node.x"
              :cy="node.y"
              :r="node.radius"
              :fill="node.ring === 'concept' ? 'var(--map-concept-fill)' : 'var(--map-code-fill)'"
              :stroke="strokeFor(node.provenance)"
              :stroke-dasharray="dashFor(node.provenance)"
              :stroke-width="node.hub ? 3 : 1.5"
            />
            <text :x="node.x" :y="node.y + node.radius + 13" text-anchor="middle">
              {{ node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label }}
            </text>
          </g>
        </svg>
      </div>

      <p v-if="undrawn > 0" class="empty">
        {{ undrawn }} further node(s) are in this map and not drawn. The picture keeps the
        concepts and the most-connected nodes.
      </p>

      <div v-if="selected" class="detail">
        <h4>{{ selected.label }}</h4>
        <p class="meta">
          {{ selected.kind }} ·
          <span :class="['prov', selected.provenance]">{{
            selected.provenance === 'extracted'
              ? 'parsed from the source'
              : selected.provenance === 'ambiguous'
                ? 'the parser found more than one answer'
                : 'an agent concluded this'
          }}</span>
          · {{ selected.degree }} connection(s)<span v-if="selected.hub">
            · this is a hub, so a change here reaches further than it looks</span
          >
        </p>
        <p v-if="selected.summary" class="summary-text">{{ selected.summary }}</p>
        <p v-if="selected.paths.length > 0" class="paths">
          {{ selected.paths.join(', ') }}
        </p>
        <!--
          domain expertise: "a claim cited by runs that merged cleanly outranks one from runs that were
          discarded." The counts rather than the score, because "outranked" is a conclusion
          and this is the evidence it was drawn from. It ranks what a worker reads first and
          nothing else — it never retires a claim and never makes one believed unchecked.
        -->
        <p class="meta">{{ citationLine(selected.id) }}</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.mastery {
  --map-parsed: #3f7f5f;
  --map-inferred: #9a6b2f;
  --map-concept-fill: rgba(63, 127, 95, 0.12);
  --map-code-fill: rgba(120, 120, 130, 0.1);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}

h3 {
  margin: 0;
  font-size: 0.95rem;
}

.sub,
.empty,
.meta {
  margin: 0.15rem 0 0;
  font-size: 0.78rem;
  opacity: 0.72;
}

.actions {
  display: flex;
  gap: 0.4rem;
}

.start {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.start .sub {
  flex-basis: 100%;
}

select {
  font: inherit;
  font-size: 0.78rem;
  padding: 0.25rem 0.4rem;
  border: 1px solid rgba(128, 128, 128, 0.5);
  border-radius: 4px;
  background: transparent;
  color: inherit;
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

button {
  font: inherit;
  font-size: 0.78rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid currentColor;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  opacity: 0.85;
}

button.primary {
  opacity: 1;
}

.error {
  font-size: 0.8rem;
  color: #b3261e;
}

.subjects {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.subjects button {
  width: 100%;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  border-color: rgba(128, 128, 128, 0.4);
}

.subjects button.active {
  border-color: currentColor;
}

.ref {
  font-weight: 600;
  font-size: 0.82rem;
}

.status.ready {
  color: #3f7f5f;
}
.status.failed {
  color: #b3261e;
}

.not-live {
  font-size: 0.74rem;
  opacity: 0.75;
  font-style: italic;
}

.summary dl {
  display: flex;
  flex-wrap: wrap;
  gap: 0.9rem;
  margin: 0.4rem 0 0;
}

.summary dt {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
}

.summary dd {
  margin: 0;
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
}

.state {
  margin: 0;
  font-size: 0.8rem;
}

.files {
  display: block;
  font-size: 0.68rem;
  color: var(--text-faint);
}

.flat {
  margin: 0.4rem 0 0;
  font-size: 0.78rem;
  color: #9a6b2f;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  font-size: 0.74rem;
  opacity: 0.8;
}

.swatch {
  display: inline-block;
  width: 1.4rem;
  border-top: 2px solid var(--map-parsed);
  vertical-align: middle;
  margin-right: 0.3rem;
}

.swatch.inferred {
  border-top-style: dashed;
  border-top-color: var(--map-inferred);
}

.canvas {
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 6px;
  overflow: hidden;
}

svg {
  display: block;
  width: 100%;
  height: auto;
}

.node {
  cursor: pointer;
}

.node text {
  font-size: 11px;
  fill: currentColor;
  opacity: 0.85;
}

.node.picked circle {
  filter: brightness(1.15);
}

.detail {
  border-top: 1px solid rgba(128, 128, 128, 0.25);
  padding-top: 0.5rem;
}

.detail h4 {
  margin: 0;
  font-size: 0.85rem;
}

.prov.inferred,
.prov.ambiguous {
  color: #9a6b2f;
}

.summary-text {
  margin: 0.3rem 0 0;
  font-size: 0.8rem;
}

.paths {
  margin: 0.25rem 0 0;
  font-size: 0.74rem;
  opacity: 0.7;
  font-family: ui-monospace, monospace;
  word-break: break-all;
}

.retrieval {
  margin-left: 0.4rem;
  padding: 0.02rem 0.3rem;
  border-radius: 0.7rem;
  font-style: normal;
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  border: 1px solid currentcolor;
}

.retrieval.on {
  color: var(--ok);
}

.retrieval.trial {
  color: var(--text-muted);
}

.retrieval.off {
  color: var(--text-faint);
}

.trial {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
}

.trial.on {
  border-color: var(--ok);
}

.trial-head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.verdict {
  font-size: 0.68rem;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.arms {
  border-collapse: collapse;
  font-size: 0.72rem;
}

.arms th,
.arms td {
  text-align: left;
  padding: 0.1rem 0.6rem 0.1rem 0;
  font-weight: 400;
}

.arms thead th {
  color: var(--text-faint);
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.overrides {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.overrides button {
  padding: 0.15rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.7rem;
  cursor: pointer;
}

.overrides button.chosen {
  border-color: var(--accent);
  color: var(--accent);
}

.start .row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.start .author {
  flex: 1 1 12rem;
  min-width: 0;
  padding: 0.25rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 0.78rem;
}

.focus {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.focus button {
  padding: 0.12rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 0.8rem;
  background: var(--bg);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.7rem;
  cursor: pointer;
}

.focus button.chosen {
  border-color: var(--accent);
  color: var(--accent);
}

.guidance {
  width: 100%;
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 0.75rem;
  resize: vertical;
}

.curation {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
}

.curation-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.curation-head button {
  padding: 0.12rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.7rem;
  cursor: pointer;
}

.proposals {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.72rem;
}

.proposals li {
  display: flex;
  gap: 0.4rem;
}

.proposals .pkey {
  color: var(--text);
}

.proposals .preason {
  color: var(--text-faint);
}

/*
 * The three disclosures. Teaching, the trial's arithmetic and upkeep are all things a
 * human does occasionally; reading what an agent knows is why this panel is open, and it
 * used to sit under all three.
 */
.fold > summary {
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--accent);
  list-style: none;
}

.fold > summary::-webkit-details-marker {
  display: none;
}

.fold > summary::before {
  content: '+ ';
}

.fold[open] > summary::before {
  content: '\2212  ';
}

/* The answer, above everything that explains it. */
.worth {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: 0.4rem;
}

.worth.on {
  border-left-color: var(--ok);
}

.worth.trial {
  border-left-color: var(--accent);
}

.worth.off {
  border-left-color: var(--text-faint);
}

.worth .badge {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  margin: 0;
  font-size: 0.8rem;
}

.worth .of {
  font-size: 0.7rem;
  color: var(--text-faint);
}

.worth-line {
  margin: 0;
  font-size: 0.74rem;
  line-height: 1.55;
}

/* The head of the ranking, so a score that reorders a prompt is one a human can argue with. */
.earned h5 {
  margin: 0 0 0.25rem;
  font-size: 0.66rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}

.earned ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.72rem;
}

.earned li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.earned .preason {
  color: var(--text-faint);
}
</style>