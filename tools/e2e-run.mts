/**
 * End-to-end driver: real server, real Runner process, real git repo, real agent run.
 *
 * Exists because the automated suite deliberately fakes the Runner (see
 * runner-gateway.integration.test.ts) — that proves the protocol, not that a real run
 * works. Run by hand:
 *
 * docker compose up -d
 * npx tsx tools/e2e-run.mts
 *
 * Defaults to LOOM_SANDBOX_ENABLED=0, so the SDK uses whatever model auth the host
 * already has. Set it to 1 with LOOM_SANDBOX_MODEL_KEY_PASSTHROUGH=1 and
 * LOOM_SANDBOX_MODEL_API_KEY to exercise the sandboxed path instead.
 *
 * Not a test: it spends real tokens and asserts nothing. It prints what happened so a
 * human can read it.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
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
 // Quiets the server logger and points at the test database, so a hand-run driver
 // can never touch a dev workspace someone is using.
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'e2e-secret-at-least-32-characters-long-value',
 SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const main = async => {
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `e2e-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'e2e-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const base = `http://127.0.0.1:${addr.port}`
 const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
 console.log('server on', base)

 // A real git repo for the agent to work in.
 const repoPath = await mkdtemp(join(tmpdir, 'e2e-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
 await writeFile(join(repoPath, 'README.md'), '# e2e\n\nA fixture repository.\n')
 await execFileAsync('git', ['-C', repoPath, 'add', '.'])
 await execFileAsync('git', [
 '-C', repoPath, '-c', 'user.email=e2e@example.test', '-c', 'user.name=e2e',
 'commit', '-qm', 'init',
 ])

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'e2e-runner' })
 void runnerId

 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 // Defaults to unsandboxed so the SDK uses the host's own auth; override by
 // exporting LOOM_SANDBOX_ENABLED=1 before running this.
 LOOM_SANDBOX_ENABLED: process.env.LOOM_SANDBOX_ENABLED ?? '0',
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `e2e-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))

 await new Promise((r) => setTimeout(r, 4000))

 const repo = await client.repository.bindExisting({
 runnerId,
 path: repoPath,
 displayName: 'e2e repo',
 })
 console.log('bound repo', repo.id, 'default branch', repo.defaultBranch)

 // seedWorkspace does not seed the built-ins — that happens on first membership
 // provisioning — so the driver authors its own persona.
 const swe = await client.persona.create({
 markdownSource: [
 '---',
 'name: e2e-swe',
 'description: Makes one small, scoped edit.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read, Edit, Write, Bash, Grep, Glob]',
 'harness:',
 ' budgetCapUsd: 0.5',
 '---',
 '',
 'You are a Software Engineer. Make the smallest correct change and stop.',
 ].join('\n'),
 })
 console.log('persona', swe.name, 'cap', swe.harnessBudgetCapUsd)

 const channel = await client.channel.create({ name: 'e2e' })
 const run = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: swe.id,
 task: 'Add a single line reading "verified" to the end of README.md, then stop.',
 })
 console.log('run', run.id, run.status)

 for (let i = 0; i < 90; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 const current = await client.agentRun.get({ agentRunId: run.id })
 const approvals = await client.approval.listPending({ agentRunId: run.id })
 if (approvals.length > 0) {
 console.log('approving', approvals[0].toolName, JSON.stringify(approvals[0].input).slice(0, 160))
 await client.approval.decide({ approvalRequestId: approvals[0].id, decision: 'approve' })
 continue
 }
 if (['completed', 'failed', 'cancelled'].includes(current.status)) {
 console.log('run finished:', current.status, 'cost', current.totalCostUsd, current.errorMessage ?? '')
 break
 }
 }

 const finalRun = await client.agentRun.get({ agentRunId: run.id })
 console.log('final status', finalRun.status, 'cost', finalRun.totalCostUsd)
 const diff = await client.agentRun.getDiff({ agentRunId: run.id }).catch((e: any) => ({ diff: `ERR ${e.message}` }))
 console.log('diff bytes', diff.diff.length)
 console.log(diff.diff.split('\n').slice(0, 20).join('\n'))

 const inbox = await client.agentRun.listNeedsAttention
 console.log('inbox size', inbox.length)

 const kept = await client.agentRun.keep({ agentRunId: run.id }).catch((e: any) => ({ error: e.message }))
 console.log('keep ->', JSON.stringify(kept).slice(0, 160))

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(0)
}

void main.catch((e) => {
 console.error('E2E FAILED', e)
 process.exit(1)
})
