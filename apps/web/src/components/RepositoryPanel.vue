<script setup lang="ts">
import type { DirectoryListing, Repository, Runner } from '@loom/api-contract'
import { ref } from 'vue'
import ConfirmButton from './ConfirmButton.vue'
import DirectoryPicker from './DirectoryPicker.vue'

const props = defineProps<{
 repositories: Repository[]
 runners: Runner[]
}>

const emit = defineEmits<{
 bind: [input: { runnerId: string; path: string; displayName: string }]
 create: [input: { runnerId: string; parentPath: string; name: string; displayName: string }]
 list: [input: { runnerId: string; path: string }, done: (listing: DirectoryListing) => void]
 'set-verify-command': [repositoryId: string, verifyCommand: string | null]
 'set-install-command': [repositoryId: string, installCommand: string | null]
 'warm-cache': [repositoryId: string, done: (result: { ok: boolean; detail: string | null }) => void]
 unbind: [
 input: { repositoryId: string; acknowledge: boolean },
 done: (result: { ok: boolean; reason: string | null }) => void,
 ]
}>

/**
 * Unbinding deletes the repository's runs and the spend recorded against them, and
 * the server will not do it until told the count is acceptable. So the first attempt
 * is a question: it comes back refused, carrying the number, and that number is what
 * the human is actually asked to agree to.
 */
const unbindWarning = ref<{ repositoryId: string; reason: string } | null>(null)

const tryUnbind = (repositoryId: string, acknowledge: boolean) => {
 emit('unbind', { repositoryId, acknowledge }, (result) => {
 unbindWarning.value = result.ok ? null: { repositoryId, reason: result.reason ?? 'Refused' }
 })
}

// The picker replaces typing an absolute path. The old form stays
// behind a toggle rather than being deleted: a headless or scripted setup still
// needs to name a path directly, and the Runner validates either way.
const showPathForm = ref(false)

const runnerId = ref('')
const path = ref('')
const displayName = ref('')

/**
 * What the merge queue runs before merging into this repository. Editing is per row, and an empty value clears it — a repository with no
 * command merges *unverified*, which the queue's entries then say outright rather
 * than reporting as a pass.
 */
const editing = ref<string | null>(null)
const draft = ref('')

const startEditing = (repo: Repository) => {
 editing.value = repo.id
 draft.value = repo.verifyCommand ?? ''
}

const saveVerifyCommand = (repositoryId: string) => {
 const value = draft.value.trim
 emit('set-verify-command', repositoryId, value.length > 0 ? value: null)
 editing.value = null
}

/**
 * What warms this repository's dependency cache, and the reason it is
 * next to the verification command rather than somewhere else: verification runs with
 * `--network none`, so on any repository whose tests need an install step the verify
 * command can only succeed against a warmed cache. Setting one without the other is the
 * configuration that looks right and silently merges unverified.
 */
const editingInstall = ref<string | null>(null)
const installDraft = ref('')
const warming = ref<string | null>(null)
const warmResult = ref<{ repositoryId: string; ok: boolean; detail: string | null } | null>(null)

const startEditingInstall = (repo: Repository) => {
 editingInstall.value = repo.id
 installDraft.value = repo.installCommand ?? ''
}

const saveInstallCommand = (repositoryId: string) => {
 const value = installDraft.value.trim
 emit('set-install-command', repositoryId, value.length > 0 ? value: null)
 editingInstall.value = null
}

const warm = (repositoryId: string) => {
 warming.value = repositoryId
 warmResult.value = null
 emit('warm-cache', repositoryId, (result) => {
 warming.value = null
 warmResult.value = { repositoryId,...result }
 })
}

const submit = => {
 if (!runnerId.value || !path.value.trim || !displayName.value.trim) return
 emit('bind', { runnerId: runnerId.value, path: path.value.trim, displayName: displayName.value.trim })
 path.value = ''
 displayName.value = ''
}
</script>

<template>
 <section class="panel">
 <h3>Repositories</h3>

 <ul class="list">
 <li v-for="repo in props.repositories":key="repo.id" class="item">
 <span class="name">{{ repo.displayName }}</span>
 <span class="meta":title="repo.absolutePath">{{ repo.absolutePath }}</span>
 <form v-if="editing === repo.id" class="verify-form" @submit.prevent="saveVerifyCommand(repo.id)">
 <input v-model="draft" placeholder="pnpm -r test" aria-label="Verification command" />
 <button type="submit">Save</button>
 <button type="button" class="link" @click="editing = null">Cancel</button>
 </form>
 <button v-else type="button" class="link verify" @click="startEditing(repo)">
 {{ repo.verifyCommand ? `verify: ${repo.verifyCommand}`: 'merges unverified — set a command' }}
 </button>

 <form
 v-if="editingInstall === repo.id"
 class="verify-form"
 @submit.prevent="saveInstallCommand(repo.id)"
 >
 <input v-model="installDraft" placeholder="npm ci" aria-label="Install command" />
 <button type="submit">Save</button>
 <button type="button" class="link" @click="editingInstall = null">Cancel</button>
 </form>
 <button v-else type="button" class="link verify" @click="startEditingInstall(repo)">
 {{ repo.installCommand ? `install: ${repo.installCommand}`: 'no install command — set one to warm the cache' }}
 </button>

 <!--
 Warming needs the install command, so the button says so rather than failing
 into a detail message a human has to read to learn what was missing.
 -->
 <div class="unbind-row">
 <ConfirmButton
 variant="link"
 label="Unbind"
 confirm-label="Unbind repository"
 @confirm="tryUnbind(repo.id, false)"
 />
 </div>
 <p v-if="unbindWarning?.repositoryId === repo.id" class="unbind-warning" role="alert">
 {{ unbindWarning.reason }}
 <!-- Shown only once the server has said what would be lost. -->
 <button type="button" class="link danger" @click="tryUnbind(repo.id, true)">
 Unbind anyway
 </button>
 <button type="button" class="link" @click="unbindWarning = null">Keep it</button>
 </p>

 <button
 type="button"
 class="link warm"
:disabled="!repo.installCommand || warming === repo.id"
 @click="warm(repo.id)"
 >
 {{ warming === repo.id ? 'warming…': 'Warm dependency cache' }}
 </button>
 <p
 v-if="warmResult && warmResult.repositoryId === repo.id"
 class="warm-result"
:class="{ bad: !warmResult.ok }"
 >
 <!--
 The success detail says whether a prepared tree came out of the warm
. A bare "Cache warmed." cannot
 distinguish "runs now start with node_modules in place" from "the install
 produced nothing a run can be given".
 -->
 {{
 warmResult.ok
 ? (warmResult.detail ?? 'Cache warmed.')
: `Warm failed: ${warmResult.detail ?? 'no detail'}`
 }}
 </p>
 </li>
 <li v-if="props.repositories.length === 0" class="empty">No repositories bound yet</li>
 </ul>

 <DirectoryPicker
:runners="props.runners"
 @list="(input, done) => emit('list', input, done)"
 @bind="(input) => emit('bind', input)"
 @create="(input) => emit('create', input)"
 />

 <button type="button" class="link toggle" @click="showPathForm = !showPathForm">
 {{ showPathForm ? 'hide': 'or bind by absolute path' }}
 </button>

 <form v-if="showPathForm" class="bind-form" @submit.prevent="submit">
 <select v-model="runnerId" aria-label="Runner">
 <option value="" disabled>Select runner…</option>
 <option v-for="runner in props.runners":key="runner.id":value="runner.id">
 {{ runner.name }}
 </option>
 </select>
 <input v-model="path" placeholder="/absolute/path/to/repo" aria-label="Repository path" />
 <input v-model="displayName" placeholder="display name" aria-label="Display name" />
 <button type="submit":disabled="!runnerId || !path.trim || !displayName.trim">
 Bind
 </button>
 </form>
 </section>
</template>

<style scoped>
.toggle {
 margin-top: 0.4rem;
}

.verify-form {
 display: flex;
 gap: 0.3rem;
 margin-top: 0.2rem;
}

.verify-form input {
 flex: 1;
 min-width: 0;
}

button.link {
 padding: 0;
 border: none;
 background: none;
 color: var(--text-faint);
 font: inherit;
 font-size: 0.72rem;
 text-align: left;
 cursor: pointer;
 overflow-wrap: anywhere;
}

button.link:hover {
 color: var(--text);
}

.panel {
 padding: 0.85rem 1rem;
 border: 1px solid var(--border);
 border-radius: 0.6rem;
 background: var(--bg);
}

h3 {
 margin: 0 0 0.5rem;
 font-size: 0.8rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
 color: var(--text-faint);
}

.list {
 list-style: none;
 margin: 0 0 0.6rem;
 padding: 0;
 display: flex;
 flex-direction: column;
 gap: 0.3rem;
}

.item {
 display: flex;
 flex-direction: column;
 font-size: 0.85rem;
}

.name {
 font-weight: 600;
}

.meta {
 color: var(--text-faint);
 font-size: 0.75rem;
 font-family: ui-monospace, monospace;
 white-space: nowrap;
 overflow: hidden;
 text-overflow: ellipsis;
 direction: rtl;
 text-align: left;
}

.warm-result {
 margin: 0.15rem 0 0;
 font-size: 0.72rem;
 color: var(--text-muted);
}

.warm-result.bad {
 color: var(--danger, #c66);
}

.link:disabled {
 opacity: 0.45;
 cursor: not-allowed;
}

.empty {
 color: var(--text-faint);
 font-size: 0.85rem;
}

.bind-form {
 display: flex;
 flex-direction: column;
 gap: 0.35rem;
}

.bind-form select,
.bind-form input {
 padding: 0.35rem 0.5rem;
 border: 1px solid var(--border);
 border-radius: 0.375rem;
 background: var(--bg);
 color: var(--text);
 font: inherit;
}

.bind-form button {
 padding: 0.35rem 0.55rem;
 border: 1px solid var(--border);
 border-radius: 0.375rem;
 background: var(--surface-hover);
 color: var(--text);
 font: inherit;
 cursor: pointer;
}

.bind-form button:disabled {
 opacity: 0.45;
 cursor: not-allowed;
}

.unbind-row {
 margin-top: 0.15rem;
}

.unbind-warning {
 margin: 0.25rem 0 0;
 padding: 0.35rem 0.5rem;
 border-radius: 0.35rem;
 background: color-mix(in oklab, var(--danger) 12%, transparent);
 color: var(--danger);
 font-size: 0.75rem;
 line-height: 1.45;
}

.unbind-warning.link {
 margin-left: 0.4rem;
}
</style>
