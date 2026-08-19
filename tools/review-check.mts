/**
 * Live driver for the `reviews` — a real model, a real review, a real merge gate.
 *
 *   docker compose up -d
 *   LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/review-check.mts
 *
 * **Check 1 is the one this file exists for**, and it is not about reviewing.
 * `reviews` is a new field on `submit_plan`'s input schema, and this repository has
 * shipped a decomposition field the model was never offered twice: the worker-notes
 * tools (missing from the persona's exhaustive `tools` allowlist) and `paths` (missing
 * from the tool schema entirely for two sessions, while the wire carried it, the domain
 * validated it and the board drew it). Both times the whole suite passed, because the
 * integration tests inject a `plan_submitted` frame directly — the right way to test the
 * server and precisely the wrong way to notice that nobody asked the model.
 *
 * Check 4 is the one only a live run can make at all: the reviewer's clone has to
 * contain the reviewed work. The words are "read access to the reviewed branch", and
 * the difference between that and a plausible-looking dispatch is a `git clone` of the
 * right clone. It is asserted through the reviewer's own diff — if its branch was cut
 * from the reviewed tip, the reviewed change is in it, and if it was cut from the
 * default branch it is not.
 *
 * Check 6 asserts the gate **against the ledger rather than against a hope**: whether a
 * model raises a blocker is its own judgement, so the assertion is that the merge queue
 * agrees with whatever it decided — refused when a reviewer blocked, accepted when none
 * did. A driver that only printed the outcome would pass either way, which is the
 * failure mode this repository has recorded twice.
 *
 * `LOOM_USE_HOST_CLAUDE_AUTH=1` is not optional in practice: without it the SDK uses
 * whatever key `.env` holds, and a placeholder produces runs that fail before the model
 * plans anything — which looks like a quiet pass and proves nothing.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
  BETTER_AUTH_SECRET: 'review-check-secret-at-least-32-characters-long',
  SERVER_PORT: '0',
  MAX_CONCURRENT_RUNS_PER_WORKSPACE: process.env.MAX_CONCURRENT_RUNS_PER_WORKSPACE ?? '8',
} as NodeJS.ProcessEnv)

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
  results.push({ ok, what })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
}

const PLANNER = [
  '---',
  'name: review-planner',
  'description: Decomposes a goal into subtasks and delegates them.',
  'model: claude-haiku-4-5-20251001',
  'tools: [Read, Grep, Glob]',
  'harness:',
  '  planner: true',
  '  delegates: [Read, Edit, Write, Grep, Glob]',
  '  approvalMode: auto',
  '  budgetCapUsd: 0.5',
  '---',
  '',
  'You are a Planner. You can read the repository but cannot write code or run ' +
    'commands — you decompose and delegate. Submit exactly one plan with submit_plan, ' +
    'then stop. Name a persona for each subtask from the roster you were given. When a ' +
    'subtask exists to check another subtask\'s work rather than to write code, use the ' +
    'reviews field for it.',
].join('\n')

const WORKER = [
  '---',
  'name: review-worker',
  'description: Implements one scoped change on its own branch.',
  'model: claude-haiku-4-5-20251001',
  'tools: [Read, Edit, Write, Grep, Glob]',
  'harness:',
  '  approvalMode: auto',
  '  budgetCapUsd: 0.5',
  '---',
  '',
  'You are a Software Engineer. Make the smallest correct change for your task and stop.',
].join('\n')

/**
 * The reviewer holds no `Edit` and no `Write`, which is the persona-level half of the * "no
 * path ownership": the platform gives it no paths, and this gives it nothing to write with
 * either. Its whole output is notes.
 */
const REVIEWER = [
  '---',
  'name: review-checker',
  'description: Reads another agent\'s branch and reports findings and blockers.',
  'model: claude-haiku-4-5-20251001',
  'tools: [Read, Grep, Glob]',
  'harness:',
  '  approvalMode: auto',
  '  budgetCapUsd: 0.5',
  '---',
  '',
  'You are a code reviewer. Read the change on the branch in your working tree and ' +
    'report with write_note. Use "blocker" for anything that must not reach the default ' +
    'branch — a secret or token written to a log, a crash, data loss — and "finding" for ' +
    'everything else. Write at least one note before you stop.',
].join('\n')

const main = async () => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `review-${Date.now()}`)
  const app = await buildApp(config, devAuth({ userId: 'review-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${addr.port}`
  const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
  console.log('server on', base)

  /**
   * The fixture carries a real defect on purpose: `logAttempt` writes the bearer token
   * into the log. The goal below sends a worker into that same file, so the reviewer is
   * reading a branch that genuinely contains something worth blocking. Nothing asserts
   * that it *will* block — check 6 asserts the gate agrees with whatever it decides —
   * but a review of flawless code would only ever exercise the open half of the gate.
   */
  const repoPath = await mkdtemp(join(tmpdir(), 'review-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  await mkdir(join(repoPath, 'src'), { recursive: true })
  await writeFile(
    join(repoPath, 'src/auth.ts'),
    [
      'export interface Session {',
      '  readonly token: string',
      '  readonly userId: string',
      '}',
      '',
      'export const logAttempt = (session: Session): void => {',
      '  console.log(`auth attempt user=${session.userId} token=${session.token}`)',
      '}',
      '',
    ].join('\n'),
  )
  await writeFile(join(repoPath, 'README.md'), '# review fixture\n')
  await execFileAsync('git', ['-C', repoPath, 'add', '.'])
  await execFileAsync('git', [
    '-C', repoPath, '-c', 'user.email=review@example.test', '-c', 'user.name=review',
    'commit', '-qm', 'init',
  ])

  const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'review-runner' })

  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: tmpdir(),
      LOOM_SANDBOX_ENABLED: process.env.LOOM_SANDBOX_ENABLED ?? '0',
      // Withheld when the sandbox was asked for — see corporation-check.mts for the
      // silent-downgrade trap this avoids.
      ...(process.env.LOOM_SANDBOX_ENABLED === '1'
        ? {}
        : {
            LOOM_ALLOW_UNSANDBOXED:
              process.env.LOOM_ALLOW_UNSANDBOXED ?? 'i-understand-the-agent-gets-my-privileges',
          }),
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `review-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))

  await new Promise((r) => setTimeout(r, 4000))

  const repo = await client.repository.bindExisting({
    runnerId, path: repoPath, displayName: 'review repo',
  })
  const channel = await client.channel.create({ name: 'review' })
  const plannerPersona = await client.persona.create({ markdownSource: PLANNER })
  await client.persona.create({ markdownSource: WORKER })
  await client.persona.create({ markdownSource: REVIEWER })

  const root = await client.agentRun.start({
    threadId: channel.rootThread.id,
    repositoryId: repo.id,
    personaId: plannerPersona.id,
    task:
      'Two subtasks. First, a worker adds a function `requireSession` to src/auth.ts ' +
      'that throws when a session has no token. Second, a reviewer reads that ' +
      'worker\'s branch and reports what it finds about src/auth.ts — it writes no ' +
      'code. Plan both, and make the second one a review of the first.',
  })
  console.log('root run', root.id)

  // ── 1. Was the model offered the field at all? ───────────────────────────────
  /**
   * Matched on `subtask(s) started`, not on `Plan accepted`: `submit_plan`'s own tool
   * result echoes "Plan accepted: N subtask(s) recorded" back to the model, and that
   * echo renders into the thread *before* the server's summary. dag-check.mts reported a
   * confident wrong answer that way, and corporation-check.mts did it twice.
   */
  const isPlanSummary = (m: any) => m.body.text?.includes('subtask(s) started')
  const planned = await (async () => {
    for (let i = 0; i < 90; i += 1) {
      await new Promise((r) => setTimeout(r, 2000))
      const page = await client.message.list({ threadId: channel.rootThread.id })
      if (page.messages.some(isPlanSummary)) return page
    }
    return client.message.list({ threadId: channel.rootThread.id })
  })()
  const summary = planned.messages.find(isPlanSummary)?.body.text ?? ''
  console.log('  plan summary:', JSON.stringify(summary))
  if (summary === '') {
    // A planner that submitted nothing has said why somewhere in its thread, and a
    // driver that reports "the field went unused" without looking is how this
    // repository has produced three confident wrong answers.
    console.log('  --- no plan; the planner thread said: ---')
    for (const message of planned.messages) {
      console.log(`  [${message.body.kind}] ${String(message.body.text).slice(0, 400)}`)
    }
    const status = await client.agentRun.get({ agentRunId: root.id })
    console.log(`  --- planner run ${status.status}: ${status.errorMessage ?? 'no error'} ---`)
  }

  /**
   * `⌕` is written only for a subtask whose `reviews` survived validation and reached
   * the scheduler. A `⏸` here instead would mean the planner expressed the ordering as
   * an ordinary dependency — the field reachable but unused, which is a different
   * failure from the field being unreachable.
   */
  check(summary.includes('⌕'), 'a real planner used reviews (a review subtask was held back)')

  // ── 2. Only the reviewed subtask started. ───────────────────────────────────
  const firstWave = await (async () => {
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 2000))
      const kids = await client.agentRun.listChildren({ agentRunId: root.id })
      if (kids.length > 0) return kids
    }
    return []
  })()
  check(
    firstWave.length === 1,
    `only the reviewed subtask started (${firstWave.length} run(s))`,
  )

  const terminal = ['completed', 'failed', 'cancelled']
  const worker = firstWave[0]
  const finishedWorker = await (async () => {
    for (let i = 0; i < 150; i += 1) {
      await new Promise((r) => setTimeout(r, 2000))
      const current = await client.agentRun.get({ agentRunId: worker.id })
      if (terminal.includes(current.status)) return current
    }
    return client.agentRun.get({ agentRunId: worker.id })
  })()
  console.log(`  worker ${finishedWorker.status}, branch ${finishedWorker.branchName}`)

  // ── 3. The reviewer started, as a review rather than a delegation. ──────────
  const withReviewer = await (async () => {
    for (let i = 0; i < 90; i += 1) {
      await new Promise((r) => setTimeout(r, 2000))
      const kids = await client.agentRun.listChildren({ agentRunId: root.id })
      if (kids.length > firstWave.length) return kids
    }
    return client.agentRun.listChildren({ agentRunId: root.id })
  })()
  const reviewer = withReviewer.find((kid: any) => kid.id !== worker.id)
  check(
    reviewer?.relation === 'review',
    `the reviewer was recorded as a review, not a delegation (relation=${reviewer?.relation})`,
  )

  // ── 4. Read access to the reviewed branch — the clause only a live run tests. ─
  /**
   * The reviewer's branch was cut from the reviewed tip, so its diff against the default
   * branch contains the reviewed change. Cut from the default branch instead, it would
   * be empty — which is what "the dispatch looked right and the clone was wrong" looks
   * like from the outside.
   */
  const reviewerDiff = await (async () => {
    for (let i = 0; i < 30; i += 1) {
      try {
        const { diff } = await client.agentRun.getDiff({ agentRunId: reviewer.id })
        if (diff.length > 0) return diff
      } catch {
        // The clone may not be reported yet; retried rather than treated as absent.
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    return ''
  })()
  check(
    reviewerDiff.includes('requireSession') || reviewerDiff.includes('auth.ts'),
    'the reviewer opened on the reviewed work (its branch carries the reviewed change)',
  )

  // ── 5. Its output is a note. ────────────────────────────────────────────────
  const finishedReviewer = await (async () => {
    for (let i = 0; i < 150; i += 1) {
      await new Promise((r) => setTimeout(r, 2000))
      const current = await client.agentRun.get({ agentRunId: reviewer.id })
      if (terminal.includes(current.status)) return current
    }
    return client.agentRun.get({ agentRunId: reviewer.id })
  })()
  console.log(`  reviewer ${finishedReviewer.status}`)

  const notes = await client.workerNote.listByTree({ agentRunId: root.id })
  const reviewerNotes = notes.filter(
    (note: any) =>
      note.agentRunId === reviewer.id &&
      note.authorKind === 'agent_run' &&
      (note.kind === 'finding' || note.kind === 'blocker'),
  )
  for (const note of reviewerNotes) console.log(`  ${note.kind}: ${note.title}`)
  check(reviewerNotes.length > 0, `the reviewer reported as notes (${reviewerNotes.length})`)

  // Path ownership, from the ledger the siblings actually read.
  const reviewerStarted = notes.filter(
    (note: any) => note.agentRunId === reviewer.id && note.kind === 'run_started',
  )
  check(
    reviewerStarted.length === 1 && reviewerStarted[0].paths.length === 0,
    'the reviewer owns no paths in the ledger',
  )

  // ── 6. The gate agrees with the ledger. ────────────────────────────────────
  /**
   * Asserted both ways round, because which way it goes is the model's call. A blocker
   * must refuse the queue and the refusal must quote the objection; no blocker must
   * leave the queue exactly as it was before this feature existed.
   */
  const blockers = reviewerNotes.filter((note: any) => note.kind === 'blocker')
  let refusal: string | null = null
  let queued = false
  try {
    await client.mergeQueue.enqueue({ agentRunId: worker.id })
    queued = true
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  console.log(`  ${blockers.length} blocker(s); enqueue ${queued ? 'accepted' : 'refused'}`)
  if (refusal) console.log(`  refusal: ${JSON.stringify(refusal)}`)

  if (blockers.length > 0) {
    check(
      !queued && refusal !== null && blockers.some((b: any) => refusal!.includes(b.title)),
      "a reviewer's blocker stopped the branch reaching the merge queue, naming it",
    )
    // And the gate opens for a human — a blocker is model output, so a gate with no key
    // would let a reviewer that misread a diff hold a branch shut forever.
    const entry = await client.mergeQueue.enqueue({
      agentRunId: worker.id,
      overrideBlockers: true,
    })
    check(entry.agentRunId === worker.id, 'a human overrode the blockers and the branch queued')
  } else {
    check(
      queued,
      'with no blocker raised, the branch queued exactly as it did before this feature',
    )
    console.log(
      '  NOTE: the blocking half of the gate was not exercised — the reviewer raised no blocker.',
    )
  }

  // ── 7. The reviewer's own branch is not mergeable. ─────────────────────────
  let reviewerRefusal: string | null = null
  try {
    await client.mergeQueue.enqueue({ agentRunId: reviewer.id })
  } catch (error) {
    reviewerRefusal = error instanceof Error ? error.message : String(error)
  }
  check(
    reviewerRefusal !== null && reviewerRefusal.includes('review run'),
    "the reviewer's own branch was refused for the queue",
  )

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) console.log('failed:', failed.map((f) => f.what).join('; '))

  const board = await client.workerNote.board({ agentRunId: root.id })
  const spend = board.cards.reduce((sum: number, c: any) => sum + (c.totalCostUsd ?? 0), 0)
  console.log(`spent $${spend.toFixed(4)} across ${board.cards.length} run(s)`)

  runner.kill('SIGKILL')
  await app.close()
  await closeDb()
  process.exit(failed.length === 0 ? 0 : 1)
}

void main().catch((e) => {
  console.error('REVIEW CHECK FAILED', e)
  process.exit(1)
})
