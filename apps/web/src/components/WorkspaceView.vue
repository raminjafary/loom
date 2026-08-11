<script setup lang="ts">
import type { ResponseStyle } from '@loom/api-contract'
import { parseMention } from '@loom/client-core'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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
import SidebarSection from './SidebarSection.vue'
import CostDashboardPanel from './CostDashboardPanel.vue'
import RunTreePanel from './RunTreePanel.vue'
import SwarmBoardPanel from './SwarmBoardPanel.vue'
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
}) => {
 const threadId = snapshot.value.activeThread?.id
 if (!threadId) return
 void agent.startRun({ threadId,...input })
}

const settingsOpen = ref(false)

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

const handleSend = (text: string) => {
 void store.send(text)
 const mention = parseMention(text, agentSnapshot.value.personas)
 pendingMention.value = mention
 if (mention) {
 mentionRepositoryId.value = agentSnapshot.value.repositories[0]?.id ?? ''
 }
}

const confirmMention = => {
 const threadId = snapshot.value.activeThread?.id
 const mention = pendingMention.value
 if (!threadId || !mention || !mentionRepositoryId.value) return
 void agent.startRun({
 threadId,
 repositoryId: mentionRepositoryId.value,
 personaId: mention.personaId,
 task: mention.task,
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
 unsubscribeEvents = store.onServerEvent( => agent.noteRealtimeActivity)
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
 />

 <main class="main">
 <header class="topbar">
 <template v-if="view === 'workspace'">
 <h2 v-if="activeChannel">#{{ activeChannel.name }}</h2>
 <h2 v-else class="muted">No channel selected</h2>
 </template>
 <h2 v-else>Inbox</h2>

 <div class="topbar-actions">
 <span v-if="view === 'workspace'" class="conn":class="snapshot.connection">
 {{ snapshot.connection }}
 </span>
 <NotificationToggle
:config="agentSnapshot.notificationConfig"
 @subscribe="(registration) => agent.registerNotificationTarget(registration)"
 @unsubscribe="(endpoint) => agent.unregisterNotificationTarget(endpoint)"
 />
 <KillSwitch
:control="agentSnapshot.runControl"
 @pause="agent.pauseAllRuns"
 @resume="agent.resumeAllRuns"
 />
 <button
 v-if="view === 'workspace'"
 type="button"
 class="inbox-toggle"
 aria-label="Settings"
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
 Inbox<span v-if="agentSnapshot.needsAttention.length" class="badge">{{
 agentSnapshot.needsAttention.length
 }}</span>
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
 @load-earlier="store.loadOlderMessages"
 @unknown-authors="(ids) => agent.resolvePersonaNames(ids)"
 />

 <ApprovalCard
:approvals="agentSnapshot.pendingApprovals"
 @decide="(id, decision) => agent.decide(id, decision)"
 />

 <div v-if="pendingMention" class="mention-bar">
 <span>Start <strong>{{ pendingMention.personaName }}</strong> on:</span>
 <select v-model="mentionRepositoryId" aria-label="Repository for this run">
 <option value="" disabled>Select repository…</option>
 <option v-for="repo in agentSnapshot.repositories":key="repo.id":value="repo.id">
 {{ repo.displayName }}
 </option>
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
:selected-run="agentSnapshot.inspectedRun"
:approvals="agentSnapshot.inspectedApprovals"
:diff="agentSnapshot.diff"
 @select="(agentRunId) => agent.inspectRun(agentRunId)"
 @decide="(id, decision) => agent.decide(id, decision)"
 @load-diff="(agentRunId) => agent.loadDiff(agentRunId)"
 @keep="(agentRunId) => agent.keepRun(agentRunId)"
 @discard="(agentRunId) => agent.discardRun(agentRunId)"
 @push="(agentRunId, ack) => agent.pushRun(agentRunId, ack)"
 @merge="(agentRunId) => agent.enqueueMerge(agentRunId)"
 @load-raw="(agentRunId, done) => agent.getRawTranscript(agentRunId).then(done)"
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
:disabled="!snapshot.activeThread"
 @start="startRun"
 @open-settings="settingsOpen = true"
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
 @load-diff="(agentRunId) => agent.loadDiff(agentRunId)"
 @keep="(agentRunId) => agent.keepRun(agentRunId)"
 @discard="(agentRunId) => agent.discardRun(agentRunId)"
 @push="(agentRunId, ack) => agent.pushRun(agentRunId, ack)"
 @merge="(agentRunId) => agent.enqueueMerge(agentRunId)"
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
 >
 <SwarmBoardPanel
:board="agentSnapshot.swarmBoard"
 @watch="(agentRunId) => agent.watchRun(agentRunId)"
 @refresh=" => agentSnapshot.activeRun && agent.refreshBoard(agentSnapshot.activeRun.id)"
 />
 <!--
 Beneath the board and fed by the same payload: the board is "what state is
 everything in", the tree is "who asked for what, and what did it cost".
 -->
 <RunTreePanel
:board="agentSnapshot.swarmBoard"
 @watch="(agentRunId) => agent.watchRun(agentRunId)"
 @refresh=" => agentSnapshot.activeRun && agent.refreshBoard(agentSnapshot.activeRun.id)"
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
 @close="settingsOpen = false"
 @create-pairing-token="(name) => agent.createPairingToken(name)"
 @bind="(input) => agent.bindRepository(input)"
 @create-repository="(input) => agent.createRepository(input)"
 @list="(input, done) => agent.listDirectory(input).then(done)"
 @set-verify-command="(repositoryId, command) => agent.setVerifyCommand(repositoryId, command)"
 @set-install-command="(repositoryId, command) => agent.setInstallCommand(repositoryId, command)"
 @warm-cache="(repositoryId, done) => void agent.warmCache(repositoryId).then(done)"
 @create-persona="(markdownSource) => agent.createPersona(markdownSource)"
 @update-persona="(input) => agent.updatePersona(input)"
 @register="(input) => agent.registerCapability(input)"
 @remove="(capabilityId) => agent.removeCapability(capabilityId)"
 @attach="(input) => agent.attachCapability(input)"
 @detach="(input) => agent.detachCapability(input)"
 @create-group="(input) => agent.createPersonaGroup(input)"
 @update-group="(input) => agent.updatePersonaGroup(input)"
 @delete-group="(id) => agent.deletePersonaGroup(id)"
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

.topbar h2 {
 margin: 0;
 font-size: 1rem;
}

.muted {
 color: var(--text-faint);
 font-weight: 500;
}

.conn {
 font-size: 0.7rem;
 text-transform: uppercase;
 letter-spacing: 0.06em;
 padding: 0.2rem 0.45rem;
 border-radius: 999px;
 border: 1px solid var(--border);
 color: var(--text-faint);
}

.conn.open {
 color: var(--ok);
 border-color: color-mix(in oklab, var(--ok) 40%, transparent);
}

.conn.connecting {
 color: var(--warn);
 border-color: color-mix(in oklab, var(--warn) 40%, transparent);
}

.conn.closed {
 color: var(--danger);
 border-color: color-mix(in oklab, var(--danger) 40%, transparent);
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
</style>
