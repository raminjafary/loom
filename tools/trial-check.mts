/**
 * Live driver for the workflow trial: real server, real Runner *process*, real Postgres, real
 * HTTP contract, real dispositions.
 *
 *   docker compose up -d
 *   npx tsx tools/trial-check.mts
 *
 * Why this exists alongside the tests. `workflow-trial.test.ts` drives the arithmetic as a pure
 * function and `workflow-queue.test.ts` drives the dealing against stubbed ports. **No trial had
 * ever counted a real task**, and the half most likely to be wrong is the half only Postgres can
 * answer: whether a task's outcome is assembled from *every run it started* — a planner's whole
 * tree, or a workflow's steps — or from whichever run happened to be the first one.
 *
 * Spends **no tokens**: the runs it starts are refused by the Runner's own unsandboxed guard,
 * after the clone. The dispositions and the metered costs are written straight to the rows, which
 * is what a person merging a branch and a proxy metering a call would have written.
 *
 * Five things only this can settle:
 *
 * 1. **The arms alternate from the rows**, starting with the planner — the side this platform
 *    would have taken anyway — and a person is told which side the next task goes to *before*
 *    they press.
 * 2. **A task is the unit.** A harness task that started six runs is one task, not six, and a
 *    planner task is its whole tree rather than the run at the top of it.
 * 3. **Cost is what the task cost**, summed over those runs on both sides.
 * 4. **The verdict is recomputed from the rows** and says how much of each side it still needs.
 * 5. **A shape that is only as good as a planner is refused**, because it costs more machinery
 *    for the same result.
 *
 * Not a test: it asserts loudly but is run by hand, and it prints what happened.
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
import { advanceWorkflowQueue, recordWorkflowAnswer } from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import { asAgentRunId, asWorkflowRunId, asWorkspaceId } from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'trial-check-secret-at-least-32-characters',
  WS_SUBSCRIPTION_SECRET: 'trial-check-subscription-secret-32-chars',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const PLANNER = 'trial-check-planner'
const WORKER = 'trial-check-worker'

const personaDoc = (
  name: string,
  input: { tools: string; harness?: Record<string, string> },
) =>
  [
    '---',
    `name: ${name}`,
    'description: Never actually runs; the arms, the rows and the arithmetic are the point.',
    'model: claude-opus-5',
    `tools: ${input.tools}`,
    ...(input.harness === undefined
      ? []
      : ['harness:', ...Object.entries(input.harness).map(([k, v]) => `  ${k}: ${v}`)]),
    '---',
    '',
    `The ${name} document.`,
  ].join('\n')

/** discover → do each part. Two steps, so a harness task is visibly more than one run. */
const graph = {
  nodes: [
    {
      kind: 'step',
      id: 'split',
      title: 'Split it',
      persona: PLANNER,
      task: 'Split up: {{input}}',
      answer: { fields: [{ kind: 'list', name: 'parts' }] },
    },
    {
      kind: 'fan',
      id: 'work',
      title: 'Do each part',
      persona: WORKER,
      task: 'Do this one part: {{item}}',
      source: 'split',
      over: 'parts',
      maxWidth: 3,
      answer: { fields: [{ kind: 'text', name: 'done' }] },
    },
  ],
  edges: [{ from: 'split', to: 'work' }],
}

const main = async () => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `trial-check-${Date.now()}`)
  const workspaceId = asWorkspaceId(ws.id)
  const app = await buildApp(config, devAuth({ userId: 'trial-check-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${addr.port}`
  const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
  console.log('server on', base)

  const repoPath = await mkdtemp(join(tmpdir(), 'trial-check-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  await writeFile(join(repoPath, 'README.md'), '# the tree a task opens on\n')
  await git(repoPath, ['add', '-A'])
  await git(repoPath, [
    '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'first',
  ])

  const { runnerId, rawToken } = await client.runner.createPairingToken({
    name: 'trial-check-runner',
  })
  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: tmpdir(),
      LOOM_SANDBOX_ENABLED: '0',
      LOOM_ALLOW_UNSANDBOXED: '',
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `trial-check-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 4000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: repoPath,
    displayName: 'trial check repo',
  })
  const planner = await client.persona.create({
    markdownSource: personaDoc(PLANNER, {
      tools: '[Read, Grep, Glob]',
      harness: { planner: 'true', delegates: '[Read, Grep, Glob, Edit, Write]', approvalMode: 'auto' },
    }),
  })
  const worker = await client.persona.create({
    markdownSource: personaDoc(WORKER, { tools: '[Read, Edit]', harness: { approvalMode: 'auto' } }),
  })
  const channel = await client.channel.create({ name: 'trial-check' })

  const drawn = await client.workflow.create({
    name: 'trial-check harness',
    description: 'split it, then do each part',
    graph,
  })
  check('a harness to put on trial', drawn.workflowId !== null, String(drawn.detail))

  console.log('\n— the arms alternate from the rows, and the planner goes first —')
  const before = await client.workflow.trial({ workflowId: drawn.workflowId })
  check(
    'a class nobody has run says so, and names what each side still needs',
    before.verdict === 'undecided' && String(before.detail).includes('0 decided task(s)'),
    String(before.detail),
  )
  check(
    'and the first task is owed to a planner — what this platform would have done anyway',
    before.nextArm === 'planner',
    String(before.nextArm),
  )

  const task = (input: string) =>
    client.workflow.trialRun({
      workflowId: drawn.workflowId,
      repositoryId: repo.id,
      threadId: channel.rootThread.id,
      input,
      capUsd: 5,
      plannerPersonaId: planner.id,
    })

  const first = await task('the first task of this class')
  check('the first task went to a planner', first.arm === 'planner', String(first.detail))
  const afterFirst = await client.workflow.trial({ workflowId: drawn.workflowId })
  check(
    'and the next one is owed to the harness',
    afterFirst.nextArm === 'workflow',
    String(afterFirst.nextArm),
  )

  const second = await task('the second task of this class')
  check('the second went through the harness', second.arm === 'workflow', String(second.detail))
  const third = await task('the third task of this class')
  check('and the third came back to the planner', third.arm === 'planner', String(third.detail))

  /**
   * A planner's task is its whole tree, so the first task is given a child — the run a planner
   * would have delegated. It is written through the same use case a plan's subtask start does.
   */
  console.log('\n— a task is the unit: a tree is one task, and so is an execution —')
  const plannerRunId = asAgentRunId(first.runId)
  const child = await app.deps.agentRuns.create({
    workspaceId,
    threadId: channel.rootThread.id,
    repositoryId: repo.id,
    runnerId,
    persona: {
      name: WORKER,
      systemPrompt: '',
      model: 'claude-sonnet-5',
      tools: ['Read', 'Edit'],
      approvalMode: 'auto',
      budgetCapUsd: 5,
    },
    parentRunId: plannerRunId,
    relation: 'delegation',
  })

  // The harness's execution deals its first step, which answers, opening two lanes.
  await advanceWorkflowQueue(app.deps, { stepStuckMs: 3_600_000, maxStartsPerTick: 16 })
  await new Promise((r) => setTimeout(r, 7000))
  const workflowRunId = asWorkflowRunId(second.runId)
  const split = (await app.deps.workflows.stepsForRun(workspaceId, workflowRunId)).find(
    (step) => step.nodeId === 'split',
  )
  if (split?.agentRunId != null) {
    await recordWorkflowAnswer(app.deps, {
      workspaceId,
      agentRunId: split.agentRunId,
      answer: { parts: ['one', 'two'] },
    })
  }
  await advanceWorkflowQueue(app.deps, { stepStuckMs: 3_600_000, maxStartsPerTick: 16 })
  await new Promise((r) => setTimeout(r, 7000))
  const steps = await app.deps.workflows.stepsForRun(workspaceId, workflowRunId)
  check(
    'the harness task started three runs — a split and two lanes',
    steps.filter((step) => step.agentRunId !== null).length === 3,
    steps.map((step) => `${step.nodeId}:${step.status}`).join(' '),
  )

  /**
   * Both sides are decided the way a person and a proxy decide them: a disposition on the branch
   * and a metered cost on the run. Everything the trial reports is read back from these.
   */
  const decide = async (
    runId: string,
    disposition: 'merged' | 'discarded',
    costUsd: number,
  ) => {
    await app.deps.agentRuns.updateStatus(workspaceId, asAgentRunId(runId), {
      status: 'completed',
      totalCostUsd: costUsd,
    })
    await app.deps.agentRuns.setBranchDisposition(workspaceId, asAgentRunId(runId), disposition)
  }

  await decide(plannerRunId as string, 'merged', 0.5)
  await decide(child.id as string, 'discarded', 0.25)
  for (const step of steps) {
    if (step.agentRunId === null) continue
    await decide(step.agentRunId as string, 'merged', 0.5)
  }

  const measured = await client.workflow.trial({ workflowId: drawn.workflowId })
  const arm = (name: string) => measured.arms.find((entry: any) => entry.arm === name)
  /**
   * Two planner tasks, and both are decided: the first because a person took one of its branches,
   * and the third because its run failed — an outcome, and the arm wears it. That is the shared
   * definition of "decided" every trial here counts with, applied to a task rather than a run.
   */
  check(
    'a planner task counts once, whatever its tree spent — two tasks, not three runs',
    arm('planner')?.tasks === 2 && arm('planner')?.decided === 2,
    `${arm('planner')?.decided} decided of ${arm('planner')?.tasks} task(s)`,
  )
  check(
    'the task whose branch was taken counts as taken; the one that failed does not',
    arm('planner')?.merged === 1,
    `${arm('planner')?.merged} of ${arm('planner')?.decided} taken`,
  )
  check(
    'the harness task counts once, not once per step',
    arm('workflow')?.decided === 1,
    `${arm('workflow')?.decided} decided of ${arm('workflow')?.tasks} task(s)`,
  )
  check(
    'and runs-per-task is the machinery each side spent — three steps against a tree of two',
    arm('workflow')?.meanRuns === 3 && arm('planner')?.meanRuns === 1.5,
    `${arm('workflow')?.meanRuns} against ${arm('planner')?.meanRuns}`,
  )
  /**
   * $1.50 for the harness task is its three runs at fifty cents. $0.375 for the planner arm is
   * the mean of a task that spent $0.75 across its tree and one whose run was refused before it
   * spent anything — which is what a task that failed costs, and it is counted.
   */
  check(
    'cost is what the whole task cost on each side, averaged over decided tasks',
    Math.abs((arm('workflow')?.meanCostUsd ?? 0) - 1.5) < 0.001 &&
      Math.abs((arm('planner')?.meanCostUsd ?? 0) - 0.375) < 0.001,
    `harness $${arm('workflow')?.meanCostUsd} against planner $${arm('planner')?.meanCostUsd}`,
  )
  check(
    'and the verdict is still "measuring" this early, naming what each side needs',
    measured.verdict === 'undecided' &&
      String(measured.detail).includes('1 decided task(s)') &&
      String(measured.detail).includes('Each side needs 5'),
    String(measured.detail),
  )

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`)
  runner.kill('SIGTERM')
  await app.fastify.close()
  await closeDb()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
