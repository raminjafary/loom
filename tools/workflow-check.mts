/**
 * Live driver for drawn workflows: real server, real Runner *process*, real WebSocket protocol,
 * real git repository, real Postgres, real HTTP contract.
 *
 *   docker compose up -d
 *   npx tsx tools/workflow-check.mts
 *
 * Why this exists alongside the tests. `workflow-graph.test.ts` and `workflow-executor.test.ts`
 * drive the decision as a pure function, `workflow-queue.test.ts` drives the tick against
 * stubbed ports, `repositories.integration.test.ts` drives the rows against real Postgres, and
 * `app.integration.test.ts` drives the contract. **No workflow had ever dealt a real run.**
 *
 * Spends **no tokens**, the substitution `campaign-check.mts` and `screen-check.mts` make: the
 * step runs it starts are refused by the Runner's own unsandboxed guard, which fires *after* the
 * clone. So every step has a real workspace at a real commit, and no model is ever called.
 *
 * Six things only this can settle:
 *
 * 1. **A step is an ordinary run.** Parentless, `relation: 'workflow'`, a real clone, in the
 *    thread the execution was opened in — visible to a person watching, metered like anything
 *    else, and not a second orchestration layer the platform never sees.
 * 2. **The prompt a step is given is the rendered one.** The execution's own input reaches the
 *    first node's task, and no `{{...}}` survives into what a model would have read.
 * 3. **A fan opens one lane per element, each with its own item**, at the width the graph set
 *    rather than the length the answering step wrote.
 * 4. **A lane moves on without its siblings**, and the barrier below opens only when every one
 *    of them has arrived. This is the claim the whole shape exists for and the one a stub can
 *    only assert about itself.
 * 5. **The answer channel refuses what the graph cannot read** — a list that came back as a
 *    sentence, and a run that is not a step at all — through the same use case the Runner's
 *    tool calls.
 * 6. **The cap halts rather than degrades.**
 * 7. **A bracket seats a real tournament from the execution's own id**, its second round is a
 *    row rather than a collision with the first, and the step below it is handed the champion
 *    rather than whichever match happened to be last.
 *
 * What it does *not* prove, stated plainly because it is this driver's limit: the answers below
 * are written by the driver through `recordWorkflowAnswer` rather than earned by a model, since
 * the unsandboxed refusal means no step run ever reaches its tool. What is proved is the
 * validation, the dispatch, the rendering, the lanes, the barrier, the cap, the settling and the
 * close.
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
import {
  advanceWorkflowQueue,
  recordWorkflowAnswer,
} from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import {
  asAgentRunId,
  asWorkflowRunId,
  asWorkspaceId,
  bracketMatches,
  bracketSeeding,
  STEP_UNANSWERED,
} from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'workflow-check-secret-at-least-32-characters',
  WS_SUBSCRIPTION_SECRET: 'workflow-check-subscription-secret-32-ch',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/**
 * Every answer below is written by the driver through `recordWorkflowAnswer` — the same use case
 * the Runner's tool calls — rather than earned, because the unsandboxed refusal means no step run
 * ever reaches its tool. Each has to be written in the window between the tick that dealt the
 * step and the tick that settles it: a step whose run ended without answering is a refusal, which
 * is correct behaviour and would make this driver measure the refusal path instead of the shape.
 */

const SCOUT = 'workflow-check-scout'
const HAND = 'workflow-check-hand'
const CHECKER = 'workflow-check-checker'

const personaDoc = (name: string) =>
  [
    '---',
    `name: ${name}`,
    'description: Never actually runs; the dispatch and the prompt are what matter.',
    'model: claude-haiku-4-5-20251001',
    'tools: [Read]',
    '---',
    '',
    `The ${name} document.`,
  ].join('\n')

/**
 * discover -> transform each site -> check that site (still in its own lane) -> barrier -> report.
 *
 * The migration sweep in miniature, and chosen because it is the shape where every claim above
 * is visible at once: a fan, a step that stays in the fan's lane, and a barrier that must not
 * open early.
 */
const graph = {
  nodes: [
    {
      kind: 'step',
      id: 'discover',
      title: 'Find the sites',
      persona: SCOUT,
      task: 'Find every site of: {{input}}',
      answer: { fields: [{ kind: 'list', name: 'sites' }] },
    },
    {
      kind: 'fan',
      id: 'transform',
      title: 'Change each site',
      persona: HAND,
      task: 'Change this one site: {{item}}',
      source: 'discover',
      over: 'sites',
      maxWidth: 3,
      answer: { fields: [{ kind: 'text', name: 'diff' }] },
    },
    {
      kind: 'step',
      id: 'verify',
      title: 'Check that site',
      persona: CHECKER,
      task: 'Check this change: {{transform.diff}}',
      answer: { fields: [{ kind: 'text', name: 'verdict' }] },
    },
    { kind: 'barrier', id: 'swept', title: 'Every site done' },
    {
      kind: 'step',
      id: 'report',
      title: 'Report the sweep',
      persona: SCOUT,
      task: 'Report on {{verify.verdict}}',
      answer: null,
    },
  ],
  edges: [
    { from: 'discover', to: 'transform' },
    { from: 'transform', to: 'verify' },
    { from: 'verify', to: 'swept' },
    { from: 'discover', to: 'swept' },
    { from: 'swept', to: 'report' },
  ],
}

/**
 * approaches -> attempt each -> barrier -> a bracket that judges them two at a time -> ship.
 *
 * The one shape whose rows are *rounds*, and the only claim in this file that a stub cannot make
 * about itself: that the pairing a real execution deals is the pairing the seed produces from the
 * execution's own id, and that a second round is dealt from what the first round answered.
 */
const bracketGraph = {
  nodes: [
    {
      kind: 'step',
      id: 'approaches',
      title: 'Name the ways',
      persona: SCOUT,
      task: 'Name the ways to: {{input}}',
      answer: { fields: [{ kind: 'list', name: 'ways' }] },
    },
    {
      kind: 'fan',
      id: 'attempt',
      title: 'Attempt each way',
      persona: HAND,
      task: 'Attempt this one way: {{item}}',
      source: 'approaches',
      over: 'ways',
      maxWidth: 4,
      answer: { fields: [{ kind: 'text', name: 'result' }] },
    },
    { kind: 'barrier', id: 'attempted', title: 'Every attempt in' },
    {
      kind: 'bracket',
      id: 'judge',
      title: 'Judge two at a time',
      persona: CHECKER,
      task: 'Which is better, {{left}} or {{right}}?',
      entrants: 'attempt',
      over: 'result',
      maxEntrants: 4,
      answer: { fields: [{ kind: 'text', name: 'why' }] },
    },
    {
      kind: 'step',
      id: 'ship',
      title: 'Carry out the winner',
      persona: SCOUT,
      task: 'Carry out {{judge.champion}} because {{judge.why}}',
      answer: null,
    },
  ],
  edges: [
    { from: 'approaches', to: 'attempt' },
    { from: 'attempt', to: 'attempted' },
    { from: 'approaches', to: 'attempted' },
    { from: 'attempted', to: 'judge' },
    { from: 'judge', to: 'ship' },
  ],
}

const main = async () => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `workflow-check-${Date.now()}`)
  const workspaceId = asWorkspaceId(ws.id)
  const app = await buildApp(config, devAuth({ userId: 'workflow-check-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${addr.port}`
  const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
  console.log('server on', base)

  const repoPath = await mkdtemp(join(tmpdir(), 'workflow-check-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  await writeFile(join(repoPath, 'README.md'), '# the tree a step opens on\n')
  await git(repoPath, ['add', '-A'])
  await git(repoPath, [
    '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'first',
  ])
  const head = await git(repoPath, ['rev-parse', 'HEAD'])

  const { runnerId, rawToken } = await client.runner.createPairingToken({
    name: 'workflow-check-runner',
  })
  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: tmpdir(),
      // Unsandboxed and unacknowledged: the run is refused right after its clone is prepared,
      // which costs nothing and still leaves a real workspace at the real commit.
      LOOM_SANDBOX_ENABLED: '0',
      LOOM_ALLOW_UNSANDBOXED: '',
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `workflow-check-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 4000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: repoPath,
    displayName: 'workflow check repo',
  })
  for (const name of [SCOUT, HAND, CHECKER]) {
    await client.persona.create({ markdownSource: personaDoc(name) })
  }
  const channel = await client.channel.create({ name: 'workflow-check' })

  console.log('\n— the gate refuses a shape before it can spend —')
  const badFan = await client.workflow.create({
    name: 'a fan of identical runs',
    description: null,
    graph: {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === 'transform' ? { ...node, task: 'Change every site.' } : node,
      ),
    },
  })
  check(
    'a fan whose lanes would all read the same prompt is refused, by name',
    badFan.workflowId === null && String(badFan.detail).includes('the same instructions'),
    String(badFan.detail),
  )
  const unknownPersona = await client.workflow.create({
    name: 'a shape for another workspace',
    description: null,
    graph: {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === 'report' ? { ...node, persona: 'nobody-here' } : node,
      ),
    },
  })
  check(
    'and so is one naming a persona this workspace does not have',
    unknownPersona.workflowId === null &&
      String(unknownPersona.detail).includes('does not have'),
    String(unknownPersona.detail),
  )

  console.log('\n— a person draws one over the real contract —')
  const created = await client.workflow.create({
    name: 'workflow-check sweep',
    description: 'discover, change each site, check each, report',
    graph,
  })
  check('the workflow was drawn', created.workflowId !== null, String(created.detail))
  const read = await client.workflow.read({ workflowId: created.workflowId })
  check('it comes back at version 1 with a digest', read?.version === 1 && read?.digest?.length === 64)
  check(
    'and its ceiling names the fan and its bound before anything runs',
    String(read?.detail).includes('up to 3 times'),
    String(read?.detail).split('\n').join(' | '),
  )

  console.log('\n— an execution deals its first step, and only that one —')
  const ASK = 'the-thing-this-execution-is-about'
  const started = await client.workflow.start({
    workflowId: created.workflowId,
    repositoryId: repo.id,
    threadId: channel.rootThread.id,
    input: ASK,
    capUsd: 5,
  })
  check('the execution opened', started.runId !== null, String(started.detail))
  const runId = asWorkflowRunId(started.runId)

  /**
   * One tick, then long enough for every run it dealt to be refused by the Runner.
   *
   * The wait is what makes the next tick able to settle them: a step is settled when its *run*
   * is terminal, and a driver that ticked twice in a row would be measuring its own timing.
   */
  const tick = async () => {
    await advanceWorkflowQueue(app.deps, { stepStuckMs: 3_600_000, maxStartsPerTick: 16 })
    await new Promise((r) => setTimeout(r, 7000))
  }

  await tick()

  let steps = await app.deps.workflows.stepsForRun(workspaceId, runId)
  check('exactly one step was dealt', steps.length === 1, steps.map((s) => s.nodeId).join(','))
  check('and it is the node nothing waits for', steps[0]?.nodeId === 'discover')

  const firstRunId = steps[0]?.agentRunId
  const firstRun = firstRunId ? await app.deps.agentRuns.findById(workspaceId, firstRunId) : null
  check(
    'the step is a parentless run carrying `relation: workflow`',
    firstRun?.parentRunId === null && firstRun?.relation === 'workflow',
    `${firstRun?.parentRunId === null ? 'root' : 'child'}/${firstRun?.relation ?? 'null'}`,
  )
  check(
    'it ran in the thread the execution was opened in',
    firstRun?.threadId === channel.rootThread.id,
  )
  check(
    'against a real clone at the repository head',
    firstRun?.clonePath !== null && firstRun?.baseCommitSha === head,
    `${firstRun?.clonePath ?? 'no clone'} @ ${firstRun?.baseCommitSha?.slice(0, 12) ?? '?'}`,
  )
  check(
    'and the task it was given is the rendered one, with the execution’s own input in it',
    firstRun?.task === `Find every site of: ${ASK}`,
    String(firstRun?.task),
  )
  check(
    'with no unrendered reference left for a model to read as instructions',
    !String(firstRun?.task).includes('{{'),
  )

  console.log('\n— the answer channel is the one the Runner’s tool calls —')
  const wrongShape = await recordWorkflowAnswer(app.deps, {
    workspaceId,
    agentRunId: firstRunId!,
    answer: { sites: 'one site and another' },
  })
  check(
    'a list that came back as a sentence is refused, and the refusal says what was wrong',
    wrongShape.ok === false && String((wrongShape as any).error).includes('rather than a list'),
    String((wrongShape as any).error ?? ''),
  )
  const stranger = await recordWorkflowAnswer(app.deps, {
    workspaceId,
    agentRunId: asAgentRunId('00000000-0000-4000-8000-0000000000ff'),
    answer: { sites: ['x'] },
  })
  check('a run that is not a step of any workflow cannot answer', stranger.ok === false)

  /**
   * Four sites answered against a fan of three: what the graph bounds is what runs. The width a
   * human drew is the only bound that was chosen by a human, and the list here was written by
   * the step the fan is fanning over.
   */
  const answered = await recordWorkflowAnswer(app.deps, {
    workspaceId,
    agentRunId: firstRunId!,
    answer: { sites: ['site-alpha', 'site-beta', 'site-gamma', 'site-delta'] },
  })
  check('a well-shaped answer is accepted', answered.ok === true)

  console.log('\n— the fan opens one lane per site, each with its own item —')
  await tick()

  steps = await app.deps.workflows.stepsForRun(workspaceId, runId)
  const lanes = steps.filter((step) => step.nodeId === 'transform')
  check(
    'three lanes were dealt, not four',
    lanes.length === 3,
    `${lanes.length} lane(s) from a 4-item answer against maxWidth 3`,
  )
  check(
    'each lane carries its own site',
    [...lanes.map((lane) => lane.item)].sort().join(',') === 'site-alpha,site-beta,site-gamma',
    lanes.map((lane) => String(lane.item)).join(','),
  )
  const laneRuns = await Promise.all(
    lanes.map((lane) =>
      lane.agentRunId ? app.deps.agentRuns.findById(workspaceId, lane.agentRunId) : null,
    ),
  )
  check(
    'and each lane’s prompt is its own site rather than the list',
    laneRuns.every((run) => /^Change this one site: site-(alpha|beta|gamma)$/.test(String(run?.task))),
    laneRuns.map((run) => String(run?.task)).join(' | '),
  )
  check(
    'the step that fanned is settled as answered even though its run was refused',
    steps.find((step) => step.nodeId === 'discover')?.status === 'answered',
    String(steps.find((step) => step.nodeId === 'discover')?.status),
  )

  console.log('\n— one lane at a time: a lane that answered moves on, one that did not is skipped —')
  /**
   * Only the first lane answers. The other two runs are already refused by the Runner, which is
   * this driver's substitute for a step that failed — and the claim under test is that a refusal
   * stops *its own lane* rather than the execution.
   */
  const firstLane = lanes[0]!
  await recordWorkflowAnswer(app.deps, {
    workspaceId,
    agentRunId: firstLane.agentRunId!,
    answer: { diff: `a change at ${firstLane.item}` },
  })
  await tick()

  steps = await app.deps.workflows.stepsForRun(workspaceId, runId)
  const checks = steps.filter((step) => step.nodeId === 'verify')
  check(
    'the check below the answered lane was dealt a real run',
    checks.filter((step) => step.agentRunId !== null).length === 1,
    checks.map((step) => `${step.itemIndex}:${step.status}`).join(' '),
  )
  check(
    'and the checks below the refused lanes are skipped, naming why, rather than blocking',
    checks.filter((step) => step.status === 'skipped').length === 2 &&
      checks.some((step) => String(step.reason).includes('did not answer in this lane')),
    checks.map((step) => `${step.itemIndex}:${step.status}`).join(' '),
  )
  check(
    'the barrier has not opened while the surviving lane is still going',
    steps.every((step) => step.nodeId !== 'swept'),
    steps.map((step) => step.nodeId).join(','),
  )

  console.log('\n— the barrier opens on what arrived, and the step past it reads every lane —')
  // The surviving lane's check answers, in the window before the next tick settles it.
  for (const step of checks) {
    if (step.agentRunId === null || step.status !== 'running') continue
    await recordWorkflowAnswer(app.deps, {
      workspaceId,
      agentRunId: step.agentRunId,
      answer: { verdict: `lane ${step.itemIndex} holds` },
    })
  }
  await tick()

  steps = await app.deps.workflows.stepsForRun(workspaceId, runId)
  const barrier = steps.find((step) => step.nodeId === 'swept')
  check(
    'once every lane has settled the barrier opens, without a run of its own',
    barrier !== undefined && barrier.status === 'answered' && barrier.agentRunId === null,
    barrier === undefined ? 'never opened' : `${barrier.status}/${barrier.agentRunId ?? 'no run'}`,
  )
  check(
    'and it cost nothing, because a barrier starts nothing',
    barrier?.costUsd === null,
    String(barrier?.costUsd),
  )

  await tick()
  steps = await app.deps.workflows.stepsForRun(workspaceId, runId)
  const report = steps.find((step) => step.nodeId === 'report')
  const reportRun = report?.agentRunId
    ? await app.deps.agentRuns.findById(workspaceId, report.agentRunId)
    : null
  check(
    'the step past the barrier is given what the lanes that answered produced',
    String(reportRun?.task).includes('lane 0 holds'),
    String(reportRun?.task).split('\n').join(' | '),
  )

  console.log('\n— a person reads the execution back over the contract —')
  const view = await client.workflow.run({ runId: started.runId })
  check('every step is on the wire with its node id', (view?.steps?.length ?? 0) >= 8, `${view?.steps?.length ?? 0} steps`)
  check(
    'each lane is identified by its item, not only by its index',
    (view?.steps ?? []).some((step: any) => step.item === 'site-beta'),
  )
  check('the run reports what it has spent', typeof view?.spentUsd === 'number', String(view?.spentUsd))

  console.log('\n— the cap halts rather than degrading —')
  const capped = await client.workflow.start({
    workflowId: created.workflowId,
    repositoryId: repo.id,
    threadId: channel.rootThread.id,
    input: 'a second ask, on a cap that is already reached',
    capUsd: 0.01,
  })
  const cappedId = asWorkflowRunId(capped.runId)
  /**
   * The first step is settled *answered* and expensive, written by the driver: a refused run is
   * metered at nothing, and a first step that answered nothing would leave the execution with
   * no lanes to deal and close it as failed rather than halting it. What is under test here is
   * the halt, so the graph has to have somewhere to go and no budget to go there with.
   */
  await app.deps.workflows.claimStep({
    workspaceId,
    workflowRunId: cappedId,
    nodeId: 'discover',
    pass: 0,
    itemIndex: 0,
    attempt: 0,
    item: null,
  })
  const cappedSteps = await app.deps.workflows.stepsForRun(workspaceId, cappedId)
  await app.deps.workflows.finishStep(workspaceId, cappedSteps[0]!.id, {
    status: 'answered',
    answer: { sites: ['one', 'two'] },
    reason: null,
    costUsd: 5,
  })
  await advanceWorkflowQueue(app.deps, { stepStuckMs: 3_600_000, maxStartsPerTick: 16 })
  const cappedRun = await app.deps.workflows.findRun(workspaceId, cappedId)
  check(
    'the execution is halted, not finished',
    cappedRun?.status === 'halted',
    `${cappedRun?.status} — ${cappedRun?.haltReason ?? 'no reason'}`,
  )
  check(
    'and the halt says what it produced is partial',
    String(cappedRun?.haltReason).includes('partial'),
    String(cappedRun?.haltReason),
  )

  console.log('\n— a bracket seats a real tournament, from the execution’s own id —')
  const selfJudged = await client.workflow.create({
    name: 'a judge that wrote what it judges',
    description: null,
    graph: {
      ...bracketGraph,
      nodes: bracketGraph.nodes.map((node) =>
        node.id === 'judge' ? { ...node, persona: HAND } : node,
      ),
    },
  })
  check(
    'a judge running the persona that made the attempts is refused',
    selfJudged.workflowId === null && String(selfJudged.detail).includes('tournament'),
    String(selfJudged.detail),
  )

  const drawn = await client.workflow.create({
    name: 'workflow-check tournament',
    description: 'name the ways, attempt each, judge them two at a time, carry out the winner',
    graph: bracketGraph,
  })
  check('the tournament was drawn', drawn.workflowId !== null, String(drawn.detail))
  const drawnDetail = await client.workflow.read({ workflowId: drawn.workflowId })
  check(
    'and its ceiling prices the matches rather than the entrants',
    String(drawnDetail?.detail).includes('3 match(es)'),
    String(drawnDetail?.detail).split('\n').join(' | '),
  )

  const tournamentRun = await client.workflow.start({
    workflowId: drawn.workflowId,
    repositoryId: repo.id,
    threadId: channel.rootThread.id,
    input: 'the-hard-problem',
    capUsd: 5,
  })
  const bracketRunId = asWorkflowRunId(tournamentRun.runId)
  await tick()

  let bracketSteps = await app.deps.workflows.stepsForRun(workspaceId, bracketRunId)
  const ways = bracketSteps.find((entry) => entry.nodeId === 'approaches')
  await recordWorkflowAnswer(app.deps, {
    workspaceId,
    agentRunId: ways!.agentRunId!,
    answer: { ways: ['way-alpha', 'way-beta', 'way-gamma'] },
  })
  await tick()

  bracketSteps = await app.deps.workflows.stepsForRun(workspaceId, bracketRunId)
  const tries = bracketSteps.filter((entry) => entry.nodeId === 'attempt')
  check('every way was attempted in its own lane', tries.length === 3, `${tries.length} lane(s)`)
  const RESULTS: Record<string, string> = {
    'way-alpha': 'the alpha attempt',
    'way-beta': 'the beta attempt',
    'way-gamma': 'the gamma attempt',
  }
  for (const attempt of tries) {
    if (attempt.agentRunId === null) continue
    await recordWorkflowAnswer(app.deps, {
      workspaceId,
      agentRunId: attempt.agentRunId,
      answer: { result: RESULTS[String(attempt.item)] ?? `an attempt at ${attempt.item}` },
    })
  }
  await tick()

  /**
   * Two ticks, not one. The first settles the attempts and writes the barrier's row; the plan is
   * computed once per tick, so the round the barrier opened onto is dealt by the next one.
   */
  bracketSteps = await app.deps.workflows.stepsForRun(workspaceId, bracketRunId)
  check(
    'the barrier below the attempts opened once every lane had settled',
    bracketSteps.find((entry) => entry.nodeId === 'attempted')?.status === 'answered',
    String(bracketSteps.find((entry) => entry.nodeId === 'attempted')?.status),
  )
  await tick()

  bracketSteps = await app.deps.workflows.stepsForRun(workspaceId, bracketRunId)
  const firstRound = bracketSteps.filter((entry) => entry.nodeId === 'judge' && entry.pass === 0)
  check(
    'three entrants make one match and one bye, not three runs',
    firstRound.length === 1,
    `${firstRound.length} match(es) in round 0`,
  )
  /**
   * The pairing is re-derived here from the execution's id and compared against the prompt the
   * Runner was actually given. Seeded from anything else — a clock, a counter, the graph alone —
   * these are different two entrants.
   */
  const entrants = bracketSeeding(
    tournamentRun.runId,
    'judge',
    tries
      .map((attempt) => RESULTS[String(attempt.item)] ?? '')
      .filter((result) => result !== ''),
    4,
  )
  const expected = bracketMatches(tournamentRun.runId, 'judge', 0, entrants).matches[0]
  const firstMatch = firstRound[0]
  if (firstMatch === undefined || firstMatch.agentRunId === null) {
    check('a first-round match was dealt to a real run', false, 'nothing to judge')
    console.log(`\n${failures} check(s) FAILED`)
    runner.kill('SIGTERM')
    await app.fastify.close()
    await closeDb()
    process.exit(1)
  }
  const matchRun = await app.deps.agentRuns.findById(workspaceId, firstMatch.agentRunId)
  check(
    'the match a real judge was dealt is the one this execution’s id seats',
    matchRun?.task === `Which is better, ${expected?.left} or ${expected?.right}?`,
    `${String(matchRun?.task)} — expected ${expected?.left} / ${expected?.right}`,
  )
  check(
    'the row names the pair, so two matches are told apart in the journal',
    String(firstMatch.item).includes('⟂'),
    String(firstMatch.item),
  )

  const badSide = await recordWorkflowAnswer(app.deps, {
    workspaceId,
    agentRunId: firstMatch.agentRunId,
    answer: { winner: 'the second one', why: 'it looked better' },
  })
  check(
    'a side outside the vocabulary is refused, naming the two words',
    badSide.ok === false && String((badSide as any).error).includes('left, right'),
    String((badSide as any).error ?? ''),
  )
  const judged = await recordWorkflowAnswer(app.deps, {
    workspaceId,
    agentRunId: firstMatch.agentRunId,
    answer: { winner: 'left', why: 'it carried the work further' },
  })
  check('and a side that is one of them is taken', judged.ok === true)
  await tick()

  bracketSteps = await app.deps.workflows.stepsForRun(workspaceId, bracketRunId)
  const secondRound = bracketSteps.filter((entry) => entry.nodeId === 'judge' && entry.pass === 1)
  check(
    'the next round is a row of its own rather than a collision with the first',
    secondRound.length === 1,
    `${secondRound.length} match(es) in round 1`,
  )
  const secondMatch = secondRound[0]
  const secondRun =
    secondMatch === undefined || secondMatch.agentRunId === null
      ? null
      : await app.deps.agentRuns.findById(workspaceId, secondMatch.agentRunId)
  check(
    'and it pairs the winner of round 0 against the entrant that sat it out',
    String(secondRun?.task).includes(String(expected?.left)) &&
      !String(secondRun?.task).includes(String(expected?.right)),
    String(secondRun?.task),
  )

  if (secondMatch?.agentRunId != null) {
    await recordWorkflowAnswer(app.deps, {
      workspaceId,
      agentRunId: secondMatch.agentRunId,
      answer: { winner: 'right', why: 'it holds up under the tests' },
    })
  }
  await tick()
  await tick()

  bracketSteps = await app.deps.workflows.stepsForRun(workspaceId, bracketRunId)
  const shipped = bracketSteps.find((entry) => entry.nodeId === 'ship')
  const shippedRun =
    shipped?.agentRunId === null || shipped?.agentRunId === undefined
      ? null
      : await app.deps.agentRuns.findById(workspaceId, shipped.agentRunId)
  check(
    'the step below the bracket is given the champion, not a match',
    /^Carry out the (alpha|beta|gamma) attempt because it holds up under the tests$/.test(
      String(shippedRun?.task),
    ),
    String(shippedRun?.task),
  )
  check(
    'with no unrendered reference left in it',
    shippedRun !== null && !String(shippedRun?.task).includes('{{'),
  )
  const bracketView = await client.workflow.run({ runId: tournamentRun.runId })
  check(
    'and a person reads the rounds back over the contract',
    (bracketView?.steps ?? []).some((entry: any) => entry.nodeId === 'judge' && entry.pass === 1),
    (bracketView?.steps ?? [])
      .filter((entry: any) => entry.nodeId === 'judge')
      .map((entry: any) => `${entry.pass}:${entry.itemIndex}:${entry.status}`)
      .join(' '),
  )

  console.log('\n— a step that completed and answered nothing is dealt again, once —')
  const retried = await client.workflow.start({
    workflowId: created.workflowId,
    repositoryId: repo.id,
    threadId: channel.rootThread.id,
    input: 'a scope step that says nothing at all',
    capUsd: 5,
  })
  const retriedId = asWorkflowRunId(retried.runId)
  /**
   * The run is *completed* here rather than left to the Runner, and that is the whole point of
   * the check: a run the Runner refuses settles as `the run failed`, which is deliberately not
   * dealt again. Only a run that finished and never called its answer tool is a dice roll, and
   * this driver has no model in it to roll one.
   */
  const silence = async (attempt: number) => {
    const rows = await app.deps.workflows.stepsForRun(workspaceId, retriedId)
    const row = rows.find((entry) => entry.nodeId === 'discover' && entry.attempt === attempt)
    if (row?.agentRunId != null) {
      await app.deps.agentRuns.updateStatus(workspaceId, row.agentRunId, {
        status: 'completed',
        totalCostUsd: 0.05,
      })
    }
    return row
  }

  await tick()
  const firstTry = await silence(0)
  check('the first attempt was dealt to a real run', firstTry?.agentRunId != null)
  await tick()

  let attempts = (await app.deps.workflows.stepsForRun(workspaceId, retriedId)).filter(
    (entry) => entry.nodeId === 'discover',
  )
  const settledFirst = attempts.find((entry) => entry.attempt === 0)
  check(
    'the silent attempt is refused in the exact words the retry turns on',
    settledFirst?.status === 'refused' && settledFirst?.reason === STEP_UNANSWERED,
    `${settledFirst?.status} — ${settledFirst?.reason ?? 'no reason'}`,
  )
  const secondTry = attempts.find((entry) => entry.attempt === 1)
  check(
    'and the step is dealt a second time, as a row of its own rather than a replacement',
    attempts.length === 2 && secondTry?.agentRunId != null,
    attempts.map((entry) => `attempt ${entry.attempt}:${entry.status}`).join(' '),
  )
  const secondRunOfStep =
    secondTry?.agentRunId == null
      ? null
      : await app.deps.agentRuns.findById(workspaceId, secondTry.agentRunId)
  check(
    'the second attempt is asked the same question, rendered the same way',
    String(secondRunOfStep?.task).startsWith(
      'Find every site of: a scope step that says nothing at all',
    ),
    String(secondRunOfStep?.task).split('\n').join(' | '),
  )
  check(
    'and is told the attempt before it ended without submitting an answer',
    String(secondRunOfStep?.task).includes('without submitting an answer'),
  )
  const midRun = await app.deps.workflows.findRun(workspaceId, retriedId)
  check(
    'the execution is still running rather than closed under a refusal it retried',
    midRun?.status === 'running',
    `${midRun?.status} — ${midRun?.haltReason ?? 'no reason'}`,
  )
  const notSkipped = await app.deps.workflows.stepsForRun(workspaceId, retriedId)
  check(
    'and nothing below it was skipped in the tick that dealt the retry',
    notSkipped.every((entry) => entry.nodeId === 'discover'),
    notSkipped.map((entry) => `${entry.nodeId}:${entry.status}`).join(' '),
  )
  check(
    'both attempts are charged to the execution, so a retry cannot be free',
    Math.abs((await app.deps.workflows.spentOnRun(workspaceId, retriedId)) - 0.05) < 1e-9,
    String(await app.deps.workflows.spentOnRun(workspaceId, retriedId)),
  )

  await silence(1)
  await tick()
  await tick()
  await tick()
  attempts = (await app.deps.workflows.stepsForRun(workspaceId, retriedId)).filter(
    (entry) => entry.nodeId === 'discover',
  )
  check(
    'a step that goes silent twice is not dealt a third time',
    attempts.length === 2,
    `${attempts.length} attempt(s)`,
  )
  const closedRun = await app.deps.workflows.findRun(workspaceId, retriedId)
  check(
    'the execution closes as failed rather than waiting on lanes that cannot open',
    closedRun?.status === 'failed',
    `${closedRun?.status}`,
  )
  check(
    'and its reason names the step that cost it, and how many attempts it had',
    String(closedRun?.haltReason).includes('"discover"') &&
      String(closedRun?.haltReason).includes('all 2 attempts'),
    String(closedRun?.haltReason),
  )
  check(
    'the spend of both attempts survives on the rows',
    Math.abs((await app.deps.workflows.spentOnRun(workspaceId, retriedId)) - 0.1) < 1e-9,
    String(await app.deps.workflows.spentOnRun(workspaceId, retriedId)),
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
