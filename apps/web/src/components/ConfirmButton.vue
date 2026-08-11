<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

/**
 * A destructive action that asks first.
 *
 * Remove, delete, discard and cancel all fired on a single click, and three of them
 * are irreversible: discarding a run deletes the branch and the clone the work lives
 * in, removing a capability detaches it from every persona at once, and deleting a
 * group is gone. A misclick on any of those cost real work with no undo.
 *
 * Two-step in place rather than a modal: the confirmation appears where the pointer
 * already is, it cannot be dismissed by clicking through it out of habit, and it
 * needs no focus trap to be correct. It times out, because a control left mid-armed
 * across a page someone walked away from is a trap for whoever comes back.
 */

const props = withDefaults(
  defineProps<{
    label: string
    /** What the armed state asks. Say what is lost, not "are you sure". */
    confirmLabel?: string
    disabled?: boolean
    /**
     * Visual weight — `link` for inline text actions, `button` for real buttons,
     * `icon` for a single glyph in a tight row, where a word plus a "keep" escape
     * hatch is more chrome than the row can carry.
     */
    variant?: 'link' | 'button' | 'icon'
    /** The glyph, for `icon`. Armed, it swaps to a check. */
    icon?: string
  }>(),
  { confirmLabel: 'Confirm', variant: 'button', icon: '×' },
)

const emit = defineEmits<{ confirm: [] }>()

const armed = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

const disarm = () => {
  armed.value = false
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

const click = () => {
  if (props.disabled) return
  if (armed.value) {
    disarm()
    emit('confirm')
    return
  }
  armed.value = true
  timer = setTimeout(disarm, 5_000)
}

onBeforeUnmount(disarm)
</script>

<template>
  <span class="wrap">
    <button
      type="button"
      :class="[props.variant, { armed }]"
      :disabled="props.disabled"
      :title="armed ? props.confirmLabel : props.label"
      :aria-label="armed ? props.confirmLabel : props.label"
      @click="click"
      @blur="disarm"
    >
      <template v-if="props.variant === 'icon'">{{ armed ? '✓' : props.icon }}</template>
      <template v-else>{{ armed ? props.confirmLabel : props.label }}</template>
    </button>
    <!-- The icon form has no room for one, and blurring disarms it anyway. -->
    <button v-if="armed && props.variant !== 'icon'" type="button" class="link keep" @click="disarm">
      keep
    </button>
  </span>
</template>

<style scoped>
.wrap {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

button {
  font: inherit;
  cursor: pointer;
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--danger);
  font-size: 0.78rem;
}

.link.keep {
  color: var(--text-muted);
}

.button {
  padding: 0.35rem 0.6rem;
  border: 1px solid color-mix(in oklab, var(--danger) 45%, var(--border));
  border-radius: 0.375rem;
  background: var(--bg);
  color: var(--danger);
  font-size: 0.82rem;
}

/* Armed reads as loaded, not merely hovered — the difference between the two
   states has to survive a glance. */
.armed {
  background: var(--danger);
  color: var(--bg);
  border-color: var(--danger);
  font-weight: 600;
}

.link.armed {
  padding: 0.05rem 0.35rem;
  border-radius: 0.25rem;
}

/* Neutral until armed. A row of red glyphs reads as a warning about the rows
   themselves, which is not what a delete affordance should say. */
.icon {
  display: grid;
  place-items: center;
  width: 1.35rem;
  height: 1.35rem;
  padding: 0;
  border: 0;
  border-radius: 0.3rem;
  background: none;
  color: var(--text-faint);
  font-size: 0.9rem;
  line-height: 1;
}

.icon:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.icon.armed {
  background: var(--danger);
  color: var(--bg);
  font-size: 0.75rem;
}
</style>
