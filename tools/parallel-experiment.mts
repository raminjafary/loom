/**
 * The riskiest assumption — the riskiest assumption, measured.
 *
 * > **That parallel swarm workers on one shared codebase produce mergeable,
 * > net-positive work.** Tree view, kanban, merge queue, cost dashboard, and the
 * > entire planner/worker narrative all depend on it.
 *
 * The riskiest assumption asks for "three clones, three workers, one real repo, one decomposed goal.
 * Measure human minutes to reconcile versus doing it serially." This is that,
 * with the part a script can measure actually measured.
 *
 * **What changed since the riskiest assumption was written**: the serialized merge queue exists, so
 * reconciliation is now instrumented rather than purely manual. The queue reports
 * per branch whether it merged clean, conflicted, or failed verification. The
 * stopwatch is only needed for the branches it hands back — and that count is the
 * headline number this prints.
 *
 * Run both arms. Parallel is the claim; serial is the control:
 *
 * docker compose up -d
 * set -a &&../.env && set +a
 * npx tsx tools/parallel-experiment.mts --mode parallel --repo /path/to/repo
 * npx tsx tools/parallel-experiment.mts --mode serial --repo /path/to/repo
 *
 * With no --repo it builds a small synthetic fixture, which is enough to exercise
 * the machinery but proves nothing about real code — the riskiest assumption says *one real repo*, and
 * it means it. Point this at something with genuine coupling between its parts, or
 * the conflict rate is measuring the fixture rather than the assumption.
 *
 * **This spends real tokens.** It is a hand-run driver, not a test: it asserts
 * nothing and prints what happened.
 *
 * Reading the result. The riskiest assumption already states the decision rule: "If reconciliation
 * costs more than it saves, the product is *one strong agent per task with
 * excellent intervention UX*" — still worth building, but a product in which most
 * of Phase 2 is dead weight. The numbers that decide it are wall-clock saved
 * versus branches-needing-hands, and cost is the tiebreak.
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
import { advanceMergeQueue, seedBuiltinPersonas } from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const arg = (name: string, fallback?: string): string | undefined => {
 const i = process.argv.indexOf(`--${name}`)
 return i === -1 ? fallback: (process.argv[i + 1] ?? fallback)
}

const MODE = (arg('mode', 'parallel') ?? 'parallel') as 'parallel' | 'serial'
const REPO_ARG = arg('repo')
const MODEL = arg('model', 'claude-sonnet-5') as string
const BUDGET = Number(arg('budget', '2'))
/** Let the reconciler agents attempt the conflicts before the run is scored. */
const RECONCILE = process.argv.includes('--reconcile')

/**
 * The decomposed goal. Deliberately three sibling tasks over the *same* area of a
 * codebase rather than three unrelated ones: the riskiest assumption is about workers on one shared
 * codebase, and handing each worker its own untouched corner would measure nothing.
 * Conflict is the thing under test, not the thing to design around.
 */
const DEFAULT_TASKS = [
 'Add a `docs/api.md` describing every exported function in this repository, one short section each. Also add a line to README.md linking to it.',
 'Add a `docs/architecture.md` describing how the source files relate to each other. Also add a line to README.md linking to it.',
 'Add a `docs/glossary.md` defining the domain terms used in this repository. Also add a line to README.md linking to it.',
]

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'experiment-secret-at-least-32-characters-long',
 SERVER_PORT: '0',
 // Serial is the control arm: one worker at a time, each cloning from the result
 // of the last. Parallel gets the whole fleet at once, which is the claim.
 MAX_CONCURRENT_RUNS_PER_WORKSPACE: MODE === 'serial' ? '1': String(DEFAULT_TASKS.length),
...(RECONCILE ? { LOOM_RECONCILER_ENABLED: '1' }: {}),
} as NodeJS.ProcessEnv)
// `reconcilerEnabled` reads process.env directly rather than config, because the
// merge sweep is not a request and has no config in scope.
if (RECONCILE) process.env.LOOM_RECONCILER_ENABLED = '1'

const git = (cwd: string, args: string[]) =>
 execFileAsync('git', ['-C', cwd,...args]).then((r) => r.stdout.trim)

const buildFixtureRepo = async : Promise<string> => {
 const path = await mkdtemp(join(tmpdir, 'experiment-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', path])
 await writeFile(join(path, 'README.md'), '# fixture\n\nA small library.\n')
 await writeFile(
 join(path, 'index.js'),
 [
 'export const add = (a, b) => a + b',
 'export const sub = (a, b) => a - b',
 'export const scale = (xs, k) => xs.map((x) => x * k)',
 '',
 ].join('\n'),
)
 await git(path, ['add', '-A'])
 await git(path, ['-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'init'])
 return path
}

const main = async => {
 const startedAt = Date.now
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `experiment-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'experiment-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))

 // seedWorkspace writes the row directly, bypassing the server's ensureWorkspace path
 // where built-ins are seeded — and `startReconciler` finds its persona by name.
 if (RECONCILE) await seedBuiltinPersonas(app.deps, { workspaceId: ws.id })

 const repoPath = REPO_ARG ?? (await buildFixtureRepo)
 const baseSha = await git(repoPath, ['rev-parse', 'HEAD'])
 console.log(`mode=${MODE} repo=${repoPath} base=${baseSha.slice(0, 8)} workers=${DEFAULT_TASKS.length}`)
 if (!REPO_ARG) {
 console.log('NOTE: synthetic fixture. The riskiest assumption asks for a real repo — this proves the machinery, not the assumption.')
 }

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'experiment-runner' })
 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: REPO_ARG ? join(repoPath, '..'): tmpdir,
 LOOM_SANDBOX_ENABLED: process.env.LOOM_SANDBOX_ENABLED ?? '0',
 /**
 * Without this the Runner refuses every unsandboxed run, and the refusal is not
 * loud: three runs "finish" in two seconds having spent $0.0000, and the merge
 * queue then merges three empty branches and reports **0 branches needing hands** —
 * a perfect the riskiest assumption result produced by nothing happening at all.
 *
 * That is why this driver had never been run successfully despite being listed as
 * ready three handoffs running. Withheld when the sandbox was actually asked for,
 * because supplying it unconditionally turns `LOOM_SANDBOX_ENABLED=1` into a silent
 * downgrade — the same rule the other drivers state.
 */
...(process.env.LOOM_SANDBOX_ENABLED === '1'
 ? {}
: {
 LOOM_ALLOW_UNSANDBOXED:
 process.env.LOOM_ALLOW_UNSANDBOXED ?? 'i-understand-the-agent-gets-my-privileges',
 }),
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `experiment-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => {
 if (process.env.EXPERIMENT_VERBOSE === '1') process.stdout.write(`[runner] ${d}`)
 })
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
 await new Promise((r) => setTimeout(r, 4000))

 const repo = await client.repository.bindExisting({
 runnerId,
 path: repoPath,
 displayName: 'experiment repo',
 })
 await client.repository.setVerifyCommand({
 repositoryId: repo.id,
 verifyCommand: arg('verify') ?? null,
 })

 const persona = await client.persona.create({
 markdownSource: [
 '---',
 'name: experiment-worker',
 'description: Does one scoped documentation task and stops.',
 `model: ${MODEL}`,
 'tools: [Read, Edit, Write, Grep, Glob]',
 'harness:',
 ` budgetCapUsd: ${BUDGET}`,
 ' autoApprove: true',
 '---',
 '',
 'You are a worker on a shared codebase. Do exactly the task you are given and',
 'nothing more. Make the smallest correct change. Do not reformat unrelated files.',
 ].join('\n'),
 })

 const channel = await client.channel.create({ name: 'experiment' })

 const awaitTerminal = async (runId: string) => {
 for (;;) {
 await new Promise((r) => setTimeout(r, 2000))
 const run = await client.agentRun.get({ agentRunId: runId })
 if (['completed', 'failed', 'cancelled'].includes(run.status)) return run
 }
 }

 const startTask = (task: string) =>
 client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: persona.id,
 task,
 })

 const workStartedAt = Date.now
 const runs: any[] = []

 if (MODE === 'parallel') {
 // All three clone from the same base, before any of them merges. This is the
 // shape the assumption is about, and the shape that produces conflicts.
 const started = await Promise.all(DEFAULT_TASKS.map(startTask))
 console.log(`started ${started.length} workers concurrently`)
 for (const run of await Promise.all(started.map((r: any) => awaitTerminal(r.id)))) runs.push(run)
 } else {
 // Control arm: each worker clones after the previous one has merged, so it sees
 // its predecessor's work and cannot conflict with it.
 for (const task of DEFAULT_TASKS) {
 const started = await startTask(task)
 const run = await awaitTerminal(started.id)
 runs.push(run)
 if (run.branchName) {
 await client.mergeQueue.enqueue({ agentRunId: run.id })
 await advanceMergeQueue(app.deps, { mergeStuckMs: 1_800_000 })
 }
 }
 }
 const workMs = Date.now - workStartedAt

 const mergeStartedAt = Date.now
 if (MODE === 'parallel') {
 for (const run of runs) {
 if (run.branchName) await client.mergeQueue.enqueue({ agentRunId: run.id })
 }
 // One sweep per entry: each advances the queue by one, and entry N+1 rebases
 // onto the result of entry N.
 for (let i = 0; i < runs.length; i += 1) {
 await advanceMergeQueue(app.deps, { mergeStuckMs: 1_800_000 })
 }
 }

 /**
 * With `--reconcile`, wait for the agents the roadmap puts in front of the queue and sweep
 * again. This is the only place the whole path runs against a
 * real model: a real conflict, a real paused rebase in a real clone, a real agent
 * editing the markers out, and the mechanical queue verifying the result.
 *
 * Reconciliation is asynchronous by design — the entry fails first so the queue keeps
 * moving — so the wait is on the reconcile children reaching a terminal state, not on
 * the sweep.
 */
 let reconciled = 0
 if (MODE === 'parallel' && RECONCILE) {
 const children: any[] = []
 for (const run of runs) {
 for (const child of await client.agentRun.listChildren({ agentRunId: run.id })) {
 if (child.relation === 'reconcile') children.push(child)
 }
 }
 console.log(`reconcilers started: ${children.length}`)
 for (const child of children) {
 const settled = await awaitTerminal(child.id)
 console.log(` reconciler ${child.id.slice(0, 8)} ${settled.status} $${(settled.totalCostUsd ?? 0).toFixed(4)}`)
 }
 // Give the reconcile_result frames time to land and re-queue before sweeping.
 await new Promise((r) => setTimeout(r, 3000))
 for (let i = 0; i < children.length + 1; i += 1) {
 await advanceMergeQueue(app.deps, { mergeStuckMs: 1_800_000 })
 }
 reconciled = children.length
 }
 const mergeMs = Date.now - mergeStartedAt

 const entries = await client.mergeQueue.list
 const merged = entries.filter((e: any) => e.status === 'merged')
 const conflicted = entries.filter((e: any) => e.failureReason === 'conflict')
 const verifyFailed = entries.filter((e: any) => e.failureReason === 'verification_failed')
 const otherFailed = entries.filter(
 (e: any) => e.status === 'failed' && !['conflict', 'verification_failed'].includes(e.failureReason),
)
 const cost = runs.reduce((sum: number, r: any) => sum + (r.totalCostUsd ?? 0), 0)
 const failedRuns = runs.filter((r: any) => r.status !== 'completed')

 /**
 * A result nobody paid for is not a result.
 *
 * Every worker failing produces a *clean* headline — three empty branches merge
 * without conflict and "branches needing hands" reads 0 — which is the most
 * dangerous possible output for a driver whose whole job is deciding whether half
 * the product is worth building. Said first, and loudly.
 */
 if (cost === 0) {
 console.log('\n' + '!'.repeat(64))
 console.log('NO WORK WAS DONE — every run cost $0.0000, so nothing below means anything.')
 for (const run of runs) {
 // The run's own reason, which is the thing that was missing: a driver that prints
 // "3 failed" and not *why* costs a full experiment to learn one line of text.
 console.log(` ${run.id.slice(0, 8)} ${run.status}: ${run.errorMessage ?? 'no reason recorded'}`)
 }
 console.log('!'.repeat(64))
 }

 console.log('\n' + '='.repeat(64))
 console.log(`the riskiest assumption RESULT — ${MODE}`)
 console.log('='.repeat(64))
 console.log(`workers ${runs.length}`)
 console.log(`runs that failed ${failedRuns.length}`)
 console.log(`agent wall-clock ${(workMs / 1000).toFixed(0)}s`)
 console.log(`merge wall-clock ${(mergeMs / 1000).toFixed(0)}s`)
 console.log(`total wall-clock ${((Date.now - startedAt) / 1000).toFixed(0)}s`)
 console.log(`metered cost $${cost.toFixed(4)}`)
 console.log('')
 console.log(`merged clean ${merged.length}`)
 console.log(` of those, verified ${merged.filter((e: any) => e.verified).length}`)
 console.log(`conflicted ${conflicted.length}`)
 console.log(`failed verification ${verifyFailed.length}`)
 console.log(`failed otherwise ${otherFailed.length}`)
 console.log('')
 if (RECONCILE) console.log(`reconcilers run ${reconciled}`)
 console.log('')
 /**
 * Counted per **run**, not per queue entry.
 *
 * A reconciled branch has two entries — the one that conflicted and the one that
 * merged after the agent fixed it — so counting failed entries reports a branch as
 * "needing hands" when no human touched it. That is the exact number the decision
 * rule turns on, and it was over-reporting by one on the first successful end-to-end
 * reconcile.
 */
 const mergedRunIds = new Set(merged.map((e: any) => e.agentRunId))
 const needingHands = runs.filter((run: any) => !mergedRunIds.has(run.id))
 console.log(`>> BRANCHES NEEDING HANDS: ${needingHands.length}`)
 console.log(' This is the number the riskiest assumption is about. The queue handled everything else')
 console.log(' without a human. Time these by hand — that is the part no script can.')
 for (const entry of entries) {
 console.log(
 ` ${entry.branchName} — ${entry.status}` +
 `${entry.failureReason ? ` (${entry.failureReason}: ${(entry.detail ?? '').split('\n')[0]})`: ''}`,
)
 }
 console.log('')
 console.log(`final history: ${(await git(repoPath, ['log', '--oneline'])).split('\n').length} commits`)
 console.log('Compare against the other arm. The riskiest assumption: if reconciliation costs more than it')
 console.log('saves, the product is one strong agent per task with excellent intervention UX.')

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(0)
}

void main.catch((e) => {
 console.error('EXPERIMENT FAILED', e)
 process.exit(1)
})
