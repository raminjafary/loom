<script setup lang="ts">
import type { Channel } from '@loom/api-contract'
import { ref } from 'vue'

const props = defineProps<{
  channels: Channel[]
  activeChannelId: string | null
}>()

const emit = defineEmits<{
  select: [channelId: string]
  create: [name: string]
}>()

const draft = ref('')

const submit = () => {
  const name = draft.value.trim()
  if (name.length < 2) return
  emit('create', name)
  draft.value = ''
}
</script>

<template>
  <aside class="sidebar">
    <h1 class="brand">Loom</h1>

    <nav class="channels">
      <button
        v-for="channel in props.channels"
        :key="channel.id"
        class="channel"
        :class="{ active: channel.id === props.activeChannelId }"
        type="button"
        @click="emit('select', channel.id)"
      >
        <span class="hash">#</span>{{ channel.name }}
      </button>
      <p v-if="props.channels.length === 0" class="empty">No channels yet</p>
    </nav>

    <form class="new-channel" @submit.prevent="submit">
      <input v-model="draft" placeholder="new-channel" aria-label="New channel name" />
      <button type="submit" :disabled="draft.trim().length < 2">Add</button>
    </form>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 15rem;
  padding: 1rem;
  border-right: 1px solid var(--border);
  background: var(--surface);
}

.brand {
  margin: 0;
  font-size: 1.1rem;
  letter-spacing: 0.02em;
}

.channels {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  flex: 1;
  overflow-y: auto;
}

.channel {
  display: flex;
  gap: 0.35rem;
  padding: 0.4rem 0.5rem;
  border: 0;
  border-radius: 0.375rem;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.channel:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.channel.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.hash {
  opacity: 0.5;
}

.empty {
  margin: 0;
  padding: 0.4rem 0.5rem;
  color: var(--text-faint);
  font-size: 0.85rem;
}

.new-channel {
  display: flex;
  gap: 0.375rem;
}

.new-channel input {
  flex: 1;
  min-width: 0;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
}

.new-channel button {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--surface-hover);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}

.new-channel button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
