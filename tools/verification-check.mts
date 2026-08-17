/**
 * Live driver for the verification harness: real server, real
 * Runner *process*, real WebSocket protocol, real git repository, and the checks
 * actually executing — in a container when the sandbox is on.
 *
 * docker compose up -d
 * LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/verification-check.mts
 * LOOM_USE_HOST_CLAUDE_AUTH=1 LOOM_SANDBOX_ENABLED=1 npx tsx tools/verification-check.mts
 *
 * Why this exists alongside the tests. `runner-gateway.integration.test.ts` drives the
 * real protocol with a fake Runner answering `verification_result` from a script, so
 * every one of its verdicts is one this repository wrote down for itself. Nothing has
 * ever watched a definition of done *run*: no test has started a process, mounted a
 * clone, or seen a check's exit code decide anything. Four of the last handoff's seven
 * findings came from driving the real thing after a green suite.
 *
 * The runs are real and cheap — a Haiku turn told to say one word — because what the
 * harness needs from a run is a finished one with a branch. The commits are written
 * into those clones by this script, standing in for what an agent would have left, the
 * same substitution `merge-queue-check.mts` makes and for the same reason: what is
 * under test is the queue and the container, not the model.
 *
 * Not a test: it asserts loudly but is run by hand, and it prints what happened.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { execFile, spawn } from 'node:child_process'
import { access, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildApp, devAuth } from '../apps/server/src/index.js'
import { loadConfig } from '../apps/server/src/config.js'
import { advanceVerificationQueue } from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const SANDBOXED = process.env.LOOM_SANDBOX_ENABLED === '1'

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'verify-check-secret-at-least-32-characters',
 SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
 execFileAsync('git', ['-C', cwd,...args]).then((r) => r.stdout.trim)

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
 console.log(`${ok ? ' ok ': ' FAIL '} ${label}${detail ? ` — ${detail}`: ''}`)
 if (!ok) failures += 1
}

const exists = async (path: string): Promise<boolean> => {
 try {
 await access(path)
 return true
 } catch {
 return false
 }
}

const PERSONA = (name: string) =>
 [
 '---',
 `name: ${name}`,
 'description: Finishes immediately; the branch is what matters.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read]',
 'harness:',
 // `auto`, and it is not a shortcut. On `ask` the run blocks on the first Read the
 // model decides to make, and one earlier pass of this driver stalled at
 // `awaiting_approval` for four minutes before reporting "never finished" — a
 // diagnosis that named the harness for something that was not the harness. What is
 // under test here is what happens *after* a run ends.
 ' approvalMode: auto',
 ' budgetCapUsd: 0.5',
 '---',
 '',
 'Reply with the single word ready and stop. Ask nothing, read nothing, write nothing.',
 ].join('\n')

const main = async => {
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `verify-check-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'verify-check-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const base = `http://127.0.0.1:${addr.port}`
 const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
 console.log('server on', base)
 console.log(SANDBOXED ? 'verification will run in a container': 'verification will run on the host')

 const repoPath = await mkdtemp(join(tmpdir, 'verify-check-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
 await writeFile(join(repoPath, 'README.md'), '# fixture\n')
 await git(repoPath, ['add', '.'])
 await git(repoPath, ['-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'init'])

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'verify-check-runner' })

 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 LOOM_SANDBOX_ENABLED: SANDBOXED ? '1': '0',
 // Withheld when the sandbox was asked for — supplying it unconditionally turns
 // LOOM_SANDBOX_ENABLED=1 into a silent downgrade and a clean pass about the path
 // that was not tested (see notes-check.mts).
...(SANDBOXED
 ? {}
: { LOOM_ALLOW_UNSANDBOXED: 'i-understand-the-agent-gets-my-privileges' }),
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `verify-check-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
 await new Promise((r) => setTimeout(r, 4000))

 const repo = await client.repository.bindExisting({
 runnerId,
 path: repoPath,
 displayName: 'verify check repo',
 })
 const persona = await client.persona.create({ markdownSource: PERSONA('verify-check-worker') })
 const channel = await client.channel.create({ name: 'verify-check' })

 /**
 * Starts a run and waits for its clone and a terminal status, answering anything it
 * asks along the way.
 *
 * The answering is not politeness. `ask_human` is offered to **every** run the
 * platform starts — mid-flight steering is explicit that asking is not a capability, so no tool list
 * and no approval mode can withhold it — and a Haiku turn given a bare fixture
 * repository will sometimes ask what it is for. Unanswered, the run sits in
 * `awaiting_approval` until the SLA sweep, and this driver reported "never finished"
 * about the harness for something that was not the harness. What is under test here
 * is what happens *after* a run ends, so the driver clears the question and moves on.
 */
 const finishRun = async : Promise<any> => {
 const run = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: persona.id,
 task: 'Reply with the single word ready. Nothing else is expected of you.',
 })
 let current = run
 for (let i = 0; i < 90; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 current = await client.agentRun.get({ agentRunId: run.id })
 if (['completed', 'failed', 'cancelled'].includes(current.status)) {
 if (!current.clonePath) throw new Error(`run ${run.id} never got a clone`)
 return current
 }
 if (current.status === 'awaiting_approval') {
 for (const pending of await client.approval.listPending({ agentRunId: run.id })) {
 await client.approval.decide({
 approvalRequestId: pending.id,
 decision: 'approve',
 // Every gate this driver can meet is a question, and the server treats an
 // approved question with no answer as a denial — deliberately, since a model
 // reads silence as assent.
 answer: 'Nothing else is expected of you. Reply with the single word ready.',
 })
 }
 }
 }
 // Names the state it was stuck in. A bare "never finished" sent one pass of this
 // driver looking at the harness for a run sitting on an unanswered question.
 throw new Error(`run ${run.id} never finished — last status ${current.status}`)
 }

 /** Writes the commit an agent would have left in the run's clone. */
 const commitIn = async (run: any, files: Record<string, string>, message: string) => {
 for (const [file, body] of Object.entries(files)) {
 await writeFile(join(run.clonePath, file), body)
 }
 await git(run.clonePath, ['add', '-A'])
 await git(run.clonePath, [
 '-c', 'user.email=agent@loom.invalid', '-c', 'user.name=agent', 'commit', '-qm', message,
 ])
 return run
 }

 const sweep = => advanceVerificationQueue(app.deps, { verificationStuckMs: 1_800_000 })

 const verificationOf = async (runId: string) =>
 (await client.agentRun.listVerifications({ agentRunIds: [runId] }))[0]

 const setChecks = (checks: { name: string; command: string }[]) =>
 client.repository.setVerificationChecks({ repositoryId: repo.id, checks })

 console.log('\n— nothing is verified before a definition of done exists —')
 const unconfigured = await finishRun
 check(
 'a repository with no checks records nothing at all',
 (await verificationOf(unconfigured.id)) === undefined,
)

 console.log('\n— every check runs, in order, and passes —')
 await setChecks([
 { name: 'build', command: 'test -f built.txt' },
 { name: 'tests', command: 'test -f tested.txt' },
 // The silent-downgrade tell for this driver. `/work` is the container's mount point
 // and does not exist on the host, so a run started with LOOM_SANDBOX_ENABLED=1 that
 // quietly executed on the host fails here instead of passing about nothing.
 { name: 'where', command: SANDBOXED ? 'test -d /work': 'test ! -d /work' },
 ])
 const passing = await commitIn(
 await finishRun,
 { 'built.txt': 'built\n', 'tested.txt': 'tested\n' },
 'add both',
)
 check('queued by the run finishing, not run yet', (await verificationOf(passing.id))?.status === 'pending')
 await sweep
 const passed = await verificationOf(passing.id)
 check('verdict is passed', passed?.status === 'passed', passed?.reason ?? '')
 check(
 'every check ran, in the operator\'s order',
 JSON.stringify(passed?.checks.map((c: any) => [c.name, c.status])) ===
 JSON.stringify([['build', 'passed'], ['tests', 'passed'], ['where', 'passed']]),
 JSON.stringify(passed?.checks.map((c: any) => [c.name, c.status])),
)
 check(
 'the commit it verified is the branch head',
 passed?.commitSha === (await git(passing.clonePath, ['rev-parse', 'HEAD'])),
)

 console.log('\n— the first failure stops the list, and stopping is not cosmetic —')
 await setChecks([
 { name: 'build', command: 'echo "error TS2345: not built" >&2; exit 1' },
 // Writes into the mounted clone. If this ever runs, the file is on disk afterwards —
 // which is the difference between a list that short-circuits and one that merely
 // reports the later results as unread.
 { name: 'tests', command: 'echo ran > after-the-failure.txt' },
 ])
 const failing = await commitIn(await finishRun, { 'src.txt': 'x\n' }, 'add src')
 await sweep
 const failed = await verificationOf(failing.id)
 check('verdict is failed', failed?.status === 'failed', failed?.reason ?? '')
 check('the failing check is named', failed?.checks[0]?.name === 'build')
 check(
 'the failing check\'s own output is kept',
 (failed?.checks[0]?.detail ?? '').includes('error TS2345'),
 (failed?.checks[0]?.detail ?? '').slice(0, 80),
)
 check('the check after it is not_run', failed?.checks[1]?.status === 'not_run')
 check(
 'and really did not run',
 !(await exists(join(failing.clonePath, 'after-the-failure.txt'))),
)

 console.log('\n— a branch with nothing on it is skipped, never passed —')
 await setChecks([{ name: 'tests', command: 'true' }])
 const empty = await finishRun
 await sweep
 const skipped = await verificationOf(empty.id)
 check('verdict is skipped', skipped?.status === 'skipped', skipped?.reason ?? '')
 check('and says why', (skipped?.reason ?? '').includes('committed nothing'))

 console.log('\n— one verification per repository at a time —')
 const a = await commitIn(await finishRun, { 'a.txt': 'a\n' }, 'add a')
 const b = await commitIn(await finishRun, { 'b.txt': 'b\n' }, 'add b')
 await sweep
 const afterOne = [await verificationOf(a.id), await verificationOf(b.id)]
 check(
 'one sweep verifies one branch',
 afterOne.filter((record) => record?.status === 'passed').length === 1,
 afterOne.map((record) => record?.status).join(' / '),
)
 await sweep
 check(
 'the next sweep verifies the other',
 (await verificationOf(a.id))?.status === 'passed' &&
 (await verificationOf(b.id))?.status === 'passed',
)

 console.log('\n— one definition of done, and the old command cannot outrank it —')
 await client.repository
.setVerifyCommand({ repositoryId: repo.id, verifyCommand: 'true' })
.then(
 => check('setting a verify command under a check list is refused', false, 'it was accepted'),
 (error: unknown) =>
 check(
 'setting a verify command under a check list is refused',
 String(error).includes('definition of done'),
 String(error).slice(0, 90),
),
)

 console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED': `${failures} CHECK(S) FAILED`}`)

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(failures === 0 ? 0: 1)
}

void main.catch((e) => {
 console.error('VERIFICATION CHECK FAILED', e)
 process.exit(1)
})
