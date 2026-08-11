<script setup lang="ts">
import type { AgentPersona, Capability, PersonaCapability } from '@loom/api-contract'
import { computed, ref } from 'vue'
import ConfirmButton from './ConfirmButton.vue'

/**
 * The capability registry — MCP servers and skills, attached per
 * persona with per-attachment scopes.
 *
 * Registering is deliberately an explicit, typed-out act rather than a discovery
 * flow. The whole security property is that a capability is something an
 * operator added on purpose; a UI that offered to import whatever a repository
 * declared would hand that decision back to the repository.
 */

const props = defineProps<{
 capabilities: Capability[]
 attachments: PersonaCapability[]
 personas: AgentPersona[]
}>

const emit = defineEmits<{
 register: [input: {
 kind: 'mcp' | 'skill'
 name: string
 description: string
 transport?: 'stdio' | 'sse' | 'http' | null
 command?: string | null
 args?: string[]
 url?: string | null
 content?: string | null
 }]
 remove: [capabilityId: string]
 attach: [input: { personaId: string; capabilityId: string; allowedTools?: string[] }]
 detach: [input: { personaId: string; capabilityId: string }]
}>

const kind = ref<'mcp' | 'skill'>('mcp')
const name = ref('')
const description = ref('')
const transport = ref<'stdio' | 'sse' | 'http'>('stdio')
const command = ref('')
const args = ref('')
const url = ref('')
const content = ref('')

const attachPersona = ref('')
const attachTools = ref('')

const submit = => {
 if (!name.value.trim) return
 emit('register', {
 kind: kind.value,
 name: name.value.trim,
 description: description.value.trim,
...(kind.value === 'mcp'
 ? {
 transport: transport.value,
 command: command.value.trim || null,
 args: args.value.split(/\s+/).filter((a) => a.length > 0),
 url: url.value.trim || null,
 }
: { content: content.value }),
 })
 name.value = ''
 description.value = ''
 command.value = ''
 args.value = ''
 url.value = ''
 content.value = ''
}

const personaName = (personaId: string) =>
 props.personas.find((persona) => persona.id === personaId)?.name ?? personaId

const attachmentsFor = (capabilityId: string) =>
 props.attachments.filter((attachment) => attachment.capabilityId === capabilityId)

const canAttach = computed( => attachPersona.value.length > 0)

const doAttach = (capabilityId: string) => {
 if (!canAttach.value) return
 const tools = attachTools.value.split(/[\s,]+/).filter((t) => t.length > 0)
 emit('attach', {
 personaId: attachPersona.value,
 capabilityId,
...(tools.length > 0 ? { allowedTools: tools }: {}),
 })
 attachTools.value = ''
}
</script>

<template>
 <section class="panel">
 <h3>Capabilities</h3>

 <ul class="list">
 <li v-for="capability in props.capabilities":key="capability.id" class="item">
 <div class="head">
 <span class="name">{{ capability.name }}</span>
 <span class="kind">{{ capability.kind }}</span>
 <ConfirmButton
 variant="link"
 label="remove"
 confirm-label="remove, detaching from every persona"
 @confirm="emit('remove', capability.id)"
 />
 </div>
 <p v-if="capability.description" class="desc">{{ capability.description }}</p>
 <p v-if="capability.kind === 'mcp'" class="meta">
 {{ capability.transport }}:
 {{ capability.transport === 'stdio' ? capability.command: capability.url }}
 <!--
 The pinned tool-list hash. Said out loud when absent, because an
 unpinned server is one whose tool list nobody has reviewed yet.
 -->
 <span class="pin">{{ capability.toolListHash ? 'pinned': 'not yet pinned' }}</span>
 </p>

 <ul class="attached">
 <li v-for="attachment in attachmentsFor(capability.id)":key="attachment.id">
 <span>{{ personaName(attachment.personaId) }}</span>
 <span class="scope">
 {{ attachment.allowedTools.length > 0 ? attachment.allowedTools.join(', '): 'all tools' }}
 </span>
 <ConfirmButton
 variant="link"
 label="detach"
 confirm-label="detach"
 @confirm="emit('detach', { personaId: attachment.personaId, capabilityId: capability.id })"
 />
 </li>
 </ul>

 <div class="attach-row">
 <select v-model="attachPersona" aria-label="Persona">
 <option value="" disabled>Attach to…</option>
 <option v-for="persona in props.personas":key="persona.id":value="persona.id">
 {{ persona.name }}
 </option>
 </select>
 <input
 v-if="capability.kind === 'mcp'"
 v-model="attachTools"
 placeholder="scope: tool names (blank = all)"
 aria-label="Allowed tools"
 />
 <button type="button":disabled="!canAttach" @click="doAttach(capability.id)">Attach</button>
 </div>
 </li>
 <li v-if="props.capabilities.length === 0" class="empty">Nothing registered yet.</li>
 </ul>

 <form class="register" @submit.prevent="submit">
 <select v-model="kind" aria-label="Capability kind">
 <option value="mcp">MCP server</option>
 <option value="skill">Skill</option>
 </select>
 <input v-model="name" placeholder="name" aria-label="Capability name" />
 <input v-model="description" placeholder="what it is for" aria-label="Description" />

 <template v-if="kind === 'mcp'">
 <select v-model="transport" aria-label="Transport">
 <option value="stdio">stdio</option>
 <option value="sse">sse</option>
 <option value="http">http</option>
 </select>
 <input v-if="transport === 'stdio'" v-model="command" placeholder="command" aria-label="Command" />
 <input v-if="transport === 'stdio'" v-model="args" placeholder="args (space separated)" aria-label="Args" />
 <input v-else v-model="url" placeholder="https://…" aria-label="URL" />
 </template>
 <textarea
 v-else
 v-model="content"
 rows="4"
 placeholder="SKILL.md content — provisioned into the run, never read from the repo"
 aria-label="Skill content"
 ></textarea>

 <button type="submit":disabled="!name.trim">Register</button>
 </form>
 </section>
</template>

<style scoped>
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
 margin: 0 0 0.6rem;
 padding: 0;
 list-style: none;
 display: flex;
 flex-direction: column;
 gap: 0.5rem;
}

.item {
 border: 1px solid var(--border);
 border-radius: 0.4rem;
 padding: 0.4rem 0.5rem;
}

.head {
 display: flex;
 align-items: baseline;
 gap: 0.4rem;
}

.name {
 font-size: 0.82rem;
}

.kind,
.pin,
.scope {
 font-size: 0.65rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
 color: var(--text-faint);
}

.desc,
.meta {
 margin: 0.15rem 0;
 font-size: 0.72rem;
 color: var(--text-faint);
 overflow-wrap: anywhere;
}

.attached {
 margin: 0.3rem 0 0;
 padding: 0;
 list-style: none;
}

.attached li {
 display: flex;
 align-items: baseline;
 gap: 0.4rem;
 font-size: 0.75rem;
}

.attach-row {
 display: flex;
 gap: 0.3rem;
 margin-top: 0.3rem;
}

.attach-row select,
.attach-row input {
 flex: 1;
 min-width: 0;
}

.register {
 display: flex;
 flex-direction: column;
 gap: 0.3rem;
}

button {
 padding: 0.25rem 0.5rem;
 border: 1px solid var(--border);
 border-radius: 0.35rem;
 background: var(--surface-hover);
 color: var(--text);
 font: inherit;
 font-size: 0.75rem;
 cursor: pointer;
}

button:disabled {
 opacity: 0.45;
 cursor: not-allowed;
}

button.link {
 margin-left: auto;
 padding: 0;
 border: none;
 background: none;
 color: var(--text-faint);
 font-size: 0.7rem;
}

button.link.danger {
 color: var(--danger);
}

.empty {
 font-size: 0.78rem;
 color: var(--text-faint);
}
</style>
