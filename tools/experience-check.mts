/**
 * Live driver for tier 5 of continuity mode: real server, real Runner *process*, real
 * Claude Agent SDK, a persona that actually remembers a repository between runs.
 *
 *   docker compose up -d
 *   LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/experience-check.mts
 *
 * Sandboxed, which needs the Runner to hold the egress control secret — without it every
 * run is *refused* rather than sandboxed, and the refusal reads like a broken feature:
 *
 *   set -a; . ./.env; set +a
 *   LOOM_USE_HOST_CLAUDE_AUTH=1 LOOM_SANDBOX_ENABLED=1 npx tsx tools/experience-check.mts
 *
 * The suite drives this with a fake Runner: it sends an `experience_recorded` frame and
 * checks what the server does with it, then reads the next `start_run`. That proves the
 * server's half — the envelope is consulted, the scope comes from the run, the fence is
 * applied — and it cannot prove the half this repository has got wrong four times: **that
 * the model is offered the tool at all.** `AgentDefinition.tools` is an exhaustive
 * allowlist, so a tool registered everywhere except the list the model sees is a feature
 * that passes every test and does nothing.
 *
 * Five things only a live run can settle:
 *
 * 1. The SDK offers `record_experience` to a persona whose envelope permits it, and the
 *    model can actually produce an argument the domain's validator accepts.
 * 2. It offers it to **nobody else** — absence of an envelope is a refusal, and the
 *    envelope-less control here is the only place that is checked against a real tool
 *    list rather than against a boolean in a unit test.
 * 3. **The next run against that repository is told what the first one learned.** This is
 *    the payoff and the only end-to-end proof that a lesson is a memory rather than a row:
 *    the marker the first run recorded comes back out of a second run's mouth.
 * 4. A run of the same persona against a **different repository** is told none of it.
 *    That is the scope rule — "per persona and per repository, never global" — checked
 *    where it could actually leak, rather than asserted about a type.
 * 5. A merge that changes the files a lesson named retires it, and the run after that is
 *    told nothing again.
 *
 * It **asserts** rather than prints. A printed value cannot fail, and every text assertion
 * filters by **author** as well as by text — four drivers in this repository have matched
 * their own input. Haiku and a 0.5 USD cap keep the whole run to a few cents.
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
import { invalidateExperienceForMerge } from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import { asRepositoryId, asWorkspaceId } from '../packages/domain/src/index.js'
import { RECORD_EXPERIENCE_TOOL_NAME } from '../apps/runner/src/experience-tool.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'experience-secret-at-least-32-characters-long',
  // Supplied rather than read from `.env`, so this driver runs without sourcing a file
  // whose `ANTHROPIC_API_KEY` is a placeholder — the Runner would hand that to the SDK on
  // the unsandboxed path and every run would 401, which is what the first pass of this
  // driver spent its runs proving.
  WS_SUBSCRIPTION_SECRET: 'experience-check-subscription-secret-32ch',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
  results.push({ ok, what })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
}

/**
 * The marker, generated per invocation, and the whole soundness of check 3.
 *
 * A fixed string would survive in a database from a previous run of this driver and make
 * "the later run was told what the earlier one learned" true without anything having
 * happened today. The later run's task never contains it — the only route from the first
 * run's tool call to the second run's mouth is the stored lesson.
 */
const MARKER = `LOOM-MEMORY-${Date.now().toString(36).toUpperCase()}`

/**
 * A **different** marker for the control's task, for the rule this repository keeps
 * re-learning: a driver must never assert on text its own input contains. The control is
 * given an instruction of the same shape, and if both named `MARKER` then "the control was
 * never told it" would fail the moment the model quoted its own task back.
 */
const CONTROL_MARKER = `LOOM-CONTROL-${Date.now().toString(36).toUpperCase()}`

/** The persona a human has allowed to keep memory: an envelope, and nothing wider. */
const REMEMBERING_PERSONA = (name: string) =>
  [
    '---',
    `name: ${name}`,
    'description: An agent a human has allowed to keep durable memory.',
    'model: claude-haiku-4-5-20251001',
    'tools: [Read, Grep, Glob]',
    'harness:',
    '  autoApprove: true',
    '  budgetCapUsd: 0.5',
    'envelope:',
    '  tools: [Read, Grep, Glob]',
    '---',
    '',
    'You answer questions about this repository. You have no standing lessons recorded yet.',
  ].join('\n')

/** The control: identical but for the block a human did not write. */
const PLAIN_PERSONA = (name: string) =>
  [
    '---',
    `name: ${name}`,
    'description: An agent nobody has allowed to keep memory.',
    'model: claude-haiku-4-5-20251001',
    'tools: [Read, Grep, Glob]',
    'harness:',
    '  autoApprove: true',
    '  budgetCapUsd: 0.5',
    '---',
    '',
    'You answer questions about this repository. You have no standing lessons recorded yet.',
  ].join('\n')

/**
 * Something worth learning, so the lesson the model writes is a real one.
 *
 * The same fixture shape `self-edit-check.mts` uses and for the same reason: a run with
 * nothing to conclude records a summary of its own task, which is the failure this tier is
 * worst at and a driver would happily accept as a pass.
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
}

/** A second repository, so the scope rule has somewhere to leak *to*. */
const writeOtherFixture = async (root: string) => {
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# Another project\n\nNothing to do with money.\n')
}

const initRepo = async (path: string, seed: (root: string) => Promise<void>) => {
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', path])
  await seed(path)
  await execFileAsync('git', ['-C', path, 'add', '.'])
  await execFileAsync('git', [
    '-C', path, '-c', 'user.email=experience@example.test', '-c', 'user.name=experience',
    'commit', '-qm', 'init',
  ])
}

const main = async () => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `experience-${Date.now()}`)
  const app = await buildApp(config, devAuth({ userId: 'experience-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${addr.port}`
  const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
  console.log('server on', base)
  console.log('marker', MARKER)

  const repoPath = await mkdtemp(join(tmpdir(), 'experience-repo-'))
  const otherPath = await mkdtemp(join(tmpdir(), 'experience-other-'))
  await initRepo(repoPath, writeFixture)
  await initRepo(otherPath, writeOtherFixture)

  const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'experience-runner' })

  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: tmpdir(),
      LOOM_SANDBOX_ENABLED: process.env.LOOM_SANDBOX_ENABLED ?? '0',
      // Withheld when the sandbox was asked for — supplying it unconditionally turns
      // LOOM_SANDBOX_ENABLED=1 into a silent downgrade and a clean pass about the path
      // that was not tested.
      ...(process.env.LOOM_SANDBOX_ENABLED === '1'
        ? {}
        : {
            LOOM_ALLOW_UNSANDBOXED:
              process.env.LOOM_ALLOW_UNSANDBOXED ?? 'i-understand-the-agent-gets-my-privileges',
          }),
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `experience-state-${Date.now()}`),
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
  const other = await client.repository.bindExisting({
    runnerId,
    path: otherPath,
    displayName: 'elsewhere',
  })
  const channel = await client.channel.create({ name: 'experience' })

  const enveloped = await client.persona.create({
    markdownSource: REMEMBERING_PERSONA('rememberer'),
  })
  const plain = await client.persona.create({ markdownSource: PLAIN_PERSONA('no-envelope') })

  /**
   * The fixture, asserted against the platform's reading of it. If the parser stopped
   * reading `envelope:`, both personas would be envelope-less, the tool would be offered to
   * neither, and every check below would fail for a reason this line names in one word.
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

  /**
   * Every run is checked for having *completed*, and that is not ceremony.
   *
   * The first pass of this driver reported six passes against a stack where every run had
   * been refused before it started — a stale sandbox image — because "the control recorded
   * nothing" and "the other repository was told nothing" are both true of a run that never
   * ran. A negative check is only evidence when the thing it denies had the chance to
   * happen, so the positive precondition is asserted here rather than assumed.
   */
  const startAndWait = async (
    label: string,
    input: Record<string, unknown>,
    repositoryId: string = repo.id,
  ): Promise<any> => {
    const started = await client.agentRun.start({
      threadId: channel.rootThread.id,
      repositoryId,
      ...input,
    })
    console.log(`${label} run`, started.id)
    const done = await awaitRun(started.id)
    console.log(`${label} finished:`, done.status, 'cost', done.totalCostUsd)
    if (done.errorMessage) console.log('  reason:', done.errorMessage)
    check(done.status === 'completed', `the ${label} run actually ran (${done.status})`)
    return started
  }

  const learnTask = (marker: string) =>
    'Read CONVENTIONS.md and src/money.ts. Then use your record_experience tool to record ' +
    'what you found as a lesson for future runs against this repository. Use the key ' +
    '"money-in-minor-units", kind "convention", and make the body start with exactly this ' +
    `code and nothing before it: ${marker}. Name src/money.ts in the paths.`

  // ── 1. The enveloped persona remembers something ────────────────────────────
  const learnRun = await startAndWait('learn', {
    personaId: enveloped.id,
    task: learnTask(MARKER),
  })

  const lessons = await client.experience.listForPersona({ personaId: enveloped.id })
  check(
    lessons.length === 1,
    `the model called ${RECORD_EXPERIENCE_TOOL_NAME} (${lessons.length} lesson(s) recorded)`,
  )
  check(
    lessons[0]?.authoredByRunId === learnRun.id,
    'the lesson is attributed to the run that wrote it',
  )
  check(
    lessons[0]?.repositoryId === repo.id,
    'and scoped to the repository the run was against, which nothing in the call named',
  )
  check(
    (lessons[0]?.body ?? '').includes(MARKER),
    'the body is what the model wrote',
  )

  // ── 2. The control is offered nothing ───────────────────────────────────────
  const controlRun = await startAndWait('control (no envelope)', {
    personaId: plain.id,
    task: learnTask(CONTROL_MARKER),
  })
  check(
    (await client.experience.listForPersona({ personaId: plain.id })).length === 0,
    'a persona with no envelope recorded nothing, having been offered no tool',
  )

  // ── 3. The payoff: the next run against this repository is told it ──────────
  //
  // The task deliberately does not contain the marker, so an echo of the instruction
  // cannot satisfy this. The only route from the first run's tool call to this run's mouth
  // is the stored lesson being rendered into its opening.
  const recallTask =
    'Without reading any file and without using any tool, answer this: your context ' +
    'contains lessons you recorded on earlier runs against this repository, and one of them ' +
    'begins with a marker code. Repeat that code exactly. If you were given no such lesson, ' +
    'reply exactly: I WAS TOLD NOTHING.'

  const recallRun = await startAndWait('later run (expected to quote it)', {
    personaId: enveloped.id,
    task: recallTask,
  })

  // ── 4. And a run against another repository is told none of it ──────────────
  const elsewhereStarted = await startAndWait(
    'elsewhere',
    { personaId: enveloped.id, task: recallTask },
    other.id,
  )

  const page = await client.message.list({ threadId: channel.rootThread.id })
  /**
   * Filtered by author, always. Four drivers in this repository have reported a failure
   * that had not happened by matching a phrase their own task also contained.
   */
  const saidBy = (runId: string): string =>
    page.messages
      .filter((m: any) => m.author?.kind === 'agent_run' && m.author.agentRunId === runId)
      .map((m: any) => m.body.text ?? '')
      .join('\n')

  check(
    saidBy(recallRun.id).includes(MARKER),
    'a later run against this repository was told what the earlier one learned',
  )
  check(
    !saidBy(elsewhereStarted.id).includes(MARKER),
    'and a run of the same persona against another repository was told none of it',
  )
  /**
   * Sound only because the control's task names `CONTROL_MARKER` instead — the claim is
   * that `MARKER` is reachable from nowhere but the stored lesson, and a run whose own
   * instruction contained it could not have shown that.
   */
  check(
    !saidBy(controlRun.id).includes(MARKER),
    'the control never saw it either',
  )

  // ── 5. A merge that changes the file retires it ─────────────────────────────
  //
  // Called directly rather than through the queue: the queue's own path is covered by
  // `merge-queue-check.mts`, and what is unproven here is that a real changed-path list
  // reaches a real lesson row and stamps it.
  const retired = await invalidateExperienceForMerge(app.deps, {
    workspaceId: asWorkspaceId(ws.id),
    repositoryId: asRepositoryId(repo.id),
    changedPaths: ['src/money.ts'],
    revision: 'abc1234',
  })
  check(retired.invalidated === 1, 'a merge touching the named file retired the lesson')

  const afterMerge = await client.experience.listForPersona({ personaId: enveloped.id })
  check(
    afterMerge.length === 1 && afterMerge[0]?.invalidatedAt !== null,
    'the row is still there, stamped rather than deleted',
  )

  const forgotRun = await startAndWait('after the merge (expected to know nothing)', {
    personaId: enveloped.id,
    task: recallTask,
  })
  const after = await client.message.list({ threadId: channel.rootThread.id })
  const forgotSaid = after.messages
    .filter((m: any) => m.author?.kind === 'agent_run' && m.author.agentRunId === forgotRun.id)
    .map((m: any) => m.body.text ?? '')
    .join('\n')
  check(
    !forgotSaid.includes(MARKER),
    'and the run after the merge was no longer told it',
  )

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) console.log('failed:', failed.map((f) => f.what).join('; '))
  console.log('  the later run said:', JSON.stringify(saidBy(recallRun.id).slice(0, 240)))
  console.log('  the lesson the model wrote:', JSON.stringify(lessons[0]?.body ?? '(none)'))

  runner.kill('SIGKILL')
  await app.close()
  await closeDb()
  process.exit(failed.length === 0 ? 0 : 1)
}

void main().catch((e) => {
  console.error('EXPERIENCE CHECK FAILED', e)
  process.exit(1)
})
