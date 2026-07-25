<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const mode = ref<'sign-in' | 'sign-up'>('sign-in')
const name = ref('')
const email = ref('')
const password = ref('')
const submitting = ref(false)

const submit = async () => {
  submitting.value = true
  try {
    if (mode.value === 'sign-up') {
      await auth.signUp(name.value, email.value, password.value)
    } else {
      await auth.signIn(email.value, password.value)
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="gate">
    <form class="card" @submit.prevent="submit">
      <h1>Loom</h1>

      <label v-if="mode === 'sign-up'">
        Name
        <input v-model="name" required autocomplete="name" />
      </label>

      <label>
        Email
        <input v-model="email" type="email" required autocomplete="email" />
      </label>

      <label>
        Password
        <input v-model="password" type="password" required autocomplete="current-password" minlength="8" />
      </label>

      <p v-if="auth.error" class="error" role="alert">{{ auth.error }}</p>

      <button type="submit" :disabled="submitting">
        {{ mode === 'sign-up' ? 'Create account' : 'Sign in' }}
      </button>

      <button
        type="button"
        class="switch"
        @click="mode = mode === 'sign-up' ? 'sign-in' : 'sign-up'"
      >
        {{ mode === 'sign-up' ? 'Have an account? Sign in' : 'New here? Create an account' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.gate {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 20rem;
  padding: 1.5rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--surface);
}

h1 {
  margin: 0 0 0.25rem;
  font-size: 1.25rem;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.85rem;
  color: var(--text-muted);
}

input {
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--bg);
  color: var(--text);
  font: inherit;
}

button[type='submit'] {
  padding: 0.6rem;
  border: 0;
  border-radius: 0.5rem;
  background: var(--accent);
  color: var(--accent-contrast);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

button[type='submit']:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.switch {
  border: 0;
  background: transparent;
  color: var(--text-faint);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  padding: 0;
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: 0.82rem;
}
</style>
