import { connectRunner } from './client.js'

/**
 * `npx loom-runner` — installable Runner CLI. Reads its
 * pairing token and allowed roots from the environment for now; a real
 * `loom-runner connect --token <pairing-token>` CLI wrapper is a small
 * follow-up over this same connectRunner() call, not a different design.
 */

const serverWsUrl = process.env.LOOM_SERVER_WS_URL ?? 'ws://localhost:3001/ws/runner'
const pairingToken = process.env.LOOM_PAIRING_TOKEN
const allowedRoots = (process.env.LOOM_ALLOWED_ROOTS ?? '').split(',').filter((s) => s.length > 0)

if (!pairingToken) {
  process.stderr.write('LOOM_PAIRING_TOKEN is required\n')
  process.exit(1)
}

if (allowedRoots.length === 0) {
  process.stderr.write('LOOM_ALLOWED_ROOTS is required (comma-separated absolute paths)\n')
  process.exit(1)
}

const runner = connectRunner({ serverWsUrl, pairingToken, allowedRoots })

process.on('SIGINT', () => {
  runner.close()
  process.exit(0)
})
process.on('SIGTERM', () => {
  runner.close()
  process.exit(0)
})
