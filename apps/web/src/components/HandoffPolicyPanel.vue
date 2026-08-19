<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RunControl } from '@loom/api-contract'

/**
 * When the platform *suggests* a handoff.
 *
 * **The labelling is the feature, not the inputs.** the rule is that the threshold
 * nudges, the agent asks and the cap refuses — the platform never swaps an agent on a
 * number, because a ratio cannot see whether an agent is mid-thought or still doing good
 * work. A settings panel headed "swap agents automatically at N%" would be a surface
 * promising something the runtime deliberately does not do, which is the exact shape of
 * the two operator reports that started the session before last. So this says what
 * actually happens: a notice is delivered, once, to a run that is filling up.
 *
 * Null renders as "platform default" rather than as the number it currently resolves to,
 * for the same reason coverage renders null rather than zero: "I have not chosen" and "I
 * chose 0.8" are different answers, and only one of them should inherit a better default
 * later.
 */

const props = defineProps<{
  control: RunControl | null
  /** What the platform uses when nothing is set — shown, never silently written down. */
  defaultThreshold: number
  defaultCapPerTree: number
  busy?: boolean
}>()

const emit = defineEmits<{
  save: [input: { threshold: number | null; capPerTree: number | null }]
}>()

const thresholdPercent = ref<string>('')
const capPerTree = ref<string>('')

watch(
  () => props.control,
  (control) => {
    thresholdPercent.value =
      control?.handoff.threshold == null ? '' : String(Math.round(control.handoff.threshold * 100))
    capPerTree.value = control?.handoff.capPerTree == null ? '' : String(control.handoff.capPerTree)
  },
  { immediate: true },
)

const effectiveThreshold = computed(() =>
  props.control?.handoff.threshold ?? props.defaultThreshold,
)
const effectiveCap = computed(() => props.control?.handoff.capPerTree ?? props.defaultCapPerTree)

const save = () => {
  const percent = thresholdPercent.value.trim()
  const cap = capPerTree.value.trim()
  emit('save', {
    threshold: percent === '' ? null : Number(percent) / 100,
    capPerTree: cap === '' ? null : Number(cap),
  })
}
</script>

<template>
  <section class="handoff">
    <header>
      <h3>Warm handoff</h3>
      <p class="sub">
        A long run degrades as its window fills — it compacts, loses detail, and gets worse
        at exactly the point it has learned the most. The platform watches for that and
        <strong>tells the run</strong>. It never swaps an agent itself: a ratio cannot see
        whether an agent is mid-thought or still doing good work, so the measurement is the
        platform's and the decision is the agent's.
      </p>
    </header>

    <div class="row">
      <label>
        <span>Tell a run when its window is</span>
        <span class="field">
          <input
            v-model="thresholdPercent"
            type="number"
            min="50"
            max="95"
            inputmode="numeric"
            :placeholder="String(Math.round(defaultThreshold * 100))"
            aria-label="Context occupancy at which the platform tells a run"
          />
          <em>% full</em>
        </span>
      </label>
      <label>
        <span>Handoffs allowed per tree</span>
        <span class="field">
          <input
            v-model="capPerTree"
            type="number"
            min="1"
            max="5"
            inputmode="numeric"
            :placeholder="String(defaultCapPerTree)"
            aria-label="How many times one tree may hand off"
          />
        </span>
      </label>
      <button type="button" class="primary" :disabled="props.busy" @click="save">Save</button>
    </div>

    <p class="sub">
      Now: a run is told once when it reaches
      <strong>{{ Math.round(effectiveThreshold * 100) }}%</strong>, and a tree may hand off
      <strong>{{ effectiveCap }}</strong> time(s).
      <span v-if="control && control.handoff.threshold === null && control.handoff.capPerTree === null">
        Both are the platform's defaults — leave a box empty to keep it that way.
      </span>
    </p>

    <ul class="what">
      <li>
        <strong>The threshold nudges.</strong> At that point the run is told its own number
        and reminded it can hand over. Once — a notice repeated every few seconds is a
        notice ignored, in a window with no room to spare.
      </li>
      <li>
        <strong>The agent asks.</strong> It writes a brief — what is done, where the branch
        stands, what is open, the single next thing — and the platform checks the files it
        claims to have changed against the ones it actually saw written.
      </li>
      <li>
        <strong>The cap refuses.</strong> Past it nobody takes over. The honest failure mode
        here is thrash: two agents passing work back and forth, each briefing the other,
        spending the budget on continuity rather than on the work.
      </li>
    </ul>
  </section>
</template>

<style scoped>
.handoff {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

h3 {
  margin: 0;
  font-size: 0.85rem;
}

.sub {
  margin: 0.15rem 0 0;
  font-size: 0.72rem;
  color: var(--text-faint);
  line-height: 1.55;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.8rem;
  padding: 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.72rem;
  color: var(--text-muted);
}

.field {
  display: flex;
  align-items: baseline;
  gap: 0.3rem;
}

.field input {
  width: 4.5rem;
  padding: 0.25rem 0.35rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 0.8rem;
}

.field em {
  font-style: normal;
  font-size: 0.72rem;
  color: var(--text-faint);
}

.primary {
  padding: 0.3rem 0.7rem;
  border: 0;
  border-radius: 0.35rem;
  background: var(--accent);
  color: var(--accent-contrast);
  font: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}

.what {
  margin: 0;
  padding-left: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.72rem;
  color: var(--text-faint);
  line-height: 1.55;
}
</style>
