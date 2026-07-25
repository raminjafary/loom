<script setup lang="ts">
import { onMounted } from 'vue'
import AuthGate from './components/AuthGate.vue'
import WorkspaceView from './components/WorkspaceView.vue'
import { useAuthStore } from './stores/auth'

const auth = useAuthStore()

onMounted(() => {
  void auth.refresh()
})
</script>

<template>
  <p v-if="auth.checking" class="loading">Loading…</p>
  <AuthGate v-else-if="!auth.authenticated" />
  <WorkspaceView v-else />
</template>

<style scoped>
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  color: var(--text-faint);
}
</style>
