/**
 * Live driver for the re-planning turn — a real Planner re-entered with a human's
 * message, emitting a real delta.
 *
 * docker compose up -d
 * LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/steer-check.mts
 *
 * The server round trip has integration tests that inject a `plan_delta_submitted`
 * frame. Those prove the boundary, the cancellation and the child start, and — exactly
 * as with `submit_plan`, `write_note` and `ask_human` before them — say nothing about
 * whether the model was ever *offered* the tool. `AgentDefinition.tools` is an
 * exhaustive allowlist, so an in-process MCP tool missing from it is silently
 * unreachable and the run completes having submitted nothing. That has shipped twice
 * in this repository; this is what catches the third time.
 *
 * What only a live run can show:
 *
 * 1. A re-planning turn is offered `submit_plan_delta` and calls it.
 * 2. It is offered it *instead of* `submit_plan` — the substitution is the design, and
 * a turn that could still decompose would answer a steering message with a second
 * fan-out beside the work already running.
 * 3. The delta is a delta: it names an existing subtask by the run id from its brief,
 * which only a model that actually read the brief can do.
 * 4. The platform applies it — the named subtask really stops.
 *
 * The message asks for a cancellation rather than an addition on purpose: cancelling
 * is the op with a checkable consequence in the database, so a pass cannot be an
 * agreeable-sounding delta that did nothing.
 *
 * Not a test: it spends real tokens. Haiku and low caps keep it to cents.
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

try {
 process.loadEnvFile(join(REPO_ROOT, '.env'))
} catch {
 // No.env is fine unsandboxed; sandboxed, the refusal below will say what is missing.
}

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'steer-secret-at-least-32-characters-long-value',
 SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const sandboxed = process.env.LOOM_SANDBOX_ENABLED === '1'

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
 results.push({ ok, what })
 console.log(`${ok ? 'PASS': 'FAIL'} ${what}`)
}

const PLANNER = [
 '---',
 'name: steer-planner',
 'description: Splits a goal into subtasks and delegates them.',
 'model: claude-haiku-4-5-20251001',
 'tools: []',
 'harness:',
 ' planner: true',
 ' delegates: [Read, Grep, Glob]',
 // The worker auto-approves so nothing stalls at a gate with no human present, and
 // The data model refuses a child that auto-approves under a parent that does not — so the
 // planner must too. Harmless on a `tools: []` persona, which can reach no risky
 // tool of its own; here it is purely the permission being handed down.
 ' autoApprove: true',
 ' budgetCapUsd: 0.6',
 '---',
 '',
 'You are an orchestrator. Split the goal into small subtasks and submit one plan.',
].join('\n')

const WORKER = [
 '---',
 'name: steer-worker',
 'description: Does one subtask.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read, Grep, Glob]',
 'harness:',
 ' autoApprove: true',
 ' budgetCapUsd: 0.4',
 '---',
 '',
 'You are a Software Engineer. Do exactly the subtask you are given, then stop.',
].join('\n')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const main = async => {
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `steer-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'steer-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))
 console.log('server on', `http://127.0.0.1:${addr.port}`, sandboxed ? '(sandboxed)': '(unsandboxed)')

 const repoPath = await mkdtemp(join(tmpdir, 'steer-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
 await writeFile(join(repoPath, 'README.md'), '# steer fixture\n')
 await writeFile(join(repoPath, 'parser.js'), 'export const parse = (s) => JSON.parse(s)\n')
 await writeFile(join(repoPath, 'render.js'), 'export const render = (v) => String(v)\n')
 await execFileAsync('git', ['-C', repoPath, 'add', '.'])
 await execFileAsync('git', [
 '-C', repoPath, '-c', 'user.email=s@example.test', '-c', 'user.name=s',
 'commit', '-qm', 'init',
 ])

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'steer-runner' })
 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 LOOM_SANDBOX_ENABLED: sandboxed ? '1': '0',
 /**
 * **Not supplied when the sandbox was asked for** — see question-check.mts. A
 * driver that passes this unconditionally turns `LOOM_SANDBOX_ENABLED=1` into a
 * silent downgrade and reports a clean pass about the path it was not testing.
 */
...(sandboxed
 ? {}
: {
 LOOM_ALLOW_UNSANDBOXED:
 process.env.LOOM_ALLOW_UNSANDBOXED ?? 'i-understand-the-agent-gets-my-privileges',
 }),
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `steer-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
 await sleep(4000)

 const repo = await client.repository.bindExisting({
 runnerId, path: repoPath, displayName: 'steer repo',
 })
 const channel = await client.channel.create({ name: 'steer' })
 await client.persona.create({ markdownSource: WORKER })
 const planner = await client.persona.create({ markdownSource: PLANNER })

 const plan = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: planner.id,
 task:
 'This repository has two files, parser.js and render.js. Produce a plan with ' +
 'exactly two subtasks for the steer-worker persona: one that reviews parser.js ' +
 'and one that reviews render.js. Each subtask should say which file it covers.',
 })
 console.log('planner run', plan.id)

 let children: any[] = []
 for (let i = 0; i < 90 && children.length < 2; i += 1) {
 await sleep(2000)
 children = (await client.agentRun.listChildren({ agentRunId: plan.id })).filter(
 (c: any) => c.relation === 'delegation',
)
 }
 check(children.length >= 2, `the planner produced subtasks to steer (${children.length})`)
 if (children.length === 0) {
 // Printed rather than left to guesswork: "no plan" has three quite different
 // causes — a refused subtask, a run that failed, and a model that never called
 // the tool — and the thread says which.
 const planRun = await client.agentRun.get({ agentRunId: plan.id })
 console.log('no plan — nothing to steer; stopping here')
 console.log(' planner status:', planRun.status, planRun.errorMessage ?? '')
 for (const m of (await client.message.list({ threadId: channel.rootThread.id })).messages) {
 console.log(' |', String(m.body.text ?? '').slice(0, 300))
 }
 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(1)
 }

 /**
 * Named by *file*, never by run id: the whole question is whether the model can map
 * a human's plain-language message onto the right subtask using the brief. Telling
 * it the id would answer the question this driver exists to ask.
 */
 const steering = await client.agentRun.steer({
 agentRunId: plan.id,
 message:
 'Stop the render.js review — that file is being deleted this afternoon, so ' +
 'reviewing it is wasted work. Leave the parser.js review running.',
 })
 console.log('steering run', steering.id)
 check(steering.relation === 'steer', 'the re-planning turn hangs off the planner as a steer run')

 const terminal = ['completed', 'failed', 'cancelled']
 let final = await client.agentRun.get({ agentRunId: steering.id })
 for (let i = 0; i < 90 && !terminal.includes(final.status); i += 1) {
 await sleep(2000)
 final = await client.agentRun.get({ agentRunId: steering.id })
 }
 console.log('steering run finished:', final.status)
 if (final.errorMessage) console.log(' error:', String(final.errorMessage).slice(0, 300))

 const messages = (await client.message.list({ threadId: channel.rootThread.id })).messages
 const applied = messages.find((m: any) => m.body.text?.includes('Re-planned'))
 // 1 + 2: it called the delta tool at all, which is the check that a missing tool
 // name in the allowlist would fail.
 check(applied !== undefined, 'the model called submit_plan_delta and the platform applied it')
 if (applied) console.log(' ', String(applied.body.text).split('\n').join('\n '))

 /**
 * The substitution. A run that still held `submit_plan` could answer by starting a
 * whole second fan-out, which is what the "a delta, emphatically" forbids.
 *
 * Counted rather than positioned, and matched on the *platform's* wording rather
 * than on "Plan accepted". Two earlier versions of this check were wrong in two
 * different ways: an index comparison read the original plan's acceptance as a
 * second one, and then a plain count of "Plan accepted" counted twice per plan,
 * because the tool's own result — "Plan accepted: N subtask(s) recorded" — is
 * echoed into the thread as agent text beside the platform's summary. Only
 * `applySubmittedPlan` writes "subtask(s) started", and it writes it once per plan.
 */
 const acceptances = messages.filter((m: any) =>
 m.body.text?.includes('subtask(s) started'),
).length
 check(acceptances === 1, `the steering turn submitted no second plan (${acceptances} accepted)`)

 // 3 + 4: it named the right subtask, and that subtask actually stopped.
 const after = (await client.agentRun.listChildren({ agentRunId: plan.id })).filter(
 (c: any) => c.relation === 'delegation',
)
 const cancelled = after.filter((c: any) => c.status === 'cancelled')
 check(cancelled.length > 0, `a subtask was cancelled by the delta (${cancelled.length})`)
 check(
 cancelled.length === 1,
 `exactly one subtask was cancelled, not the whole plan (${after.map((c: any) => c.status).join(', ')})`,
)

 const spent = [plan, steering,...after].reduce(
 (sum: number, r: any) => sum + (r.totalCostUsd ?? 0),
 0,
)
 const failed = results.filter((r) => !r.ok)
 console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
 if (failed.length > 0) console.log('failed:', failed.map((f) => f.what).join('; '))
 console.log(`spent about $${spent.toFixed(4)} across ${after.length + 2} runs`)

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(failed.length === 0 ? 0: 1)
}

void main.catch((e) => {
 console.error('STEER CHECK FAILED', e)
 process.exit(1)
})
