<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import ApprovalCard from './ApprovalCard.vue'
import Composer from './Composer.vue'
import ChannelList from './ChannelList.vue'
import DiffView from './DiffView.vue'
import MessageList from './MessageList.vue'
import PersonaForm from './PersonaForm.vue'
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
        <h2 v-if="activeChannel">#{{ activeChannel.name }}</h2>
        <h2 v-else class="muted">No channel selected</h2>

        <span class="conn" :class="snapshot.connection">
          {{ snapshot.connection }}
        </span>
      </header>

      <p v-if="snapshot.error" class="error" role="alert">{{ snapshot.error }}</p>
      <p v-if="agentSnapshot.error" class="error" role="alert">{{ agentSnapshot.error }}</p>

      <MessageList :messages="snapshot.messages" :persona-name-by-run-id="personaNameByRunId" />

      <ApprovalCard
        :approvals="agentSnapshot.pendingApprovals"
        @decide="(id, decision) => agent.decide(id, decision)"
      />

      <Composer :disabled="!snapshot.activeThread" @send="store.send" />
    </main>

    <aside class="agent-sidebar">
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
      <DiffView
        :run="agentSnapshot.activeRun"
        :diff="agentSnapshot.diff"
        @load-diff="(agentRunId) => agent.loadDiff(agentRunId)"
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

.error {
  margin: 0;
  padding: 0.6rem 1.25rem;
  background: color-mix(in oklab, var(--danger) 14%, transparent);
  color: var(--danger);
  font-size: 0.85rem;
}

.agent-sidebar {
  width: 18rem;
  flex-shrink: 0;
  overflow-y: auto;
  border-left: 1px solid var(--border);
  background: var(--surface);
}
</style>
