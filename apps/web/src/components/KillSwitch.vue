<script setup lang="ts">
import type { RunControl } from '@loom/api-contract'
import { ref } from 'vue'

/**
 * The global kill switch (PLAN.md §6 runtime safety: "One button. Nothing had
 * one."). Lives in the top bar rather than the sidebar so it is reachable from
 * every view — a stop control you have to navigate to is not one button.
 */

const props = defineProps<{ control: RunControl | null }>()
const emit = defineEmits<{ pause: []; resume: [] }>()

// Two-step inline confirm instead of `window.confirm`: pausing cancels
// in-flight work irreversibly, but a modal dialog blocks the whole page (and
// every automated check of it) for a decision that fits in the bar itself.
const confirming = ref(false)

const pause = () => {
  confirming.value = false
  emit('pause')
}
</script>

<template>
  <div class="kill-switch">
    <template v-if="props.control?.paused">
      <span class="paused" title="New runs are blocked until resumed">Runs paused</span>
      <button type="button" class="resume" @click="emit('resume')">Resume</button>
    </template>

    <template v-else-if="confirming">
      <button type="button" class="danger" @click="pause">Confirm: stop all runs</button>
      <button type="button" class="cancel" @click="confirming = false">Cancel</button>
    </template>

    <button
      v-else
      type="button"
      class="stop"
      title="Cancel every in-flight run and block new ones"
      @click="confirming = true"
    >
      Stop all
    </button>
  </div>
</template>

<style scoped>
.kill-switch {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

button {
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--surface-hover);
  color: var(--text);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}

.stop {
  color: var(--danger);
  border-color: color-mix(in oklab, var(--danger) 40%, transparent);
}

.danger {
  border: 0;
  background: var(--danger);
  color: var(--accent-contrast);
  font-weight: 600;
}

.cancel {
  border: 0;
  background: none;
  color: var(--text-muted);
}

.paused {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0.2rem 0.45rem;
  border-radius: 999px;
  border: 1px solid color-mix(in oklab, var(--danger) 40%, transparent);
  color: var(--danger);
}
</style>
