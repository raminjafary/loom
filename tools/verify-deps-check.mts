/**
 * `verifyCommand` on a repository whose tests need
 * dependencies, which is to say on a real one.
 *
 * Merge verification runs with `--network none` against a bare `git clone`, so before
 * the dependency cache was mounted under it the only commands that could succeed were
 * ones needing nothing installed. On a real project that meant no usable
 * `verifyCommand` at all, and the safety net quietly degraded to "merged unverified
 * and said so" — measured in `tools/reconcile-queue-check.mts`, where the whole
 * argument for the reconciler's default is that the repository's own tests check the
 * agent's work.
 *
 * This drives the fixed path end to end: real server, real Runner process, real git,
 * a real repository, and a verification command that **installs offline from the
 * warmed cache and then runs the project's own suite**. The network stays closed
 * throughout; if the cache were not there, the install would fail and so would the
 * merge.
 *
 * **Spends no tokens.** The run it starts is refused for want of a model credential
 * *after* its clone is prepared, which is all the queue needs — the commit an agent
 * would have left is written by this script.
 *
 *   docker compose up -d
 *   set -a && . ./.env && set +a
 *   npx tsx tools/verify-deps-check.mts --repo /path/to/project --cache /path/to/warm-cache
 *
 * Warm the cache first, the same way the platform does — `repository.warm` with the
 * repository's `installCommand`, or by hand:
 *
 *   npm_config_cache=/path/to/warm-cache/npm npm install
 *
 * Asserts loudly and exits non-zero. Two things it will not let pass: a merge that
 * reports `verified: false`, and a verification that wrote anything into the warmed
 * cache — the second is the property that makes mounting it safe at all.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { execFile, spawn } from 'node:child_process'
import { readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { buildApp, devAuth } from '../apps/server/src/index.js'
import { loadConfig } from '../apps/server/src/config.js'
import { advanceMergeQueue } from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}

const REPO = arg('repo')
const CACHE = arg('cache')
/**
 * The default is npm's, and `--offline` is the load-bearing flag: it makes npm refuse
 * the network outright rather than merely prefer the cache, so a command that succeeds
 * here has *proved* it needed nothing but what the warm step left behind.
 */
const VERIFY = arg('verify', 'npm install --offline --no-audit --no-fund && npm test') as string

if (!REPO || !CACHE) {
  console.error(
    'usage: verify-deps-check.mts --repo <real project> --cache <warmed cache root> [--verify <command>]',
  )
  process.exit(2)
}

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'verify-deps-secret-at-least-32-characters-x',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** A stable fingerprint of the warmed cache, to prove verification did not write to it. */
const fingerprint = async (root: string): Promise<string> => {
  const { stdout } = await execFileAsync('sh', [
    '-c',
    `find ${JSON.stringify(root)} -type f | wc -l; du -sk ${JSON.stringify(root)} | cut -f1`,
  ])
  return stdout.trim().replace(/\s+/g, ' ')
}

const main = async () => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `verify-deps-${Date.now()}`)
  const app = await buildApp(config, devAuth({ userId: 'vd-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))

  const cacheEntries = await readdir(CACHE).catch(() => [] as string[])
  console.log(`repo   ${REPO}`)
  console.log(`cache  ${CACHE} (${cacheEntries.length} entries)`)
  console.log(`verify ${VERIFY}`)
  if (cacheEntries.length === 0) {
    console.log('\nThe cache is empty. Warm it first, or this measures nothing but a failing install.')
  }
  const before = await fingerprint(CACHE)

  const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'vd-runner' })
  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: `${dirname(REPO)},${tmpdir()}`,
      /**
       * Defaults to unsandboxed *with* the acknowledgement, because verification has
       * to actually run and the sandboxed path needs an image. `LOOM_SANDBOX_ENABLED=1`
       * drives the production path instead — worth doing at least once, since the two
       * differ by the mount and the `-e` flags and only one of them is the default.
       *
       * Either way the *run* costs nothing: no model credential is provided, so it is
       * refused after its clone exists, which is the only part the queue needs.
       */
      LOOM_SANDBOX_ENABLED: process.env.LOOM_SANDBOX_ENABLED ?? '0',
      /**
       * **Withheld when the sandbox was asked for** — see question-check.mts. Supplying
       * it unconditionally turns `LOOM_SANDBOX_ENABLED=1` into a silent downgrade and
       * reports a clean pass about the path it was not testing.
       */
      ...(process.env.LOOM_SANDBOX_ENABLED === '1'
        ? {}
        : { LOOM_ALLOW_UNSANDBOXED: 'i-understand-the-agent-gets-my-privileges' }),
      LOOM_USE_HOST_CLAUDE_AUTH: '0',
      LOOM_DEP_CACHE_ENABLED: '1',
      LOOM_DEP_CACHE_ROOT: CACHE,
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `vd-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => {
    if (process.env.VD_VERBOSE === '1') process.stdout.write(`[runner] ${d}`)
  })
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 4000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: REPO,
    displayName: 'verify-deps repo',
  })
  await client.repository.setVerifyCommand({ repositoryId: repo.id, verifyCommand: VERIFY })

  const persona = await client.persona.create({
    markdownSource: [
      '---',
      'name: vd-worker',
      'description: Never actually runs; the workspace is what matters.',
      'model: claude-haiku-4-5-20251001',
      'tools: [Read]',
      '---',
      '',
      'Unused.',
    ].join('\n'),
  })
  const channel = await client.channel.create({ name: 'verify-deps' })

  const started = await client.agentRun.start({
    threadId: channel.rootThread.id,
    repositoryId: repo.id,
    personaId: persona.id,
  })
  let run = started
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 500))
    run = await client.agentRun.get({ agentRunId: started.id })
    if (run.clonePath && ['completed', 'failed', 'cancelled'].includes(run.status)) break
  }
  if (!run.clonePath) throw new Error('the run never got a clone')
  check('run cost nothing', (run.totalCostUsd ?? 0) === 0, `$${(run.totalCostUsd ?? 0).toFixed(4)}`)
  check(
    'the clone has no node_modules, exactly as the queue produces it',
    (await readdir(run.clonePath)).every((entry) => entry !== 'node_modules'),
  )

  /**
   * The commit an agent would have left behind. Deliberately a file the project's own
   * suite ignores: what is under test is whether verification can *run*, not whether
   * this script can write a passing test.
   *
   * Unique per invocation, because the previous invocation merged its marker into the
   * repository — a fixed name makes the second run a no-op commit and the check dies
   * with "nothing to commit" instead of measuring anything.
   */
  await writeFile(
    join(run.clonePath, `LOOM_VERIFY_MARKER-${Date.now()}.md`),
    'added by the verify-deps check\n',
  )
  await git(run.clonePath, ['add', '-A'])
  await git(run.clonePath, [
    '-c', 'user.email=agent@loom.invalid', '-c', 'user.name=agent', 'commit', '-qm', 'add marker',
  ])

  const targetBefore = await git(REPO, ['rev-parse', 'HEAD'])
  await client.mergeQueue.enqueue({ agentRunId: run.id })
  const startedAt = Date.now()
  await advanceMergeQueue(app.deps, { mergeStuckMs: 1_800_000 })
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0)

  const entry = (await client.mergeQueue.list())[0]
  console.log(`\nverification took ${elapsed}s`)
  check(
    'merged',
    entry?.status === 'merged',
    `${entry?.status}${entry?.failureReason ? `/${entry.failureReason}` : ''} ${(entry?.detail ?? '').split('\n').slice(0, 3).join(' | ')}`,
  )
  // The headline. `verified` records whether tests actually ran and passed, never
  // whether any were configured — so a `true` here is the project's real suite having
  // executed against dependencies installed with the network closed.
  check('verified by the project\'s own suite', entry?.verified === true)
  check(
    'the target branch actually moved',
    (await git(REPO, ['rev-parse', 'HEAD'])) !== targetBefore,
  )

  const after = await fingerprint(CACHE)
  check('the warmed cache is untouched', before === after, `${before} → ${after}`)

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  if (failures === 0) {
    console.log('A real project\'s test suite ran under merge verification, offline, from the')
    console.log('warmed cache — which is what makes the roadmap\'s "the queue checks the agent" true')
    console.log('anywhere other than a fixture.')
  }

  runner.kill('SIGKILL')
  await app.close()
  await closeDb()
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((e) => {
  console.error('VERIFY DEPS CHECK FAILED', e)
  process.exit(1)
})
