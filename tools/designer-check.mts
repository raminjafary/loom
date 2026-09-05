/**
 * Live driver for the designer agent: real server, real Runner *process*, real WebSocket
 * protocol, real git repository, real Postgres, real HTTP contract.
 *
 *   docker compose up -d
 *   npx tsx tools/designer-check.mts
 *
 * Why this exists alongside the tests. `workflow-design.test.ts` drives the rules against stubbed
 * ports and `repositories.integration.test.ts` drives the rows against real Postgres. **No
 * proposal had ever crossed the contract**, and the thing most likely to be wrong is not a rule
 * but a wire: a relation the mapper does not list, a frame the gateway drops, a graph that
 * survives validation and cannot be read back.
 *
 * Spends **no tokens**, the substitution every driver here makes: the designer run it starts is
 * refused by the Runner's own unsandboxed guard, which fires *after* the clone — so the run is
 * real, its persona snapshot is real, and no model is ever called. The submission is then written
 * through `recordWorkflowDesign`, which is the same use case the Runner's tool call reaches.
 *
 * Seven things only this can settle:
 *
 * 1. **A designer is an ordinary run** — parentless, `relation: 'design'`, a real clone, in the
 *    thread the person asked in — and the relation survives the round trip through the database,
 *    which is exactly where `workflow` was silently dropped once before.
 * 2. **The brief is what the designer is actually given**: the roster with what each persona
 *    holds, the harnesses this workspace already has, and the vocabulary — in the run's own task,
 *    with no unrendered placeholder in it.
 * 3. **A proposal is refused before it is stored**, in the validator's own words, by the same
 *    channel the tool calls.
 * 4. **A shape naming a persona outside the designing run's envelope is refused** — the claim the
 *    whole shape rests on, and the one a stub can only assert about itself.
 * 5. **Approving is what writes the version**, and a proposal against an existing name writes the
 *    *next version* of that harness rather than a second harness with the same name.
 * 6. **Declining writes nothing**, and keeps the reason.
 * 7. **A proposal crosses the contract as a shape a person can read** — the graph, the one-line
 *    summary, and the ceiling it would spend.
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
import { recordWorkflowDesign } from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import { asAgentRunId, asWorkspaceId } from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'designer-check-secret-at-least-32-characters',
  WS_SUBSCRIPTION_SECRET: 'designer-check-subscription-secret-32-ch',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const DESIGNER = 'designer-check-designer'
const WORKER = 'designer-check-worker'
const SHELL = 'designer-check-shell'
const REVIEWER = 'designer-check-reviewer'

/**
 * The designer is a planner with an envelope, because drawing a step that runs a persona is
 * delegating to it a version at a time. `SHELL` sits *outside* that envelope on purpose: it is
 * the persona a proposal must not be able to name.
 */
const personaDoc = (
  name: string,
  input: { model?: string; tools: string; harness?: Record<string, string> },
) =>
  [
    '---',
    `name: ${name}`,
    'description: Never actually runs; the dispatch, the brief and the refusals are the point.',
    `model: ${input.model ?? 'claude-opus-5'}`,
    `tools: ${input.tools}`,
    ...(input.harness === undefined
      ? []
      : ['harness:', ...Object.entries(input.harness).map(([key, value]) => `  ${key}: ${value}`)]),
    '---',
    '',
    `The ${name} document.`,
  ].join('\n')

/** A shape the designer's own envelope covers: one step, then a fan of the worker. */
const shapeNaming = (worker: string) => ({
  nodes: [
    {
      kind: 'step',
      id: 'scope',
      title: 'Scope it',
      persona: DESIGNER,
      task: 'Split up: {{input}}',
      answer: { fields: [{ kind: 'list', name: 'parts' }] },
    },
    {
      kind: 'fan',
      id: 'work',
      title: 'Do each part',
      persona: worker,
      task: 'Do this one part: {{item}}',
      source: 'scope',
      over: 'parts',
      maxWidth: 3,
      answer: { fields: [{ kind: 'text', name: 'done' }] },
    },
  ],
  edges: [
    { from: 'scope', to: 'work' },
  ],
})

const main = async () => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `designer-check-${Date.now()}`)
  const workspaceId = asWorkspaceId(ws.id)
  const app = await buildApp(config, devAuth({ userId: 'designer-check-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${addr.port}`
  const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
  console.log('server on', base)

  const repoPath = await mkdtemp(join(tmpdir(), 'designer-check-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  await writeFile(join(repoPath, 'README.md'), '# the tree a designer reads\n')
  await git(repoPath, ['add', '-A'])
  await git(repoPath, [
    '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'first',
  ])

  const { runnerId, rawToken } = await client.runner.createPairingToken({
    name: 'designer-check-runner',
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
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `designer-check-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 4000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: repoPath,
    displayName: 'designer check repo',
  })
  const designer = await client.persona.create({
    markdownSource: personaDoc(DESIGNER, {
      tools: '[Read, Grep, Glob]',
      harness: {
        planner: 'true',
        delegates: '[Read, Grep, Glob, Edit, Write]',
        approvalMode: 'auto',
      },
    }),
  })
  await client.persona.create({
    markdownSource: personaDoc(WORKER, {
      model: 'claude-sonnet-5',
      tools: '[Read, Edit]',
      harness: { approvalMode: 'auto' },
    }),
  })
  await client.persona.create({
    markdownSource: personaDoc(SHELL, {
      model: 'claude-sonnet-5',
      tools: '[Read, Bash]',
      harness: { approvalMode: 'auto' },
    }),
  })
  await client.persona.create({
    markdownSource: personaDoc(REVIEWER, {
      model: 'claude-sonnet-5',
      tools: '[Read, Grep]',
      harness: { approvalMode: 'auto' },
    }),
  })
  const channel = await client.channel.create({ name: 'designer-check' })

  /**
   * One harness drawn by hand before anybody asks for one, so the brief has something to say
   * about what this workspace already has — which is the answer that costs nobody a version.
   */
  const drawnByHand = await client.workflow.create({
    name: 'a harness drawn by hand',
    description: 'so the designer can be told it already exists',
    graph: shapeNaming(WORKER),
  })
  check(
    'a harness drawn by hand, for the designer to be told about',
    drawnByHand.workflowId !== null,
    String(drawnByHand.detail),
  )

  console.log('\n— a person asks for a harness, in words —')
  const ASK = 'a way to triage a flaky test without one agent grading its own change'
  const asked = await client.workflow.design({
    personaId: designer.id,
    repositoryId: repo.id,
    threadId: channel.rootThread.id,
    ask: ASK,
  })
  check('the designer was started', asked.runId !== null, String(asked.detail))
  check(
    'and the person is told plainly that nothing is configured by it',
    String(asked.detail).includes('nothing is configured'),
    String(asked.detail),
  )

  const runId = asAgentRunId(asked.runId)
  // Long enough for the Runner to prepare the clone and be refused by its unsandboxed guard.
  await new Promise((r) => setTimeout(r, 7000))
  const run = await app.deps.agentRuns.findById(workspaceId, runId)
  check(
    'it is a parentless run carrying `relation: design`, read back from the database',
    run?.parentRunId === null && run?.relation === 'design',
    `${run?.parentRunId === null ? 'root' : 'child'}/${run?.relation ?? 'null'}`,
  )
  check(
    'it ran in the thread the person asked in, against a real clone',
    run?.threadId === channel.rootThread.id && run?.clonePath !== null,
    `${run?.threadId === channel.rootThread.id ? 'same thread' : 'elsewhere'} @ ${run?.clonePath ?? 'no clone'}`,
  )

  const brief = String(run?.task)
  check('the brief carries the ask verbatim', brief.includes(ASK))
  check(
    'and the roster with what each persona holds',
    brief.includes(`${WORKER} (claude-sonnet-5; Read, Edit)`),
    brief.split('\n').find((line) => line.includes(WORKER)) ?? 'no roster line',
  )
  check(
    'and names the persona it may NOT use, with the reason, before it draws',
    brief.includes('may NOT name') && brief.includes(SHELL),
    brief.split('\n').find((line) => line.includes(SHELL)) ?? 'no refusal line',
  )
  check(
    'and what this workspace already has, as one line each with its shape',
    brief.includes('WHAT THIS WORKSPACE ALREADY HAS') &&
      brief.includes('"a harness drawn by hand" (v1)') &&
      brief.includes('scope → work(×3)'),
    brief.split('\n').find((line) => line.includes('drawn by hand')) ?? 'no existing line',
  )
  check(
    'and the vocabulary, including the node kinds the validator accepts',
    ['`step`', '`fan`', '`router`', '`verifier`', '`bracket`', '`barrier`'].every((kind) =>
      brief.includes(kind),
    ),
  )
  check(
    'with no unrendered placeholder left in what a model would read',
    !brief.includes('{{ask}}') && !brief.includes('undefined'),
  )

  console.log('\n— the same channel the tool calls refuses a shape before it is stored —')
  const notADesigner = await recordWorkflowDesign(app.deps, {
    workspaceId,
    agentRunId: asAgentRunId('00000000-0000-4000-8000-0000000000ff'),
    name: 'x',
    description: null,
    rationale: 'y',
    graph: shapeNaming(WORKER),
  })
  check('a run that does not exist cannot propose', notADesigner.ok === false)

  const badShape = await recordWorkflowDesign(app.deps, {
    workspaceId,
    agentRunId: runId,
    name: 'a shape that cannot run',
    description: null,
    rationale: 'this should not survive validation',
    graph: {
      nodes: [
        {
          kind: 'step',
          id: 'scope',
          title: 'Scope',
          persona: DESIGNER,
          task: 'scope {{input}}',
          answer: { fields: [{ kind: 'text', name: 'parts' }] },
        },
        {
          kind: 'fan',
          id: 'work',
          title: 'Work',
          persona: WORKER,
          task: 'do {{item}}',
          source: 'scope',
          over: 'parts',
          maxWidth: 3,
          answer: null,
        },
      ],
      edges: [{ from: 'scope', to: 'work' }],
    },
  })
  check(
    'a fan over a text field is refused in the validator’s own words',
    badShape.ok === false && String((badShape as any).error).includes('not a list'),
    String((badShape as any).error ?? ''),
  )

  /**
   * The claim the whole shape rests on. The designer holds no shell and may not hand one down,
   * so a harness whose lanes would each have one is refused *before* a person ever sees it —
   * approval is the second gate, not the only one.
   */
  const escalating = await recordWorkflowDesign(app.deps, {
    workspaceId,
    agentRunId: runId,
    name: 'a harness with a shell in every lane',
    description: null,
    rationale: 'every lane would run a shell the designer may not hand out',
    graph: shapeNaming(SHELL),
  })
  check(
    'a shape naming a persona outside the designer’s envelope is refused, by node and by tool',
    escalating.ok === false &&
      String((escalating as any).error).includes('Bash') &&
      String((escalating as any).error).includes('"work"'),
    String((escalating as any).error ?? ''),
  )

  console.log('\n— a proposal a person can read, and only a person can make real —')
  const proposed = await recordWorkflowDesign(app.deps, {
    workspaceId,
    agentRunId: runId,
    name: 'flaky test triage',
    description: 'when a test fails twice a week and nobody knows which',
    rationale:
      'one run cannot tell a flake from a break, and the agent that changed the code is the ' +
      'worst judge of whether it did: two lanes and a reviewer who wrote none of it can.',
    graph: shapeNaming(WORKER),
  })
  check('a shape inside the envelope is proposed', proposed.ok === true, String((proposed as any).error ?? ''))
  check(
    'and the outcome says a person decides, with the ceiling they will read',
    proposed.ok === true &&
      proposed.outcome.includes('Nothing runs until a person approves') &&
      proposed.outcome.includes('Worst case'),
    proposed.ok ? proposed.outcome.split('\n').join(' | ') : '',
  )

  const queue = await client.workflow.proposals({ status: 'proposed' })
  check('it is on the wire as a proposal', queue.length === 1, `${queue.length} proposal(s)`)
  const first = queue[0]
  check(
    'as a shape a person can read rather than as JSON in a queue',
    typeof first?.shape === 'string' && first.shape.includes('scope'),
    String(first?.shape),
  )
  check(
    'with the graph, the ceiling, the case for it, and who drew it',
    Array.isArray((first?.graph as any)?.nodes) &&
      String(first?.detail).includes('step(s)') &&
      String(first?.rationale).includes('flake from a break') &&
      first?.personaName === DESIGNER,
    `${first?.personaName ?? 'nobody'} · ${String(first?.detail).split('\n')[0]}`,
  )
  check(
    'and it is a new harness rather than a version of one',
    first?.workflowId === null,
    String(first?.workflowId),
  )

  const before = await client.workflow.list()
  check(
    'nothing was drawn by proposing it',
    !before.some((workflow: any) => workflow.name === 'flaky test triage'),
    before.map((workflow: any) => workflow.name).join(', '),
  )

  console.log('\n— approving is what writes the version —')
  const approved = await client.workflow.approveDesign({ designId: first.id })
  check(
    'it is drawn as version 1',
    approved.version === 1,
    `${String(approved.version)} — ${String(approved.detail)}`,
  )
  const after = await client.workflow.list()
  const drawn = after.find((workflow: any) => workflow.name === 'flaky test triage')
  check('and the harness exists at that version', drawn?.version === 1, String(drawn?.version))
  const again = await client.workflow.approveDesign({ designId: first.id })
  check(
    'approving it twice writes no second version',
    again.versionId === null && String(again.detail).includes('already approved'),
    String(again.detail),
  )

  console.log('\n— the same name proposes the next version, not a rival —')
  const revised = await recordWorkflowDesign(app.deps, {
    workspaceId,
    agentRunId: runId,
    name: 'flaky test triage',
    description: 'the same job, with somebody checking the work',
    rationale: 'the first version had nobody reviewing the lanes, which was the point of it',
    graph: {
      nodes: [
        ...shapeNaming(WORKER).nodes,
        { kind: 'barrier', id: 'done', title: 'Every part done' },
        {
          kind: 'step',
          id: 'review',
          title: 'Check the whole',
          persona: REVIEWER,
          task: 'You did none of this. Check it: {{work.done}}',
          answer: null,
        },
      ],
      edges: [
        ...shapeNaming(WORKER).edges,
        { from: 'work', to: 'done' },
        { from: 'scope', to: 'done' },
        { from: 'done', to: 'review' },
      ],
    },
  })
  check(
    'a proposal under an existing name is the next version of it',
    revised.ok === true && revised.outcome.includes('next version'),
    revised.ok ? revised.outcome.split('\n')[0] ?? '' : String((revised as any).error),
  )
  const identical = await recordWorkflowDesign(app.deps, {
    workspaceId,
    agentRunId: runId,
    name: 'flaky test triage',
    description: null,
    rationale: 'the shape it already has',
    graph: shapeNaming(WORKER),
  })
  check(
    'and a shape identical to the version in use is refused rather than queued',
    identical.ok === false && String((identical as any).error).includes('node for node'),
    String((identical as any).error ?? ''),
  )

  const open = await client.workflow.proposals({ status: 'proposed' })
  const version2 = open.find((proposal: any) => proposal.workflowId !== null)
  check('the next-version proposal is on the wire against its harness', version2 !== undefined)
  const approvedAgain = await client.workflow.approveDesign({ designId: version2.id })
  check(
    'approving it draws version 2 rather than a second harness of the same name',
    approvedAgain.version === 2,
    String(approvedAgain.detail),
  )
  const finalList = await client.workflow.list()
  check(
    'and there is still exactly one harness by that name',
    finalList.filter((workflow: any) => workflow.name === 'flaky test triage').length === 1,
  )

  console.log('\n— declining keeps the reason and writes nothing —')
  const third = await recordWorkflowDesign(app.deps, {
    workspaceId,
    agentRunId: runId,
    name: 'a harness nobody wants',
    description: null,
    rationale: 'proposed so that declining it can be checked',
    graph: shapeNaming(WORKER),
  })
  check('a third proposal from one session is still allowed', third.ok === true)
  const fourth = await recordWorkflowDesign(app.deps, {
    workspaceId,
    agentRunId: runId,
    name: 'one harness too many',
    description: null,
    rationale: 'a fourth from one session is a review queue rather than a case',
    graph: shapeNaming(WORKER),
  })
  check(
    'a fourth is refused, because a session may not fill a review queue',
    fourth.ok === false && String((fourth as any).error).includes('limit'),
    String((fourth as any).error ?? ''),
  )

  const pending = await client.workflow.proposals({ status: 'proposed' })
  const unwanted = pending.find((proposal: any) => proposal.name === 'a harness nobody wants')
  const declined = await client.workflow.declineDesign({
    designId: unwanted.id,
    note: 'three barriers where one plain edge would do',
  })
  check('it is declined', declined.declined === true, String(declined.detail))
  const history = await client.workflow.proposals({})
  const dead = history.find((proposal: any) => proposal.id === unwanted.id)
  check(
    'and what the person said is kept with it, for the next designer to be shown',
    dead?.status === 'declined' && String(dead?.decisionNote).includes('plain edge'),
    `${String(dead?.status)} — ${String(dead?.decisionNote)}`,
  )
  const stillMissing = await client.workflow.list()
  check(
    'declining drew nothing',
    !stillMissing.some((workflow: any) => workflow.name === 'a harness nobody wants'),
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
