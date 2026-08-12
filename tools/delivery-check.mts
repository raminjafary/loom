/**
 * Live driver for note delivery into a run already working.
 *
 * docker compose up -d
 * LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/delivery-check.mts
 *
 * The claim under test is narrow and entirely unprovable from a test suite: that text
 * handed to the SDK's streaming input channel *after* the agent loop started actually
 * reaches the model's context, on its next turn, without interrupting it. Nothing in
 * the integration tests touches the SDK, and the failure mode is silent — the frame is
 * sent, the run completes normally, and the model simply never saw it.
 *
 * The task is built so a pass cannot be luck:
 *
 * 1. The filename the worker must create appears **only** in a note written after the
 * run started. It is not in the repository, not in the task, and not derivable.
 * 2. The worker is told not to read the shared notes, and the transcript is checked
 * for a `read_notes` call. Delivery and the ledger carry the same text, so without
 * that check a pass would prove only that the ledger works — which it already did.
 * 3. The note is written only once the run has made a tool call, so it genuinely
 * arrives mid-flight rather than being folded into the opening prompt.
 *
 * Not a test: it spends real tokens. Haiku and a low cap keep it to cents.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildApp, devAuth } from '../apps/server/src/index.js'
import { loadConfig } from '../apps/server/src/config.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

try {
 process.loadEnvFile(join(REPO_ROOT, '.env'))
} catch {
 // No.env is fine unsandboxed; sandboxed, the refusal below will say what is missing.
}

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'delivery-secret-at-least-32-characters-long',
 SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const sandboxed = process.env.LOOM_SANDBOX_ENABLED === '1'

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
 results.push({ ok, what })
 console.log(`${ok ? 'PASS': 'FAIL'} ${what}`)
}

/** Named only in a note written mid-run. A guess cannot produce it. */
const DELIVERED_NAME = 'DELIVERED-4dq-3141.md'

const WORKER = [
 '---',
 'name: delivery-worker',
 'description: Works on a repository and follows instructions that arrive while it works.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read, Glob, Grep, Write, Edit]',
 'harness:',
 ' autoApprove: true',
 ' budgetCapUsd: 0.5',
 '---',
 '',
 'You are a Software Engineer. Instructions may arrive in your context while you ' +
 'work; treat one from a human as authoritative and act on it.',
].join('\n')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const main = async => {
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `delivery-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'delivery-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))
 console.log('server on', `http://127.0.0.1:${addr.port}`, sandboxed ? '(sandboxed)': '(unsandboxed)')

 const repoPath = await mkdtemp(join(tmpdir, 'delivery-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
 await writeFile(join(repoPath, 'README.md'), '# delivery fixture\n')
 // Twenty files, not five: the run has to stay busy long enough for a note written
 // from outside to land while it is genuinely mid-turn. The first attempt used five
 // and the run was finished before the note was written — the driver reported a
 // failure of delivery when what it had actually measured was its own timing.
 const sources = Array.from({ length: 20 }, (_unused, index) => `mod${index}.js`)
 for (const name of sources) {
 await writeFile(join(repoPath, name), `export const ${name.split('.')[0]} = => ${name.length}\n`)
 }
 await execFileAsync('git', ['-C', repoPath, 'add', '.'])
 await execFileAsync('git', [
 '-C', repoPath, '-c', 'user.email=d@example.test', '-c', 'user.name=d',
 'commit', '-qm', 'init',
 ])

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'delivery-runner' })
 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 LOOM_SANDBOX_ENABLED: sandboxed ? '1': '0',
 // Withheld when the sandbox was asked for — see question-check.mts.
...(sandboxed
 ? {}
: {
 LOOM_ALLOW_UNSANDBOXED:
 process.env.LOOM_ALLOW_UNSANDBOXED ?? 'i-understand-the-agent-gets-my-privileges',
 }),
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `delivery-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
 await sleep(4000)

 const repo = await client.repository.bindExisting({
 runnerId, path: repoPath, displayName: 'delivery repo',
 })
 const channel = await client.channel.create({ name: 'delivery' })
 const persona = await client.persona.create({ markdownSource: WORKER })

 const run = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: persona.id,
 task:
 'Read every.js file in this repository one at a time, and for each one report ' +
 'its single exported name. Read them one per tool call — do not glob their ' +
 'contents in one go — and work through all twenty before doing anything else. ' +
 'While you are reading them, a human will add one more instruction to ' +
 'your context telling you the exact name of a markdown file to create; when you ' +
 'see it, finish reading and then create that file with one line of text in it. ' +
 'Do NOT call read_notes at any point — the instruction will come to you on its ' +
 'own. If you reach the end of the files and no instruction has appeared, say so ' +
 'and stop without creating anything.',
 })
 console.log('run', run.id)

 /**
 * Written only once the run has actually called a tool. Before that the run may
 * still be cloning, and a note that lands then is in the opening ledger — which is
 * the mechanism that already worked, not the one under test.
 */
 let sawToolCall = false
 for (let i = 0; i < 90 && !sawToolCall; i += 1) {
 await sleep(500)
 // Read from the thread rather than the board: a tool call is rendered as a message
 // the moment the event lands, whereas the board's `currentToolName` is only true
 // *between* a call and its result and is easy to sample straight past.
 const page = await client.message.list({ threadId: channel.rootThread.id }).catch( => null)
 sawToolCall = Boolean(page?.messages?.some((m: any) => m.body.text?.startsWith('→ Read')))
 }
 const stillRunning = (await client.agentRun.get({ agentRunId: run.id })).status === 'running'
 check(sawToolCall && stillRunning, 'the run was mid-flight when the note was written')

 await client.workerNote.write({
 agentRunId: run.id,
 kind: 'decision',
 title: 'Filename for the summary file',
 body: `Create the markdown file with exactly this name: ${DELIVERED_NAME}`,
 paths: [],
 })
 console.log('delivered:', DELIVERED_NAME)

 const terminal = ['completed', 'failed', 'cancelled']
 let final = await client.agentRun.get({ agentRunId: run.id })
 for (let i = 0; i < 120 && !terminal.includes(final.status); i += 1) {
 await sleep(2000)
 final = await client.agentRun.get({ agentRunId: run.id })
 }
 check(final.status === 'completed', `the run finished (${final.status})`)
 if (final.errorMessage) console.log(' error:', String(final.errorMessage).slice(0, 300))

 // The name arrived. This is the whole point: it exists nowhere the run could read.
 const files = final.clonePath ? await readdir(final.clonePath).catch( => [] as string[]): []
 check(
 files.includes(DELIVERED_NAME),
 `the delivered filename was used (${files.join(', ') || 'no clone'})`,
)

 /**
 * And it arrived by *delivery*, not by the ledger. The note is on the ledger too, so
 * a run that called `read_notes` would have found it there and this driver would be
 * proving a mechanism that already worked.
 */
 const page = await client.message.list({ threadId: channel.rootThread.id })
 const readNotes = page.messages.filter((m: any) => m.body.text?.includes('read_notes')).length
 check(readNotes === 0, `the run never read the ledger (${readNotes} read_notes calls)`)

 const failed = results.filter((r) => !r.ok)
 console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
 if (failed.length > 0) console.log('failed:', failed.map((f) => f.what).join('; '))
 console.log(`spent $${(final.totalCostUsd ?? 0).toFixed(4)}`)

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(failed.length === 0 ? 0: 1)
}

void main.catch((e) => {
 console.error('DELIVERY CHECK FAILED', e)
 process.exit(1)
})
