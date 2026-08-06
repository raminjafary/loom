import { z } from 'zod'

const EnvSchema = z.object({
  DATABASE_URL: z.string().default('postgres://loom:loom@localhost:5432/loom'),
  VALKEY_URL: z.string().default('redis://localhost:6379'),
  SERVER_PORT: z.coerce.number().int().default(3001),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().default('http://localhost:3001'),
  // Dead-run reaper (PLAN.md §6 runtime safety) — see agent-use-cases.ts's
  // reapStuckRuns for how the two timeouts are used.
  REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  REAPER_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  REAPER_NO_PROGRESS_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  // Approval SLA (PLAN.md §6) — how long a risky-tool gate may sit undecided
  // before it auto-denies and the run resumes. Swept on the reaper's interval.
  // Independent of REAPER_NO_PROGRESS_TIMEOUT_MS by design: a run waiting on a
  // human is excluded from the no-progress signal (see reapStuckRuns), so this
  // is the only clock that governs an `awaiting_approval` run.
  APPROVAL_SLA_MS: z.coerce.number().int().positive().default(900_000),
})

export type Config = z.infer<typeof EnvSchema>

const DEFAULT_TEST_DATABASE_URL = 'postgres://loom:loom@localhost:5432/loom_test'

/**
 * Integration tests run against real Postgres, not a mock — but never
 * against the same database a developer might be using the app against by
 * hand. Under `NODE_ENV=test`, `DATABASE_URL` is always overridden to a
 * separate test database (`TEST_DATABASE_URL`, defaulted like `DATABASE_URL`
 * itself is) so `pnpm -r test` can never truncate a live dev workspace.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const config = EnvSchema.parse(env)
  if (config.NODE_ENV === 'test') {
    return { ...config, DATABASE_URL: env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL }
  }
  return config
}
