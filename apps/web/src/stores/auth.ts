import { createAuthSession } from '@loom/client-core'
import { defineStore } from 'pinia'
import { ref } from 'vue'

const AUTH_BASE_URL = import.meta.env.VITE_AUTH_URL ?? 'http://localhost:3001/api/auth'

export const useAuthStore = defineStore('auth', () => {
  const session = createAuthSession({ baseUrl: AUTH_BASE_URL })

  const authenticated = ref(false)
  const checking = ref(true)
  const error = ref<string | null>(null)

  const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err)

  const refresh = async () => {
    checking.value = true
    try {
      const result = await session.getSession()
      authenticated.value = result.data !== null
    } finally {
      checking.value = false
    }
  }

  const signIn = async (email: string, password: string) => {
    error.value = null
    const result = await session.signIn({ email, password })
    if (result.error) {
      error.value = result.error.message ?? 'Sign in failed'
      return
    }
    authenticated.value = true
  }

  const signUp = async (name: string, email: string, password: string) => {
    error.value = null
    try {
      const result = await session.signUp({ name, email, password })
      if (result.error) {
        error.value = result.error.message ?? 'Sign up failed'
        return
      }
      authenticated.value = true
    } catch (err) {
      error.value = errorMessage(err)
    }
  }

  const signOut = async () => {
    await session.signOut()
    authenticated.value = false
  }

  return { authenticated, checking, error, refresh, signIn, signUp, signOut }
})
