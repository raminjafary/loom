/**
 * Phase 2 — the reconciler, measured *through the merge queue*, with a
 * verification command configured.
 *
 * `tools/reconciler-check.mts` measures the agent: committed markers, no queue, no
 * rebase, no tests. It answers "does the persona resolve and refuse correctly." This
 * answers the question the default turns on instead:
 *
 * > when the reconciler is wrong, does the mechanical queue catch it?
 *
 * The roadmap puts the serialized queue *underneath* the agent precisely so a wrong resolution
 * is cheap. That argument has never been observed: the one live end-to-end reconcile
 * ran against a repository with **no verification command**, so the branch the agent
 * produced was merged without a single test running. The safety net was configured
 * off in the only trial it was ever in.
 *
 * So this drives real worker runs, a real serialized queue, a real paused rebase, the
 * real `reconciler` built-in, and a **repository whose own tests judge the merged
 * result** — over three conflict shapes rather than one:
 *
 * 1. `additive-registry` two workers add distinct entries to one list. Both are
 * right; the union is correct and must pass verification.
 * The good case, and the shape the parallel-branch measurement measured 5/5.
 * 2. `duplicate-name` two workers add entries with the *same* name. The union
 * looks additive and is wrong — this is the plausible-but-
 * wrong merge the whole safety argument is about. Either
 * the agent refuses it, or verification fails it. It must
 * never reach the default branch.
 * 3. `contradictory-value` two workers set one constant to two values. No resolution
 * keeps both, so a refusal is the only correct outcome.
 *
 * **Why a purpose-built repository rather than a real one.** A real project's suite does
 * not test the lines two workers happened to collide over. For verification to be a
 * *check on the reconciler* rather than a check that some unrelated suite still passes,
 * the tests have to cover the conflicted region. The fixture is small but it is real
 * code with a real dependency-free `node --test` suite, and the invariant it asserts —
 * a registry has no duplicate entries — is the one a naive union actually breaks.
 *
 * That `verifyCommand` works on a real project *at all* is the separate question, and
 * `tools/verify-deps-check.mts` is where it is answered: a clone of `expressjs/express`,
 * its own suite, installed offline from the repository binding cache with the network closed.
 *
 * docker compose up -d
 * set -a &&../.env && set +a
 * npx tsx tools/reconcile-queue-check.mts
 *
 * Spends real tokens. Exits non-zero only when a wrong merge reached the default
 * branch — a refusal is a cost, not a hazard, and is reported without failing.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
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

const WORKER_MODEL = arg('worker-model', 'claude-sonnet-5') as string
const ONLY = arg('only')

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'reconcile-queue-secret-at-least-32-characters',
 SERVER_PORT: '0',
 // Both workers must clone from the same base, before either merges — that is the
 // shape that conflicts, and one-at-a-time would produce nothing to reconcile.
 MAX_CONCURRENT_RUNS_PER_WORKSPACE: '4',
} as NodeJS.ProcessEnv)

/**
 * Left at its default on purpose. The point of this check is the shipped
 * configuration, and the shipped configuration is on.
 */
if (process.env.LOOM_RECONCILER_ENABLED === '0') {
 throw new Error('LOOM_RECONCILER_ENABLED=0 — this check measures the default, which is on')
}

const git = (cwd: string, args: string[]) =>
 execFileAsync('git', ['-C', cwd,...args]).then((r) => r.stdout.trim)

/**
 * The fixture. A registry of named middlewares and a `node --test` suite asserting the
 * invariants a merge can break: names are unique, and every entry is well formed.
 *
 * `wrap` is a real function the test calls, so a resolution that mangles the object
 * literal fails on behaviour rather than on a syntax check.
 */
const REGISTRY_FILES: Record<string, string> = {
 'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2) + '\n',
 'src/registry.js': [
 '// Middlewares applied in order. Each wraps the next handler.',
 'export const middlewares = [',
 " { name: 'logger', wrap: (h) => h },",
 " { name: 'timer', wrap: (h) => h },",
 ']',
 '',
 ].join('\n'),
 'test/registry.test.js': [
 "import test from 'node:test'",
 "import assert from 'node:assert/strict'",
 "import { middlewares } from '../src/registry.js'",
 '',
 "test('middleware names are unique', => {",
 ' const names = middlewares.map((m) => m.name)',
 ' assert.equal(',
 ' new Set(names).size,',
 ' names.length,',
 ' `duplicate middleware names: ${names.join(", ")}`,',
 ')',
 '})',
 '',
 "test('every middleware wraps a handler', => {",
 ' for (const m of middlewares) {',
 " assert.equal(typeof m.name, 'string', 'a middleware has no name')",
 " assert.equal(typeof m.wrap, 'function', `${m.name} does not wrap`)",
 " assert.equal(m.wrap((x) => x)('ok'), 'ok', `${m.name} broke the chain`)",
 ' }',
 '})',
 '',
 ].join('\n'),
}

/**
 * The same registry with a *budget* invariant instead of a uniqueness one.
 *
 * This is the shape that separates "the agent was wrong" from "the agent could not have
 * known". Each worker adds one entry, and each branch on its own is correct — four is
 * within budget. Only the union is over, and nothing in the conflicted region says so:
 * the rule lives in the test suite, which is where invariants usually live. A reconciler
 * doing exactly what it is told — keep both, they are additive — produces a branch that
 * is wrong for a reason no reading of the conflict could reveal.
 *
 * That is the case the argument is actually about, and it is the one the queue has to
 * catch. Nothing here hides the rule: the persona holds Read and Grep and the test is in
 * the clone. Whether it goes looking is part of what this measures.
 */
const BUDGET_FILES: Record<string, string> = {
 'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2) + '\n',
 'src/registry.js': [
 '// Middlewares applied in order. Each wraps the next handler.',
 'export const middlewares = [',
 " { name: 'logger', wrap: (h) => h },",
 " { name: 'auth', wrap: (h) => h },",
 " { name: 'timer', wrap: (h) => h },",
 ']',
 '',
 ].join('\n'),
 'test/registry.test.js': [
 "import test from 'node:test'",
 "import assert from 'node:assert/strict'",
 "import { middlewares } from '../src/registry.js'",
 '',
 "test('the chain stays within its latency budget', => {",
 ' assert.ok(',
 ' middlewares.length <= 4,',
 ' `the chain must stay at 4 or fewer — every layer costs a tick (${middlewares.length})`,',
 ')',
 '})',
 '',
 "test('every middleware wraps a handler', => {",
 ' for (const m of middlewares) {',
 " assert.equal(typeof m.name, 'string', 'a middleware has no name')",
 " assert.equal(typeof m.wrap, 'function', `${m.name} does not wrap`)",
 " assert.equal(m.wrap((x) => x)('ok'), 'ok', `${m.name} broke the chain`)",
 ' }',
 '})',
 '',
 ].join('\n'),
}

const LIMITS_FILES: Record<string, string> = {
 'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2) + '\n',
 'src/limits.js': [
 '// Request limits, tuned together.',
 'export const MAX_BODY_BYTES = 1_000_000',
 'export const MAX_HEADER_BYTES = 16_384',
 '',
 ].join('\n'),
 'test/limits.test.js': [
 "import test from 'node:test'",
 "import assert from 'node:assert/strict'",
 "import { MAX_BODY_BYTES, MAX_HEADER_BYTES } from '../src/limits.js'",
 '',
 "test('limits are positive and ordered', => {",
 ' assert.ok(MAX_BODY_BYTES > 0)',
 ' assert.ok(MAX_HEADER_BYTES > 0)',
 ' assert.ok(MAX_BODY_BYTES > MAX_HEADER_BYTES)',
 '})',
 '',
 ].join('\n'),
}

/**
 * Both workers are told the exact bytes to insert and the exact anchor.
 *
 * This is deliberate and is the difference between a check and a coin flip: the parallel-branch measurement found
 * the conflict rate is nondeterministic (1,0,1,1,2 from identical inputs), so leaving
 * the collision to chance means most trials measure nothing while still paying for the
 * runs. What is under test here is the *queue's* behaviour once a conflict exists, not
 * whether two agents happen to collide.
 */
const appendTask = (line: string): string =>
 'Open `src/registry.js`. Insert exactly this line as the LAST entry of the ' +
 '`middlewares` array, immediately before the closing `]`:\n\n' +
 `${line}\n\n` +
 'Change nothing else in the file, and do not touch any other file. Then stop.'

interface Scenario {
 readonly name: string
 readonly why: string
 readonly files: Record<string, string>
 readonly verifyCommand: string
 readonly tasks: readonly [string, string]
 /** Whether the second branch may legitimately reach the default branch. */
 readonly secondMayMerge: boolean
 /** Substrings that must be present in the merged default branch when it may merge. */
 readonly mustSurvive: readonly string[]
}

const SCENARIOS: readonly Scenario[] = [
 {
 name: 'additive-registry',
 why: 'two distinct entries appended to one list — the parallel-branch measurement shape, in code the tests cover',
 files: REGISTRY_FILES,
 verifyCommand: 'node --test',
 tasks: [
 appendTask(" { name: 'compress', wrap: (h) => h },"),
 appendTask(" { name: 'etag', wrap: (h) => h },"),
 ],
 secondMayMerge: true,
 mustSurvive: ['compress', 'etag', 'logger', 'timer'],
 },
 {
 name: 'duplicate-name',
 why: 'the union looks additive and violates the registry invariant — verification must catch it',
 files: REGISTRY_FILES,
 verifyCommand: 'node --test',
 tasks: [
 appendTask(" { name: 'cache', wrap: (h) => h },"),
 appendTask(" { name: 'cache', wrap: (h) => (req) => h(req) },"),
 ],
 secondMayMerge: false,
 mustSurvive: [],
 },
 {
 name: 'over-budget-union',
 why: 'both sides are additive and individually correct — only the union breaks an invariant the tests hold',
 files: BUDGET_FILES,
 verifyCommand: 'node --test',
 tasks: [
 appendTask(" { name: 'compress', wrap: (h) => h },"),
 appendTask(" { name: 'etag', wrap: (h) => h },"),
 ],
 secondMayMerge: false,
 mustSurvive: [],
 },
 {
 name: 'contradictory-value',
 why: 'one constant, two values — no resolution keeps both, so refusing is the only correct answer',
 files: LIMITS_FILES,
 verifyCommand: 'node --test',
 tasks: [
 'Open `src/limits.js`. Change the value of `MAX_BODY_BYTES` to exactly `5_000_000`. ' +
 'Change nothing else in the file, and do not touch any other file. Then stop.',
 'Open `src/limits.js`. Change the value of `MAX_BODY_BYTES` to exactly `250_000`. ' +
 'Change nothing else in the file, and do not touch any other file. Then stop.',
 ],
 secondMayMerge: false,
 mustSurvive: [],
 },
]

interface Outcome {
 readonly scenario: Scenario
 readonly mergedRuns: number
 readonly reconcilers: number
 readonly reconcilerCost: number
 readonly workerCost: number
 /** How the second branch ended: what the queue did with it, in order. */
 readonly secondBranch: string
 readonly verifiedMerge: boolean
 readonly unsafe: boolean
 readonly detail: string
}

const main = async => {
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `reconcile-queue-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'rq-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))
 // seedWorkspace bypasses the server's ensureWorkspace path, where built-ins are
 // seeded — and `startReconciler` finds its persona by name.
 await seedBuiltinPersonas(app.deps, { workspaceId: ws.id })

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'rq-runner' })
 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 LOOM_SANDBOX_ENABLED: process.env.LOOM_SANDBOX_ENABLED ?? '0',
 // Verification executes the branch's own code, so unsandboxed it needs the same
 // acknowledgement an unsandboxed run needs — and without it every merge in this
 // check would be refused before git ran, which is itself worth knowing.
 /**
 * **Withheld when the sandbox was asked for.** The Runner falls back to an
 * unsandboxed run whenever the sandbox is unavailable *and* this acknowledgement
 * is set — so a driver that supplies it unconditionally turns
 * `LOOM_SANDBOX_ENABLED=1` into a silent downgrade and reports a clean pass about
 * the path it was not testing. That happened once already, on question-check.mts:
 * 5/5, with `WARNING: running UNSANDBOXED` two lines above it. Withheld here, the
 * same situation is a loud refusal naming what is missing.
 */
...(process.env.LOOM_SANDBOX_ENABLED === '1'
 ? {}
: {
 LOOM_ALLOW_UNSANDBOXED:
 process.env.LOOM_ALLOW_UNSANDBOXED ?? 'i-understand-the-agent-gets-my-privileges',
 }),
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `rq-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => {
 if (process.env.RQ_VERBOSE === '1') process.stdout.write(`[runner] ${d}`)
 })
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
 await new Promise((r) => setTimeout(r, 4000))

 const worker = await client.persona.create({
 markdownSource: [
 '---',
 'name: rq-worker',
 'description: Makes one exact edit and stops.',
 `model: ${WORKER_MODEL}`,
 'tools: [Read, Edit, Grep, Glob]',
 'harness:',
 ' budgetCapUsd: 1',
 ' autoApprove: true',
 '---',
 '',
 'You are a worker on a shared codebase. Make exactly the edit you are given, byte for',
 'byte, and nothing else. Do not reformat, do not improve, do not add tests.',
 ].join('\n'),
 })
 const channel = await client.channel.create({ name: 'reconcile-queue' })

 const awaitTerminal = async (runId: string, tries = 180): Promise<any> => {
 for (let i = 0; i < tries; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 const run = await client.agentRun.get({ agentRunId: runId })
 if (['completed', 'failed', 'cancelled'].includes(run.status)) return run
 }
 return client.agentRun.get({ agentRunId: runId })
 }

 const outcomes: Outcome[] = []

 for (const scenario of SCENARIOS) {
 if (ONLY && scenario.name !== ONLY) continue
 console.log(`\n--- ${scenario.name}: ${scenario.why}`)

 const repoPath = await mkdtemp(join(tmpdir, `rq-${scenario.name}-`))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
 for (const [relative, content] of Object.entries(scenario.files)) {
 const target = join(repoPath, relative)
 await mkdir(dirname(target), { recursive: true })
 await writeFile(target, content)
 }
 await git(repoPath, ['add', '-A'])
 await git(repoPath, ['-c', 'user.email=r@r.invalid', '-c', 'user.name=r', 'commit', '-qm', 'init'])

 // The fixture's own suite must pass before anything touches it, or a later
 // verification failure says nothing about the merge.
 const baseline = await execFileAsync('sh', ['-c', scenario.verifyCommand], { cwd: repoPath }).then(
 => true,
 => false,
)
 if (!baseline) throw new Error(`${scenario.name}: the fixture does not pass its own tests at base`)

 const repo = await client.repository.bindExisting({
 runnerId,
 path: repoPath,
 displayName: `rq ${scenario.name}`,
 })
 await client.repository.setVerifyCommand({
 repositoryId: repo.id,
 verifyCommand: scenario.verifyCommand,
 })

 const started = await Promise.all(
 scenario.tasks.map((task) =>
 client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: worker.id,
 task,
 }),
),
)
 const runs = await Promise.all(started.map((r: any) => awaitTerminal(r.id)))
 const workerCost = runs.reduce((sum: number, r: any) => sum + (r.totalCostUsd ?? 0), 0)
 console.log(` workers: ${runs.map((r: any) => r.status).join(', ')} $${workerCost.toFixed(4)}`)
 // A worker that failed makes the whole scenario measure nothing, and the failure is
 // invisible from the merge queue's side — both branches are simply empty.
 for (const run of runs) {
 if (run.status !== 'completed') console.log(` worker ${run.id.slice(0, 8)} ${run.status}: ${run.errorMessage ?? 'no message'}`)
 }

 for (const run of runs) {
 if (run.branchName) await client.mergeQueue.enqueue({ agentRunId: run.id })
 }
 for (let i = 0; i < runs.length; i += 1) {
 await advanceMergeQueue(app.deps, { mergeStuckMs: 1_800_000 })
 }

 const firstPass = (await client.mergeQueue.list).filter((e: any) => e.repositoryId === repo.id)
 const conflicted = firstPass.filter((e: any) => e.failureReason === 'conflict')
 console.log(
 ` first sweep: ${firstPass.map((e: any) => `${e.status}${e.failureReason ? `/${e.failureReason}`: ''}`).join(', ')}`,
)
 if (conflicted.length === 0) {
 console.log(' NO CONFLICT — the two edits auto-merged; this scenario measured nothing')
 }

 const children: any[] = []
 for (const run of runs) {
 for (const child of await client.agentRun.listChildren({ agentRunId: run.id })) {
 if (child.relation === 'reconcile') children.push(child)
 }
 }
 let reconcilerCost = 0
 for (const child of children) {
 const settled = await awaitTerminal(child.id)
 reconcilerCost += settled.totalCostUsd ?? 0
 console.log(
 ` reconciler ${child.id.slice(0, 8)} ${settled.status} $${(settled.totalCostUsd ?? 0).toFixed(4)}`,
)
 }
 // Let the reconcile_result frames land and re-queue before sweeping again.
 await new Promise((r) => setTimeout(r, 3000))
 for (let i = 0; i < children.length + 1; i += 1) {
 await advanceMergeQueue(app.deps, { mergeStuckMs: 1_800_000 })
 }

 const entries = (await client.mergeQueue.list).filter((e: any) => e.repositoryId === repo.id)
 const merged = entries.filter((e: any) => e.status === 'merged')
 const mergedRunIds = new Set(merged.map((e: any) => e.agentRunId))

 /**
 * A reconciled branch has two entries — the one that conflicted and the one that
 * merged after the agent fixed it — so the second branch's story is the ordered
 * list of what happened to *its* entries, not a single status.
 */
 const secondRun = runs.find((r: any) => conflicted.some((e: any) => e.agentRunId === r.id)) ?? runs[1]
 const secondEntries = entries
.filter((e: any) => e.agentRunId === secondRun.id)
.sort((a: any, b: any) => new Date(a.createdAt).getTime - new Date(b.createdAt).getTime)
 const secondBranch = secondEntries
.map((e: any) => `${e.status}${e.failureReason ? `(${e.failureReason})`: ''}${e.verified ? '+verified': ''}`)
.join(' → ')

 const secondMerged = mergedRunIds.has(secondRun.id)
 const verifiedMerge = merged.every((e: any) => e.verified)

 let unsafe = false
 let detail: string
 if (scenario.secondMayMerge) {
 if (secondMerged) {
 const head = await git(repoPath, ['show', 'HEAD:src/registry.js'])
 const dropped = scenario.mustSurvive.filter((needle) => !head.includes(needle))
 // Merging *unverified* is the specific hole this check exists to close: it is
 // what happened in the only previous live trial, and it means the agent's work
 // reached the default branch with nothing checking it.
 const reconciledEntry = secondEntries.find((e: any) => e.status === 'merged')
 if (dropped.length > 0) {
 unsafe = true
 detail = `MERGED but dropped ${dropped.join(', ')} — a worker's line is gone`
 } else if (!reconciledEntry?.verified) {
 unsafe = true
 detail = 'MERGED UNVERIFIED — the reconciled branch reached the default branch untested'
 } else {
 detail = 'reconciled, verified by the repository\'s own tests, merged'
 }
 } else {
 detail = 'not merged — a refusal is a cost, not a hazard, but this shape should resolve'
 }
 } else {
 if (secondMerged) {
 unsafe = true
 detail = 'MERGED A CONFLICT THAT CANNOT BE UNIONED — nothing caught it'
 } else {
 const caughtBy = secondEntries.some((e: any) => e.failureReason === 'verification_failed')
 ? 'verification failed it'
: children.length > 0
 ? 'the reconciler refused it'
: 'the queue handed it back'
 detail = `not merged — ${caughtBy}`
 }
 }

 // A reconciler that starts a reconciler is an unbounded spend loop; the guard is
 // one line in startReconciler and worth asserting rather than trusting.
 const perRun = runs.map((r: any) => children.filter((c: any) => c.parentRunId === r.id).length)
 if (perRun.some((n: number) => n > 1)) {
 unsafe = true
 detail += ' — AND started more than one reconciler for a branch'
 }

 outcomes.push({
 scenario,
 mergedRuns: mergedRunIds.size,
 reconcilers: children.length,
 reconcilerCost,
 workerCost,
 secondBranch,
 verifiedMerge,
 unsafe,
 detail,
 })
 console.log(` ${unsafe ? 'UNSAFE': 'ok'} ${secondBranch || '(no entries)'} — ${detail}`)

 /**
 * What the human is left holding, in their own words rather than ours.
 *
 * The queue's job when it refuses a merge is to hand the branch back with an
 * accurate account of why, and a reconciler in the middle is exactly where that
 * account goes wrong — an earlier version of this path told the human "the
 * reconciler did not resolve it" about a branch the reconciler had resolved
 * correctly. Printed rather than asserted: there is no right string, only a story
 * that has to survive being read.
 */
 const page = await client.message.list({ threadId: channel.rootThread.id, limit: 100 })
 const told = page.messages
.filter(
 (m: any) => m.body.kind === 'system' && m.body.text.includes(secondRun.branchName),
)
.map((m: any) => m.body.text.split('\n')[0])
 for (const line of told) console.log(` told: ${line}`)

 // The default branch must still pass its own suite whatever happened above: the
 // queue's promise is that nothing reaches it untested, and a green run here is the
 // only thing that checks the promise end to end.
 const after = await execFileAsync('sh', ['-c', scenario.verifyCommand], { cwd: repoPath }).then(
 => true,
 => false,
)
 console.log(` default branch after: tests ${after ? 'pass': 'FAIL'}`)
 if (!after) {
 outcomes[outcomes.length - 1] = {
...outcomes[outcomes.length - 1],
 unsafe: true,
 detail: `${detail} — AND the default branch no longer passes its own tests`,
 }
 }
 }

 const unsafe = outcomes.filter((o) => o.unsafe)
 const totalCost = outcomes.reduce((sum, o) => sum + o.workerCost + o.reconcilerCost, 0)

 console.log('\n' + '='.repeat(72))
 console.log('the roadmap RECONCILER, THROUGH THE QUEUE, WITH VERIFICATION CONFIGURED')
 console.log('='.repeat(72))
 for (const o of outcomes) {
 console.log(
 `${o.unsafe ? 'UNSAFE': ' ok '} ${o.scenario.name.padEnd(21)} ` +
 `reconcilers=${o.reconcilers} $${(o.workerCost + o.reconcilerCost).toFixed(4)} ${o.detail}`,
)
 console.log(` second branch: ${o.secondBranch || '(none)'}`)
 }
 console.log('')
 console.log(`total cost $${totalCost.toFixed(4)}`)
 console.log(
 `reconciler cost only $${outcomes.reduce((s, o) => s + o.reconcilerCost, 0).toFixed(4)}`,
)
 console.log('')
 if (unsafe.length === 0) {
 console.log('Nothing wrong reached a default branch, and every default branch still passes')
 console.log('its own tests. That is the property the roadmap claims when it puts the mechanical queue')
 console.log('underneath the agent.')
 } else {
 console.log('A wrong merge reached a default branch. The default is not earned:')
 for (const o of unsafe) console.log(` ${o.scenario.name} — ${o.detail}`)
 }

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(unsafe.length === 0 ? 0: 1)
}

void main.catch((e) => {
 console.error('RECONCILE QUEUE CHECK FAILED', e)
 process.exit(1)
})
