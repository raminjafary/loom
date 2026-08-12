/**
 * Live driver for the `dependsOn` — a real model, a real pipeline.
 *
 * docker compose up -d
 * LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/dag-check.mts
 *
 * **The check this exists for is check 1**, and it is not about scheduling.
 * `dependsOn` is a new field on `submit_plan`'s input schema, and this repository has
 * twice shipped a decomposition field the model was never actually offered: the
 * worker-notes tools (absent from the persona's exhaustive `tools` allowlist), and
 * `paths` (absent from the tool schema entirely, for two whole sessions, while the
 * wire carried it, the domain validated it and the board drew it). Both times every
 * test passed, because the integration tests inject a `plan_submitted` frame directly
 * — which is the right way to test the server and exactly the wrong way to notice that
 * a model was never asked.
 *
 * So the first assertion is "a real planner produced at least one edge". Everything
 * after it is the behaviour those edges are supposed to buy.
 *
 * The goal given below is deliberately, unambiguously sequential — write a file, then
 * document what the file contains. A planner that fans this out is not wrong about the
 * tool, it is wrong about the work, and the two failures are worth telling apart:
 * check 1 failing means the *field* is unreachable, check 3 failing means the model
 * chose not to use it.
 *
 * `LOOM_USE_HOST_CLAUDE_AUTH=1` is not optional in practice: without it the SDK uses
 * whatever key `.env` holds, and a placeholder key produces runs that fail before the
 * model ever plans — which looks like a passing "no crash" and proves nothing.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildApp, devAuth } from '../apps/server/src/index.js'
import { loadConfig } from '../apps/server/src/config.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'dag-check-secret-at-least-32-characters-long',
 SERVER_PORT: '0',
 MAX_CONCURRENT_RUNS_PER_WORKSPACE: process.env.MAX_CONCURRENT_RUNS_PER_WORKSPACE ?? '8',
} as NodeJS.ProcessEnv)

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
 results.push({ ok, what })
 console.log(`${ok ? 'PASS': 'FAIL'} ${what}`)
}

const PLANNER = [
 '---',
 'name: dag-planner',
 'description: Decomposes a goal into subtasks and delegates them.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read, Grep, Glob]',
 'harness:',
 ' planner: true',
 ' delegates: [Read, Edit, Write, Grep, Glob]',
 ' autoApprove: true',
 ' budgetCapUsd: 0.5',
 '---',
 '',
 'You are a Planner. You can read the repository but cannot write code or run ' +
 'commands — you decompose and delegate. Submit exactly one plan with submit_plan, ' +
 'then stop. Name a persona for each subtask from the roster you were given. When ' +
 'one subtask can only be done after another has finished, say so with dependsOn.',
].join('\n')

const WORKER = [
 '---',
 'name: dag-worker',
 'description: Implements one scoped change on its own branch.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read, Edit, Write, Grep, Glob]',
 'harness:',
 ' autoApprove: true',
 ' budgetCapUsd: 0.5',
 '---',
 '',
 'You are a Software Engineer. Make the smallest correct change for your task and stop.',
].join('\n')

const main = async => {
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `dag-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'dag-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const base = `http://127.0.0.1:${addr.port}`
 const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
 console.log('server on', base)

 const repoPath = await mkdtemp(join(tmpdir, 'dag-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
 await writeFile(join(repoPath, 'README.md'), '# dag fixture\n')
 await execFileAsync('git', ['-C', repoPath, 'add', '.'])
 await execFileAsync('git', [
 '-C', repoPath, '-c', 'user.email=dag@example.test', '-c', 'user.name=dag',
 'commit', '-qm', 'init',
 ])

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'dag-runner' })

 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 LOOM_SANDBOX_ENABLED: process.env.LOOM_SANDBOX_ENABLED ?? '0',
 // Withheld when the sandbox was asked for — see corporation-check.mts for the
 // silent-downgrade trap this avoids.
...(process.env.LOOM_SANDBOX_ENABLED === '1'
 ? {}
: {
 LOOM_ALLOW_UNSANDBOXED:
 process.env.LOOM_ALLOW_UNSANDBOXED ?? 'i-understand-the-agent-gets-my-privileges',
 }),
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `dag-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))

 await new Promise((r) => setTimeout(r, 4000))

 const repo = await client.repository.bindExisting({
 runnerId, path: repoPath, displayName: 'dag repo',
 })
 const channel = await client.channel.create({ name: 'dag' })
 const plannerPersona = await client.persona.create({ markdownSource: PLANNER })
 await client.persona.create({ markdownSource: WORKER })

 const root = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: plannerPersona.id,
 task:
 'Two pieces of work, and the second one cannot start until the first is done. ' +
 'First: create a file config-format.md that defines the configuration file ' +
 'format for this project. Second: create docs/config-guide.md, a guide that ' +
 'explains and quotes that format — it can only be written once the format ' +
 'exists. Plan both subtasks and make the ordering explicit.',
 })
 console.log('root run', root.id)

 // ── 1. Was the model offered the field at all? ───────────────────────────────
 /**
 * Matched on `subtask(s) started`, **not** on `Plan accepted`.
 *
 * Two different messages contain that phrase and only one of them is the server's:
 * `submit_plan`'s own tool result echoes "Plan accepted: N subtask(s) **recorded**"
 * back to the model, and that echo is rendered into the thread as a tool result
 * before the server posts "Plan accepted: N subtask(s) **started**". The first run
 * of this driver matched the echo, found no `⏸` in it — there could not be one —
 * and reported that a real planner had not used `dependsOn`. It had.
 *
 * Same shape as the `✗` bug in corporation-check.mts, one session earlier: a driver
 * matching on a substring that means two things reports confidently about the wrong
 * one.
 */
 const isPlanSummary = (m: any) => m.body.text?.includes('subtask(s) started')
 const messages = await (async => {
 for (let i = 0; i < 90; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 const page = await client.message.list({ threadId: channel.rootThread.id })
 if (page.messages.some(isPlanSummary)) return page
 }
 return client.message.list({ threadId: channel.rootThread.id })
 })
 const summary = messages.messages.find(isPlanSummary)?.body.text ?? ''
 console.log(' plan summary:', JSON.stringify(summary))

 /**
 * The `⏸` line is the platform's own record that a subtask was held back, and it is
 * only ever written when a plan carried an edge. Asserted on the rendered summary
 * rather than on the raw tool input because that is the artefact a human sees — and
 * because a field that parsed but never reached the scheduler would still fail here.
 */
 check(summary.includes('⏸'), 'a real planner used dependsOn (a subtask was held back)')

 // ── 2. The stage accounting the collaboration topology requires, before anything spends. ────────────
 const staged = messages.messages.find((m: any) => m.body.text?.includes('runs in 2 stages'))
 check(staged !== undefined, 'the per-stage spend ceiling was posted before any child started')

 // ── 3. Only the first stage started. ────────────────────────────────────────
 const firstWave = await (async => {
 for (let i = 0; i < 60; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 const kids = await client.agentRun.listChildren({ agentRunId: root.id })
 if (kids.length > 0) return kids
 }
 return []
 })
 check(
 firstWave.length > 0 && firstWave.length < 2,
 `only the unblocked subtask(s) started (${firstWave.length} run(s))`,
)

 // ── 4. The second stage was released once the first finished. ───────────────
 const terminal = ['completed', 'failed', 'cancelled']
 for (let i = 0; i < 120; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 const first = await client.agentRun.get({ agentRunId: firstWave[0].id })
 if (terminal.includes(first.status)) break
 }
 const released = await (async => {
 for (let i = 0; i < 60; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 const kids = await client.agentRun.listChildren({ agentRunId: root.id })
 if (kids.length > firstWave.length) return kids
 }
 return client.agentRun.listChildren({ agentRunId: root.id })
 })
 check(
 released.length > firstWave.length,
 `the dependent started after its predecessor finished (${firstWave.length} → ${released.length} run(s))`,
)

 const advanced = await client.message.list({ threadId: channel.rootThread.id })
 check(
 advanced.messages.some((m: any) => m.body.text?.includes('Plan stage advanced')),
 'the thread said which subtask the stage advance started',
)

 const failed = results.filter((r) => !r.ok)
 console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
 if (failed.length > 0) console.log('failed:', failed.map((f) => f.what).join('; '))

 const board = await client.workerNote.board({ agentRunId: root.id })
 const spend = board.cards.reduce((sum: number, c: any) => sum + (c.totalCostUsd ?? 0), 0)
 console.log(`spent $${spend.toFixed(4)} across ${board.cards.length} run(s)`)

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(failed.length === 0 ? 0: 1)
}

void main.catch((e) => {
 console.error('DAG CHECK FAILED', e)
 process.exit(1)
})
