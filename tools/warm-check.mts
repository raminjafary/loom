/**
 * Live driver for the dependency cache: real server, real Runner
 * process, real container, a real install through the egress proxy to a real registry.
 *
 * docker compose up -d
 * set -a &&../.env && set +a
 * LOOM_DEP_CACHE_ENABLED=1 npx tsx tools/warm-check.mts --repo /path/to/repo
 *
 * Exists because everything else about this feature is testable without leaving the
 * process, and the one part that is not is the part most likely to be wrong: whether an
 * install inside a `--network internal` sandbox can actually reach a package registry
 * through the proxy's allowlist, and whether what it downloads lands in a directory a
 * later run inherits.
 *
 * That is the same shape as the three bugs this codebase found the hard way — a stale
 * image, an approval gate nobody was watching, and a git refusal — each at a boundary
 * the unit tests stub. Spends no model tokens; it downloads packages.
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

const arg = (name: string, fallback?: string): string | undefined => {
 const i = process.argv.indexOf(`--${name}`)
 return i === -1 ? fallback: (process.argv[i + 1] ?? fallback)
}

const INSTALL = arg('install', 'npm install --no-audit --no-fund --ignore-scripts') as string
const CACHE_ROOT = process.env.LOOM_DEP_CACHE_ROOT ?? join(tmpdir, 'loom-warm-check-cache')

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'warm-check-secret-at-least-32-characters-long',
 SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
 results.push({ ok, what })
 console.log(`${ok ? 'PASS': 'FAIL'} ${what}`)
}

/** Bytes under a directory, via du — the only number that says the cache is real. */
const sizeBytes = async (path: string): Promise<number> => {
 try {
 const { stdout } = await execFileAsync('du', ['-sk', path])
 return Number(stdout.trim.split(/\s+/)[0]) * 1024
 } catch {
 return 0
 }
}

const buildFixture = async : Promise<string> => {
 const path = await mkdtemp(join(tmpdir, 'warm-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', path])
 // Small, real, and with a couple of transitive deps — enough that a populated cache
 // is unmistakable and a cold install is not instant.
 await writeFile(
 join(path, 'package.json'),
 JSON.stringify(
 { name: 'warm-fixture', version: '1.0.0', private: true, dependencies: { chalk: '5.3.0' } },
 null,
 2,
),
)
 await execFileAsync('git', ['-C', path, 'add', '-A'])
 await execFileAsync('git', [
 '-C', path, '-c', 'user.email=w@w.invalid', '-c', 'user.name=w', 'commit', '-qm', 'init',
 ])
 return path
}

const main = async => {
 if (process.env.LOOM_DEP_CACHE_ENABLED !== '1') {
 console.log('LOOM_DEP_CACHE_ENABLED=1 is required — this script tests the cache.')
 process.exit(1)
 }
 await execFileAsync('rm', ['-rf', CACHE_ROOT]).catch( => {})

 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `warm-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'warm-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))

 const repoPath = arg('repo') ?? (await buildFixture)
 console.log(`repo=${repoPath}\ncache=${CACHE_ROOT}\ninstall=${INSTALL}`)

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'warm-runner' })
 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 LOOM_DEP_CACHE_ENABLED: '1',
 LOOM_DEP_CACHE_ROOT: CACHE_ROOT,
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `warm-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
 await new Promise((r) => setTimeout(r, 4000))

 const repo = await client.repository.bindExisting({
 runnerId,
 path: repoPath,
 displayName: 'warm fixture',
 })

 // Refused before it is configured — a "warmed" cache that ran nothing is the kind of
 // quiet no-op this whole session was about.
 let refused = false
 try {
 await client.repository.warmCache({ repositoryId: repo.id })
 } catch {
 refused = true
 }
 check(refused, 'warming without an install command is refused, not silently a no-op')

 await client.repository.setInstallCommand({ repositoryId: repo.id, installCommand: INSTALL })
 const before = await sizeBytes(CACHE_ROOT)

 const startedAt = Date.now
 const result = await client.repository.warmCache({ repositoryId: repo.id })
 const warmMs = Date.now - startedAt

 check(result.ok, `the install ran in the sandbox and succeeded${result.detail ? ` (${result.detail})`: ''}`)
 const after = await sizeBytes(CACHE_ROOT)
 console.log(` cache ${(before / 1024).toFixed(0)}K -> ${(after / 1024).toFixed(0)}K in ${(warmMs / 1000).toFixed(0)}s`)

 /**
 * Checked against npm's *content* store, not the directory's size.
 *
 * The first run of this script passed this on 4K of `/deps/npm/_logs` — npm's own
 * debug log from the install that had just failed with 407. "The cache has bytes in
 * it" is satisfied by a record of failure, which is precisely the kind of
 * measures-the-wrong-thing the reconciler harness already got caught doing.
 */
 const cacheEntries = await sizeBytes(join(CACHE_ROOT, 'npm', '_cacache'))
 check(
 cacheEntries > 0,
 `packages reached the content store — the proxy allowlist let the registry through (${(cacheEntries / 1024).toFixed(0)}K in _cacache)`,
)

 if (!result.ok) {
 console.log('\nThe install failed, so nothing below would mean anything. Detail above.')
 }

 const failed = results.filter((r) => !r.ok)
 console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
 if (failed.length > 0) console.log('failed:', failed.map((f) => f.what).join('; '))
 console.log(`\nCache root left at ${CACHE_ROOT} — a run started with`)
 console.log('LOOM_DEP_CACHE_ENABLED=1 pointing there now starts warm.')

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(failed.length === 0 ? 0: 1)
}

void main.catch((e) => {
 console.error('WARM CHECK FAILED', e)
 process.exit(1)
})
