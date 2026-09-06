/**
 * Traffic through the workflow trial: ten real tasks of one class, five a side, decided by a
 * definition of done rather than by this file.
 *
 *   docker compose up -d postgres valkey egress-proxy
 *   docker build -f apps/runner/Dockerfile.sandbox -t loom-agent-sandbox:latest .
 *   export $(grep -E "^LOOM_EGRESS_CONTROL_SECRET=" .env | xargs)
 *   LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/trial-traffic.mts
 *
 * Why this exists alongside `trial-check.mts`. That driver settles the arithmetic — the arms
 * alternate, a task is the unit, cost sums over a tree — and it does so at zero tokens by writing
 * the dispositions straight to the rows. So every outcome it counts is an outcome this repository
 * chose, which is honest about the plumbing and says nothing whatever about the shapes. The trial
 * has machinery and no traffic, and a verdict is the one thing it has never produced.
 *
 * **The disposition rule, stated once and applied identically to both arms:** a branch is taken
 * if it passes the repository's definition of done, and discarded if it does not. Nothing here
 * looks at which arm produced a branch before deciding about it. That rule is the whole
 * difference between traffic and a fixture — it is what makes the numbers below evidence rather
 * than a preference this file expressed in arithmetic.
 *
 * **Why the class is shaped the way it is.** Every run on this platform gets its own clone off
 * the bound repository and its own branch; nothing shares a tree, and that is true of a planner's
 * delegated children exactly as it is of a workflow's lanes. So *both* arms produce several
 * partial branches per task, and a definition of done that only passes once every part is in
 * would fail every branch on both sides — the trial would then be measuring nothing but price.
 * The class here is therefore **monotone**: each call site is fixed together with the test that
 * proves it, so a branch carrying one lane's work is green on its own, and a branch carrying a
 * wrong fix is red on its own. That is what lets a per-branch check decide anything at all.
 *
 * Ten tasks and ten repositories, one each, because a definition of done is per repository: a
 * task whose fixture had already been fixed by an earlier task's merge would be measuring how
 * much work was left rather than how well it was done.
 *
 * Not a test: it spends real tokens, takes a while, and is run by hand. It asserts what must be
 * true of the *measurement* and prints the verdict, which is the thing it cannot assert — a
 * driver that failed unless the harness won would not be a trial.
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
import {
  advanceVerificationQueue,
  advanceWorkflowQueue,
} from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import { asAgentRunId, asWorkspaceId } from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'trial-traffic-secret-at-least-32-characters',
  WS_SUBSCRIPTION_SECRET: 'trial-traffic-subscription-secret-32-chr',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const PLANNER = 'trial-traffic-planner'
const WORKER = 'trial-traffic-worker'
/**
 * The harness's scoping step is a *scout*, not the planner, and the difference is not cosmetic.
 * A planner persona used as a workflow step is handed `submit_plan` alongside the step's own
 * answer tool, and on a task that looks like a decomposition it submits the plan — so the step
 * is refused for not answering while its run looks entirely successful. The workflow already is
 * the decomposition; a step of one has nothing to plan.
 */
const SCOUT = 'trial-traffic-scout'

// Ten is the trial's own minimum — five decided tasks a side. Overridable only to smoke-test
// the pipeline before spending on a full pass; a verdict needs the ten.
const TASKS = Number(process.env.TRIAL_TASKS ?? 10)
const SITES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] as const

/**
 * One task's repository: an interface that changed, five call sites that did not, and a suite
 * that is green because nothing yet claims the call sites work.
 *
 * Green at HEAD on purpose. A fixture whose suite is already red cannot tell "this branch is
 * wrong" from "this branch is incomplete", and both arms produce incomplete branches.
 */
const buildFixture = async (path: string, seed: number): Promise<void> => {
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', path])
  await mkdir(join(path, 'src'), { recursive: true })
  await mkdir(join(path, 'test'), { recursive: true })
  await writeFile(join(path, 'package.json'), `${JSON.stringify({ name: `fixture-${seed}`, private: true, type: 'module' }, null, 2)}\n`)
  await writeFile(
    join(path, 'src', 'api.js'),
    [
      '// Changed shape: one object, not two positional arguments.',
      'export const formatUser = ({ first, last }) => `${last}, ${first}`',
      '',
    ].join('\n'),
  )
  for (const site of SITES) {
    await writeFile(
      join(path, 'src', `${site}.js`),
      [
        "import { formatUser } from './api.js'",
        '',
        '// Still calling the old two-argument shape, so this returns the wrong string.',
        `export const ${site} = (first, last) => \`${site.toUpperCase()}: \${formatUser(first, last)}\``,
        '',
      ].join('\n'),
    )
  }
  await writeFile(
    join(path, 'test', 'baseline.test.js'),
    [
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import { formatUser } from '../src/api.js'",
      '',
      "test('formatUser takes one object', () => {",
      "  assert.equal(formatUser({ first: 'Ada', last: 'Lovelace' }), 'Lovelace, Ada')",
      '})',
      '',
    ].join('\n'),
  )
  await git(path, ['add', '-A'])
  await git(path, ['-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'first'])
}

const TASK_TEXT = [
  'src/api.js now takes a single object: formatUser({ first, last }). The five call sites in',
  `src/ (${SITES.join('.js, ')}.js) still call it with two positional arguments, so each returns`,
  'the wrong string.',
  '',
  'For every call site file: fix the call, and add a test file under test/ named after it that',
  "proves the fix — calling it with ('Ada', 'Lovelace') must return the site's own uppercase",
  'prefix followed by "Lovelace, Ada".',
  '',
  'Do not change src/api.js and do not change test/baseline.test.js. `node --test` must pass',
  'when you are done. Fix a call site and add its test together, so the suite is green at every',
  'point rather than only at the end.',
].join('\n')

const personaDoc = (name: string, input: { tools: string; harness: Record<string, string> }) =>
  [
    '---',
    `name: ${name}`,
    `description: Works on a call-site migration with a test suite as the definition of done.`,
    'model: claude-haiku-4-5-20251001',
    `tools: ${input.tools}`,
    'harness:',
    ...Object.entries(input.harness).map(([key, value]) => `  ${key}: ${value}`),
    '---',
    '',
    `You are the ${name}. Make the smallest correct change, touch nothing you were not asked to,`,
    'and stop when the part you were given is done.',
    '',
    'When you are given a tool to submit your answer with, submitting it is how the work counts.',
    'A run that finishes without calling it has refused the step, however well it went.',
  ].join('\n')

/** scope the call sites, then fix each one in its own lane. */
const graph = {
  nodes: [
    {
      kind: 'step',
      id: 'scope',
      title: 'Find the call sites',
      persona: SCOUT,
      task:
        'Read src/ and list every call-site file that still calls formatUser with two positional ' +
        'arguments. Answer with the list of file paths and nothing else — another run fixes each.',
      answer: { fields: [{ kind: 'list', name: 'sites' }] },
    },
    {
      kind: 'fan',
      id: 'fix',
      title: 'Fix one call site',
      persona: WORKER,
      task: `Fix this one call site and add its test, and touch nothing else: {{item}}\n\n${TASK_TEXT}`,
      source: 'scope',
      over: 'sites',
      maxWidth: 5,
      answer: { fields: [{ kind: 'text', name: 'done' }] },
    },
  ],
  edges: [{ from: 'scope', to: 'fix' }],
}

const main = async () => {
  const missing = [
    process.env.LOOM_EGRESS_CONTROL_SECRET ? null : 'LOOM_EGRESS_CONTROL_SECRET',
    process.env.LOOM_USE_HOST_CLAUDE_AUTH === '1' ? null : 'LOOM_USE_HOST_CLAUDE_AUTH=1',
  ].filter((name): name is string => name !== null)
  if (missing.length > 0) {
    console.error(
      `Refusing to run: ${missing.join(' and ')} not set. This driver reaches a model, so it\n` +
        'runs sandboxed with the credential in the egress proxy.',
    )
    process.exit(1)
  }

  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `trial-traffic-${Date.now()}`)
  const workspaceId = asWorkspaceId(ws.id)
  const app = await buildApp(config, devAuth({ userId: 'trial-traffic-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))
  console.log('server on', `http://127.0.0.1:${addr.port}`)

  const { runnerId, rawToken } = await client.runner.createPairingToken({
    name: 'trial-traffic-runner',
  })
  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: tmpdir(),
      LOOM_SANDBOX_ENABLED: '1',
      LOOM_EGRESS_CONTROL_SECRET: process.env.LOOM_EGRESS_CONTROL_SECRET,
      LOOM_USE_HOST_CLAUDE_AUTH: '1',
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `trial-traffic-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 5000))

  console.log(`\npreparing ${TASKS} fixtures, one per task`)
  const repos: any[] = []
  for (let index = 0; index < TASKS; index += 1) {
    const path = await mkdtemp(join(tmpdir(), `trial-traffic-${index}-`))
    await buildFixture(path, index)
    const repo = await client.repository.bindExisting({
      runnerId,
      path,
      displayName: `trial fixture ${index}`,
    })
    await client.repository.setVerificationChecks({
      repositoryId: repo.id,
      // `node --test`, with no path. On Node 24 `node --test test/` reports one synthetic
      // failing test named "test" and exits non-zero on a suite that passes — so every branch on
      // both arms was discarded, and the trial would have produced a verdict about nothing.
      checks: [{ name: 'tests', command: 'node --test' }],
    })
    repos.push(repo)
  }
  check('every task has its own repository and its own definition of done', repos.length === TASKS)

  const planner = await client.persona.create({
    markdownSource: personaDoc(PLANNER, {
      // Read-only, because the platform refuses a planner that holds Edit or Write: it
      // decomposes rather than acts. Its envelope is what its workers may hold.
      tools: '[Read, Grep, Glob]',
      harness: {
        planner: 'true',
        delegates: '[Read, Edit, Write, Grep, Glob]',
        approvalMode: 'auto',
        budgetCapUsd: '1.0',
      },
    }),
  })
  await client.persona.create({
    markdownSource: personaDoc(SCOUT, {
      tools: '[Read, Grep, Glob]',
      harness: { approvalMode: 'auto', budgetCapUsd: '0.3' },
    }),
  })
  await client.persona.create({
    markdownSource: personaDoc(WORKER, {
      tools: '[Read, Edit, Write, Grep, Glob]',
      harness: { approvalMode: 'auto', budgetCapUsd: '0.6' },
    }),
  })
  const channel = await client.channel.create({ name: 'trial-traffic' })

  const drawn = await client.workflow.create({
    name: 'call-site migration',
    description: 'scope the call sites, then fix each in its own lane',
    graph,
  })
  check('the harness on trial was drawn', drawn.workflowId !== null, String(drawn.detail))

  /**
   * A plan is accepted by a person, and this driver is standing in for one. Accepted
   * unconditionally and for both arms' sake: a driver that read the plan and accepted the ones
   * it liked would be deciding the planner arm's quality before the definition of done got to.
   */
  const acceptPlanOf = async (entry: { arm: string; runId: string }): Promise<number> => {
    if (entry.arm !== 'planner') return 0
    // `awaitingReview`, which is derived from the rows — not a `status` field, which this driver
    // asked for first and never found, so every plan sat at `waiting` and every planner task was
    // recorded as one run that delegated nothing.
    const plan = await client.plan.get({ agentRunId: entry.runId }).catch(() => null)
    if (plan === null || plan.awaitingReview !== true) return 0
    const result = await client.plan.accept({ agentRunId: entry.runId }).catch(() => null)
    return result === null ? 0 : result.started
  }

  const runsOfTask = async (entry: { arm: string; runId: string }) => {
    if (entry.arm === 'planner') {
      // `listTree`, not root-plus-children: the port's own note says a board built the second way
      // silently omitted a sub-planner's workers, and a trial that counted a task's runs that way
      // would under-report exactly the arm whose whole claim is how many runs it takes.
      return app.deps.agentRuns.listTree(workspaceId, asAgentRunId(entry.runId))
    }
    const steps = await app.deps.workflows.stepsForRun(workspaceId, entry.runId as any)
    const runs = await Promise.all(
      steps
        .filter((step) => step.agentRunId !== null)
        .map((step) => app.deps.agentRuns.findById(workspaceId, step.agentRunId!)),
    )
    return runs.filter((run): run is NonNullable<typeof run> => run != null)
  }

  const TERMINAL = ['completed', 'failed', 'cancelled']
  const started: { arm: string; runId: string; index: number }[] = []

  console.log(`\nrunning ${TASKS} tasks of one class, alternating arms\n`)
  for (let index = 0; index < TASKS; index += 1) {
    const dealt = await client.workflow.trialRun({
      workflowId: drawn.workflowId,
      repositoryId: repos[index].id,
      threadId: channel.rootThread.id,
      input: TASK_TEXT,
      capUsd: 4,
      plannerPersonaId: planner.id,
    })
    started.push({ arm: dealt.arm, runId: dealt.runId, index })
    console.log(`  task ${index + 1}/${TASKS} → ${dealt.arm}`)

    // Drive this task to a standstill before dealing the next. Serial rather than parallel: ten
    // tasks at once would have both arms competing for the same Runner, and a lane that waited
    // its turn would be recorded as a slower arm rather than a busier machine.
    /**
     * Quiet *and* not growing, for three polls together. Terminal-and-stop was the first version
     * and it ended every planner task after one run: a plan's subtasks are started once the
     * planner stops, so at the moment the root goes terminal the tree is legitimately one run
     * with nothing running in it. The harness has the same shape a tick later — a fan opens after
     * the step above it settles — so the condition has to be that nothing has appeared either.
     */
    const deadline = Date.now() + 15 * 60 * 1000
    let quietPolls = 0
    let lastSize = -1
    while (Date.now() < deadline) {
      await advanceWorkflowQueue(app.deps, { stepStuckMs: 3_600_000, maxStartsPerTick: 16 })
      await acceptPlanOf(started[index]!)
      await new Promise((r) => setTimeout(r, 6000))
      const runs = await runsOfTask(started[index]!)
      const quiet = runs.length > 0 && runs.every((run) => TERMINAL.includes(run.status))
      quietPolls = quiet && runs.length === lastSize ? quietPolls + 1 : 0
      lastSize = runs.length
      if (quietPolls >= 3) break
    }
    const settled = await runsOfTask(started[index]!)
    console.log(`    ${settled.length} run(s) finished`)
  }

  console.log('\nrunning every branch through the definition of done')
  for (let pass = 0; pass < 40; pass += 1) {
    await advanceVerificationQueue(app.deps, { verificationStuckMs: 1_800_000 })
    await new Promise((r) => setTimeout(r, 5000))
  }

  /**
   * The disposition, from the definition of done and from nothing else. Written here rather than
   * through the merge queue because what is being measured is whether the work was worth taking,
   * and the queue's serialization would additionally measure the order ten unrelated fixtures
   * happened to be queued in.
   */
  console.log('\ndeciding every branch by the rule, without looking at which arm made it\n')
  let taken = 0
  let dropped = 0
  for (const entry of started) {
    const runs = await runsOfTask(entry)
    for (const run of runs) {
      if (run.branchName === null) continue
      const verification = (
        await client.agentRun.listVerifications({ agentRunIds: [String(run.id)] })
      )[0]
      const passed = verification?.status === 'passed'
      await app.deps.agentRuns.setBranchDisposition(
        workspaceId,
        asAgentRunId(String(run.id)),
        passed ? 'merged' : 'discarded',
      )
      if (passed) taken += 1
      else dropped += 1
    }
  }
  check(
    'the definition of done actually ran, rather than every branch defaulting to discarded',
    taken + dropped > 0 && taken > 0,
    `${taken} branch(es) taken, ${dropped} discarded`,
  )

  const trial = await client.workflow.trial({ workflowId: drawn.workflowId })
  const arm = (name: string) => trial.arms.find((entry: any) => entry.arm === name)

  console.log('\n— what the trial says —\n')
  for (const name of ['workflow', 'planner']) {
    const side = arm(name)
    // `meanCostUsd`, per decided task — the total is not on the wire, and reading a field that
    // is not there prints $0.000 on an arm that spent real money.
    console.log(
      `  ${name.padEnd(9)} ${side?.decided}/${side?.tasks} decided · ` +
        `${side?.merged} taken (${(Number(side?.successRate ?? 0) * 100).toFixed(0)}%) · ` +
        `${side?.verificationFailed} failed checks · ` +
        `$${Number(side?.meanCostUsd ?? 0).toFixed(3)}/task · ` +
        `${Number(side?.meanRuns ?? 0).toFixed(1)} runs/task`,
    )
  }
  console.log(`\n  verdict: ${trial.verdict}\n  ${String(trial.detail).split('\n').join('\n  ')}\n`)

  check(
    'both arms were dealt the same number of tasks, give or take the odd one',
    Math.abs(Number(arm('workflow')?.tasks ?? 0) - Number(arm('planner')?.tasks ?? 0)) <= 1,
    `${arm('workflow')?.tasks} harness, ${arm('planner')?.tasks} planner`,
  )
  check(
    'the trial reached a verdict rather than still asking for evidence',
    trial.verdict !== 'undecided',
    `${String(trial.verdict)} — ${arm('workflow')?.decided} and ${arm('planner')?.decided} decided`,
  )

  console.log(
    `\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`} — the verdict ` +
      'itself is not one of them, because a driver that failed unless the harness won would ' +
      'not be a trial.',
  )
  runner.kill('SIGTERM')
  await app.fastify.close()
  await closeDb()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
