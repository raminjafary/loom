import { z } from 'zod'
import { buildGateway } from './gateway.js'

/**
 * Validated at boot rather than read with a fallback, because a fan-out service that
 * started with an empty secret would refuse every subscriber and look like a broken
 * gateway. Same bar as `LOOM_EGRESS_CONTROL_SECRET`: 32 characters, and
 * never the value shipped in `.env.example`.
 */
const EnvSchema = z.object({
  WS_GATEWAY_PORT: z.coerce.number().int().default(3002),
  VALKEY_URL: z.string().default('redis://localhost:6379'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  WS_SUBSCRIPTION_SECRET: z
    .string()
    .min(32, 'WS_SUBSCRIPTION_SECRET must be at least 32 characters')
    .refine((secret) => !/change-me|changeme|your-secret|placeholder|example/i.test(secret), {
      message:
        'WS_SUBSCRIPTION_SECRET still looks like the example value. It is the whole ' +
        'authentication of /ws/client — generate one with `openssl rand -base64 32`.',
    }),
})

const env = EnvSchema.parse(process.env)

const gateway = await buildGateway({
  valkeyUrl: env.VALKEY_URL,
  webOrigin: env.WEB_ORIGIN,
  subscriptionSecret: env.WS_SUBSCRIPTION_SECRET,
})

process.on('SIGINT', () => void gateway.close().then(() => process.exit(0)))
process.on('SIGTERM', () => void gateway.close().then(() => process.exit(0)))

await gateway.listen({ port: env.WS_GATEWAY_PORT, host: '0.0.0.0' })
