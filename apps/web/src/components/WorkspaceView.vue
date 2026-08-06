<script setup lang="ts">
import { parseMention } from '@loom/client-core'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ApprovalCard from './ApprovalCard.vue'
import Composer from './Composer.vue'
import ChannelList from './ChannelList.vue'
import DiffView from './DiffView.vue'
import InboxView from './InboxView.vue'
import KillSwitch from './KillSwitch.vue'
import MessageList from './MessageList.vue'
import PersonaForm from './PersonaForm.vue'
import PersonaGroupPanel from './PersonaGroupPanel.vue'
import RepositoryPanel from './RepositoryPanel.vue'
import RunnerPanel from './RunnerPanel.vue'
import { useAgentStore } from '../stores/agent'
import { useWorkspaceStore } from '../stores/workspace'

const store = useWorkspaceStore()
const agent = useAgentStore()

const snapshot = computed(() => store.snapshot)
const agentSnapshot = computed(() => agent.snapshot)
const activeChannel = computed(
  () => snapshot.value.channels.find((c) => c.id === snapshot.value.activeChannelId) ?? null,
)
const personaNameByRunId = computed(() => {
  const run = agentSnapshot.value.activeRun
  return run ? { [run.id]: run.persona.name } : {}
})

const startRun = (input: { repositoryId: string; personaId: string }) => {
  const threadId = snapshot.value.activeThread?.id
  if (!threadId) return
  void agent.startRun({ threadId, repositoryId: input.repositoryId, personaId: input.personaId })
}

// `@mention` starts a run (PLAN.md §3a): the message always posts as
// ordinary chat; if it mentions a known persona, a repo-picker bar appears
// so the human can say inline which bound repo to target — never bound per
// channel, and never assumed (§3a non-scope).
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

const confirmMention = () => {
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

const cancelMention = () => {
  pendingMention.value = null
}

// Inbox (PLAN.md §3) — the retention hook, a second top-level view toggled
// locally since apps/web has no router. Refreshed on entry rather than
// polled continuously.
const view = ref<'workspace' | 'inbox'>('workspace')

const openInbox = () => {
  view.value = 'inbox'
  void agent.refreshInbox()
}

onMounted(() => {
  void store.start()
  void agent.start()
})

onBeforeUnmount(() => {
  store.dispose()
  agent.dispose()
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
          <span v-if="view === 'workspace'" class="conn" :class="snapshot.connection">
            {{ snapshot.connection }}
          </span>
          <KillSwitch
            :control="agentSnapshot.runControl"
            @pause="agent.pauseAllRuns()"
            @resume="agent.resumeAllRuns()"
          />
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

      <template v-if="view === 'workspace'">
        <p v-if="snapshot.error" class="error" role="alert">{{ snapshot.error }}</p>
        <p v-if="agentSnapshot.error" class="error" role="alert">{{ agentSnapshot.error }}</p>

        <MessageList :messages="snapshot.messages" :persona-name-by-run-id="personaNameByRunId" />

        <ApprovalCard
          :approvals="agentSnapshot.pendingApprovals"
          @decide="(id, decision) => agent.decide(id, decision)"
        />

        <div v-if="pendingMention" class="mention-bar">
          <span>Start <strong>{{ pendingMention.personaName }}</strong> on:</span>
          <select v-model="mentionRepositoryId" aria-label="Repository for this run">
            <option value="" disabled>Select repository…</option>
            <option v-for="repo in agentSnapshot.repositories" :key="repo.id" :value="repo.id">
              {{ repo.displayName }}
            </option>
          </select>
          <button type="button" :disabled="!mentionRepositoryId" @click="confirmMention">Start run</button>
          <button type="button" class="cancel" @click="cancelMention">Cancel</button>
        </div>

        <Composer :disabled="!snapshot.activeThread" :personas="agentSnapshot.personas" @send="handleSend" />
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
      />
    </main>

    <aside v-if="view === 'workspace'" class="agent-sidebar">
      <RunnerPanel
        :runners="agentSnapshot.runners"
        :last-pairing="agentSnapshot.lastPairing"
        @create-pairing-token="(name) => agent.createPairingToken(name)"
      />
      <RepositoryPanel
        :repositories="agentSnapshot.repositories"
        :runners="agentSnapshot.runners"
        @bind="(input) => agent.bindRepository(input)"
      />
      <PersonaForm
        :repositories="agentSnapshot.repositories"
        :personas="agentSnapshot.personas"
        :disabled="!snapshot.activeThread"
        @start="startRun"
        @create-persona="(markdownSource) => agent.createPersona(markdownSource)"
      />
      <PersonaGroupPanel
        :personas="agentSnapshot.personas"
        :groups="agentSnapshot.personaGroups"
        @create="(input) => agent.createPersonaGroup(input)"
        @update="(input) => agent.updatePersonaGroup(input)"
        @delete="(id) => agent.deletePersonaGroup(id)"
      />
      <DiffView
        :run="agentSnapshot.activeRun"
        :diff="agentSnapshot.diff"
        @load-diff="(agentRunId) => agent.loadDiff(agentRunId)"
        @keep="(agentRunId) => agent.keepRun(agentRunId)"
        @discard="(agentRunId) => agent.discardRun(agentRunId)"
        @push="(agentRunId, ack) => agent.pushRun(agentRunId, ack)"
      />
    </aside>
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

.inbox-toggle .badge {
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
