/**
 * Live driver for the base-image half — the prepared dependency tree.
 *
 * docker compose up -d
 * set -a &&../.env && set +a
 * LOOM_USE_HOST_CLAUDE_AUTH=1 LOOM_DEP_CACHE_ENABLED=1 \
 * npx tsx tools/prepared-tree-check.mts
 *
 * The unit tests cover capture and materialization against a git repository on disk.
 * What they cannot cover is the thing this feature is actually about: whether a real
 * warm through a real sandbox produces a tree that a *real run* opens onto, and
 * whether the run's branch is the same branch it would have been without one.
 *
 * Every check asserts. Nothing here prints a value and calls it a result — a printed
 * line cannot fail, and this repository has twice recorded a missing field as a
 * model's choice because a driver printed instead of asserting.
 *
 * Spends a small amount of model tokens (one Haiku run, capped) and downloads one
 * package.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildApp, devAuth } from '../apps/server/src/index.js'
import { loadConfig } from '../apps/server/src/config.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const CACHE_ROOT = join(tmpdir, `loom-prepared-check-cache-${Date.now}`)
const PREPARED_ROOT = join(tmpdir, `loom-prepared-check-trees-${Date.now}`)
const INSTALL = 'npm install --no-audit --no-fund --ignore-scripts'

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'prepared-check-secret-at-least-32-characters',
 SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
 results.push({ ok, what })
 console.log(`${ok ? 'PASS': 'FAIL'} ${what}`)
}

const exists = async (path: string): Promise<boolean> =>
 (await stat(path).catch( => null)) !== null

const fixture = async : Promise<string> => {
 const path = await mkdtemp(join(tmpdir, 'prepared-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', path])
 await writeFile(
 join(path, 'package.json'),
 JSON.stringify(
 { name: 'prepared-fixture', version: '1.0.0', private: true, dependencies: { chalk: '5.3.0' } },
 null,
 2,
),
)
 await writeFile(join(path, '.gitignore'), 'node_modules/\n')
 await writeFile(join(path, 'README.md'), '# prepared fixture\n')
 await execFileAsync('git', ['-C', path, 'add', '-A'])
 await execFileAsync('git', [
 '-C', path, '-c', 'user.email=p@p.invalid', '-c', 'user.name=p', 'commit', '-qm', 'init',
 ])
 return path
}

const main = async => {
 if (process.env.LOOM_DEP_CACHE_ENABLED !== '1') {
 console.log('LOOM_DEP_CACHE_ENABLED=1 is required — the prepared tree rides on the cache.')
 process.exit(1)
 }
 /**
 * Without host auth the SDK falls back to `.env`'s placeholder key and the run fails
 * before any model acts — which reads as a passing "no crash" if nothing checks.
 */
 if (process.env.LOOM_USE_HOST_CLAUDE_AUTH !== '1' && !process.env.ANTHROPIC_API_KEY) {
 console.log('LOOM_USE_HOST_CLAUDE_AUTH=1 is required — otherwise the run spends nothing and proves nothing.')
 process.exit(1)
 }

 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `prepared-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'prepared-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))

 const repoPath = await fixture
 console.log(`repo=${repoPath}\ncache=${CACHE_ROOT}\nprepared=${PREPARED_ROOT}`)

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'prepared-runner' })
 const runnerLog: string[] = []
 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 LOOM_DEP_CACHE_ENABLED: '1',
 LOOM_DEP_CACHE_ROOT: CACHE_ROOT,
 LOOM_PREPARED_TREE_ROOT: PREPARED_ROOT,
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `prepared-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 const capture = (chunk: Buffer) => {
 const text = chunk.toString
 runnerLog.push(text)
 process.stdout.write(`[runner] ${text}`)
 }
 runner.stdout.on('data', capture)
 runner.stderr.on('data', capture)
 await new Promise((r) => setTimeout(r, 4000))

 const repo = await client.repository.bindExisting({
 runnerId,
 path: repoPath,
 displayName: 'prepared fixture',
 })
 await client.repository.setInstallCommand({ repositoryId: repo.id, installCommand: INSTALL })

 // ── 1. The warm captures a tree ────────────────────────────────────────────────
 const warm = await client.repository.warmCache({ repositoryId: repo.id })
 check(warm.ok, `the warm succeeded${warm.detail ? ` — ${warm.detail}`: ''}`)
 check(
 typeof warm.detail === 'string' && warm.detail.includes('node_modules'),
 'the warm result names what a run will now start with, rather than only saying "warmed"',
)

 const manifestPath = join(PREPARED_ROOT, repo.id, 'manifest.json')
 const manifest = await readFile(manifestPath, 'utf8').then(JSON.parse).catch( => null)
 check(manifest !== null, 'a manifest was written for this repository')
 check(manifest?.directories?.includes('node_modules') === true, 'node_modules was captured')
 /**
 * Cross-checked against `du` rather than against a guessed threshold. A threshold
 * only asserts "big enough", which a one-package fixture fails for the wrong reason;
 * agreeing with the filesystem asserts that the accounting itself is right.
 */
 const duKb = await execFileAsync('du', ['-sk', join(PREPARED_ROOT, repo.id, 'node_modules')])
.then(({ stdout }) => Number(stdout.trim.split(/\s+/)[0]))
.catch( => 0)
 const ratio = duKb > 0 ? (manifest?.bytes ?? 0) / (duKb * 1024): 0
 check(
 ratio > 0.4 && ratio < 1.2,
 `the recorded size matches what is on disk (${((manifest?.bytes ?? 0) / 1024).toFixed(0)}K recorded, ${duKb}K on disk)`,
)
 check(
 await exists(join(PREPARED_ROOT, repo.id, 'node_modules', 'chalk', 'package.json')),
 'the dependency itself is in the prepared tree, not just a directory named after it',
)

 // ── 2. A real run opens onto it ────────────────────────────────────────────────
 const swe = await client.persona.create({
 markdownSource: [
 '---',
 'name: prepared-swe',
 'description: Makes one small, scoped edit.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read, Edit, Write, Bash, Grep, Glob]',
 'harness:',
 ' autoApprove: true',
 ' budgetCapUsd: 0.5',
 '---',
 '',
 'You are a Software Engineer. Make the smallest correct change and stop.',
 ].join('\n'),
 })

 const channel = await client.channel.create({ name: 'prepared' })
 const run = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: swe.id,
 task: 'Append a single line reading "verified" to the end of README.md, then stop.',
 })

 let clonePath: string | null = null
 for (let i = 0; i < 120; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 const current = await client.agentRun.get({ agentRunId: run.id })
 clonePath ??= current.clonePath ?? null
 if (['completed', 'failed', 'cancelled'].includes(current.status)) break
 }

 const finalRun = await client.agentRun.get({ agentRunId: run.id })
 clonePath ??= finalRun.clonePath ?? null
 check(
 finalRun.status === 'completed',
 `the run completed (${finalRun.status}${finalRun.errorMessage ? `: ${finalRun.errorMessage}`: ''})`,
)
 check(
 runnerLog.join('').includes(`run ${run.id} starts prepared: node_modules`),
 'the Runner reported handing this run a prepared tree',
)

 check(clonePath !== null, "the run's clone path is known")
 if (clonePath) {
 check(
 await exists(join(clonePath, 'node_modules', 'chalk', 'package.json')),
 "the dependency is present in the run's own clone",
)

 /**
 * The property the whole design rests on. A prepared tree only contains paths the
 * repository ignores, so what the run committed and what a human reviews must be
 * exactly what they would have been without one — no `node_modules` in the diff,
 * and nothing extra in the commit.
 */
 const { stdout: status } = await execFileAsync('git', ['-C', clonePath, 'status', '--porcelain'])
 check(status.trim === '', `the prepared tree left the working tree clean (${JSON.stringify(status.trim.slice(0, 120))})`)

 const { stdout: committed } = await execFileAsync('git', [
 '-C', clonePath, 'diff', '--name-only', `${repo.defaultBranch}...HEAD`,
 ])
 const paths = committed.split('\n').filter((line) => line.length > 0)
 check(
 paths.length > 0 && paths.every((path) => !path.startsWith('node_modules/')),
 `the commit contains only the agent's own work (${paths.join(', ') || 'nothing'})`,
)
 }

 const diff = await client.agentRun
.getDiff({ agentRunId: run.id })
.catch((e: any) => ({ diff: `ERR ${e.message}` }))
 check(
 !diff.diff.includes('node_modules/'),
 'the diff a human reviews carries nothing from the prepared tree',
)

 const failed = results.filter((r) => !r.ok)
 console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
 if (failed.length > 0) console.log('failed:', failed.map((f) => f.what).join('; '))
 console.log(`run cost $${finalRun.totalCostUsd ?? 0}`)

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(failed.length === 0 ? 0: 1)
}

void main.catch((e) => {
 console.error('PREPARED TREE CHECK FAILED', e)
 process.exit(1)
})
