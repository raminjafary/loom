<script setup lang="ts">
import type { AgentPersona, PersonaGroup } from '@loom/api-contract'
import { ref } from 'vue'

const props = defineProps<{
  personas: AgentPersona[]
  groups: PersonaGroup[]
}>()

const emit = defineEmits<{
  create: [input: { name: string; personaIds: string[] }]
  update: [input: { personaGroupId: string; name: string; personaIds: string[] }]
  delete: [personaGroupId: string]
}>()

const personaName = (id: string) => props.personas.find((p) => p.id === id)?.name ?? id

const toggleMember = (group: PersonaGroup, personaId: string) => {
  const personaIds = group.personaIds.includes(personaId)
    ? group.personaIds.filter((id) => id !== personaId)
    : [...group.personaIds, personaId]
  emit('update', { personaGroupId: group.id, name: group.name, personaIds })
}

const showNewGroup = ref(false)
const draftName = ref('')
const draftMemberIds = ref(new Set<string>())

const toggleDraftMember = (personaId: string) => {
  if (draftMemberIds.value.has(personaId)) draftMemberIds.value.delete(personaId)
  else draftMemberIds.value.add(personaId)
  draftMemberIds.value = new Set(draftMemberIds.value)
}

const submitNewGroup = () => {
  if (!draftName.value.trim()) return
  emit('create', { name: draftName.value.trim(), personaIds: [...draftMemberIds.value] })
  draftName.value = ''
  draftMemberIds.value = new Set()
  showNewGroup.value = false
}
</script>

<template>
  <section class="panel">
    <h3>Persona groups</h3>

    <p v-if="props.groups.length === 0" class="empty">No groups yet — organizational only, doesn't start anything.</p>

    <ul class="groups">
      <li v-for="group in props.groups" :key="group.id" class="group">
        <div class="group-header">
          <strong>{{ group.name }}</strong>
          <button type="button" class="delete" @click="emit('delete', group.id)">Delete</button>
        </div>
        <div class="chips">
          <button
            v-for="persona in props.personas"
            :key="persona.id"
            type="button"
            class="chip"
            :class="{ active: group.personaIds.includes(persona.id) }"
            @click="toggleMember(group, persona.id)"
          >
            {{ persona.name }}
          </button>
        </div>
      </li>
    </ul>

    <button type="button" class="toggle-new" @click="showNewGroup = !showNewGroup">
      {{ showNewGroup ? 'Cancel' : '+ New group' }}
    </button>

    <form v-if="showNewGroup" class="new-group" @submit.prevent="submitNewGroup">
      <input v-model="draftName" type="text" placeholder="Group name" aria-label="Group name" />
      <div class="chips">
        <button
          v-for="persona in props.personas"
          :key="persona.id"
          type="button"
          class="chip"
          :class="{ active: draftMemberIds.has(persona.id) }"
          @click="toggleDraftMember(persona.id)"
        >
          {{ persona.name }}
        </button>
      </div>
      <button type="submit" :disabled="!draftName.trim()">Create group</button>
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

.empty {
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
  color: var(--text-faint);
}

.groups {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.group {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.35rem;
}

.delete {
  border: 0;
  background: none;
  color: var(--danger);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  padding: 0;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.chip {
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-contrast);
}

.toggle-new {
  margin-top: 0.5rem;
  padding: 0.3rem 0;
  border: 0;
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}

.new-group {
  margin-top: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.new-group input {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
}

.new-group button[type='submit'] {
  padding: 0.35rem 0.55rem;
  border: 0;
  border-radius: 0.375rem;
  background: var(--accent);
  color: var(--accent-contrast);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.new-group button[type='submit']:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
