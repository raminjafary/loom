import { createAuthClient } from 'better-auth/client'

/**
 * Thin wrapper so every client (web, tui, future) authenticates the same way.
 * `better-auth/client` is framework-agnostic on its own — no React/Vue
 * dependency — which is what lets it live here rather than in apps/web.
 */
export const createAuthSession = (options: { baseUrl: string }) => {
  const client = createAuthClient({
    baseURL: options.baseUrl,
    fetchOptions: { credentials: 'include' },
  })

  return {
    signUp: (input: { email: string; password: string; name: string }) =>
      client.signUp.email(input),
    signIn: (input: { email: string; password: string }) => client.signIn.email(input),
    signOut: () => client.signOut(),
    getSession: () => client.getSession(),
  }
}

export type AuthSession = ReturnType<typeof createAuthSession>
