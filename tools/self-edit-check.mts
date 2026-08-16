/**
 * Live driver for tier 1 of continuity mode: real server, real Runner
 * *process*, real Claude Agent SDK, a persona that actually rewrites its own prompt.
 *
 * docker compose up -d
 * LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/self-edit-check.mts
 *
 * The suite drives this with a fake Runner: it sends a `persona_prompt_revised` frame and
 * checks what the server does with it. That proves the server's half — the envelope is
 * consulted, the frontmatter survives, the revision is recorded — and it cannot prove the
 * half that has failed in this repository four times: **that the model is offered the tool
 * at all.** `AgentDefinition.tools` is an exhaustive allowlist, so a tool registered
 * everywhere except the list the model sees is a feature that passes every test and does
 * nothing, and a run told to use it invents a substitute instead.
 *
 * Six things only a live run can settle:
 *
 * 1. The SDK offers `revise_own_prompt` to a persona whose envelope permits it.
 * 2. It offers it to **nobody else** — absence of an envelope is a refusal, and the
 * envelope-less control here is the only place that is checked against a real tool list
 * rather than against a boolean in a unit test.
 * 3. The write lands on the persona row and the **frontmatter is untouched** — tools,
 * model and the envelope itself are what a human wrote, after a model rewrote the
 * document they live in.
 * 4. **The next run of that persona is actually told the new prompt.** This is the payoff
 * and the only end-to-end proof that a self-edit is a self-edit rather than a row in a
 * table: the marker the first run wrote comes back out of a second run's mouth.
 * 5. The history holds what was replaced, attributed to the run that replaced it.
 * 6. A human's revert puts the old prompt back, over real HTTP, and keeps the version it
 * undid.
 *
 * It **asserts** rather than prints. A printed value cannot fail, and two handoffs here
 * mis-recorded a missing field as a model's choice because a driver printed where it
 * should have checked. Every text assertion filters by **author** as well as by text —
 * three drivers in this repository have matched their own input. Haiku and a 0.5 USD cap
 * keep the whole run to a few cents.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildApp, devAuth } from '../apps/server/src/index.js'
import { loadConfig } from '../apps/server/src/config.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import { REVISE_PROMPT_TOOL_NAME, REVISE_TOOLS_TOOL_NAME } from '../apps/runner/src/self-tool.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'self-edit-secret-at-least-32-characters-long',
 SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
 results.push({ ok, what })
 console.log(`${ok ? 'PASS': 'FAIL'} ${what}`)
}

/**
 * The marker, generated per invocation.
 *
 * It exists so check 4 cannot pass by accident. A fixed string would survive in a
 * database from a previous run of this driver and make "the next run was told the new
 * prompt" true without anything having happened today.
 */
const MARKER = `LOOM-SELF-EDIT-${Date.now.toString(36).toUpperCase}`

/**
 * A **different** marker for the control's task, and the reason is the rule this
 * repository keeps re-learning: a driver must never assert on text its own input
 * contains.
 *
 * The control is given the same instruction as the edit run, and that instruction names a
 * marker to write. If both used `MARKER`, then "the control never said it" would fail the
 * moment the model quoted its own task back — which is exactly what happened on the run
 * that found this, and it is the fourth time a driver here has matched its own input
 * (`corporation-check.mts` twice, `mastery-check.mts` once). The control's marker is
 * never asserted on; it exists only so the control's task can be identical in shape
 * without being identical in text.
 */
const CONTROL_MARKER = `LOOM-CONTROL-${Date.now.toString(36).toUpperCase}`

const STARTING_PROMPT =
 'You answer questions about this repository. You have no standing lessons recorded yet.'

/**
 * `envelope:` present and permitting exactly the tools the persona already holds — which
 * is the tier 1 in its purest form: may rewrite its prompt, may become nothing else.
 */
const ENVELOPED_PERSONA = (name: string) =>
 [
 '---',
 `name: ${name}`,
 'description: An agent a human has allowed to rewrite its own prompt.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read, Grep, Glob]',
 'harness:',
 ' autoApprove: true',
 ' budgetCapUsd: 0.5',
 'envelope:',
 ' tools: [Read, Grep, Glob]',
 '---',
 '',
 STARTING_PROMPT,
 ].join('\n')

/** The control: identical but for the block a human did not write. */
const PLAIN_PERSONA = (name: string) =>
 [
 '---',
 `name: ${name}`,
 'description: An agent nobody has allowed to rewrite itself.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read, Grep, Glob]',
 'harness:',
 ' autoApprove: true',
 ' budgetCapUsd: 0.5',
 '---',
 '',
 STARTING_PROMPT,
 ].join('\n')

/**
 * Something worth learning, so the edit the model makes is a real one.
 *
 * A convention stated in one file and obeyed by two others — the same fixture shape
 * `mastery-check.mts` uses, for the same reason: a run with nothing to conclude produces
 * a prompt rewrite that is a summary of its own task, which is exactly the edit continuity mode
 * tier 1 is worst at and this driver would happily record as a pass.
 */
const writeFixture = async (root: string) => {
 await mkdir(join(root, 'src'), { recursive: true })
 await writeFile(
 join(root, 'CONVENTIONS.md'),
 '# Conventions\n\nEvery price in this codebase is an integer number of minor units.\n' +
 'Floating point money is a bug. The canonical helper is `toMinorUnits`.\n',
)
 await writeFile(
 join(root, 'src', 'money.ts'),
 'export const toMinorUnits = (value: number): number => Math.round(value * 100)\n',
)
 await writeFile(
 join(root, 'src', 'fare.ts'),
 "import { toMinorUnits } from './money.js'\n\nexport const fareFor = (base: number) => toMinorUnits(base)\n",
)
}

const main = async => {
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `self-edit-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'self-edit-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const base = `http://127.0.0.1:${addr.port}`
 const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
 console.log('server on', base)
 console.log('marker', MARKER)

 const repoPath = await mkdtemp(join(tmpdir, 'self-edit-repo-'))
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
 await writeFixture(repoPath)
 await execFileAsync('git', ['-C', repoPath, 'add', '.'])
 await execFileAsync('git', [
 '-C', repoPath, '-c', 'user.email=self-edit@example.test', '-c', 'user.name=self-edit',
 'commit', '-qm', 'init',
 ])

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'self-edit-runner' })

 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 LOOM_SANDBOX_ENABLED: process.env.LOOM_SANDBOX_ENABLED ?? '0',
 // Withheld when the sandbox was asked for — supplying it unconditionally turns
 // LOOM_SANDBOX_ENABLED=1 into a silent downgrade and a clean pass about the path
 // that was not tested (see notes-check.mts).
...(process.env.LOOM_SANDBOX_ENABLED === '1'
 ? {}
: {
 LOOM_ALLOW_UNSANDBOXED:
 process.env.LOOM_ALLOW_UNSANDBOXED ?? 'i-understand-the-agent-gets-my-privileges',
 }),
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `self-edit-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))

 await new Promise((r) => setTimeout(r, 4000))

 const repo = await client.repository.bindExisting({
 runnerId,
 path: repoPath,
 displayName: 'money',
 })
 const channel = await client.channel.create({ name: 'self-edit' })

 const enveloped = await client.persona.create({ markdownSource: ENVELOPED_PERSONA('self-editor') })
 const plain = await client.persona.create({ markdownSource: PLAIN_PERSONA('no-envelope') })

 /**
 * The fixture, asserted against the platform's reading of it.
 *
 * `corporation-check.mts` spent a whole live run reporting a bug that had already been
 * fixed, because it authored a persona fixture nobody had checked. Here the stakes are
 * higher than a wasted run: if the parser stopped reading `envelope:`, both personas
 * would be envelope-less, the tool would be offered to neither, and every check below
 * would fail for a reason this line names in one word.
 */
 check(enveloped.envelope !== null, 'the fixture persona really carries an envelope')
 check(plain.envelope === null, 'the control persona really carries none')

 const awaitRun = async (runId: string): Promise<any> => {
 for (let i = 0; i < 120; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 const current = await client.agentRun.get({ agentRunId: runId })
 if (['completed', 'failed', 'cancelled'].includes(current.status)) return current
 }
 return client.agentRun.get({ agentRunId: runId })
 }

 const startAndWait = async (label: string, input: Record<string, unknown>): Promise<any> => {
 const started = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: repo.id,
...input,
 })
 console.log(`${label} run`, started.id)
 const done = await awaitRun(started.id)
 console.log(`${label} finished:`, done.status, 'cost', done.totalCostUsd)
 if (done.errorMessage) console.log(' reason:', done.errorMessage)
 return started
 }

 const editTask = (marker: string) =>
 'Read CONVENTIONS.md and src/money.ts. Then use your revise_own_prompt tool to record ' +
 'the convention you found as a standing instruction for future runs of your persona. ' +
 'Send the complete new prompt, and make its first line exactly this and nothing else: ' +
 `${marker}`

 // ── 1. The enveloped persona rewrites itself ────────────────────────────────
 const editRun = await startAndWait('self-edit', {
 personaId: enveloped.id,
 task: editTask(MARKER),
 })

 const revisions = await client.persona.revisions({ personaId: enveloped.id })
 check(
 revisions.length === 1,
 `the model called ${REVISE_PROMPT_TOOL_NAME} (${revisions.length} revision(s) recorded)`,
)
 check(
 revisions[0]?.replacedByRunId === editRun.id,
 'the revision is attributed to the run that made it',
)
 check(
 (revisions[0]?.rationale ?? '').length > 0,
 `the model said why (${JSON.stringify((revisions[0]?.rationale ?? '').slice(0, 80))})`,
)
 check(
 (revisions[0]?.markdownSource ?? '').includes(STARTING_PROMPT),
 'the history holds the prompt that was replaced, not the one that replaced it',
)

 const afterEdit = (await client.persona.list).find((p: any) => p.id === enveloped.id)
 check(
 (afterEdit?.markdownSource ?? '').includes(MARKER),
 'the stored persona now carries the prompt the model wrote',
)

 /**
 * The guard, on the real path. Everything a human wrote in the frontmatter has to be
 * byte-identical after a model rewrote the document it lives in — including the
 * envelope, which is the field a self-edit must never be able to reach.
 */
 check(
 JSON.stringify(afterEdit?.tools) === JSON.stringify(enveloped.tools) &&
 afterEdit?.model === enveloped.model &&
 afterEdit?.name === enveloped.name &&
 afterEdit?.harnessApprovalMode === enveloped.harnessApprovalMode &&
 JSON.stringify(afterEdit?.envelope) === JSON.stringify(enveloped.envelope),
 'the frontmatter is exactly what the human wrote — tools, model, approval mode, envelope',
)

 // ── 2. The control: no envelope, no tool, nothing changed ───────────────────
 const controlRun = await startAndWait('control (no envelope)', {
 personaId: plain.id,
 task: editTask(CONTROL_MARKER),
 })
 const controlRevisions = await client.persona.revisions({ personaId: plain.id })
 check(
 controlRevisions.length === 0,
 `a persona with no envelope rewrote nothing (${controlRevisions.length} revision(s))`,
)
 const afterControl = (await client.persona.list).find((p: any) => p.id === plain.id)
 check(
 (afterControl?.markdownSource ?? '').includes(STARTING_PROMPT) &&
 !(afterControl?.markdownSource ?? '').includes(MARKER),
 'the control persona still says what a human wrote',
)

 // ── 3. The payoff: the next run is told the new prompt ──────────────────────
 //
 // The task deliberately does **not** contain the marker's random half, so an echo of
 // the instruction cannot satisfy this. The only route from the first run's tool call to
 // this run's mouth is the stored persona being loaded into its system prompt.
 const quoteRun = await startAndWait('later run (expected to quote it)', {
 personaId: enveloped.id,
 task:
 'Without reading any file and without using any tool, answer this: the first line of ' +
 'your own standing instructions is a marker code. Repeat that line exactly. If your ' +
 'instructions contain no marker code, reply exactly: I WAS TOLD NOTHING.',
 })

 const page = await client.message.list({ threadId: channel.rootThread.id })
 /**
 * Filtered by author, always. Three drivers in this repository have reported a failure
 * that had not happened by matching a phrase their own task also contained.
 */
 const saidBy = (runId: string): string =>
 page.messages
.filter((m: any) => m.author?.kind === 'agent_run' && m.author.agentRunId === runId)
.map((m: any) => m.body.text ?? '')
.join('\n')

 check(
 saidBy(quoteRun.id).includes(MARKER),
 'a later run of that persona was told the prompt the earlier one wrote',
)
 /**
 * Sound only because the control's task names `CONTROL_MARKER` instead — see that
 * constant. The claim is that `MARKER` is reachable from nowhere but the stored
 * persona, and a run whose own instruction contained it could not have shown that.
 */
 check(
 !saidBy(controlRun.id).includes(MARKER),
 'the control run was never told it, which is what makes the line above mean something',
)

 // ── 4. Tier 2: the tool list, within the envelope ───────────────────────────
 //
 // A separate persona, because tier 1 already spent this one's single revision for the
 // run — and the cap is per run, not per tier, so reusing it would test the cap rather
 // than the tier.
 const retooler = await client.persona.create({
 markdownSource: ENVELOPED_PERSONA('self-retooler'),
 })
 /**
 * The fixture holds exactly what its envelope permits, and it has to: the first version
 * of this driver tried to author three tools under an envelope of one, and the platform
 * refused it — correctly, since continuity mode requires a persona to fit its own envelope, or the
 * ceiling would be a decoration on a room already taller than it. So the tier-2 case
 * here is a **drop**, which is the direction the tool's description argues for anyway;
 * the refusal path is covered deterministically by the gateway integration test, where
 * a frame can ask for `Bash` without a model having to be persuaded to.
 */
 check(
 retooler.tools.length === (retooler.envelope?.tools.length ?? -1),
 'the retooling fixture fits its own envelope, which is the only state a human may author',
)

 const retoolRun = await startAndWait('tier 2 (expected to drop tools)', {
 personaId: retooler.id,
 /**
 * Directive on purpose. An earlier version asked the model to "reduce your tool list
 * to what you can still justify", and it obeyed on one run and declined on the next —
 * so the check was measuring the model's taste rather than the mechanism. Whether an
 * agent reaches for this tool at the right moment is a real question and it belongs to
 * The measurement, not to a driver whose job is to prove the call works end to
 * end.
 */
 task:
 'This persona never opens files — it answers from memory. Call your revise_own_tools ' +
 'tool now with an empty tools list, and say in one sentence why holding no tools is ' +
 'right for it. Do not read anything first.',
 })

 const retoolRevisions = await client.persona.revisions({ personaId: retooler.id })
 check(
 retoolRevisions.length === 1,
 `the model called ${REVISE_TOOLS_TOOL_NAME} (${retoolRevisions.length} revision(s))`,
)
 const afterRetool = (await client.persona.list).find((p: any) => p.id === retooler.id)
 check(
 (afterRetool?.tools.length ?? 99) < retooler.tools.length,
 `it holds fewer tools than it started with (${retooler.tools.join(', ')} → ${(afterRetool?.tools ?? []).join(', ') || 'none'})`,
)
 /**
 * The envelope, checked against what actually landed rather than against the refusal
 * path. A model that asked for something outside it was refused; a model that asked for
 * nothing outside it proves the ceiling holds only if the stored list is inside it.
 */
 check(
 (afterRetool?.tools ?? []).every((tool: string) =>
 (retooler.envelope?.tools ?? []).includes(tool),
),
 'and everything it kept is inside the envelope a human set',
)
 check(
 (afterRetool?.markdownSource ?? '').includes(STARTING_PROMPT),
 'tier 2 moved the tool list and left the prompt alone',
)
 check(
 retoolRevisions[0]?.replacedByRunId === retoolRun.id,
 'the tool change is attributed to the run that made it',
)

 // ── 5. The human's undo ─────────────────────────────────────────────────────
 const restored = await client.persona.revert({
 personaId: enveloped.id,
 revisionId: revisions[0].id,
 })
 check(
 restored.markdownSource.includes(STARTING_PROMPT) && !restored.markdownSource.includes(MARKER),
 'a human put the original prompt back',
)
 const history = await client.persona.revisions({ personaId: enveloped.id })
 check(
 history.length === 2 && (history[0]?.markdownSource ?? '').includes(MARKER),
 `the undone version survives in the history (${history.length} entries)`,
)
 check(
 history[0]?.replacedByKind === 'human',
 'and the revert is recorded as a human"s act, not an agent"s',
)

 const failed = results.filter((r) => !r.ok)
 console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
 if (failed.length > 0) console.log('failed:', failed.map((f) => f.what).join('; '))
 console.log(' the later run said:', JSON.stringify(saidBy(quoteRun.id).slice(0, 240)))
 console.log(' the prompt the model wrote:\n' + (afterEdit?.markdownSource ?? '(none)'))

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(failed.length === 0 ? 0: 1)
}

void main.catch((e) => {
 console.error('SELF-EDIT CHECK FAILED', e)
 process.exit(1)
})
