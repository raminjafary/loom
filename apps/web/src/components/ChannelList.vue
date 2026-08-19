<script setup lang="ts">
import type { Channel } from '@loom/api-contract'
import { ref } from 'vue'
import ConfirmButton from './ConfirmButton.vue'

const props = defineProps<{
  channels: Channel[]
  activeChannelId: string | null
  /**
   * Unread count per channel id. Absent means nothing unread —
   * see the session's own note on why this is not a field on `Channel`.
   */
  unread?: Record<string, number>
}>()

/** Capped in the label, not in the count: "99+" is a badge, "1,284" is a paragraph. */
const unreadLabel = (channelId: string): string => {
  const count = props.unread?.[channelId] ?? 0
  return count > 99 ? '99+' : String(count)
}

const hasUnread = (channelId: string): boolean => (props.unread?.[channelId] ?? 0) > 0

const emit = defineEmits<{
  select: [channelId: string]
  create: [name: string]
  delete: [
    input: { channelId: string; acknowledge: boolean },
    done: (result: { ok: boolean; reason: string | null }) => void,
  ]
}>()

/**
 * Deleting a channel takes its messages and every run started in it. The server
 * refuses the first attempt and says how much that is, and *that sentence* is the
 * confirmation a human should be answering — not a generic "are you sure" written
 * before anyone knew the number.
 */
const pendingDelete = ref<{ channelId: string; reason: string } | null>(null)

const tryDelete = (channelId: string, acknowledge: boolean) => {
  emit('delete', { channelId, acknowledge }, (result) => {
    pendingDelete.value = result.ok ? null : { channelId, reason: result.reason ?? 'Refused' }
  })
}

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
      <div v-for="channel in props.channels" :key="channel.id" class="channel-row">
        <button
          class="channel"
          :class="{ active: channel.id === props.activeChannelId }"
          type="button"
          @click="emit('select', channel.id)"
        >
          <span class="hash">#</span>{{ channel.name }}
        </button>
        <!--
          Beside the name rather than inside the button: a count that moves while a human
          is aiming at a channel changes the click target, which is the one thing a
          sidebar must not do.
        -->
        <span
          v-if="hasUnread(channel.id)"
          class="unread"
          :title="`${unreadLabel(channel.id)} unread`"
        >
          {{ unreadLabel(channel.id) }}
        </span>
        <ConfirmButton
          v-if="props.channels.length > 1"
          variant="icon"
          :label="`Delete #${channel.name}`"
          :confirm-label="`Confirm deleting #${channel.name}`"
          class="remove"
          @confirm="tryDelete(channel.id, false)"
        />
        <p v-if="pendingDelete && pendingDelete.channelId === channel.id" class="refusal" role="alert">
          {{ pendingDelete.reason }}
          <span class="refusal-actions">
            <button type="button" class="danger" @click="tryDelete(channel.id, true)">
              Delete anyway
            </button>
            <button type="button" @click="pendingDelete = null">Keep</button>
          </span>
        </p>
      </div>
      <p v-if="props.channels.length === 0" class="empty">No channels yet</p>
    </nav>

    <form class="new-channel" @submit.prevent="submit">
      <input v-model="draft" placeholder="new-channel" aria-label="New channel name" />
      <button type="submit" :disabled="draft.trim().length < 2">Add</button>
    </form>
  </aside>
</template>

<style scoped>
.unread {
  min-width: 1.25rem;
  padding: 0 0.35rem;
  border-radius: 999px;
  background: var(--accent, #7aa2f7);
  color: var(--accent-fg, #10121a);
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1.25rem;
  text-align: center;
  /* Never shrinks: a badge squeezed by a long channel name reads as part of the name. */
  flex: 0 0 auto;
}

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

.channel-row:hover .channel {
  background: transparent;
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

.channel-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.15rem;
  border-radius: 0.375rem;
}

.channel-row:hover {
  background: var(--surface-hover);
}

.channel-row .channel {
  flex: 1;
  min-width: 0;
}

/* Only on hover or focus: a delete affordance on every row, always, invites the
   accident it is guarded against. */
.remove {
  opacity: 0;
  transition: opacity 100ms ease;
}

.channel-row:hover .remove,
.channel-row:focus-within .remove {
  opacity: 1;
}

.refusal {
  flex-basis: 100%;
  margin: 0.2rem 0 0.4rem;
  padding: 0.35rem 0.45rem;
  border-radius: 0.35rem;
  background: color-mix(in oklab, var(--danger) 12%, transparent);
  color: var(--danger);
  font-size: 0.72rem;
  line-height: 1.45;
}

.refusal-actions {
  display: flex;
  gap: 0.6rem;
  margin-top: 0.25rem;
}

.refusal-actions button {
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-size: 0.72rem;
  text-decoration: underline;
  cursor: pointer;
}

.refusal-actions .danger {
  color: var(--danger);
  font-weight: 600;
}
</style>
