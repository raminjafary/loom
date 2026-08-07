<script setup lang="ts">
import type { NotificationConfig } from '@loom/api-contract'
import { applicationServerKey, toPushRegistration, type PushRegistration } from '@loom/client-core'
import { computed, ref, watch } from 'vue'

/**
 * Turns web push on for this browser (PLAN.md §3's notification half, §7's "is
 * notified when it needs them"). In the top bar beside the kill switch: both
 * answer "what is this workspace doing while I am not looking".
 *
 * Everything platform-specific happens here — permission prompts, the service
 * worker, `PushManager` — because granting permission is a browser interaction
 * that cannot be abstracted away. What leaves this component is only the
 * resulting endpoint and keys, through the same contract a terminal client would
 * use (@loom/client-core, §4c).
 */

const props = defineProps<{ config: NotificationConfig | null }>()
const emit = defineEmits<{
  subscribe: [registration: PushRegistration]
  unsubscribe: [endpoint: string]
}>()

type State = 'loading' | 'unsupported' | 'unconfigured' | 'denied' | 'off' | 'on' | 'working'

const state = ref<State>('loading')
const detail = ref<string | null>(null)

const supported = (): boolean =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

const existingSubscription = async (): Promise<PushSubscription | null> => {
  const registration = await navigator.serviceWorker.getRegistration('/sw.js')
  return (await registration?.pushManager.getSubscription()) ?? null
}

const settle = async (): Promise<void> => {
  if (!supported()) {
    state.value = 'unsupported'
    return
  }
  if (props.config === null) {
    state.value = 'loading'
    return
  }
  if (props.config.transport === null || props.config.publicKey === null) {
    state.value = 'unconfigured'
    return
  }
  if (Notification.permission === 'denied') {
    state.value = 'denied'
    return
  }
  state.value = (await existingSubscription()) ? 'on' : 'off'
}

// Watched, not just read on mount: `config` is null until the session's `init()`
// resolves, so a mount-only read leaves this stuck on "Notifications…" forever.
// Found by clicking it in a real browser, not by a test.
watch(() => props.config, () => void settle(), { immediate: true })

// `config` arrives after `init()` resolves, so the initial state is genuinely
// unknown rather than "off" — showing an enable button before then would offer
// an action that fails on a deployment with no transport.
const label = computed(() => {
  switch (state.value) {
    case 'loading':
      return 'Notifications…'
    case 'unsupported':
      return 'Notifications unsupported'
    case 'unconfigured':
      return 'Notifications off (server)'
    case 'denied':
      return 'Notifications blocked'
    case 'working':
      return 'Working…'
    case 'on':
      return 'Notifications on'
    case 'off':
      return 'Enable notifications'
  }
})

const title = computed(() => {
  switch (state.value) {
    case 'unsupported':
      return 'This browser has no Push API'
    case 'unconfigured':
      return 'No VAPID keys are configured on the server — see .env.example'
    case 'denied':
      return 'Reset notification permission for this site in your browser settings'
    case 'on':
      return 'Click to stop notifying this browser'
    default:
      return 'Get told when a run needs you, without watching it'
  }
})

const actionable = computed(() => state.value === 'off' || state.value === 'on')

const enable = async () => {
  const publicKey = props.config?.publicKey
  if (!publicKey) return

  state.value = 'working'
  detail.value = null
  try {
    // Ask before registering anything: a denied prompt must leave no service
    // worker and no subscription behind.
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      state.value = permission === 'denied' ? 'denied' : 'off'
      return
    }

    const registration = await navigator.serviceWorker.register('/sw.js')
    // `register` resolves before the worker is active; subscribing against an
    // installing worker fails intermittently.
    await navigator.serviceWorker.ready

    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        // Required by Chrome: a push that shows no notification is not allowed.
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      }))

    emit('subscribe', toPushRegistration(subscription.toJSON()))
    state.value = 'on'
  } catch (error) {
    detail.value = error instanceof Error ? error.message : String(error)
    state.value = 'off'
  }
}

const disable = async () => {
  state.value = 'working'
  detail.value = null
  try {
    const subscription = await existingSubscription()
    if (subscription) {
      const endpoint = subscription.endpoint
      // Drop the browser's own subscription first: if the server call fails, the
      // worst case is a stored target the push service reports as gone, which
      // the adapter prunes on its next delivery. The reverse order would leave a
      // browser still receiving pushes it asked to stop.
      await subscription.unsubscribe()
      emit('unsubscribe', endpoint)
    }
    state.value = 'off'
  } catch (error) {
    detail.value = error instanceof Error ? error.message : String(error)
    void settle()
  }
}
</script>

<template>
  <button
    type="button"
    class="notify"
    :class="{ on: state === 'on', inert: !actionable }"
    :disabled="!actionable"
    :title="detail ?? title"
    @click="state === 'on' ? disable() : enable()"
  >
    {{ label }}
  </button>
</template>

<style scoped>
.notify {
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--surface-hover);
  color: var(--text);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}

.notify.on {
  color: var(--ok);
  border-color: color-mix(in oklab, var(--ok) 40%, transparent);
}

.notify.inert {
  color: var(--text-faint);
  cursor: default;
}
</style>
