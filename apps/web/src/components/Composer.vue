<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ disabled: boolean }>()
const emit = defineEmits<{ send: [text: string] }>()

const draft = ref('')

const submit = () => {
  const text = draft.value.trim()
  if (text.length === 0 || props.disabled) return
  emit('send', text)
  draft.value = ''
}
</script>

<template>
  <form class="composer" @submit.prevent="submit">
    <textarea
      v-model="draft"
      :disabled="props.disabled"
      rows="1"
      placeholder="Message… (Enter to send, Shift+Enter for a newline)"
      aria-label="Message"
      @keydown.enter.exact.prevent="submit"
    />
    <button type="submit" :disabled="props.disabled || draft.trim().length === 0">Send</button>
  </form>
</template>

<style scoped>
.composer {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem 1rem;
  border-top: 1px solid var(--border);
}

textarea {
  flex: 1;
  resize: vertical;
  min-height: 2.5rem;
  max-height: 12rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--surface);
  color: var(--text);
  font: inherit;
}

button {
  align-self: flex-end;
  padding: 0.6rem 1rem;
  border: 0;
  border-radius: 0.5rem;
  background: var(--accent);
  color: var(--accent-contrast);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
