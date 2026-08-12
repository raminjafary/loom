/**
 * Live driver for the corporation — a three-level tree, driven by real models.
 *
 * docker compose up -d
 * LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/corporation-check.mts
 *
 * Exists because the automated suite drives every one of these paths with a *fake*
 * Runner and hand-written `plan_submitted` frames. That proves the server's half —
 * depth is enforced, the ledger is scoped, cross-plan claims collide. It cannot prove
 * the half only a real model exercises, and that half is where this feature's risk is:
 *
 * 1. **A Planner reads its roster and names a sub-planner.** The roster is prose
 * appended to a system prompt. A test asserts the prose is in the frame; only a
 * model can show it produces a plan that uses it. If it never delegates an area,
 * the corporation is a shape nothing reaches.
 * 2. **A sub-planner, started as a child, plans again.** Its own roster is computed
 * with one hop less, so it must offer workers and no longer offer planners.
 * 3. **The scoping holds on the real path**, where the ledger reaching a worker is
 * built by `startAgentRun` rather than by a test calling `buildContextLedger`.
 *
 * Not a test: it **spends real tokens** and prints PASS/FAIL lines for a human. Haiku
 * throughout and a low cap per run keep it cheap, but three levels means the run count
 * is 1 + areas + units, so it is the most expensive driver in here — expect a handful
 * of runs, not one.
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
 BETTER_AUTH_SECRET: 'corporation-secret-at-least-32-characters-long',
 SERVER_PORT: '0',
 // Three levels means more runs alive at once than the dev default of 3 allows: the
 // root plus two areas is already at the limit before a single unit starts.
 MAX_CONCURRENT_RUNS_PER_WORKSPACE: process.env.MAX_CONCURRENT_RUNS_PER_WORKSPACE ?? '8',
 MAX_DELEGATION_DEPTH: process.env.MAX_DELEGATION_DEPTH ?? '2',
} as NodeJS.ProcessEnv)

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
 results.push({ ok, what })
 console.log(`${ok ? 'PASS': 'FAIL'} ${what}`)
}

const PLANNER = (name: string) =>
 [
 '---',
 `name: ${name}`,
 'description: Decomposes a goal into areas or subtasks and delegates them.',
 'model: claude-haiku-4-5-20251001',
 'tools: []',
 'harness:',
 ' planner: true',
 ' delegates: [Read, Edit, Write, Grep, Glob]',
 // The workers below auto-approve so nothing stalls at a gate with no human
 // present, and the data model refuses a child that auto-approves under a parent that does
 // not — so the planners must too. Harmless on a `tools: []` persona, which can
 // reach no risky tool of its own; here it is purely the permission being handed
 // down. Getting this wrong is what the first live run of this driver found: the
 // sub-planners' rosters came back empty and they correctly declined to plan.
 ' autoApprove: true',
 ' budgetCapUsd: 0.5',
 '---',
 '',
 'You are a Planner. You cannot read files, write code, or run commands — you ' +
 'decompose and delegate. Submit exactly one plan with submit_plan, then stop. ' +
 'Name a persona for each subtask from the roster you were given, and claim the ' +
 'paths each subtask owns.',
 ].join('\n')

const WORKER = [
 '---',
 'name: corp-worker',
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
 const ws = await seedWorkspace(db, `corp-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'corp-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const base = `http://127.0.0.1:${addr.port}`
 const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
 console.log('server on', base)

 const repoPath = await mkdtemp(join(tmpdir, 'corp-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
 // Two clearly separate areas, so a decomposition into areas is the obvious split
 // and a wrong one is visible rather than arguable.
 await writeFile(join(repoPath, 'README.md'), '# corporation fixture\n')
 await writeFile(join(repoPath, 'docs-area.md'), '# Docs area\n\nTODO: describe the project.\n')
 await writeFile(join(repoPath, 'api-area.md'), '# API area\n\nTODO: list the endpoints.\n')
 await execFileAsync('git', ['-C', repoPath, 'add', '.'])
 await execFileAsync('git', [
 '-C', repoPath, '-c', 'user.email=corp@example.test', '-c', 'user.name=corp',
 'commit', '-qm', 'init',
 ])

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'corp-runner' })

 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 LOOM_SANDBOX_ENABLED: process.env.LOOM_SANDBOX_ENABLED ?? '0',
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
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `corp-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))

 await new Promise((r) => setTimeout(r, 4000))

 const repo = await client.repository.bindExisting({
 runnerId, path: repoPath, displayName: 'corp repo',
 })
 const channel = await client.channel.create({ name: 'corp' })

 const rootPersona = await client.persona.create({ markdownSource: PLANNER('corp-planner') })
 await client.persona.create({ markdownSource: WORKER })

 const terminal = ['completed', 'failed', 'cancelled']
 const awaitRun = async (runId: string, ticks = 90): Promise<any> => {
 for (let i = 0; i < ticks; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 const current = await client.agentRun.get({ agentRunId: runId })
 if (terminal.includes(current.status)) return current
 }
 return client.agentRun.get({ agentRunId: runId })
 }
 const awaitChildren = async (runId: string, want: number, ticks = 90) => {
 let kids: any[] = []
 for (let i = 0; i < ticks; i += 1) {
 kids = await client.agentRun.listChildren({ agentRunId: runId })
 if (kids.length >= want) return kids
 await new Promise((r) => setTimeout(r, 2000))
 }
 return kids
 }

 // ── The root orchestrator: split a goal too large for one decomposition. ──────
 const root = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: rootPersona.id,
 task:
 'This repository has two independent areas that each need several files of work: ' +
 'the docs area (docs-area.md) and the API area (api-area.md). Each area is too ' +
 'large to be one unit of work. Split the goal by area, one subtask per area, and ' +
 'delegate each area to a planner so it can decompose its own area. Claim the ' +
 'matching path for each subtask.',
 })
 console.log('root run', root.id)

 const areas = await awaitChildren(root.id, 2)
 check(areas.length >= 1, `the root delegated (${areas.length} area run(s) started)`)

 // The claim this driver exists for: a Planner read a roster and chose a planner from
 // it. If it picked workers instead, the tree is flat and everything below is moot.
 const areaPlanners = areas.filter((run: any) => run.persona.planner === true)
 check(
 areaPlanners.length >= 1,
 `the root chose a planner for an area (${areaPlanners.length} of ${areas.length})`,
)

 const sub = areaPlanners[0] ?? areas[0]
 if (sub) {
 const units = await awaitChildren(sub.id, 1)
 check(units.length >= 1, `the sub-planner planned again (${units.length} unit run(s))`)

 // Depth 2 is the configured ceiling, so a sub-planner must be offered workers and
 // no longer planners — the roster is recomputed with one hop less.
 check(
 units.every((run: any) => run.persona.planner !== true),
 'every run below a sub-planner is a worker, not another planner',
)

 if (units[0]) {
 const worker = await awaitRun(units[0].id)
 check(
 ['completed', 'failed'].includes(worker.status),
 `a level-2 worker reached a terminal state (${worker.status})`,
)
 }
 }

 // ── The board must show the whole tree, at any depth. ─────────────────────────
 const board = await client.workerNote.board({ agentRunId: root.id })
 const depths = new Map<string, number>([[root.id, 0]])
 for (const card of board.cards) {
 if (card.parentRunId && depths.has(card.parentRunId)) {
 depths.set(card.runId, (depths.get(card.parentRunId) ?? 0) + 1)
 }
 }
 const deepest = Math.max(...depths.values)
 check(deepest >= 2, `the board renders the tree at depth ${deepest} (${board.cards.length} cards)`)
 console.log(
 ' board:',
 board.cards.map((c: any) => `${c.personaName}/${c.status}`).join(' '),
)

 // ── The scoping, on the real path. ────────────────────────────────────────────
 // Every note is keyed to the tree, so the leak would be invisible in `listByTree`.
 // What matters is what a *run* was handed, and the platform note recording each
 // run's start is the one fact that names another area.
 const notes = await client.workerNote.listByTree({ agentRunId: root.id })
 check(notes.length > 0, `the tree accumulated a ledger (${notes.length} note(s))`)
 /**
 * Path ownership, asserted rather than merely printed.
 *
 * This was a `console.log` for several sessions, and the line it printed was empty
 * every time — which read as "planners choose not to claim paths" and was recorded
 * as such in two handoffs. The real cause was that `submit_plan`'s schema never
 * offered a `paths` field, so no planner could claim one however it was prompted.
 * The wire protocol carried the field, the domain validated it, the server acted on
 * it, and the model was never asked. A printed line cannot fail; this can.
 */
 const ownership = notes.filter((n: any) => n.kind === 'path_ownership')
 console.log(' path claims:', ownership.map((n: any) => `${n.title}:[${n.paths}]`).join(' '))
 check(
 ownership.some((n: any) => (n.paths ?? []).length > 0),
 `a planner claimed paths for its subtasks (${ownership.length} claim(s))`,
)

 const messages = await client.message.list({ threadId: channel.rootThread.id })
 const refusals = messages.messages
.map((m: any) => m.body.text ?? '')
.filter((t: string) => t.includes('✗'))
 check(refusals.length === 0, `no subtask was refused${refusals.length ? `: ${refusals[0]}`: ''}`)

 const failed = results.filter((r) => !r.ok)
 console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
 if (failed.length > 0) console.log('failed:', failed.map((f) => f.what).join('; '))

 const spend = board.cards.reduce((sum: number, c: any) => sum + (c.totalCostUsd ?? 0), 0)
 console.log(`spent $${spend.toFixed(4)} across ${board.cards.length} run(s)`)

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(failed.length === 0 ? 0: 1)
}

void main.catch((e) => {
 console.error('CORPORATION CHECK FAILED', e)
 process.exit(1)
})
