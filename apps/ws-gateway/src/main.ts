import { buildGateway } from './gateway.js'

const port = Number(process.env.WS_GATEWAY_PORT ?? 3002)
const gateway = await buildGateway({
  valkeyUrl: process.env.VALKEY_URL ?? 'redis://localhost:6379',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
})

process.on('SIGINT', () => void gateway.close().then(() => process.exit(0)))
process.on('SIGTERM', () => void gateway.close().then(() => process.exit(0)))

await gateway.listen({ port, host: '0.0.0.0' })
