<script setup lang="ts">
import type {
 ColosseumSession,
 ColosseumView,
 MasteryView,
 ResponseStyle,
 SubjectMapListing,
} from '@loom/api-contract'
import {
 areaLabelFromAnnouncement,
 buildInboxBoard,
 buildThreadTrail,
 parseMention,
 SELECTABLE_MODELS,
 threadsByParentMessage,
 waitingCount,
} from '@loom/client-core'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ActiveRunsPanel from './ActiveRunsPanel.vue'
import ApprovalCard from './ApprovalCard.vue'
import Composer from './Composer.vue'
import ChannelList from './ChannelList.vue'
import DiffView from './DiffView.vue'
import InboxView from './InboxView.vue'
import MergeQueuePanel from './MergeQueuePanel.vue'
import KillSwitch from './KillSwitch.vue'
import MessageList from './MessageList.vue'
import NotificationToggle from './NotificationToggle.vue'
import RunLauncher from './RunLauncher.vue'
import SettingsOverlay from './SettingsOverlay.vue'
import TeamComposer from './TeamComposer.vue'
import SidebarSection from './SidebarSection.vue'
import CostDashboardPanel from './CostDashboardPanel.vue'
import RunTreePanel from './RunTreePanel.vue'
import SwarmBoardPanel from './SwarmBoardPanel.vue'
import SteerPanel from './SteerPanel.vue'
import SwarmGraphPanel from './SwarmGraphPanel.vue'
import WorkerNotesPanel from './WorkerNotesPanel.vue'
import { useAgentStore } from '../stores/agent'
import { useWorkspaceStore } from '../stores/workspace'

const store = useWorkspaceStore
const agent = useAgentStore

const snapshot = computed( => store.snapshot)
const agentSnapshot = computed( => agent.snapshot)
const activeChannel = computed(
 => snapshot.value.channels.find((c) => c.id === snapshot.value.activeChannelId) ?? null,
)
// Built and accumulated by the session: this used to be "whichever single run is
// being watched", which meant every other author in the thread — siblings, and every
// run that finished before the page opened — rendered as a raw run id.
const personaNameByRunId = computed( => agentSnapshot.value.personaNameByRunId)

const startRun = (input: {
 repositoryId: string
 personaId: string
 responseStyle: ResponseStyle
 task?: string
 model?: string
 budgetCapUsd?: number | null
}) => {
 const threadId = snapshot.value.activeThread?.id
 if (!threadId) return
 void agent.startRun({ threadId,...input })
}

/**
 * Area threads. Both derivations live in
 * `client-core` so they are tested; these are the two bindings.
 */
const areaThreadByMessageId = computed( => {
 const byParent = threadsByParentMessage(snapshot.value.channelThreads)
 return Object.fromEntries([...byParent].map(([messageId, thread]) => [messageId, thread.id]))
})

const threadTrail = computed( =>
 buildThreadTrail(
 snapshot.value.channelThreads,
 snapshot.value.activeThread?.id ?? null,
 (parentMessageId) => {
 const announcement = snapshot.value.messages.find((m) => m.id === parentMessageId)
 return announcement ? areaLabelFromAnnouncement(announcement.body.text): null
 },
),
)

const settingsOpen = ref(false)

/**
 * The expertise tab. Held here rather than in the session snapshot because expertise
 * is per persona and a workspace has many — folding every map into the snapshot would
 * put an unbounded read on the path that opens the app, for a surface most sessions
 * never open.
 */
const masteryPersonaId = ref<string | null>(null)
const masteryMaps = ref<SubjectMapListing[]>([])
const masteryView = ref<MasteryView | null>(null)
const masteryLoading = ref(false)
const masteryError = ref<string | null>(null)

const selectExpertisePersona = async (personaId: string) => {
 masteryPersonaId.value = personaId
 masteryView.value = null
 masteryLoading.value = true
 masteryError.value = null
 try {
 masteryMaps.value = await agent.listPersonaMaps(personaId)
 } catch (error) {
 // Its own error, not the session banner: a panel that renders its empty state on a
 // failed fetch says the opposite of what happened, which this app has shipped before.
 masteryError.value = error instanceof Error ? error.message: String(error)
 } finally {
 masteryLoading.value = false
 }
}

const loadMastery = async (mapId: string) => {
 masteryLoading.value = true
 masteryError.value = null
 try {
 const view = await agent.getMastery(mapId)
 masteryView.value = view
 /**
 * The list is refreshed from the view's own row, not left as it was fetched.
 *
 * A map's status moves while a human is looking at it — `mastering` becomes `ready`
 * or `failed` when the run ends — so the row and the summary underneath it are two
 * reads taken at different moments. Seen in a browser: the subject row said
 * "mastering" directly above a line reading "the mastery run failed". The view is
 * the later read and carries the same row, so there is nothing to fetch.
 */
 if (view) {
 masteryMaps.value = masteryMaps.value.map((listing) =>
 listing.map.id === view.map.id
 ? // The view is the later read, and it carries the trial as well as the row —
 // so the list's badge and the panel underneath it cannot disagree.
 {...listing, map: view.map, retrievalState: view.retrievalState }
: listing,
)
 }
 } catch (error) {
 masteryError.value = error instanceof Error ? error.message: String(error)
 } finally {
 masteryLoading.value = false
 }
}

/**
 * The open map follows the run that is writing it.
 *
 * The reason for writing a map incrementally is not only durability: "that also makes
 * the partial map readable *during* the run, which is what makes stopping early a real
 * option." A panel that only fetched on click made that claim false — the data
 * accumulated and nobody could watch it.
 *
 * Driven by the session snapshot rather than by a timer, which is the same mechanism the
 * board uses: every run transition posts a thread message, so a snapshot changing is the
 * earliest signal that anything about a run has moved. The guard is what keeps it cheap —
 * one extra read per nudge, only while a map is actually being mastered and only while
 * someone is looking at it.
 */
const followOpenMap = => {
 const open = masteryView.value
 if (!open || open.map.status !== 'mastering' || masteryLoading.value) return
 void loadMastery(open.map.id)
}

watch( => agentSnapshot.value, followOpenMap)

/**
 * The safety net behind the nudge, and it is not optional — the nudge alone loses a
 * race that happens constantly.
 *
 * A snapshot changes when a run transitions, so the *completion* nudge is what would
 * flip an open map from `mastering` to `ready`. Open the panel a moment after that
 * nudge has already passed and no further snapshot ever arrives, so the map sits on
 * "Mastering." forever while the database says otherwise. Seen in a browser: 7 nodes,
 * status `ready` in Postgres, and a panel still claiming the run was in progress.
 *
 * Same shape and same reasoning as the session's own 10s net behind its socket. It
 * costs nothing when nothing is being mastered, because the guard above returns first.
 */
const MASTERY_FOLLOW_MS = 4_000
const masteryFollowTimer = window.setInterval(followOpenMap, MASTERY_FOLLOW_MS)
onBeforeUnmount( => window.clearInterval(masteryFollowTimer))

/**
 * The expertise the swarm graph draws.
 *
 * Fetched when the canvas opens and when the watched run changes repository — never on
 * the board's poll. The cost discipline is that watching a swarm adds no per-tick
 * query, and expertise does not move between polls: a map changes when a mastery run
 * writes to it, which is rare and is its own surface.
 *
 * Joined to persona *names* here rather than in `client-core`, because the id→name map
 * is session state the graph module deliberately does not import.
 */
const graphExpertise = ref<
 {
 mapId: string
 subjectRef: string
 subjectKind: string
 personaName: string
 retrievalState: 'trial' | 'on' | 'off'
 }[]
>([])

/**
 * Which runs on the watched tree actually read which map.
 *
 * Fetched with the band, in the same round and on the same schedule — holding a map and
 * having been handed one are different facts, and only the second answers "which of these
 * agents adopted this expertise".
 */
const graphExpertiseUses = ref<
 { agentRunId: string; mapId: string; arm: 'retrieved' | 'withheld' }[]
>([])

const loadGraphExpertise = async => {
 const repositoryId = agentSnapshot.value.activeRun?.repositoryId ?? null
 if (!repositoryId) {
 graphExpertise.value = []
 graphExpertiseUses.value = []
 return
 }

 const runIds = (agentSnapshot.value.swarmBoard?.cards ?? []).map((card) => card.runId)
 graphExpertiseUses.value = (await agent.listExpertiseUsedByRuns(runIds)).map((use) => ({
 agentRunId: use.agentRunId,
 mapId: use.map.id,
 arm: use.arm,
 }))
 const nameById = new Map(agentSnapshot.value.personas.map((p) => [p.id, p.name]))
 const maps = await agent.listRepositoryMaps(repositoryId)
 graphExpertise.value = maps
.filter((listing) => listing.map.status === 'ready')
.flatMap((listing) => {
 const personaName = nameById.get(listing.map.personaId)
 // A map whose persona no longer exists is dropped rather than drawn under a uuid.
 // The byline lesson: a label that resolves to an id says less than none.
 return personaName
 ? [
 {
 mapId: listing.map.id,
 subjectRef: listing.map.subjectRef,
 subjectKind: listing.map.subjectKind,
 personaName,
 /**
 * Whether the platform is actually handing this map to runs. A
 * band that said "expert" while the map was withheld would be the graph
 * claiming an expertise nobody is carrying.
 */
 retrievalState: listing.retrievalState,
 },
 ]
: []
 })
}


const startMastery = async (input: {
 repositoryId: string
 subjectKind: 'repository' | 'author'
 subjectRef: string
 focus: string[]
 guidance: string
}) => {
 const personaId = masteryPersonaId.value
 const threadId = snapshot.value.activeThread?.id
 if (!personaId) return
 // A run needs a thread to be watchable in, and there is deliberately no invented one:
 // a mastery run posts its progress where a human is already looking.
 if (!threadId) {
 masteryError.value = 'Open a channel first — a mastery run reports into a thread.'
 return
 }
 masteryError.value = null
 const runId = await agent.startMastery({
 threadId,
 personaId,
 repositoryId: input.repositoryId,
 subjectKind: input.subjectKind,
...(input.subjectRef === '' ? {}: { subjectRef: input.subjectRef }),
...(input.focus.length === 0 ? {}: { focus: input.focus }),
...(input.guidance === '' ? {}: { guidance: input.guidance }),
 })
 if (runId) {
 settingsOpen.value = false
 await selectExpertisePersona(personaId)
 }
}
/**
 * A human overruling the measurement.
 *
 * Both surfaces are refreshed afterwards, and the reason is the same defect this panel
 * already had once: the list row and the open view are two reads taken at different
 * moments, so changing the state and refreshing only one leaves a badge disagreeing with
 * the panel underneath it.
 */
const setMapRetrieval = async (input: { mapId: string; override: 'on' | 'off' | null }) => {
 await agent.setMapRetrieval(input.mapId, input.override)
 const personaId = masteryPersonaId.value
 if (personaId) await selectExpertisePersona(personaId)
 await loadMastery(input.mapId)
}

/**
 * What the last curation pass did, for the panel to report.
 *
 * Held here rather than in the panel because the panel is re-rendered whenever the map
 * reloads, and a report that vanished the moment its own effect landed would be a result
 * a human never got to read.
 */
const masteryCuration = ref<{
 checked: number
 kept: number
 retired: number
 proposed: number
 withdrawn: number
} | null>(null)

const curateMap = async (mapId: string) => {
 masteryCuration.value = await agent.curateMap(mapId)
 // Reloaded, because a pass changes what the map holds — a report saying two claims were
 // retired above a graph still drawing them is the surface disagreeing with itself.
 await loadMastery(mapId)
}

/**
 * The venue, fetched when its tab is opened rather than on the snapshot: a session is
 * convened rarely and read deliberately, and putting it on the poll would add a query to
 * every tick of a surface nobody has open.
 */
const colosseumSessions = ref<ColosseumSession[]>([])
const colosseumView = ref<ColosseumView | null>(null)

const refreshColosseum = async => {
 colosseumSessions.value = await agent.listColosseumSessions
}

const selectColosseumSession = async (sessionId: string) => {
 colosseumView.value = await agent.getColosseumSession(sessionId)
}

const conveneColosseum = async (input: {
 purpose: 'consultation' | 'contention' | 'crunching' | 'warm_up'
 subject: string
 question: string
 personaIds: string[]
}) => {
 const threadId = snapshot.value.activeThread?.id
 // A session is watched where the work is, and there is deliberately no invented thread:
 // The "a session is a thing on the board, not a gap in the record".
 if (!threadId) return
 const sessionId = await agent.conveneColosseum({
 threadId,
 repositoryId: agentSnapshot.value.activeRun?.repositoryId ?? null,
...input,
 })
 await refreshColosseum
 if (sessionId) await selectColosseumSession(sessionId)
}

/**
 * One turn. The refreshed view is what shows the floor as taken — the answer itself
 * lands when the run finishes, through the same completion path every other run uses.
 */
const takeColosseumTurn = async (input: { sessionId: string; personaId?: string }) => {
 await agent.takeColosseumTurn(input)
 await selectColosseumSession(input.sessionId)
}

const composerOpen = ref(false)

/**
 * What each persona is expert in, for the design canvas.
 *
 * Fetched when the composer opens rather than carried on the snapshot, for the same
 * reason the graph's band is: expertise changes when a mastery run writes to a map, which
 * is rare and has its own surface. Not filtered to a repository — a team has no
 * repository, and picking one would be the canvas claiming a fact the platform
 * does not hold.
 */
const composerExpertise = ref<
 {
 personaId: string
 subjectRef: string
 subjectKind: string
 retrievalState: 'trial' | 'on' | 'off'
 }[]
>([])

watch(composerOpen, async (isOpen) => {
 if (!isOpen) return
 composerExpertise.value = (await agent.listWorkspaceMaps)
.filter((listing) => listing.map.status === 'ready')
.map((listing) => ({
 personaId: listing.map.personaId,
 subjectRef: listing.map.subjectRef,
 subjectKind: listing.map.subjectKind,
 retrievalState: listing.retrievalState,
 }))
})

const CONNECTION_LABEL: Record<string, string> = {
 open: 'Live',
 connecting: 'Connecting',
 closed: 'Offline',
}

const CONNECTION_TITLE: Record<string, string> = {
 open: 'Connected — messages and run updates arrive as they happen.',
 connecting: 'Reconnecting to the realtime gateway…',
 closed: 'Not connected. Nothing new will appear until this reconnects.',
}

/**
 * Each collapsed section still answers its own question.
 *
 * That is the whole reason collapsing is acceptable here: a header that says only
 * "Merge queue" trades one scrolling problem for a clicking one, whereas one that
 * says "2 queued · 1 failed" is often the entire answer.
 */
const watchedSummary = computed( => {
 const run = agentSnapshot.value.activeRun
 if (!run) return null
 const cost = run.totalCostUsd === null ? null: `$${run.totalCostUsd.toFixed(2)}`
 return [run.persona.name, run.status, cost].filter(Boolean).join(' · ')
})

const boardCardCount = computed( => agentSnapshot.value.swarmBoard?.cards.length ?? 0)

const blockerCount = computed( =>
 (agentSnapshot.value.swarmBoard?.cards ?? []).reduce((sum, card) => sum + card.blockerCount, 0),
)

const swarmSummary = computed( => {
 if (boardCardCount.value === 0) return null
 const parts = [`${boardCardCount.value} run${boardCardCount.value === 1 ? '': 's'}`]
 const collisions = agentSnapshot.value.swarmBoard?.pathCollisions.length ?? 0
 if (collisions > 0) parts.push(`${collisions} path collision${collisions === 1 ? '': 's'}`)
 if (blockerCount.value > 0) parts.push(`${blockerCount.value} blocker${blockerCount.value === 1 ? '': 's'}`)
 return parts.join(' · ')
})

const failedMergeCount = computed(
 => agentSnapshot.value.mergeQueue.filter((entry) => entry.status === 'failed').length,
)

const mergeSummary = computed( => {
 const entries = agentSnapshot.value.mergeQueue
 if (entries.length === 0) return null
 const queued = entries.filter((entry) => entry.status === 'queued').length
 const parts: string[] = []
 if (queued > 0) parts.push(`${queued} queued`)
 if (failedMergeCount.value > 0) parts.push(`${failedMergeCount.value} failed`)
 return parts.length > 0 ? parts.join(' · '): `${entries.length} entries`
})

const spendSummary = computed( => {
 const summary = agentSnapshot.value.costSummary
 if (!summary) return null
 const window = costWindowHours.value === null ? 'all time': `${costWindowHours.value}h`
 return `$${summary.totals.totalUsd.toFixed(2)} · ${window}`
})

// `@mention` starts a run: the message always posts as
// ordinary chat; if it mentions a known persona, a repo-picker bar appears
// so the human can say inline which bound repo to target — never bound per
// channel, and never assumed (the persona model non-scope).
const pendingMention = ref<{ personaId: string; personaName: string; task: string } | null>(null)
const mentionRepositoryId = ref('')
const mentionModel = ref('')
const mentionBudgetCap = ref('')

/** What the "Agent default" option should say it will actually use. */
const mentionPersonaModel = computed( => {
 const personaId = pendingMention.value?.personaId
 if (!personaId) return ''
 return agentSnapshot.value.personas.find((persona) => persona.id === personaId)?.model ?? ''
})

/**
 * Bumped on every send so the thread follows to the bottom (see MessageList.sentTick).
 * Someone who scrolled up and then typed is waiting to see what they just said.
 */
const sentTick = ref(0)

const handleSend = (text: string) => {
 sentTick.value += 1
 void store.send(text)
 const mention = parseMention(text, agentSnapshot.value.personas)
 pendingMention.value = mention
 if (mention) {
 mentionRepositoryId.value = agentSnapshot.value.repositories[0]?.id ?? ''
 // Reset per mention: an override chosen for one agent is not a choice about
 // the next one, matching RunLauncher's rule.
 mentionModel.value = ''
 mentionBudgetCap.value = ''
 }
}

const confirmMention = => {
 const threadId = snapshot.value.activeThread?.id
 const mention = pendingMention.value
 if (!threadId || !mention || !mentionRepositoryId.value) return
 const cap =
 mentionBudgetCap.value === ''
 ? undefined
: mentionBudgetCap.value === 'none'
 ? null
: Number.parseFloat(mentionBudgetCap.value)
 void agent.startRun({
 threadId,
 repositoryId: mentionRepositoryId.value,
 personaId: mention.personaId,
 task: mention.task,
...(mentionModel.value === '' ? {}: { model: mentionModel.value }),
...(cap === undefined ? {}: { budgetCapUsd: cap }),
 })
 pendingMention.value = null
}

const cancelMention = => {
 pendingMention.value = null
}

// Inbox — the retention hook, a second top-level view toggled
// locally since apps/web has no router. Refreshed on entry rather than
// polled continuously.
const view = ref<'workspace' | 'inbox'>('workspace')

const openInbox = => {
 view.value = 'inbox'
 void agent.refreshInbox
}

/**
 * The number on the Inbox button — the board's own count, not the length of the list the
 * Inbox fetches.
 *
 * `needsAttention` is a *fetch*, and the board is a *reading* of it: a run whose branch is
 * already queued for merge is in that fetch and is waiting on the queue rather than on a
 * human, so counting the fetch overstated the badge by everything already in flight. The
 * lanes decide, and `waitingCount` counts the three a human can act on.
 */
const inboxWaiting = computed( =>
 waitingCount(
 buildInboxBoard({
 needsAttention: agentSnapshot.value.needsAttention,
 settled: agentSnapshot.value.settledRuns,
 mergeQueue: agentSnapshot.value.mergeQueue,
 }),
),
)

/**
 * Post-mortem: hand a finished run to the board and graph, which live in the workspace
 * sidebar.
 *
 * The view switch is the whole reason this is a function rather than a bare
 * `agent.watchRun`. The panels being populated are not on screen in the Inbox, so
 * watching without returning to the workspace looks exactly like the button doing
 * nothing — and the Swarm section is collapsible, so it can hide the result a second
 * time. Expanded here for the same reason.
 */
const revealSwarm = ref(0)

/**
 * Watch a run *and* open the thread it is talking in.
 *
 * The graph, the board and the run tree all used to emit `watch`, which fetches the
 * run and its board and leaves the conversation on whatever thread was already open.
 * On a corporation that is usually the wrong one: a sub-planner runs in its own area
 * thread, so clicking its node showed a human the root's conversation and none of the
 * work they had just clicked on.
 *
 * The thread comes from the fetched run rather than from the board card, which does
 * not carry one — so this awaits the watch instead of firing both at once.
 */
const openRunThread = async (agentRunId: string) => {
 await agent.watchRun(agentRunId)
 const threadId = agent.snapshot.activeRun?.threadId
 if (threadId && threadId !== snapshot.value.activeThread?.id) {
 await store.openThread(threadId)
 }
}

/**
 * `:busy` was hardcoded `false`, so the prop `SteerPanel` disables its button with was
 * wired to nothing — and this is the one control in the app where every press starts a
 * frontier-model planner run. A double-click bought two of them.
 */
const revealGraph = ref(0)

/**
 * Declared after `revealGraph` on purpose. Placed above it this watcher reads the ref in
 * its own initializer, which `vue-tsc` accepts and the browser refuses — "Cannot access
 * 'revealGraph' before initialization", thrown once at setup, killing the whole view.
 * A temporal-dead-zone error is invisible to every static check in this repo.
 */
watch(
 => [revealGraph.value, agentSnapshot.value.activeRun?.repositoryId] as const,
 => void loadGraphExpertise,
)

/**
 * What the canvas's Refresh re-reads: the tree **and** the merge queue.
 *
 * Both, because the graph now draws both — refreshing only the board
 * would leave the queue band showing a state a human had just pressed a button to update.
 * The poll behind it does the same pair for the same reason.
 */
const refreshGraph = => {
 const watched = agentSnapshot.value.activeRun
 if (watched) void agent.refreshBoard(watched.id)
 void agent.refreshMergeQueue
}

/**
 * The canvas's two outbound actions.
 *
 * Both watch the clicked run first: the diff and the steer target are properties of
 * the *watched* run everywhere else in this app, and giving the canvas its own path to
 * either would be a second way to reach the same state — which is how the two get out
 * of step.
 */
const reviewFromGraph = async (agentRunId: string) => {
 await agent.watchRun(agentRunId)
 await agent.loadDiff(agentRunId)
}

const steerFromGraph = async (agentRunId: string) => {
 await agent.watchRun(agentRunId)
 // SteerPanel lives inside the Swarm section, so this is the counter that reveals it.
 // The canvas closes itself on this action; opening a sidebar section behind a
 // full-screen scrim would look like nothing happened.
 revealSwarm.value += 1
}

const steering = ref(false)

const steer = async (agentRunId: string, message: string) => {
 if (steering.value) return
 steering.value = true
 try {
 await agent.steer(agentRunId, message)
 } finally {
 steering.value = false
 }
}

const watchFromInbox = (agentRunId: string) => {
 void agent.watchRun(agentRunId)
 view.value = 'workspace'
 revealSwarm.value += 1
}

/**
 * Where a clicked notification lands: the Inbox, with that run
 * already selected. A notification that dropped a human on the workspace view
 * and left them to find the run would put the search back on them, which is the
 * cost the Inbox exists to remove.
 */
const openRun = async (agentRunId: string) => {
 openInbox
 await agent.inspectRun(agentRunId)
}

// Two arrival paths, because a service worker cannot reach into a page that
// isn't running: a cold start carries the run in `?run=` (there is no router to
// carry it any other way), and an already-open tab gets a postMessage from the
// worker after it focuses this window.
const consumeRunDeepLink = => {
 const runId = new URLSearchParams(window.location.search).get('run')
 if (!runId) return
 // Strip it once used, so a reload doesn't keep yanking the view back to a run
 // the human has already dealt with.
 window.history.replaceState(null, '', window.location.pathname)
 void openRun(runId)
}

const onServiceWorkerMessage = (event: MessageEvent) => {
 const data = event.data as { type?: string; runId?: string } | null
 if (data?.type !== 'loom:open-run' || !data.runId) return
 void openRun(data.runId)
}

/**
 * Re-read on focus.
 *
 * The 1.5s poll is scoped to a *watched run* and stops when nothing is active, so a
 * tab left open shows whatever it last saw — a merged branch, a reconciler that ran
 * after its parent finished, a new note. Focus rather than a second timer: not polling
 * continuously is a deliberate decision about background cost, and a tab nobody is
 * looking at is precisely the case that decision protects.
 */
const onFocus = => {
 if (document.visibilityState === 'visible') void agent.refresh
}

/**
 * The dashboard's window. Held here rather than in the panel because the
 * fetch is the store's and the panel is a view — and because a refresh must ask for the
 * window currently on screen, not the one it was mounted with.
 */
const costWindowHours = ref<number | null>(24)
const setCostWindow = (hours: number | null) => {
 costWindowHours.value = hours
 void agent.refreshCostSummary(hours)
}

/**
 * The two sessions, joined.
 *
 * Chat state and run state are deliberately separate sessions, but they are not
 * independent facts: every run transition posts a thread message, so a frame on the
 * chat socket is the earliest possible signal that run state is stale. This is what
 * replaced chasing it with a 1.5s interval.
 */
let unsubscribeEvents: ( => void) | null = null

onMounted( => {
 /**
 * One subscription, two jobs. Every frame nudges the structured
 * re-read as before; a `run.activity` frame *additionally* feeds the canvas, which
 * draws it immediately rather than waiting for the re-read it triggered — the whole
 * point being that by the time a board fetch lands, the call that prompted it has
 * usually finished.
 */
 unsubscribeEvents = store.onServerEvent((event) => {
 agent.noteRealtimeActivity
 if (event.type === 'run.activity') {
 agent.noteRunActivity(
 {
 agentRunId: event.agentRunId,
 parentRunId: event.parentRunId,
 kind: event.kind,
 label: event.label,
 at: Date.now,
 },
 event.treeRunId,
)
 }
 })
 void store.start
 void agent.start
 // Fetched once on mount and on demand, never on the run poll: workspace spend changes
 // slowly, and re-aggregating every two seconds would be a query per tick to redraw a
 // number that had not moved.
 void agent.refreshCostSummary(costWindowHours.value)
 consumeRunDeepLink
 navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage)
 window.addEventListener('focus', onFocus)
 document.addEventListener('visibilitychange', onFocus)
})

onBeforeUnmount( => {
 unsubscribeEvents?.
 window.removeEventListener('focus', onFocus)
 document.removeEventListener('visibilitychange', onFocus)
 navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage)
 store.dispose
 agent.dispose
})
</script>

<template>
 <div class="app">
 <ChannelList
:channels="snapshot.channels"
:active-channel-id="snapshot.activeChannelId"
 @select="store.selectChannel"
 @create="store.createChannel"
 @delete="(input, done) => void store.deleteChannel(input).then(done)"
 />

 <main class="main">
 <header class="topbar">
 <template v-if="view === 'workspace'">
 <h2 v-if="activeChannel">#{{ activeChannel.name }}</h2>
 <h2 v-else class="muted">No channel selected</h2>
 <!--
 The way out of an area. Absent on an ordinary channel:
 `buildThreadTrail` returns nothing when the active thread is the root, so
 this costs a channel that has never run a swarm exactly nothing.
 -->
 <nav v-if="threadTrail.length > 0" class="trail" aria-label="Thread">
 <template v-for="(step, index) in threadTrail":key="step.threadId">
 <span v-if="index > 0" class="trail-sep" aria-hidden="true">/</span>
 <span v-if="step.current" class="trail-here">{{ step.label }}</span>
 <button v-else type="button" class="trail-link" @click="store.openThread(step.threadId)">
 {{ step.label }}
 </button>
 </template>
 </nav>
 </template>
 <h2 v-else>Inbox</h2>

 <div class="topbar-actions">
 <!--
 "open" is what a WebSocket calls itself, not what a human wants to know.
 The question behind this pill is "am I seeing things as they happen".
 -->
 <span
 v-if="view === 'workspace'"
 class="conn"
:class="snapshot.connection"
:title="CONNECTION_TITLE[snapshot.connection]"
 >
 <span class="conn-dot" aria-hidden="true"></span>
 {{ CONNECTION_LABEL[snapshot.connection] }}
 </span>
 <!--
 Workspace-only. The Inbox is a place to decide on runs that have already
 stopped, and a row of global switches over it is noise between a human and
 the decision they came to make. The one exception is below: a *paused*
 workspace is why the Inbox is not filling, so it still says so — as a
 statement, not a control.
 -->
 <NotificationToggle
 v-if="view === 'workspace'"
:config="agentSnapshot.notificationConfig"
 @subscribe="(registration) => agent.registerNotificationTarget(registration)"
 @unsubscribe="(endpoint) => agent.unregisterNotificationTarget(endpoint)"
 />
 <!--
 The canvas, hoisted out of the sidebar. It sat inside a *collapsed*
 section, behind a panel, behind an Open button — three levels down from
 anything a human looks at, on one of the defining surfaces. Disabled
 rather than hidden when there is no swarm, so its absence reads as "nothing
 to draw" rather than as the control not existing.
 -->
 <button
 v-if="view === 'workspace'"
 type="button"
 class="graph-open"
:disabled="boardCardCount === 0"
:title="boardCardCount === 0 ? 'No swarm to draw yet': 'Open the swarm graph'"
 @click="revealGraph += 1"
 >
 Graph
 </button>
 <!--
 The design canvas, beside the observability one and never disabled — the "visual creation" is what a human does *before* there is a swarm, so gating
 it on there being one would put it behind the thing it exists to produce.
 Two canvases, deliberately: this one's positions are choices, the Graph's
 are computed.
 -->
 <button
 v-if="view === 'workspace'"
 type="button"
 class="graph-open"
 title="Design a team — who is on it, and what each planner may hand down"
 @click="composerOpen = true"
 >
 Design
 </button>
 <KillSwitch
 v-if="view === 'workspace'"
:control="agentSnapshot.runControl"
:cancelled-count="agentSnapshot.lastPauseCancelledCount"
 @pause="agent.pauseAllRuns"
 @resume="agent.resumeAllRuns"
 />
 <span
 v-else-if="agentSnapshot.runControl?.paused"
 class="paused-note"
 title="New runs are blocked. Resume from the workspace."
 >
 Runs paused
 </span>
 <button
 v-if="view === 'workspace'"
 type="button"
 class="inbox-toggle settings-toggle"
 aria-label="Settings"
 title="Settings — runners, repositories, personas, capabilities"
 @click="settingsOpen = true"
 >
 ⚙
 </button>
 <button
 v-if="view === 'workspace'"
 type="button"
 class="inbox-toggle"
 @click="openInbox"
 >
 Inbox<span v-if="inboxWaiting" class="badge">{{ inboxWaiting }}</span>
 </button>
 <button v-else type="button" class="inbox-toggle" @click="view = 'workspace'">
 Back to workspace
 </button>
 </div>
 </header>

 <!--
 Outside the workspace-only block, deliberately. These sat inside it, so any
 failure while the Inbox was open produced no visible change at all — a click on
 "Queue for merge" or "Load diff" that errored looked identical to a click that
 did nothing, which is exactly how the Inbox came to be reported as broken.
 -->
 <p v-if="snapshot.error" class="error" role="alert">{{ snapshot.error }}</p>
 <p v-if="agentSnapshot.error" class="error" role="alert">{{ agentSnapshot.error }}</p>

 <template v-if="view === 'workspace'">

 <MessageList
:messages="snapshot.messages"
:persona-name-by-run-id="personaNameByRunId"
:current-actor="snapshot.currentActor"
:has-more-history="snapshot.hasMoreHistory"
:loading-history="snapshot.loadingHistory"
:area-thread-by-message-id="areaThreadByMessageId"
:sent-tick="sentTick"
 @load-earlier="store.loadOlderMessages"
 @unknown-authors="(ids) => agent.resolvePersonaNames(ids)"
 @open-thread="(threadId) => store.openThread(threadId)"
 />

 <ApprovalCard
:approvals="agentSnapshot.pendingApprovals"
 @decide="(id, decision, answer) => agent.decide(id, decision, answer)"
 />

 <!--
 The mention path used to send only thread/repository/persona/task, so the two
 launch surfaces were each missing what the other had: the sidebar could set a
 model and a cap but not a task, and this could set a task but neither of the
 two the cost model calls the cost swing factors. Both are here now.
 -->
 <div v-if="pendingMention" class="mention-bar">
 <span>Start <strong>{{ pendingMention.personaName }}</strong> on:</span>
 <select v-model="mentionRepositoryId" aria-label="Repository for this run">
 <option value="" disabled>Select repository…</option>
 <option v-for="repo in agentSnapshot.repositories":key="repo.id":value="repo.id">
 {{ repo.displayName }}
 </option>
 </select>
 <select v-model="mentionModel" aria-label="Model for this run">
 <option value="">{{ mentionPersonaModel || 'Agent default' }}</option>
 <option v-for="entry in SELECTABLE_MODELS":key="entry.id":value="entry.id">
 {{ entry.label }}
 </option>
 </select>
 <select v-model="mentionBudgetCap" aria-label="Spend cap for this run">
 <option value="">Agent cap</option>
 <option value="0.50">$0.50</option>
 <option value="1.00">$1.00</option>
 <option value="5.00">$5.00</option>
 <option value="20.00">$20.00</option>
 <option value="none">No cap</option>
 </select>
 <button type="button":disabled="!mentionRepositoryId" @click="confirmMention">Start run</button>
 <button type="button" class="cancel" @click="cancelMention">Cancel</button>
 </div>

 <Composer:disabled="!snapshot.activeThread":personas="agentSnapshot.personas" @send="handleSend" />
 </template>

 <InboxView
 v-else
 class="inbox-region"
:runs="agentSnapshot.needsAttention"
:settled="agentSnapshot.settledRuns"
:merge-queue="agentSnapshot.mergeQueue"
:selected-run="agentSnapshot.inspectedRun"
:approvals="agentSnapshot.inspectedApprovals"
:diff="agentSnapshot.diff"
:fetch-error="agentSnapshot.fetchErrors.inbox"
:diff-error="agentSnapshot.fetchErrors.diff"
:loading="agentSnapshot.loading"
 @refresh=" => agent.refreshInbox"
 @select="(agentRunId) => agent.inspectRun(agentRunId)"
 @close=" => agent.clearInspectedRun"
 @decide="(id, decision, answer) => agent.decide(id, decision, answer)"
 @load-diff="(agentRunId) => agent.loadDiff(agentRunId)"
 @keep="(agentRunId) => agent.keepRun(agentRunId)"
 @discard="(agentRunId) => agent.discardRun(agentRunId)"
 @push="(agentRunId, ack) => agent.pushRun(agentRunId, ack)"
 @merge="(agentRunId, override, done) => void agent.enqueueMerge(agentRunId, override).then(done)"
 @load-raw="(agentRunId, done) => agent.getRawTranscript(agentRunId).then(done)"
 @watch="(agentRunId) => watchFromInbox(agentRunId)"
 />
 </main>

 <!--
 The sidebar answers "what is happening", in one order: what you can start, what
 needs you, what is running, what it costs. Everything a human sets up once —
 runners, repositories, personas, capabilities, groups — moved to Settings, which
 is where it can have the width a markdown persona actually needs.
 -->
 <aside v-if="view === 'workspace'" class="agent-sidebar">
 <RunLauncher
:repositories="agentSnapshot.repositories"
:personas="agentSnapshot.personas"
:groups="agentSnapshot.personaGroups"
:disabled="!snapshot.activeThread"
 @start="startRun"
 @open-settings="settingsOpen = true"
 @preview-delegation="(input, done) => void agent.previewDelegation(input).then(done)"
 />

 <SidebarSection
 title="Watching"
:summary="watchedSummary"
:empty="!agentSnapshot.activeRun"
 empty-text="no run selected"
 storage-key="watching"
:default-open="true"
 >
 <ActiveRunsPanel
:runs="agentSnapshot.activeRuns"
:watched-run-id="agentSnapshot.activeRun?.id ?? null"
 @watch="(agentRunId) => agent.watchRun(agentRunId)"
 />
 <DiffView
:run="agentSnapshot.activeRun"
:diff="agentSnapshot.diff"
:fetch-error="agentSnapshot.fetchErrors.diff"
 @load-diff="(agentRunId) => agent.loadDiff(agentRunId)"
 @keep="(agentRunId) => agent.keepRun(agentRunId)"
 @discard="(agentRunId) => agent.discardRun(agentRunId)"
 @push="(agentRunId, ack) => agent.pushRun(agentRunId, ack)"
 @merge="(agentRunId, override, done) => void agent.enqueueMerge(agentRunId, override).then(done)"
 @load-raw="(agentRunId, done) => agent.getRawTranscript(agentRunId).then(done)"
 />
 </SidebarSection>

 <SidebarSection
 title="Swarm"
:summary="swarmSummary"
:empty="boardCardCount === 0"
 empty-text="no swarm"
:attention="blockerCount > 0"
 storage-key="swarm"
:reveal="revealSwarm"
 >
 <SwarmBoardPanel
:board="agentSnapshot.swarmBoard"
:fetch-error="agentSnapshot.fetchErrors.board"
 @watch="(agentRunId) => openRunThread(agentRunId)"
 @refresh=" => agentSnapshot.activeRun && agent.refreshBoard(agentSnapshot.activeRun.id)"
 />
 <!--
 Three readings of one payload, and that is the point: the board is "what state is
 everything in", the graph is "who called whom, and who is about to collide"
, and the tree is "who asked for what, and what did it cost".
 -->
 <SwarmGraphPanel
:board="agentSnapshot.swarmBoard"
:merge-queue="agentSnapshot.mergeQueue"
:active-run-id="agentSnapshot.activeRun?.id ?? null"
:open-signal="revealGraph"
:activity="agentSnapshot.recentActivity"
:expertise="graphExpertise"
:expertise-uses="graphExpertiseUses"
 @review="(agentRunId) => reviewFromGraph(agentRunId)"
 @steer="(agentRunId) => steerFromGraph(agentRunId)"
 @open="(agentRunId) => openRunThread(agentRunId)"
 @refresh=" => refreshGraph"
 />
 <RunTreePanel
:board="agentSnapshot.swarmBoard"
 @watch="(agentRunId) => openRunThread(agentRunId)"
 @refresh=" => agentSnapshot.activeRun && agent.refreshBoard(agentSnapshot.activeRun.id)"
 />
 <!--
 Steering lives under the board rather than beside the composer, because it
 reads the board: the run ids and statuses a re-plan acts on are the ones
 drawn directly above it.
 -->
 <SteerPanel
:board="agentSnapshot.swarmBoard"
:busy="steering"
 @steer="(agentRunId, message) => steer(agentRunId, message)"
 />
 </SidebarSection>

 <SidebarSection
 title="Notes"
:summary="agentSnapshot.treeNotes.length ? `${agentSnapshot.treeNotes.length}`: null"
:empty="!agentSnapshot.activeRun"
 empty-text="no tree"
 storage-key="notes"
 >
 <WorkerNotesPanel
:notes="agentSnapshot.treeNotes"
:agent-run-id="agentSnapshot.activeRun?.id ?? null"
:persona-name-by-run-id="personaNameByRunId"
 @open="(agentRunId) => openRunThread(agentRunId)"
 @write="(input) => agentSnapshot.activeRun && agent.writeNote({ agentRunId: agentSnapshot.activeRun.id,...input })"
 @refresh=" => agentSnapshot.activeRun && agent.refreshBoard(agentSnapshot.activeRun.id)"
 />
 </SidebarSection>

 <SidebarSection
 title="Merge queue"
:summary="mergeSummary"
:empty="agentSnapshot.mergeQueue.length === 0"
 empty-text="empty"
:attention="failedMergeCount > 0"
 storage-key="merge-queue"
 >
 <MergeQueuePanel
:entries="agentSnapshot.mergeQueue"
 @open="(agentRunId) => openRun(agentRunId)"
 @cancel="(entryId) => agent.cancelMerge(entryId)"
 @refresh=" => agent.refreshMergeQueue"
 />
 </SidebarSection>

 <!--
 Workspace-wide, unlike everything above it: the board and the tree are scoped to
 the watched run's tree, and the question is about all of them.
 -->
 <SidebarSection
 title="Spend"
:summary="spendSummary"
:empty="agentSnapshot.costSummary === null"
 empty-text="nothing spent"
 storage-key="spend"
 >
 <CostDashboardPanel
:summary="agentSnapshot.costSummary"
:window-hours="costWindowHours"
:fetch-error="agentSnapshot.fetchErrors.cost"
 @open="(agentRunId) => openRun(agentRunId)"
 @refresh=" => agent.refreshCostSummary(costWindowHours)"
 @window="(hours) => setCostWindow(hours)"
 />
 </SidebarSection>
 </aside>

 <SettingsOverlay
 v-if="settingsOpen"
:runners="agentSnapshot.runners"
:repositories="agentSnapshot.repositories"
:personas="agentSnapshot.personas"
:persona-groups="agentSnapshot.personaGroups"
:capabilities="agentSnapshot.capabilities"
:capability-attachments="agentSnapshot.capabilityAttachments"
:last-pairing="agentSnapshot.lastPairing"
:mastery-persona-id="masteryPersonaId"
:mastery-maps="masteryMaps"
:mastery-view="masteryView"
:mastery-loading="masteryLoading"
:mastery-error="masteryError"
 @close="settingsOpen = false"
 @select-expertise="selectExpertisePersona"
 @select-map="loadMastery"
 @refresh-maps=" => masteryPersonaId && selectExpertisePersona(masteryPersonaId)"
 @master="startMastery"
:mastery-curation="masteryCuration"
:colosseum-sessions="colosseumSessions"
:colosseum-view="colosseumView"
:run-control="agentSnapshot.runControl"
 @set-handoff-policy="(input) => void agent.setHandoffPolicy(input)"
 @colosseum-select="(sessionId) => void selectColosseumSession(sessionId)"
 @colosseum-refresh=" => void refreshColosseum"
 @colosseum-convene="(input) => void conveneColosseum(input)"
 @colosseum-claim="
 (input) =>
 void agent
.recordColosseumClaim(input)
.then( => selectColosseumSession(input.sessionId))
 "
 @colosseum-settle="
 (input) =>
 void agent
.settleColosseumClaim(input)
.then( => colosseumView && selectColosseumSession(colosseumView.session.id))
 "
 @colosseum-take-turn="(input) => void takeColosseumTurn(input)"
 @colosseum-conclude="
 (sessionId) =>
 void agent.concludeColosseum(sessionId).then( => selectColosseumSession(sessionId))
 "
 @set-retrieval="setMapRetrieval"
 @curate="curateMap"
 @create-pairing-token="(name) => agent.createPairingToken(name)"
 @remove-runner="(runnerId, done) => void agent.removeRunner(runnerId).then(done)"
 @unbind="(input, done) => void agent.unbindRepository(input).then(done)"
 @delete-persona="(personaId) => agent.deletePersona(personaId)"
 @bind="(input) => agent.bindRepository(input)"
 @create-repository="(input) => agent.createRepository(input)"
 @list="(input, done) => agent.listDirectory(input).then(done)"
 @set-verify-command="(repositoryId, command) => agent.setVerifyCommand(repositoryId, command)"
 @set-install-command="(repositoryId, command) => agent.setInstallCommand(repositoryId, command)"
 @warm-cache="(repositoryId, done) => void agent.warmCache(repositoryId).then(done)"
 @create-persona="(markdownSource) => agent.createPersona(markdownSource)"
 @update-persona="(input) => agent.updatePersona(input)"
 @parse-persona="(source, done) => void agent.parsePersona(source).then(done)"
 @reset-persona="(personaId) => agent.resetPersonaToBuiltin(personaId)"
 @register="(input) => agent.registerCapability(input)"
 @remove="(capabilityId) => agent.removeCapability(capabilityId)"
 @attach="(input) => agent.attachCapability(input)"
 @detach="(input) => agent.detachCapability(input)"
 @create-group="(input) => agent.createPersonaGroup(input)"
 @update-group="(input) => agent.updatePersonaGroup(input)"
 @delete-group="(id) => agent.deletePersonaGroup(id)"
 @compose="composerOpen = true"
 />

 <!--
 The composition canvas.
 Deliberately a sibling of Settings rather than a tab inside it: a canvas needs
 the viewport, the same argument the diff review overlay already makes.
 -->
 <TeamComposer
 v-if="composerOpen"
:personas="agentSnapshot.personas"
:groups="agentSnapshot.personaGroups"
:repositories="agentSnapshot.repositories"
:matrix="agentSnapshot.delegationMatrix"
:max-delegation-depth="snapshot.limits?.maxDelegationDepth"
:expertise="composerExpertise"
 @close="composerOpen = false"
 @create-persona="
 (input) => void agent.createPersona(input.markdownSource).then(input.done)
 "
 @create-group="(input) => agent.createPersonaGroup(input)"
 @set-verify-command="(repositoryId, command) => agent.setVerifyCommand(repositoryId, command)"
 @save-group="(input) => agent.updatePersonaGroup(input)"
 @update-persona="(input) => agent.updatePersona(input)"
 />
 </div>
</template>

<style scoped>
.app {
 display: flex;
 height: 100vh;
 overflow: hidden;
}

.main {
 display: flex;
 flex-direction: column;
 flex: 1;
 min-width: 0;
}

.topbar {
 display: flex;
 align-items: center;
 justify-content: space-between;
 gap: 1rem;
 padding: 0.85rem 1.25rem;
 border-bottom: 1px solid var(--border);
}

.trail {
 display: flex;
 align-items: center;
 gap: 0.35rem;
 font-size: 0.85rem;
 color: var(--text-muted);
}

.trail-sep {
 opacity: 0.5;
}

.trail-link {
 padding: 0;
 font: inherit;
 color: var(--text-muted);
 background: none;
 border: none;
 cursor: pointer;
 text-decoration: underline;
}

.trail-link:hover {
 color: var(--text);
}

.trail-here {
 color: var(--text);
}

.topbar h2 {
 margin: 0;
 font-size: 1rem;
}

.muted {
 color: var(--text-faint);
 font-weight: 500;
}

.conn {
 display: inline-flex;
 align-items: center;
 gap: 0.35rem;
 font-size: 0.72rem;
 padding: 0.2rem 0.55rem;
 border-radius: 999px;
 border: 1px solid var(--border);
 color: var(--text-faint);
}

.conn-dot {
 width: 0.4rem;
 height: 0.4rem;
 border-radius: 50%;
 background: currentcolor;
}

.conn.open {
 color: var(--ok);
 border-color: color-mix(in oklab, var(--ok) 35%, transparent);
 background: color-mix(in oklab, var(--ok) 10%, transparent);
}

.conn.connecting {
 color: var(--warn);
 border-color: color-mix(in oklab, var(--warn) 35%, transparent);
}

/* Only this one earns a pulse: it is the state where what you are looking at is
 quietly going stale. */
.conn.connecting.conn-dot {
 animation: pulse 1.1s ease-in-out infinite;
}

@keyframes pulse {
 50% {
 opacity: 0.25;
 }
}

@media (prefers-reduced-motion: reduce) {
.conn.connecting.conn-dot {
 animation: none;
 }
}

.conn.closed {
 color: var(--danger);
 border-color: color-mix(in oklab, var(--danger) 40%, transparent);
 background: color-mix(in oklab, var(--danger) 10%, transparent);
}

.topbar-actions {
 display: flex;
 align-items: center;
 gap: 0.6rem;
}

.inbox-toggle {
 display: flex;
 align-items: center;
 gap: 0.35rem;
 padding: 0.3rem 0.6rem;
 border: 1px solid var(--border);
 border-radius: 0.375rem;
 background: var(--surface-hover);
 color: var(--text);
 font: inherit;
 font-size: 0.8rem;
 cursor: pointer;
}

.paused-note {
 padding: 0.2rem 0.55rem;
 border: 1px solid color-mix(in oklab, var(--warn) 45%, transparent);
 border-radius: 999px;
 background: color-mix(in oklab, var(--warn) 10%, transparent);
 color: var(--warn);
 font-size: 0.72rem;
}

.settings-toggle {
 padding: 0.24rem 0.5rem;
 font-size: 1.05rem;
 line-height: 1;
}

.graph-open:disabled {
 opacity: 0.4;
 cursor: not-allowed;
}

.inbox-toggle.badge {
 padding: 0.05rem 0.4rem;
 border-radius: 999px;
 background: var(--accent);
 color: var(--accent-contrast);
 font-size: 0.7rem;
 font-weight: 600;
}

.error {
 margin: 0;
 padding: 0.6rem 1.25rem;
 background: color-mix(in oklab, var(--danger) 14%, transparent);
 color: var(--danger);
 font-size: 0.85rem;
}

.mention-bar {
 display: flex;
 align-items: center;
 gap: 0.5rem;
 padding: 0.5rem 1.25rem;
 border-top: 1px solid var(--border);
 background: color-mix(in oklab, var(--accent) 8%, transparent);
 font-size: 0.85rem;
}

.mention-bar select {
 padding: 0.3rem 0.5rem;
 border: 1px solid var(--border);
 border-radius: 0.375rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
}

.mention-bar button {
 padding: 0.3rem 0.6rem;
 border: 0;
 border-radius: 0.375rem;
 background: var(--accent);
 color: var(--accent-contrast);
 font: inherit;
 font-weight: 600;
 cursor: pointer;
}

.mention-bar button:disabled {
 opacity: 0.45;
 cursor: not-allowed;
}

.mention-bar button.cancel {
 background: none;
 color: var(--text-muted);
 font-weight: 500;
}

.inbox-region {
 flex: 1;
 min-height: 0;
}

.agent-sidebar {
 width: 21rem;
 flex-shrink: 0;
 overflow-y: auto;
 border-left: 1px solid var(--border);
 background: var(--surface);
 padding: 0.5rem;
 display: flex;
 flex-direction: column;
 gap: 0.5rem;
}

/*
 * Without this the column does not scroll — it compresses.
 *
 * A flex item's automatic minimum size is its content, which is what normally forces
 * a column to overflow and its scrollbar to appear. But an item with `overflow`
 * other than `visible` has that minimum computed as zero instead, and every section
 * here clips its own corners. So each one shrank to fit the viewport and cut its
 * contents off mid-row, and the sidebar had nothing to scroll.
 */
.agent-sidebar > * {
 flex-shrink: 0;
}
</style>
