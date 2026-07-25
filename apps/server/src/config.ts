import { z } from 'zod'

const EnvSchema = z.object({
  DATABASE_URL: z.string().default('postgres://loom:loom@localhost:5432/loom'),
  VALKEY_URL: z.string().default('redis://localhost:6379'),
  SERVER_PORT: z.coerce.number().int().default(3001),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export type Config = z.infer<typeof EnvSchema>

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  EnvSchema.parse(env)
