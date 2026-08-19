<script setup lang="ts">
import type { DirectoryListing, Runner } from '@loom/api-contract'
import { ref, watch } from 'vue'

/**
 * The directory picker, replacing bind-by-typed-absolute-path.
 *
 * It opens on the Runner's allowed roots rather than on any path this component
 * chooses, so the first thing a human sees is already inside the boundary. There
 * is no path input: a typed path would be a way to name somewhere the picker
 * would not have shown, and while the Runner refuses that anyway, offering the
 * field invites people to try.
 *
 * "Up" disappears at the root — `parent` comes back null — for the same reason.
 * The boundary should be visible as an absence, not as an error after a click.
 */

const props = defineProps<{ runners: Runner[]; busy?: boolean }>()
const emit = defineEmits<{
  list: [input: { runnerId: string; path: string }, done: (listing: DirectoryListing) => void]
  bind: [input: { runnerId: string; path: string; displayName: string }]
  create: [input: { runnerId: string; parentPath: string; name: string; displayName: string }]
}>()

const runnerId = ref('')
const listing = ref<DirectoryListing | null>(null)
const newRepoName = ref('')
const error = ref<string | null>(null)

const browse = (path: string) => {
  if (!runnerId.value) return
  error.value = null
  emit('list', { runnerId: runnerId.value, path }, (next) => {
    listing.value = next
  })
}

// Re-opens at the roots whenever the Runner changes — a cursor from one Runner's
// filesystem means nothing on another's.
watch(runnerId, () => {
  listing.value = null
  if (runnerId.value) browse('')
})

const bindHere = () => {
  if (!runnerId.value || !listing.value?.path) return
  const path = listing.value.path
  emit('bind', { runnerId: runnerId.value, path, displayName: path.split('/').pop() ?? path })
}

const createHere = () => {
  const name = newRepoName.value.trim()
  if (!runnerId.value || !listing.value?.path || !name) return
  emit('create', {
    runnerId: runnerId.value,
    parentPath: listing.value.path,
    name,
    displayName: name,
  })
  newRepoName.value = ''
}

const atRoots = () => listing.value !== null && listing.value.path === ''
</script>

<template>
  <div class="picker">
    <select v-model="runnerId" aria-label="Runner">
      <option value="" disabled>Select a Runner to browse…</option>
      <option v-for="runner in props.runners" :key="runner.id" :value="runner.id">
        {{ runner.name }}{{ runner.connected ? '' : ' (offline)' }}
      </option>
    </select>

    <template v-if="listing">
      <div class="crumb">
        <button v-if="listing.parent !== null" type="button" class="up" @click="browse(listing.parent)">
          ↑ up
        </button>
        <span class="here">{{ atRoots() ? 'allowed roots' : listing.path }}</span>
      </div>

      <ul class="entries">
        <li v-for="entry in listing.entries" :key="entry.path">
          <button
            v-if="entry.isDirectory"
            type="button"
            class="entry dir"
            @click="browse(entry.path)"
          >
            <span class="icon">{{ entry.isRepository ? '◆' : '▸' }}</span>
            <span class="name">{{ entry.name }}</span>
            <span v-if="entry.isRepository" class="tag">git</span>
          </button>
          <span v-else class="entry file">
            <span class="icon">·</span>
            <span class="name">{{ entry.name }}</span>
          </span>
        </li>
        <li v-if="listing.entries.length === 0" class="empty">Empty.</li>
      </ul>

      <p v-if="listing.truncated" class="truncated">
        Only the first entries are shown — this directory has more than the Runner will list.
      </p>

      <div v-if="!atRoots()" class="actions">
        <button type="button" :disabled="props.busy" @click="bindHere">Bind this directory</button>
        <form class="create" @submit.prevent="createHere">
          <input v-model="newRepoName" placeholder="new-repo-name" aria-label="New repository name" />
          <button type="submit" :disabled="props.busy || !newRepoName.trim()">git init here</button>
        </form>
      </div>
    </template>

    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.crumb {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}

.here {
  font-size: 0.72rem;
  color: var(--text-faint);
  overflow-wrap: anywhere;
}

.up {
  padding: 0.1rem 0.35rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--surface-hover);
  color: var(--text);
  font: inherit;
  font-size: 0.7rem;
  cursor: pointer;
}

.entries {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 14rem;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
}

.entry {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
  width: 100%;
  padding: 0.2rem 0.4rem;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 0.78rem;
  text-align: left;
}

.entry.dir {
  cursor: pointer;
}

.entry.dir:hover {
  background: var(--surface-hover);
}

.entry.file {
  color: var(--text-faint);
}

.icon {
  width: 0.9rem;
  flex: none;
}

.name {
  overflow-wrap: anywhere;
}

.tag {
  margin-left: auto;
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--accent);
}

.empty,
.truncated {
  margin: 0;
  padding: 0.3rem 0.4rem;
  font-size: 0.72rem;
  color: var(--text-faint);
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.create {
  display: flex;
  gap: 0.3rem;
}

.create input {
  flex: 1;
  min-width: 0;
}

.actions button {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--surface-hover);
  color: var(--text);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.error {
  margin: 0;
  font-size: 0.72rem;
  color: var(--danger);
}
</style>
