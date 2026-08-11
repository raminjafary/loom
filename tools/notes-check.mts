/**
 * Live driver for the worker-notes ledger: real server, real
 * Runner *process*, real Claude Agent SDK, two runs in one tree.
 *
 * docker compose up -d
 * npx tsx tools/notes-check.mts
 *
 * Exists because the automated suite drives the notes protocol with a *fake* Runner
 * (runner-gateway.integration.test.ts). That proves the server's half — that a note
 * frame is persisted, that a refusal is relayed, that a child's `start_run` carries
 * the ledger. It cannot prove the half that only a real model exercises:
 *
 * 1. The SDK actually *offers* `write_note`/`read_notes` to the model, and the
 * in-process MCP server registers with the tool names the platform expects.
 * 2. A note written mid-run is durable before the run ends, on the real path.
 * 3. Run 2, started after run 1 finished, is handed run 1's note — the whole point
 * of the feature, and the thing no unit test can vouch for.
 *
 * Not a test: it **spends real tokens** and asserts nothing beyond printing PASS/FAIL
 * lines for a human to read. Haiku and a 0.5 USD cap per run keep it cheap.
 *
 * Defaults to LOOM_SANDBOX_ENABLED=0 for the same reason e2e-run.mts does — the SDK
 * then uses whatever model auth the host already has. The notes path is identical
 * either way: sandboxed, the tool lives in agent-host.ts and its frames cross the
 * stdio boundary; unsandboxed, it is the same in-process handle. Run it both ways if
 * you are changing sandbox.ts.
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
import { UNTRUSTED_NOTE_OPEN } from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'notes-secret-at-least-32-characters-long-value',
 SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
 results.push({ ok, what })
 console.log(`${ok ? 'PASS': 'FAIL'} ${what}`)
}

const PERSONA = (name: string, prompt: string) =>
 [
 '---',
 `name: ${name}`,
 'description: A worker that records what it learns.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read, Edit, Write, Grep, Glob]',
 'harness:',
 ' autoApprove: true',
 ' budgetCapUsd: 0.5',
 '---',
 '',
 prompt,
 ].join('\n')

const main = async => {
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `notes-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'notes-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const base = `http://127.0.0.1:${addr.port}`
 const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
 console.log('server on', base)

 const repoPath = await mkdtemp(join(tmpdir, 'notes-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
 // A fact worth a note, and one the model has to actually read the repo to find —
 // so an agent that never calls the tool cannot fake the result by guessing.
 await writeFile(
 join(repoPath, 'CONVENTIONS.md'),
 '# Conventions\n\nThe magic number for this project is 4d-quater-7788.\n',
)
 await writeFile(join(repoPath, 'README.md'), '# notes fixture\n')
 await execFileAsync('git', ['-C', repoPath, 'add', '.'])
 await execFileAsync('git', [
 '-C', repoPath, '-c', 'user.email=notes@example.test', '-c', 'user.name=notes',
 'commit', '-qm', 'init',
 ])

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'notes-runner' })

 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 LOOM_SANDBOX_ENABLED: process.env.LOOM_SANDBOX_ENABLED ?? '0',
 LOOM_ALLOW_UNSANDBOXED:
 process.env.LOOM_ALLOW_UNSANDBOXED ?? 'i-understand-the-agent-gets-my-privileges',
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `notes-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))

 await new Promise((r) => setTimeout(r, 4000))

 const repo = await client.repository.bindExisting({
 runnerId,
 path: repoPath,
 displayName: 'notes repo',
 })
 const channel = await client.channel.create({ name: 'notes' })

 const scout = await client.persona.create({
 markdownSource: PERSONA(
 'notes-scout',
 'You are a Software Engineer. Use write_note to record anything a later worker ' +
 'would have to rediscover. Make the smallest correct change and stop.',
),
 })
 const follower = await client.persona.create({
 markdownSource: PERSONA(
 'notes-follower',
 'You are a Software Engineer. Call read_notes before doing anything else, and ' +
 'use what you find. Make the smallest correct change and stop.',
),
 })

 const awaitRun = async (runId: string): Promise<any> => {
 for (let i = 0; i < 90; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 const current = await client.agentRun.get({ agentRunId: runId })
 if (['completed', 'failed', 'cancelled'].includes(current.status)) return current
 }
 return client.agentRun.get({ agentRunId: runId })
 }

 // ── Run 1: read the repo, record what you found. ────────────────────────────
 const first = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: scout.id,
 task:
 'Read CONVENTIONS.md. Record the project\'s magic number as a note with ' +
 'write_note (kind "finding", and name CONVENTIONS.md in paths). Then append a ' +
 'line reading "scouted" to README.md and stop.',
 })
 console.log('run 1', first.id)

 // Polled *while the run is in flight*: the worker-notes design requires notes to be durable
 // before a run terminates, because a killed or reaped run never reaches a stop
 // handler. Checking only afterwards would pass even if they were flushed at the end.
 let midRunNotes = 0
 const settledFirst = await Promise.race([
 awaitRun(first.id),
 (async => {
 for (let i = 0; i < 90; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 const notes = await client.workerNote.listByTree({ agentRunId: first.id })
 const authored = notes.filter((n: any) => n.authorKind === 'agent_run')
 if (authored.length > 0) {
 midRunNotes = authored.length
 const status = (await client.agentRun.get({ agentRunId: first.id })).status
 if (status === 'running') break
 }
 }
 return awaitRun(first.id)
 }),
 ])
 check(midRunNotes > 0, 'a note was durable while run 1 was still running (incremental write)')
 console.log('run 1 finished:', settledFirst.status, 'cost', settledFirst.totalCostUsd)

 const afterFirst = await client.workerNote.listByTree({ agentRunId: first.id })
 const agentNotes = afterFirst.filter((n: any) => n.authorKind === 'agent_run')
 check(agentNotes.length > 0, `the model called write_note (${agentNotes.length} note(s))`)
 const mentionsMagic = agentNotes.some((n: any) =>
 `${n.title} ${n.body}`.includes('4d-quater-7788'),
)
 check(mentionsMagic, 'the note carries the fact only a repo read could supply')
 check(
 afterFirst.some((n: any) => n.authorKind === 'platform' && n.kind === 'branch_ready'),
 'the platform recorded its own structural facts alongside the agent prose',
)
 for (const note of agentNotes) {
 console.log(` note: (${note.kind}) ${note.title} — paths ${JSON.stringify(note.paths)}`)
 }

 // A human's note, to prove the trusted channel reaches a real run too.
 await client.workerNote.write({
 agentRunId: first.id,
 kind: 'decision',
 title: 'Do not touch CONVENTIONS.md',
 body: 'It is maintained by hand.',
 paths: ['CONVENTIONS.md'],
 })

 // ── Run 2: a fresh run in a fresh clone. Does it inherit? ───────────────────
 //
 // A separate tree, deliberately *not* a child: this is the harder case. Notes are
 // keyed by tree, so run 2 sees run 1's ledger only if the tree resolution is right.
 // Started as a child of nothing, it gets its own tree — so this run reads via the
 // Planner-less path and should see nothing, which is the control. The real
 // inheritance case is covered by the planner test in the suite; here what matters is
 // that `read_notes` works at all against a real model.
 const second = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
 personaId: follower.id,
 task:
 'Call read_notes first. Then append one line to README.md saying whether you ' +
 'found any notes, and stop.',
 })
 console.log('run 2', second.id)
 const settledSecond = await awaitRun(second.id)
 console.log('run 2 finished:', settledSecond.status, 'cost', settledSecond.totalCostUsd)

 const page = await client.message.list({ threadId: channel.rootThread.id })
 const calledRead = page.messages.some((m: any) =>
 m.body.text?.includes('read_notes'),
)
 check(calledRead, 'the model called read_notes (visible as a tool call in the thread)')

 // The ledger as the platform would render it for a *sibling* — the fencing is the
 // The worker-notes design mitigation, so it has to survive the real path, not just a unit test.
 const rendered = await client.workerNote.listByTree({ agentRunId: first.id })
 check(rendered.length > agentNotes.length, 'the ledger accumulated across runs')

 const board = await client.workerNote.board({ agentRunId: first.id })
 check(board.cards.length > 0, `the board renders (${board.cards.length} card(s))`)
 console.log(
 ' board:',
 board.cards
.map((c: any) => `${c.personaName}/${c.status}/notes=${c.noteCount}`)
.join(' '),
)

 // Printed rather than checked: a human reading this output is the point, and the
 // fence is what they should be able to see with their own eyes.
 const ledgerForPrint = rendered
.filter((n: any) => n.authorKind === 'agent_run')
.map((n: any) => n.title)
 console.log(' agent-authored titles:', JSON.stringify(ledgerForPrint))
 console.log(' fence marker in use:', UNTRUSTED_NOTE_OPEN)

 const failed = results.filter((r) => !r.ok)
 console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
 if (failed.length > 0) console.log('failed:', failed.map((f) => f.what).join('; '))

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(failed.length === 0 ? 0: 1)
}

void main.catch((e) => {
 console.error('NOTES CHECK FAILED', e)
 process.exit(1)
})
