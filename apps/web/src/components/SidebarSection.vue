<script setup lang="ts">
import { computed, ref, watch } from 'vue'

/**
 * A collapsible sidebar group.
 *
 * The sidebar was twelve panels of identical visual weight in one scrolling column,
 * three of which said a variant of "nothing to show". This is the unit that fixes
 * that: a header that carries the panel's own summary — a count, a total — so a
 * closed section still answers the question it exists to answer, and an empty one
 * costs a line instead of a card.
 */

const props = defineProps<{
  title: string
  /** Shown on the header, open or closed. The point of collapsing at all. */
  summary?: string | null
  /** Empty sections stay shut and say so in one line. */
  empty?: boolean
  emptyText?: string
  defaultOpen?: boolean
  /** Draws attention: something here needs a human. */
  attention?: boolean
  /** Remembers open/closed across reloads under this key. */
  storageKey?: string
  /**
   * Bump to open this section because the user just asked for what is in it.
   *
   * A counter rather than a boolean: a flag that stays true fires its watcher once, so
   * a second request after the user had closed the section again would do nothing.
   * Distinct from `attention` on purpose — that means "something here needs a human"
   * and carries visual emphasis to match, which is a claim this must not make.
   */
  reveal?: number
}>()

const key = computed(() => (props.storageKey ? `loom:section:${props.storageKey}` : null))

const initial = (): boolean => {
  const stored = key.value ? localStorage.getItem(key.value) : null
  if (stored === 'open') return true
  if (stored === 'closed') return false
  return props.defaultOpen ?? false
}

const open = ref(initial())

watch(open, (next) => {
  if (key.value) localStorage.setItem(key.value, next ? 'open' : 'closed')
})

// Something that needs a human opens itself, whatever was remembered — a decision
// waiting behind a collapsed header is a decision that does not get made.
watch(
  () => props.attention,
  (needsHuman) => {
    if (needsHuman) open.value = true
  },
  { immediate: true },
)

watch(
  () => props.reveal,
  (next, previous) => {
    if (next !== undefined && next !== previous) open.value = true
  },
)

const expandable = computed(() => !props.empty)
</script>

<template>
  <section class="section" :class="{ attention: props.attention, empty: props.empty }">
    <button
      type="button"
      class="head"
      :disabled="!expandable"
      :aria-expanded="expandable ? open : undefined"
      @click="open = !open"
    >
      <span v-if="expandable" class="chevron" :class="{ open }">›</span>
      <span v-else class="chevron placeholder" aria-hidden="true">·</span>
      <span class="title">{{ props.title }}</span>
      <span v-if="props.empty" class="summary faint">{{ props.emptyText ?? 'none' }}</span>
      <span v-else-if="props.summary" class="summary">{{ props.summary }}</span>
    </button>

    <div v-if="open && expandable" class="body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.section {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg);
  overflow: hidden;
}

/* Dimmed, not hidden. Making an empty section borderless made it hard to find at
   all — the answer to "where is the swarm panel" should be "there, and it says it
   is empty", not a blank gap. */
.section.empty {
  border-style: dashed;
  background: none;
}

.section.attention {
  border-color: color-mix(in oklab, var(--warn) 55%, var(--border));
}

.head {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  width: 100%;
  padding: 0.4rem 0.6rem;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.head:disabled {
  cursor: default;
}

.section.empty .head {
  padding-left: 0.6rem;
}

.chevron {
  color: var(--text-faint);
  font-size: 0.85rem;
  transition: transform 120ms ease;
}

.chevron.open {
  transform: rotate(90deg);
}

.chevron.placeholder {
  opacity: 0.4;
}

.title {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.section.empty .title {
  color: var(--text-faint);
}

.summary {
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.summary.faint {
  color: var(--text-faint);
}

.body {
  padding: 0 0.4rem 0.4rem;
}
</style>
