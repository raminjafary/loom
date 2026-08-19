/**
 * Live driver for the realtime gateway's authentication: the real `apps/ws-gateway` **process**, started the way `pnpm dev`
 * starts it, against real Valkey.
 *
 * docker compose up -d
 * npx tsx tools/gateway-auth-check.mts
 *
 * Why this exists alongside `realtime.e2e.test.ts`. That test calls `buildGateway` with
 * options it constructs itself, so it proves the verifier and nothing about how the
 * running service gets its secret. Everything between `process.env` and `buildGateway` —
 * the env schema, the boot-time refusal of a placeholder, `--env-file` reaching the
 * container's environment at all — is exactly the seam where a security control ships
 * configured-but-inert. This repository has shipped that shape three times.
 *
 * Not a test: it asserts loudly but is run by hand, and it prints what happened.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createEventPublisher } from '../apps/server/src/events.js'
import { asWorkspaceId } from '../packages/domain/src/index.js'
import {
 SUBSCRIPTION_TOKEN_TTL_MS,
 formatSubscriptionToken,
 subscriptionTokenSignedInput,
} from '../packages/domain/src/index.js'
import { createHmac } from 'node:crypto'

const REPO_ROOT = new URL('..', import.meta.url).pathname
const WORKSPACE = 'live-gateway-workspace'

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
 console.log(`${ok ? ' ok ': ' FAIL '} ${label}${detail ? ` — ${detail}`: ''}`)
 if (!ok) failures += 1
}

const freePort = async : Promise<number> =>
 new Promise((resolve, reject) => {
 const server = createServer
 server.on('error', reject)
 server.listen(0, '127.0.0.1', => {
 const address = server.address
 if (address === null || typeof address === 'string') return reject(new Error('no port'))
 const { port } = address
 server.close( => resolve(port))
 })
 })

/**
 * Started through `tsx --env-file=.env`, which is what `pnpm --filter @loom/ws-gateway start`
 * does — the path a real deployment takes, rather than importing `buildGateway` and handing
 * it a secret this script already has.
 */
const startGateway = async (
 env: NodeJS.ProcessEnv,
): Promise<{ child: ChildProcess; output: => string; exited: Promise<number | null> }> => {
 let output = ''
 const child = spawn(
 'npx',
 ['tsx', '--env-file=.env', 'apps/ws-gateway/src/main.ts'],
 { cwd: REPO_ROOT, env: {...process.env,...env }, stdio: ['ignore', 'pipe', 'pipe'] },
)
 child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString))
 child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString))
 const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
 return { child, output: => output, exited }
}

const waitForHealthy = async (port: number, timeoutMs = 20_000): Promise<boolean> => {
 const deadline = Date.now + timeoutMs
 while (Date.now < deadline) {
 try {
 const response = await fetch(`http://127.0.0.1:${port}/healthz`)
 if (response.ok) return true
 } catch {
 // Not listening yet.
 }
 await new Promise((resolve) => setTimeout(resolve, 200))
 }
 return false
}

/**
 * Node's global WebSocket, not the `ws` package: `tools/` is not a workspace package, so a
 * driver may import the repository's own source and Node's own globals and nothing else.
 * The one thing this costs is the Origin case — the global client sends no custom headers —
 * which `realtime.e2e.test.ts` covers with `ws` instead.
 */
const frameOrTimeout = (
 socket: WebSocket,
 match: (value: Record<string, unknown>) => boolean,
 timeoutMs = 4000,
) =>
 new Promise<Record<string, unknown> | null>((resolve) => {
 const timer = setTimeout( => {
 socket.removeEventListener('message', onMessage)
 resolve(null)
 }, timeoutMs)
 function onMessage(event: MessageEvent) {
 let parsed: unknown
 try {
 parsed = JSON.parse(String(event.data))
 } catch {
 return
 }
 if (!match(parsed as Record<string, unknown>)) return
 clearTimeout(timer)
 socket.removeEventListener('message', onMessage)
 resolve(parsed as Record<string, unknown>)
 }
 socket.addEventListener('message', onMessage)
 })

const closedWithin = (socket: WebSocket, timeoutMs = 4000) =>
 new Promise<boolean>((resolve) => {
 if (socket.readyState === WebSocket.CLOSED) return resolve(true)
 const timer = setTimeout( => resolve(false), timeoutMs)
 socket.addEventListener('close', => {
 clearTimeout(timer)
 resolve(true)
 })
 })

const openSocket = async (url: string): Promise<WebSocket> => {
 const socket = new WebSocket(url)
 await new Promise<void>((resolve) => {
 socket.addEventListener('open', => resolve)
 socket.addEventListener('error', => resolve)
 })
 return socket
}

const main = async => {
 const secret = process.env.WS_SUBSCRIPTION_SECRET
 if (!secret || secret.length < 32) {
 console.error(
 'WS_SUBSCRIPTION_SECRET must be set (32+ chars) in the environment for this driver:\n' +
 ' set -a;../.env; set +a\n' +
 'It is read here only to mint tokens the way apps/server would.',
)
 process.exit(1)
 }

 const mint = (workspaceId: string, ageMs = 0) => {
 const expiresAtMs = Date.now - ageMs + SUBSCRIPTION_TOKEN_TTL_MS
 const signedInput = subscriptionTokenSignedInput({ workspaceId, expiresAtMs })
 const signature = createHmac('sha256', secret).update(signedInput).digest('base64url')
 return formatSubscriptionToken({ workspaceId, expiresAtMs }, signature)
 }

 console.log('\n— boot refuses a secret that is not one —')
 for (const [label, value] of [
 ['unset', undefined],
 ['too short', 'short'],
 ['still the example value', 'change-me-to-a-real-secret-of-32-plus-chars'],
 ] as const) {
 const port = await freePort
 const { child, output, exited } = await startGateway({
 WS_GATEWAY_PORT: String(port),
 // `--env-file` loads.env, and a variable already present in the environment wins,
 // so an empty string is how "unset" is expressed to the child.
 WS_SUBSCRIPTION_SECRET: value ?? '',
 })
 const code = await Promise.race([
 exited,
 new Promise<number | null>((resolve) => setTimeout( => resolve(null), 15_000)),
 ])
 check(`refuses to start with a secret that is ${label}`, code !== null && code !== 0,
 code === null ? 'still running after 15s': `exit ${code}`)
 check(
 ` and says why (${label})`,
 /WS_SUBSCRIPTION_SECRET/.test(output),
 output.split('\n').find((line) => line.includes('WS_SUBSCRIPTION_SECRET'))?.trim ?? 'no mention',
)
 child.kill('SIGKILL')
 }

 console.log('\n— the running service —')
 const port = await freePort
 const { child, exited } = await startGateway({ WS_GATEWAY_PORT: String(port) })
 const url = `ws://127.0.0.1:${port}/ws/client`

 try {
 check('starts with the secret from.env', await waitForHealthy(port))

 const noToken = await openSocket(url)
 noToken.send(JSON.stringify({ type: 'subscribe', workspaceId: WORKSPACE }))
 const refusedFrame = await frameOrTimeout(noToken, (v) => v.type === 'error')
 check(
 'refuses the pre-the open-items list frame — a bare workspaceId, which is what any peer used to send',
 refusedFrame?.message === 'expected subscribe frame',
 String(refusedFrame?.message ?? 'no frame'),
)
 noToken.close

 const forged = await openSocket(url)
 forged.send(
 JSON.stringify({ type: 'subscribe', token: mint(WORKSPACE).replace(/.$/, 'X') }),
)
 const forgedFrame = await frameOrTimeout(forged, (v) => v.type === 'error')
 check('refuses a token with one byte changed', forgedFrame?.message === 'subscription refused',
 String(forgedFrame?.message ?? 'no frame'))
 check(' and closes the socket rather than leaving it open to retry', await closedWithin(forged))

 const expired = await openSocket(url)
 expired.send(JSON.stringify({ type: 'subscribe', token: mint(WORKSPACE, SUBSCRIPTION_TOKEN_TTL_MS * 2) }))
 const expiredFrame = await frameOrTimeout(expired, (v) => v.type === 'error')
 check('refuses an expired token', expiredFrame?.message === 'subscription refused',
 String(expiredFrame?.message ?? 'no frame'))
 expired.close

 const good = await openSocket(url)
 good.send(JSON.stringify({ type: 'subscribe', token: mint(WORKSPACE) }))
 const subscribed = await frameOrTimeout(good, (v) => v.type === 'subscribed')
 check('admits a properly signed token', subscribed?.workspaceId === WORKSPACE,
 String(subscribed?.workspaceId ?? 'no frame'))

 // The assertion that makes the rest mean something: the authorised socket really is
 // wired to the workspace's channel, so a refusal is a refusal of something real. Published
 // through the server's own adapter rather than a hand-built Valkey command, so the channel
 // name is the one apps/server actually uses.
 const publisher = createEventPublisher(process.env.VALKEY_URL ?? 'redis://localhost:6379')
 const delivered = frameOrTimeout(good, (v) => v.type === 'channel.created')
 await publisher.publish({
 type: 'channel.created',
 workspaceId: asWorkspaceId(WORKSPACE),
 channel: { id: 'live-1' },
 } as never)
 const received = await delivered
 check('and that socket receives the workspace stream',
 (received?.channel as { id?: string } | undefined)?.id === 'live-1')
 await publisher.close
 good.close
 } finally {
 child.kill('SIGTERM')
 await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))])
 child.kill('SIGKILL')
 }

 console.log(failures === 0 ? '\nall checks passed': `\n${failures} check(s) failed`)
 process.exit(failures === 0 ? 0: 1)
}

await main
