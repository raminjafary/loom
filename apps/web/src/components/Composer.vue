<script setup lang="ts">
import type { AgentPersona } from '@loom/api-contract'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ disabled: boolean; personas: AgentPersona[] }>()
const emit = defineEmits<{ send: [text: string] }>()

const draft = ref('')
const cursorPos = ref(0)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

/**
 * Grows the field to its content, up to the CSS `max-height`.
 *
 * Required rather than cosmetic now that the drag handle is gone: with `rows="1"` and
 * no resize affordance, a multi-line draft would otherwise scroll inside a
 * single-line box. Height is reset to `auto` first because `scrollHeight` on an
 * already-tall element reports the old height, so the field would grow and never
 * shrink.
 */
const autoGrow = () => {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

const mentionQuery = computed(() => {
  const upToCursor = draft.value.slice(0, cursorPos.value)
  const match = /(?:^|\s)@([A-Za-z0-9_-]*)$/.exec(upToCursor)
  return match ? (match[1] ?? '') : null
})

const mentionMatches = computed(() => {
  const query = mentionQuery.value
  if (query === null) return []
  const lower = query.toLowerCase()
  return props.personas.filter((p) => p.name.toLowerCase().startsWith(lower)).slice(0, 6)
})

const trackCursor = (event: Event) => {
  cursorPos.value = (event.target as HTMLTextAreaElement).selectionStart
}

const selectMention = async (name: string) => {
  const query = mentionQuery.value ?? ''
  const before = draft.value.slice(0, cursorPos.value - query.length)
  const after = draft.value.slice(cursorPos.value)
  draft.value = `${before}${name} ${after}`
  await nextTick()
  const newCursor = before.length + name.length + 1
  textareaRef.value?.focus()
  textareaRef.value?.setSelectionRange(newCursor, newCursor)
  cursorPos.value = newCursor
  void nextTick(autoGrow)
}

const onInput = (event: Event) => {
  trackCursor(event)
  autoGrow()
}

const submit = () => {
  const text = draft.value.trim()
  if (text.length === 0 || props.disabled) return
  emit('send', text)
  draft.value = ''
  // Back to one line — clearing the value does not shrink an element whose height was
  // set inline by `autoGrow`.
  void nextTick(autoGrow)
}

/**
 * The placeholder, as a ladder of hints, longest first — and which one fits is measured
 * rather than guessed.
 *
 * A textarea's placeholder wraps and this field is one line tall, so at any width where a hint
 * needs a second line that line is sliced off and the reader gets half a sentence. Both obvious
 * fixes cost something at every width: a taller field, or an ellipsis on a hint whose ending is
 * the part worth reading.
 *
 * Measuring costs nothing anywhere. Each candidate is laid out in a hidden mirror in the
 * field's own font and the longest that fits is used, so nobody with room for the full hint
 * loses it. Three rungs rather than two because the field gets narrower than a phone: at 900px
 * the run launcher leaves the composer about 200px, which the middle rung does not fit either —
 * that was measured on the sweep after the two-rung version, which chose correctly and still
 * rendered a sliced line.
 *
 * The last rung has to be short enough to fit anything, because there is no rung below it.
 */
const PLACEHOLDERS = [
  'Message… (Enter to send, Shift+Enter for a newline, @persona to start a run)',
  'Message… (@persona to start a run)',
  'Message…',
] as const

const mirrorRef = ref<HTMLSpanElement | null>(null)
const rung = ref(0)
const placeholder = computed(() => PLACEHOLDERS[rung.value] ?? PLACEHOLDERS[PLACEHOLDERS.length - 1])

const measurePlaceholder = () => {
  const el = textareaRef.value
  const mirror = mirrorRef.value
  if (!el || !mirror) return
  const style = getComputedStyle(el)
  const inner =
    el.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
  // A field with no layout yet reports zero, and zero is not "nothing fits" — it is "not
  // measured", so the longest hint stays until there is a width to compare against.
  if (inner <= 0) return
  const fits = PLACEHOLDERS.findIndex((text) => {
    mirror.textContent = text
    return mirror.getBoundingClientRect().width <= inner
  })
  mirror.textContent = ''
  rung.value = fits === -1 ? PLACEHOLDERS.length - 1 : fits
}

let observer: ResizeObserver | null = null
onMounted(() => {
  measurePlaceholder()
  observer = new ResizeObserver(measurePlaceholder)
  if (textareaRef.value) observer.observe(textareaRef.value)
})
onBeforeUnmount(() => observer?.disconnect())

const onEnter = () => {
  const first = mentionMatches.value[0]
  if (first) {
    void selectMention(first.name)
    return
  }
  submit()
}
</script>

<template>
  <form class="composer" @submit.prevent="submit">
    <div class="input-wrap">
      <ul v-if="mentionMatches.length > 0" class="mentions">
        <li v-for="persona in mentionMatches" :key="persona.id">
          <button type="button" @mousedown.prevent="selectMention(persona.name)">
            @{{ persona.name }}
            <span class="mention-desc">{{ persona.description }}</span>
          </button>
        </li>
      </ul>
      <textarea
        ref="textareaRef"
        v-model="draft"
        :disabled="props.disabled"
        rows="1"
        :placeholder="placeholder"
        aria-label="Message"
        @input="onInput"
        @click="trackCursor"
        @keyup="trackCursor"
        @keydown.enter.exact.prevent="onEnter"
      />
      <span ref="mirrorRef" class="hint-mirror" aria-hidden="true" />
    </div>
    <button type="submit" :disabled="props.disabled || draft.trim().length === 0">Send</button>
  </form>
</template>

<style scoped>
.composer {
  display: flex;
  /*
    Bottom-aligned, so the button tracks the *last* line as the textarea grows rather
    than floating against the middle of a three-line draft.
  */
  align-items: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem 1rem;
  border-top: 1px solid var(--border);
}

.input-wrap {
  position: relative;
  flex: 1;
}

/* Base sizing and states come from styles.css; this is what the composer alone
   needs — it grows, it has a ceiling, and it sits on the surface rather than the
   page so the send row reads as one control. */
textarea {
  /*
    `display: block` is the fix for the misalignment, not the heights below. A textarea
    is inline-block by default, so it sits on a text baseline and carries a few pixels
    of descender space underneath — which is why it never lined up with the Send button
    no matter what padding either one had.
  */
  display: block;
  width: 100%;
  min-height: 2.6rem;
  max-height: 12rem;
  padding: 0.6rem 0.7rem;
  border-radius: 0.5rem;
  background: var(--surface);
  font-size: 0.92rem;
  line-height: 1.4;
  /*
    No drag handle. It overlapped the rounded corner and gave the box a second, ragged
    edge; the field already grows with its content and is capped by `max-height`.
  */
  resize: none;
  overflow-y: auto;
}

/*
  The ruler for the placeholder above: one candidate at a time on one unbreakable line, in the
  field's own font, laid out where it cannot be seen or read aloud. `visibility: hidden` rather
  than `display: none`, which has no width to measure.
*/
.hint-mirror {
  position: absolute;
  top: 0;
  left: 0;
  visibility: hidden;
  pointer-events: none;
  white-space: pre;
  font-size: 0.92rem;
  line-height: 1.4;
}

.mentions {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin: 0 0 0.3rem;
  padding: 0.25rem;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--surface);
  box-shadow: 0 4px 12px rgb(0 0 0 / 0.15);
  max-height: 12rem;
  overflow-y: auto;
}

.mentions button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: 0.35rem 0.5rem;
  border: 0;
  border-radius: 0.35rem;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.mentions button:hover {
  background: color-mix(in oklab, var(--accent) 12%, transparent);
}

.mention-desc {
  font-size: 0.75rem;
  color: var(--text-faint);
}

button[type='submit'] {
  /* Exactly the textarea's resting height, so the two agree on one edge. */
  min-height: 2.6rem;
  padding: 0.6rem 1rem;
  border: 0;
  border-radius: 0.5rem;
  background: var(--accent);
  color: var(--accent-contrast);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

button[type='submit']:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
