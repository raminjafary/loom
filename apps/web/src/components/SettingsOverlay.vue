<script setup lang="ts">
import type {
 AgentPersona,
 Capability,
 DirectoryListing,
 MasteryView,
 SubjectMapListing,
 PersonaCapability,
 PersonaDraft,
 PersonaGroup,
 Repository,
 Runner,
} from '@loom/api-contract'
import { computed, onMounted, ref } from 'vue'
import CapabilityPanel from './CapabilityPanel.vue'
import MasteryPanel from './MasteryPanel.vue'
import PersonaEditor from './PersonaEditor.vue'
import PersonaGroupPanel from './PersonaGroupPanel.vue'
import RepositoryPanel from './RepositoryPanel.vue'
import RunnerPanel from './RunnerPanel.vue'

/**
 * Configuration, out of the sidebar.
 *
 * Runners, repositories, personas, capabilities and groups are things a human sets
 * up once and then rarely touches. They were occupying two thirds of a 21rem column
 * that is supposed to answer "what is happening right now", and they need width the
 * column never had — a persona is a markdown document, and it was being edited in a
 * ten-row textarea 240px wide.
 */

const props = defineProps<{
 runners: Runner[]
 repositories: Repository[]
 personas: AgentPersona[]
 personaGroups: PersonaGroup[]
 capabilities: Capability[]
 capabilityAttachments: PersonaCapability[]
 lastPairing: { runnerId: string; name: string; rawToken: string } | null
 /** The expertise tab — fetched on demand, so never part of the session snapshot. */
 masteryPersonaId: string | null
 masteryMaps: SubjectMapListing[]
 masteryView: MasteryView | null
 masteryLoading: boolean
 masteryError: string | null
 /** What the last curation pass did. */
 masteryCuration: {
 checked: number
 kept: number
 retired: number
 proposed: number
 withdrawn: number
 } | null
}>

const repositoryNames = computed( =>
 Object.fromEntries(props.repositories.map((repository) => [repository.id, repository.displayName])),
)

const emit = defineEmits<{
 close: []
 'select-expertise': [personaId: string]
 'select-map': [mapId: string]
 'refresh-maps': []
 master: [
 input: {
 repositoryId: string
 subjectKind: 'repository' | 'author'
 subjectRef: string
 focus: string[]
 guidance: string
 },
 ]
 /** Portable expertise: a human's standing answer about whether a map is used. */
 'set-retrieval': [input: { mapId: string; override: 'on' | 'off' | null }]
 /** One curation pass over one map. */
 curate: [mapId: string]
 'create-pairing-token': [name: string]
 bind: [input: { runnerId: string; path: string; displayName: string }]
 'create-repository': [
 input: { runnerId: string; parentPath: string; name: string; displayName: string },
 ]
 list: [input: { runnerId: string; path: string }, done: (listing: DirectoryListing) => void]
 'set-verify-command': [repositoryId: string, command: string | null]
 'set-install-command': [repositoryId: string, command: string | null]
 'warm-cache': [
 repositoryId: string,
 done: (result: { ok: boolean; detail: string | null }) => void,
 ]
 'remove-runner': [runnerId: string, done: (r: { ok: boolean; reason: string | null }) => void]
 unbind: [
 input: { repositoryId: string; acknowledge: boolean },
 done: (r: { ok: boolean; reason: string | null }) => void,
 ]
 'delete-persona': [personaId: string]
 'create-persona': [markdownSource: string]
 'update-persona': [input: { personaId: string; markdownSource: string }]
 'parse-persona': [markdownSource: string, done: (draft: PersonaDraft) => void]
 'reset-persona': [personaId: string]
 register: [
 input: {
 kind: 'mcp' | 'skill'
 name: string
 description: string
 transport?: 'stdio' | 'sse' | 'http' | null
 command?: string | null
 args?: string[]
 url?: string | null
 content?: string | null
 },
 ]
 remove: [capabilityId: string]
 attach: [input: { personaId: string; capabilityId: string; allowedTools?: string[] }]
 detach: [input: { personaId: string; capabilityId: string }]
 'create-group': [input: { name: string; personaIds: string[] }]
 'update-group': [input: { personaGroupId: string; name: string; personaIds: string[] }]
 'delete-group': [personaGroupId: string]
 /** Opens the composition canvas. */
 compose: []
}>

type Tab = 'infrastructure' | 'personas' | 'expertise' | 'capabilities'

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
 { id: 'infrastructure', label: 'Runners & repositories' },
 { id: 'personas', label: 'Personas & groups' },
 { id: 'expertise', label: 'Expertise' },
 { id: 'capabilities', label: 'Capabilities' },
]

const tab = ref<Tab>('infrastructure')

const onKeydown = (event: KeyboardEvent) => {
 if (event.key === 'Escape') emit('close')
}

/**
 * The Escape handler sat on a `tabindex="-1"` element that nothing ever focused, so
 * it never fired — and unlike the diff and graph overlays this scrim had no
 * `@click.self` either. Settings was closable only by its ✕, while claiming
 * `aria-modal="true"`.
 *
 * Focusing the scrim on mount is what makes both the keydown and the modal claim
 * true, and it moves focus off whatever was behind the overlay.
 */
const scrim = ref<HTMLElement | null>(null)
onMounted( => scrim.value?.focus)
</script>

<template>
 <div
 ref="scrim"
 class="scrim"
 role="dialog"
 aria-modal="true"
 aria-label="Settings"
 tabindex="-1"
 @keydown="onKeydown"
 @click.self="emit('close')"
 >
 <div class="sheet">
 <header>
 <h2>Settings</h2>
 <nav>
 <button
 v-for="entry in TABS"
:key="entry.id"
 type="button"
:class="{ on: tab === entry.id }"
 @click="tab = entry.id"
 >
 {{ entry.label }}
 </button>
 </nav>
 <button type="button" class="close" aria-label="Close settings" @click="emit('close')">
 ✕
 </button>
 </header>

 <div class="body">
 <template v-if="tab === 'infrastructure'">
 <RunnerPanel
:runners="runners"
:last-pairing="lastPairing"
 @create-pairing-token="(name) => emit('create-pairing-token', name)"
 @remove="(runnerId, done) => emit('remove-runner', runnerId, done)"
 />
 <RepositoryPanel
:repositories="repositories"
:runners="runners"
 @bind="(input) => emit('bind', input)"
 @create="(input) => emit('create-repository', input)"
 @list="(input, done) => emit('list', input, done)"
 @set-verify-command="(id, command) => emit('set-verify-command', id, command)"
 @set-install-command="(id, command) => emit('set-install-command', id, command)"
 @warm-cache="(id, done) => emit('warm-cache', id, done)"
 @unbind="(input, done) => emit('unbind', input, done)"
 />
 </template>

 <template v-else-if="tab === 'personas'">
 <PersonaEditor
:personas="personas"
:capabilities="capabilities"
:attachments="capabilityAttachments"
 @create-persona="(source) => emit('create-persona', source)"
 @update-persona="(input) => emit('update-persona', input)"
 @delete-persona="(personaId) => emit('delete-persona', personaId)"
 @attach="(input) => emit('attach', input)"
 @detach="(input) => emit('detach', input)"
 @parse="(source, done) => emit('parse-persona', source, done)"
 @reset-persona="(personaId) => emit('reset-persona', personaId)"
 />
 <PersonaGroupPanel
:personas="personas"
:groups="personaGroups"
 @create="(input) => emit('create-group', input)"
 @update="(input) => emit('update-group', input)"
 @delete="(id) => emit('delete-group', id)"
 @compose="emit('compose')"
 />
 </template>

 <template v-else-if="tab === 'expertise'">
 <MasteryPanel
:personas="personas"
:persona-id="masteryPersonaId"
:repositories="repositories"
:maps="masteryMaps"
:view="masteryView"
:loading="masteryLoading"
:error="masteryError"
:repository-names="repositoryNames"
:active-repository-id="null"
 @select-persona="(personaId) => emit('select-expertise', personaId)"
 @select="(mapId) => emit('select-map', mapId)"
 @refresh="emit('refresh-maps')"
 @master="(input) => emit('master', input)"
 @set-retrieval="(input) => emit('set-retrieval', input)"
:curation="masteryCuration"
 @curate="(mapId) => emit('curate', mapId)"
 />
 </template>

 <CapabilityPanel
 v-else
:capabilities="capabilities"
:attachments="capabilityAttachments"
:personas="personas"
 @register="(input) => emit('register', input)"
 @remove="(id) => emit('remove', id)"
 @attach="(input) => emit('attach', input)"
 @detach="(input) => emit('detach', input)"
 />
 </div>
 </div>
 </div>
</template>

<style scoped>
.scrim {
 position: fixed;
 inset: 0;
 z-index: 40;
 display: flex;
 align-items: center;
 justify-content: center;
 padding: 2rem;
 background: rgb(0 0 0 / 45%);
}

.sheet {
 display: flex;
 flex-direction: column;
 width: min(64rem, 100%);
 max-height: 100%;
 border: 1px solid var(--border);
 border-radius: 0.75rem;
 background: var(--surface);
 overflow: hidden;
}

header {
 display: flex;
 align-items: center;
 gap: 1rem;
 padding: 0.7rem 1rem;
 border-bottom: 1px solid var(--border);
}

h2 {
 margin: 0;
 font-size: 0.95rem;
}

nav {
 display: flex;
 gap: 0.3rem;
}

nav button {
 padding: 0.28rem 0.6rem;
 border: 1px solid transparent;
 border-radius: 0.375rem;
 background: none;
 color: var(--text-muted);
 font: inherit;
 font-size: 0.8rem;
 cursor: pointer;
}

nav button.on {
 border-color: var(--border);
 background: var(--bg);
 color: var(--text);
 font-weight: 600;
}

.close {
 margin-left: auto;
 padding: 0.2rem 0.45rem;
 border: 1px solid var(--border);
 border-radius: 0.375rem;
 background: var(--bg);
 color: var(--text-muted);
 font: inherit;
 cursor: pointer;
}

.body {
 flex: 1;
 min-height: 0;
 overflow-y: auto;
 padding: 1rem;
 display: flex;
 flex-direction: column;
 gap: 1rem;
}
</style>
