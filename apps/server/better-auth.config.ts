import { createDatabase } from '@loom/db'
import { createBetterAuth } from './src/better-auth.js'

/**
 * Config entry point for `@better-auth/cli generate` only — not imported by
 * the running server (apps/server/src/app.ts builds its own instance from
 * env at request time). The CLI needs a real Auth instance to introspect for
 * schema generation, which is why this connects to Postgres directly.
 */
const { db } = createDatabase(
  process.env.DATABASE_URL ?? 'postgres://loom:loom@localhost:5432/loom',
)

export const auth = createBetterAuth({
  db,
  secret: process.env.BETTER_AUTH_SECRET ?? 'schema-generation-only',
  baseUrl: process.env.BETTER_AUTH_URL ?? 'http://localhost:3001',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
})
