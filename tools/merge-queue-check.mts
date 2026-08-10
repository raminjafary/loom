/**
 * Live driver for the serialized merge queue: real server,
 * real Runner *process*, real WebSocket protocol, real git repository, real
 * rebase and fast-forward.
 *
 * docker compose up -d
 * npx tsx tools/merge-queue-check.mts
 *
 * Why this exists alongside the tests. `merge.test.ts` drives real git but calls
 * `mergeRunBranch` directly; `runner-gateway.integration.test.ts` drives the real
 * protocol but with a fake Runner that answers `merge_result` from a script.
 * Neither one has ever had the whole chain — server sweep → dispatch → socket →
 * real Runner → real git → back — actually happen. Five bugs across previous
 * sessions were found by driving the real thing after a green suite.
 *
 * Spends **no tokens**. The runs it starts are refused by the Runner's own
 * unsandboxed guard, which is enough: the guard fires *after* the clone, so each
 * run has a real workspace and a real branch, which is all the queue needs. The
 * commits are written into those clones by this script, standing in for what an
 * agent would have left behind.
 *
 * Not a test: it asserts loudly but is run by hand, and it prints what happened.
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
import { advanceMergeQueue } from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'merge-check-secret-at-least-32-characters',
 SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
 execFileAsync('git', ['-C', cwd,...args]).then((r) => r.stdout.trim)

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
 console.log(`${ok ? ' ok ': ' FAIL '} ${label}${detail ? ` — ${detail}`: ''}`)
 if (!ok) failures += 1
}

const main = async => {
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `merge-check-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'merge-check-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const base = `http://127.0.0.1:${addr.port}`
 const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
 console.log('server on', base)

 const repoPath = await mkdtemp(join(tmpdir, 'merge-check-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
 await writeFile(join(repoPath, 'README.md'), '# fixture\n')
 await git(repoPath, ['add', '.'])
 await git(repoPath, ['-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'init'])
 const baseSha = await git(repoPath, ['rev-parse', 'HEAD'])
 console.log('repo', repoPath, 'at', baseSha.slice(0, 8))

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'merge-check-runner' })

 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 // Unsandboxed and *unacknowledged* on purpose: the run is refused right
 // after its clone is prepared, which costs nothing and still leaves the
 // real workspace the merge queue needs.
 LOOM_SANDBOX_ENABLED: '0',
 LOOM_ALLOW_UNSANDBOXED: '',
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `merge-check-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
 await new Promise((r) => setTimeout(r, 4000))

 const repo = await client.repository.bindExisting({
 runnerId,
 path: repoPath,
 displayName: 'merge check repo',
 })

 const persona = await client.persona.create({
 markdownSource: [
 '---',
 'name: merge-check-worker',
 'description: Never actually runs; the workspace is what matters.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read]',
 '---',
 '',
 'Unused.',
 ].join('\n'),
 })

 const channel = await client.channel.create({ name: 'merge-check' })

 /**
 * Starts a run and waits for its clone. Kept separate from `commitIn` because
 * *when* a clone is taken is the thing under test: two branches only conflict, and
 * a rebase is only doing anything, if both were cloned from the same base before
 * either merged. Committing at clone time would have quietly made every case a
 * fast-forward — which is exactly what the first draft of this script did.
 */
 const startRun = async => {
 const run = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: persona.id,
 })
 let current = run
 for (let i = 0; i < 60; i += 1) {
 await new Promise((r) => setTimeout(r, 500))
 current = await client.agentRun.get({ agentRunId: run.id })
 if (current.clonePath && ['completed', 'failed', 'cancelled'].includes(current.status)) break
 }
 if (!current.clonePath) throw new Error(`run ${run.id} never got a clone`)
 return current
 }

 /** Writes the commit an agent would have left in the run's clone. */
 const commitIn = async (run: any, file: string, body: string, message: string) => {
 await writeFile(join(run.clonePath, file), body)
 await git(run.clonePath, ['add', '-A'])
 await git(run.clonePath, [
 '-c', 'user.email=agent@loom.invalid', '-c', 'user.name=agent', 'commit', '-qm', message,
 ])
 return run
 }

 const sweep = => advanceMergeQueue(app.deps, { mergeStuckMs: 1_800_000 })

 // All three cloned up front, from the same base, before anything merges — the
 // shape a swarm actually produces.
 const first = await startRun
 const sibling = await startRun
 const rival = await startRun
 await commitIn(first, 'one.txt', 'one\n', 'add one')
 await commitIn(sibling, 'two.txt', 'two\n', 'add two')
 await commitIn(rival, 'one.txt', 'a rival edit\n', 'rewrite one')

 console.log('\n— one branch, merged and fast-forwarded —')
 await client.mergeQueue.enqueue({ agentRunId: first.id })
 check('queueing does not merge', (await git(repoPath, ['rev-parse', 'HEAD'])) === baseSha)
 await sweep

 const afterFirst = (await client.mergeQueue.list)[0]
 check('entry merged', afterFirst?.status === 'merged', afterFirst?.detail ?? '')
 check('unverified is reported as such', afterFirst?.verified === false)
 const firstSha = await git(repoPath, ['rev-parse', 'HEAD'])
 check('default branch fast-forwarded', firstSha === afterFirst?.mergedCommitSha)
 check('the work is there', (await git(repoPath, ['log', '-1', '--pretty=%s'])) === 'add one')
 check(
 'run disposition is merged',
 (await client.agentRun.get({ agentRunId: first.id })).branchDisposition === 'merged',
)

 console.log('\n— a sibling cloned from the same base, rebased onto the first —')
 // This one's clone predates the merge above, so it only merges cleanly because
 // the queue rebases at merge time rather than at enqueue time. That is the
 // property the whole queue exists for.
 await client.mergeQueue.enqueue({ agentRunId: sibling.id })
 await sweep
 check('sibling merged', (await client.mergeQueue.list)[1]?.status === 'merged')
 check(
 'rebased on top, not beside',
 (await git(repoPath, ['log', '--pretty=%s'])) === 'add two\nadd one\ninit',
 await git(repoPath, ['log', '--pretty=%s']).then((l) => l.replace(/\n/g, ' | ')),
)

 console.log('\n— a real conflict, handed back —')
 // Same base as `first`, same file, different content: a genuine divergence, not
 // a branch that merely arrives late.
 const shaBeforeConflict = await git(repoPath, ['rev-parse', 'HEAD'])
 await client.mergeQueue.enqueue({ agentRunId: rival.id })
 await sweep
 const conflicted = (await client.mergeQueue.list)[2]
 check('entry failed', conflicted?.status === 'failed')
 check('reason is conflict', conflicted?.failureReason === 'conflict', conflicted?.detail ?? '')
 check('names the conflicting file', (conflicted?.detail ?? '').includes('one.txt'))
 check('repository untouched', (await git(repoPath, ['rev-parse', 'HEAD'])) === shaBeforeConflict)
 check(
 'branch handed back to its run',
 (await client.agentRun.get({ agentRunId: rival.id })).branchDisposition === null,
)

 console.log('\n— verification runs, and a failing one blocks the merge —')
 await client.repository.setVerifyCommand({ repositoryId: repo.id, verifyCommand: 'test -f nope.txt' })
 const fourth = await commitIn(await startRun, 'three.txt', 'three\n', 'add three')
 const shaBeforeVerify = await git(repoPath, ['rev-parse', 'HEAD'])
 await client.mergeQueue.enqueue({ agentRunId: fourth.id })
 await sweep
 const verified = (await client.mergeQueue.list)[3]
 // With no sandbox and no acknowledgement, the Runner refuses to execute branch
 // code on the host at all — which is the sandbox spec boundary holding, not a bug.
 check(
 'refused or failed, never merged',
 verified?.status === 'failed',
 `${verified?.failureReason} ${verified?.detail?.slice(0, 90) ?? ''}`,
)
 check('repository untouched', (await git(repoPath, ['rev-parse', 'HEAD'])) === shaBeforeVerify)

 console.log('\n— a dirty target is refused, not clobbered —')
 await client.repository.setVerifyCommand({ repositoryId: repo.id, verifyCommand: null })
 await writeFile(join(repoPath, 'README.md'), '# fixture\n\nuncommitted human edit\n')
 const fifth = await commitIn(await startRun, 'four.txt', 'four\n', 'add four')
 await client.mergeQueue.enqueue({ agentRunId: fifth.id })
 await sweep
 const dirty = (await client.mergeQueue.list)[4]
 check('reason is dirty_target', dirty?.failureReason === 'dirty_target', dirty?.detail ?? '')
 check(
 'the human edit survives',
 (await git(repoPath, ['status', '--porcelain'])).includes('README.md'),
)

 console.log('\n— queue state —')
 for (const entry of await client.mergeQueue.list) {
 console.log(
 ` #${entry.position} ${entry.branchName} ${entry.status}` +
 `${entry.failureReason ? ` (${entry.failureReason})`: ''}`,
)
 }

 console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED': `${failures} CHECK(S) FAILED`}`)

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(failures === 0 ? 0: 1)
}

void main.catch((e) => {
 console.error('MERGE QUEUE CHECK FAILED', e)
 process.exit(1)
})
