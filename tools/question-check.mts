/**
 * Live driver for the clarifying question — a real model calling `ask_human`.
 *
 * docker compose up -d
 * LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/question-check.mts
 *
 * The server round trip has integration tests that inject a `question_asked` frame.
 * That proves the gate, the SLA path and the answer relay, and — exactly as with
 * `submit_plan` and `write_note` before it — says nothing about whether the model was
 * ever *offered* the tool. `AgentDefinition.tools` is an exhaustive allowlist, so an
 * in-process MCP tool missing from it is silently unreachable, and the run completes
 * having never asked. That bug has shipped twice in this repository; this is the check
 * that catches the third time.
 *
 * What only a live run can show:
 *
 * 1. The tool is registered *and* listed, so the model can call it at all.
 * 2. The run actually blocks — `awaiting_approval` with the question on the gate.
 * 3. The answer reaches the model and changes what it does. The task is built so the
 * answer is unguessable: the file it must write is named in the answer and nowhere
 * else, so a run that guessed cannot pass by accident.
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

/**
 * The sandbox needs the egress proxy's control secret, and that lives in `.env` —
 * which a spawned process does not inherit. Without it `egressConfigFromEnv` returns
 * nothing, the Runner has no sandbox to run in, and the run is refused. Loaded here so
 * the refusal is about something real rather than about a missing shell export.
 */
try {
 process.loadEnvFile(join(REPO_ROOT, '.env'))
} catch {
 // No.env is fine unsandboxed; sandboxed, the refusal below will say what is missing.
}

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'question-secret-at-least-32-characters-long-x',
 SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

/** `LOOM_SANDBOX_ENABLED=1` drives the container path — see the env block below. */
const sandboxed = process.env.LOOM_SANDBOX_ENABLED === '1'

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
 results.push({ ok, what })
 console.log(`${ok ? 'PASS': 'FAIL'} ${what}`)
}

/** Named in the answer and nowhere else, so a guess cannot produce it. */
const SECRET_NAME = 'ANSWERED-4i-7788.md'

const PERSONA = [
 '---',
 'name: question-worker',
 'description: A worker that asks before choosing.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read, Edit, Write, Grep, Glob]',
 'harness:',
 ' autoApprove: true',
 ' budgetCapUsd: 0.5',
 '---',
 '',
 'You are a Software Engineer. When a choice is genuinely not determined by the ' +
 'repository or your task, use ask_human and wait rather than guessing.',
].join('\n')

const main = async => {
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `question-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'question-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))
 console.log('server on', `http://127.0.0.1:${addr.port}`, sandboxed ? '(sandboxed)': '(unsandboxed)')

 const repoPath = await mkdtemp(join(tmpdir, 'question-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
 await writeFile(join(repoPath, 'README.md'), '# question fixture\n')
 await execFileAsync('git', ['-C', repoPath, 'add', '.'])
 await execFileAsync('git', [
 '-C', repoPath, '-c', 'user.email=q@example.test', '-c', 'user.name=q',
 'commit', '-qm', 'init',
 ])

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'question-runner' })
 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 LOOM_SANDBOX_ENABLED: sandboxed ? '1': '0',
 /**
 * **Not supplied when the sandbox was asked for.** The Runner falls back to an
 * unsandboxed run whenever the sandbox is unavailable *and* this acknowledgement
 * is set — so a driver that passes it unconditionally turns
 * `LOOM_SANDBOX_ENABLED=1` into a silent downgrade, and reports a clean pass
 * about the path it was not testing. That happened on this file's first
 * sandboxed run: 5/5, with `WARNING: running UNSANDBOXED` two lines above it.
 *
 * Withheld here, the same situation is a loud refusal naming what is missing.
 */
...(sandboxed
 ? {}
: {
 LOOM_ALLOW_UNSANDBOXED:
 process.env.LOOM_ALLOW_UNSANDBOXED ?? 'i-understand-the-agent-gets-my-privileges',
 }),
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `question-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
 await new Promise((r) => setTimeout(r, 4000))

 const repo = await client.repository.bindExisting({
 runnerId, path: repoPath, displayName: 'question repo',
 })
 const channel = await client.channel.create({ name: 'question' })
 const persona = await client.persona.create({ markdownSource: PERSONA })

 const run = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: persona.id,
 task:
 'Add exactly one new markdown file to the root of this repository. The filename ' +
 'is not written anywhere in this repository and you cannot derive it — you must ' +
 'use the ask_human tool to ask what it should be called, wait for the answer, ' +
 'and use exactly the name you are given. Do not guess a filename. Put a single ' +
 'line of text in the file and stop.',
 })
 console.log('run', run.id)

 // 1 + 2: the model called it, and the run is blocked with the question on the gate.
 let pending: any[] = []
 for (let i = 0; i < 90 && pending.length === 0; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 pending = await client.approval.listPending({ agentRunId: run.id })
 }
 check(pending.length > 0, 'the model called ask_human and the platform gated it')
 if (pending.length === 0) {
 console.log('no question was asked — the tool was probably never offered to the model')
 } else {
 const gate = pending[0]
 check(typeof gate.question === 'string' && gate.question.length > 0, 'the gate carries a question')
 console.log(' question:', gate.question)
 check(
 (await client.agentRun.get({ agentRunId: run.id })).status === 'awaiting_approval',
 'the run is blocked on it',
)

 // 3: the answer reaches the model and changes what it does.
 await client.approval.decide({
 approvalRequestId: gate.id,
 decision: 'approve',
 answer: `Call it exactly ${SECRET_NAME}`,
 })
 console.log(' answered:', SECRET_NAME)
 }

 const terminal = ['completed', 'failed', 'cancelled']
 let final = await client.agentRun.get({ agentRunId: run.id })
 for (let i = 0; i < 90 && !terminal.includes(final.status); i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 final = await client.agentRun.get({ agentRunId: run.id })
 }
 check(final.status === 'completed', `the run finished after answering (${final.status})`)
 if (final.status !== 'completed' && final.errorMessage) {
 console.log(' run error:', String(final.errorMessage).slice(0, 400))
 }

 // The clone, not the source repo — the run works on its own copy.
 const clonePath = final.clonePath
 const files = clonePath ? await readdir(clonePath).catch( => [] as string[]): []
 check(
 files.includes(SECRET_NAME),
 `the model used the answered filename (${clonePath ? files.join(', '): 'no clone path'})`,
)

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
 console.error('QUESTION CHECK FAILED', e)
 process.exit(1)
})
