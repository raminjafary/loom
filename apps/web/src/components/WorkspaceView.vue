<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import Composer from './Composer.vue'
import ChannelList from './ChannelList.vue'
import MessageList from './MessageList.vue'
import { useWorkspaceStore } from '../stores/workspace'

const store = useWorkspaceStore()

const snapshot = computed(() => store.snapshot)
const activeChannel = computed(
  () => snapshot.value.channels.find((c) => c.id === snapshot.value.activeChannelId) ?? null,
)

onMounted(() => {
  void store.start()
})

onBeforeUnmount(() => {
  store.dispose()
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

      <MessageList :messages="snapshot.messages" />

      <Composer :disabled="!snapshot.activeThread" @send="store.send" />
    </main>
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
</style>
