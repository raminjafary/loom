/**
 * The designer with a model in it: a real session draws a real harness, and nothing in this
 * file writes a graph.
 *
 *   docker compose up -d postgres valkey egress-proxy
 *   LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/designer-live.mts
 *
 * Why this exists alongside `designer-check.mts`. That driver spends no tokens, which is what
 * makes it runnable on every change — but it buys that by calling `recordWorkflowDesign` itself.
 * Every graph it proposes is a graph *this repository* wrote, so it settles the plumbing and says
 * nothing about whether a model can draw a shape the validator accepts. Until this file ran, no
 * proposal in the system had ever come from a model.
 *
 * **Sandboxed**, unlike the drivers that only need a clone: the run reaches a model, so it gets
 * the path where the credential lives in the egress proxy and never inside the container. That is
 * also why it needs `LOOM_EGRESS_CONTROL_SECRET` and `LOOM_USE_HOST_CLAUDE_AUTH=1` — without the
 * second the proxy has a placeholder key, and every run fails at the first model call with an
 * upstream 401 that looks like a platform bug.
 *
 * Five things only a real session can settle:
 *
 * 1. **A model can draw a shape this validator accepts** — the graph crosses the design tool as
 *    loose JSON, so the only thing standing between a model's idea of a workflow and a refusal is
 *    prose in the brief. Nothing before this had tested that prose against a model.
 * 2. **A refusal is a correction rather than a dead end.** The validator answers in its own words
 *    as the tool result, so a model that draws a fan over a text field has the rest of its turn to
 *    fix it. Eleven shapes across three earlier sessions were refused zero times, so the second
 *    ask here *baits* the loop: nested per-item work, whose obvious drawing is a fan inside a fan
 *    and whose refusal is the one rule the vocabulary does not state. A loop that has never run
 *    is a claim rather than a feature, so this driver fails when it does not run.
 * 3. **The envelope holds against a model**, not against a fixture. `SHELL` is in the workspace
 *    and out of the designer's envelope, and the brief names it as forbidden — the question is
 *    whether a shape naming it ever gets stored, which a driver writing its own graphs cannot ask.
 * 4. **The brief is enough to draw from.** A session that ends without proposing anything is the
 *    interesting failure: it means the roster, the vocabulary and the ask did not add up to a
 *    shape, and no unit test can see that.
 * 5. **What a model drew is what a person approves** — the stored graph, node for node.
 *
 * Not a test: it spends real tokens and is run by hand. It asserts loudly, prints the shape the
 * model drew, and exits non-zero if anything it claims is untrue.
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
import { asAgentRunId, asWorkspaceId } from '../packages/domain/src/index.js'
import { SUBMIT_WORKFLOW_DESIGN_TOOL_NAME } from '../apps/runner/src/design-tool.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'designer-live-secret-at-least-32-characters',
  WS_SUBSCRIPTION_SECRET: 'designer-live-subscription-secret-32-chr',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const DESIGNER = 'designer-live-designer'
const WORKER = 'designer-live-worker'
const REVIEWER = 'designer-live-reviewer'
const SHELL = 'designer-live-shell'

/**
 * `SHELL` holds `Bash` and sits outside the designer's envelope on purpose. The brief names it as
 * the persona a proposal may not use; whether a model respects that is the question, and the
 * platform's answer has to hold either way.
 */
const personaDoc = (
  name: string,
  input: { model: string; tools: string; description: string; harness?: Record<string, string> },
) =>
  [
    '---',
    `name: ${name}`,
    `description: ${input.description}`,
    `model: ${input.model}`,
    `tools: ${input.tools}`,
    ...(input.harness === undefined
      ? []
      : ['harness:', ...Object.entries(input.harness).map(([key, value]) => `  ${key}: ${value}`)]),
    '---',
    '',
    `You are the ${name}.`,
  ].join('\n')

/** A shape drawn by hand, so the brief has a "what this workspace already has" to show. */
const handDrawn = {
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
      persona: WORKER,
      task: 'Do this one part: {{item}}',
      source: 'scope',
      over: 'parts',
      maxWidth: 3,
      answer: { fields: [{ kind: 'text', name: 'done' }] },
    },
  ],
  edges: [{ from: 'scope', to: 'work' }],
}

const main = async () => {
  /**
   * Two environment variables, refused up front rather than diagnosed later, because each fails
   * as something it is not.
   *
   * Without `LOOM_EGRESS_CONTROL_SECRET` the Runner builds no egress client, and a run with
   * `LOOM_SANDBOX_ENABLED=1` and no proxy takes the *unsandboxed* branch — so the failure reads
   * "Refusing to run unsandboxed" on a driver that asked for a sandbox, which sends a reader to
   * the sandbox flag that was already correct.
   *
   * Without `LOOM_USE_HOST_CLAUDE_AUTH=1` the proxy presents whatever `ANTHROPIC_API_KEY` it was
   * built with — a placeholder, in this repository — and every model call comes back 401, which
   * reads like a platform bug and is not one.
   */
  const missing = [
    process.env.LOOM_EGRESS_CONTROL_SECRET ? null : 'LOOM_EGRESS_CONTROL_SECRET',
    process.env.LOOM_USE_HOST_CLAUDE_AUTH === '1' ? null : 'LOOM_USE_HOST_CLAUDE_AUTH=1',
  ].filter((name): name is string => name !== null)
  if (missing.length > 0) {
    console.error(
      `Refusing to run: ${missing.join(' and ')} not set.\n` +
        'This driver reaches a model, so it runs sandboxed with the credential in the egress\n' +
        'proxy. Start the proxy and export both from .env:\n\n' +
        '  docker compose up -d postgres valkey egress-proxy\n' +
        '  export $(grep -E "^LOOM_EGRESS_CONTROL_SECRET=" .env | xargs)\n' +
        '  LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/designer-live.mts',
    )
    process.exit(1)
  }

  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `designer-live-${Date.now()}`)
  const workspaceId = asWorkspaceId(ws.id)
  const app = await buildApp(config, devAuth({ userId: 'designer-live-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))
  console.log('server on', `http://127.0.0.1:${addr.port}`)

  const repoPath = await mkdtemp(join(tmpdir(), 'designer-live-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  await writeFile(join(repoPath, 'README.md'), '# the tree the designer opens on\n')
  await git(repoPath, ['add', '-A'])
  await git(repoPath, [
    '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'first',
  ])

  const { runnerId, rawToken } = await client.runner.createPairingToken({
    name: 'designer-live-runner',
  })
  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: tmpdir(),
      // Sandboxed, because this one reaches a model: the credential stays in the proxy and the
      // container gets a lease token that is worthless outside it.
      LOOM_SANDBOX_ENABLED: '1',
      LOOM_EGRESS_CONTROL_SECRET: process.env.LOOM_EGRESS_CONTROL_SECRET,
      LOOM_USE_HOST_CLAUDE_AUTH: '1',
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `designer-live-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 5000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: repoPath,
    displayName: 'designer live repo',
  })

  const designer = await client.persona.create({
    markdownSource: personaDoc(DESIGNER, {
      model: 'claude-sonnet-5',
      tools: '[Read, Grep, Glob]',
      description: 'Draws harnesses for work this workspace does more than once.',
      // A planner with an envelope, and `auto` — on a planner that is a ceiling rather than a
      // setting, so an `ask` designer could only name workers whose every step is refused. The
      // envelope is a tool list, which is why `SHELL` is outside it: it holds `Bash`.
      harness: {
        planner: 'true',
        delegates: '[Read, Grep, Glob, Edit]',
        approvalMode: 'auto',
        budgetCapUsd: '1.5',
      },
    }),
  })
  await client.persona.create({
    markdownSource: personaDoc(WORKER, {
      model: 'claude-haiku-4-5-20251001',
      tools: '[Read, Edit]',
      description: 'Makes one scoped edit and stops.',
      harness: { approvalMode: 'auto', budgetCapUsd: '0.4' },
    }),
  })
  await client.persona.create({
    markdownSource: personaDoc(REVIEWER, {
      model: 'claude-haiku-4-5-20251001',
      tools: '[Read, Grep]',
      description: 'Checks work it did not do.',
      harness: { approvalMode: 'auto', budgetCapUsd: '0.4' },
    }),
  })
  await client.persona.create({
    markdownSource: personaDoc(SHELL, {
      model: 'claude-haiku-4-5-20251001',
      tools: '[Read, Bash]',
      description: 'Runs commands. Outside the designer envelope on purpose.',
      harness: { approvalMode: 'auto', budgetCapUsd: '0.4' },
    }),
  })

  /**
   * A design session reads a brief, reads the tree, and calls a tool — possibly several
   * times, because a refused shape is meant to be redrawn.
   *
   * Twenty minutes, raised from ten after a session that was still working at 601s was
   * reported as `running` and counted as a failure. The wait ends the moment the run is
   * terminal, so the number only costs anything when a session is genuinely iterating, which
   * is the case this driver exists to watch.
   */
  const settle = async (id: ReturnType<typeof asAgentRunId>) => {
    const DEADLINE_MS = 20 * 60 * 1000
    const startedAt = Date.now()
    let run = await app.deps.agentRuns.findById(workspaceId, id)
    while (Date.now() - startedAt < DEADLINE_MS) {
      run = await app.deps.agentRuns.findById(workspaceId, id)
      // `awaiting_approval` ends the wait too. It is not terminal, but a design session has no
      // approval to give — it reads and calls one tool — so a parked one is a finding, and
      // waiting out the deadline to report it would cost ten minutes to learn nothing more.
      if (run !== null && ['completed', 'failed', 'cancelled', 'awaiting_approval'].includes(run.status)) {
        break
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
    console.log(
      `\ndesign session ${String(run?.status)} after ${Math.round((Date.now() - startedAt) / 1000)}s, ` +
        `cost $${String(run?.totalCostUsd ?? 0)}${run?.errorMessage ? ` — ${run.errorMessage}` : ''}`,
    )
    /**
     * A session still working when the wait ends is stopped here rather than left running.
     *
     * The first run of this driver walked away from one: the driver exited, its Runner took
     * a signal, and the container stayed up for twenty-five minutes talking to a model with
     * nobody reading the answers. The Runner that would clean it up starts with a fresh
     * state directory each time and cannot know the container was its predecessor's, so the
     * only process that knows is this one. The workspace-wide control is the right
     * instrument because this workspace is the driver's own and the abandoned session is
     * the only thing in it.
     */
    if (run !== null && !['completed', 'failed', 'cancelled'].includes(run.status)) {
      await client.runControl.pauseAll()
      await client.runControl.resume()
      console.log('  (it was still working and has been stopped — nothing was reading it)')
    }
    return run
  }

  /**
   * The design tool's traffic in one thread: what was called, and what came back.
   *
   * Read from the thread rather than from the event table — a tool call and its result are
   * already messages there, paired on `toolUseId`, which is what a person reads when they ask
   * why a session took three goes. Asserting on the same rows keeps this driver honest about
   * what is actually visible. Per *thread*, so two sessions cannot be read as one: the second
   * ask below runs in a thread of its own for exactly that reason.
   */
  const toolTraffic = async (threadId: string) => {
    const messages: any[] = []
    let cursor: string | undefined
    do {
      const page = await client.message.list({
        threadId,
        limit: 100,
        view: 'all',
        ...(cursor === undefined ? {} : { cursor }),
      })
      messages.push(...page.messages)
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined && messages.length < 1000)
    const textOf = (message: any) => String(message?.body?.text ?? message?.text ?? '')
    /**
     * Matched on the tool's own name at the head of the line, never on the tool's name
     * *appearing* in a message. The first version of this check searched the text, and passed on
     * the run that found the bug: the model had asked a human why `submit_workflow_design` was
     * not among its tools, and the question quoted the name. A check that a complaint about a
     * missing tool satisfies is worse than no check.
     */
    const calls = messages.filter((message) =>
      textOf(message).startsWith(`→ ${SUBMIT_WORKFLOW_DESIGN_TOOL_NAME}`),
    )
    const callIds = new Set(calls.map((message) => String(message.toolUseId)))
    const results = messages.filter(
      (message) =>
        message.toolUseId !== null &&
        callIds.has(String(message.toolUseId)) &&
        !textOf(message).startsWith('→'),
    )
    const refusals = results.filter((message) => textOf(message).startsWith('✗'))
    const askedForIt = messages.filter(
      (message) => textOf(message).startsWith('→') && textOf(message).includes('ask_human'),
    )
    return { calls, refusals, askedForIt, textOf }
  }

  const channel = await client.channel.create({ name: 'designer-live' })
  const drawn = await client.workflow.create({
    name: 'a harness drawn by hand',
    description: 'so the designer can be told this workspace already has one',
    graph: handDrawn,
  })
  check('a harness drawn by hand, for the brief to show', drawn.workflowId !== null, String(drawn.detail))

  console.log('\n— a person asks for a harness, in words, and a model draws one —')
  const ASK =
    'a way to work through a dependency upgrade that breaks a dozen call sites, without the ' +
    'agent that made a change being the one that says the change is fine'
  const asked = await client.workflow.design({
    personaId: designer.id,
    repositoryId: repo.id,
    threadId: channel.rootThread.id,
    ask: ASK,
  })
  check('the designer was started', asked.runId !== null, String(asked.detail))
  const runId = asAgentRunId(asked.runId)

  const run = await settle(runId)

  check(
    'the session reached a model rather than being refused before one',
    Number(run?.totalCostUsd ?? 0) > 0,
    `$${String(run?.totalCostUsd ?? 0)}`,
  )
  check(
    'and it ran to the end',
    run?.status === 'completed',
    `${String(run?.status)}${run?.errorMessage ? ` — ${run.errorMessage}` : ''}`,
  )

  const { calls, refusals, askedForIt, textOf } = await toolTraffic(channel.rootThread.id)
  console.log(
    `\nthe session called the design tool ${calls.length} time(s); ` +
      `${refusals.length} came back as a refusal`,
  )
  for (const refusal of refusals) console.log(`  refused: ${textOf(refusal).slice(0, 220)}`)
  check(
    'the model reached for the design tool at all',
    calls.length > 0,
    `${calls.length} call(s) — the brief has to be enough to draw from`,
  )
  /**
   * The signature of a designer that was handed the wrong toolset: it reads the brief, finds no
   * tool by the name the brief gives, and asks a human. The run parks, costs a dollar and fails
   * nothing, so this is checked by name rather than left to whoever reads the status.
   */
  check(
    'and it did not have to ask a human where that tool was',
    askedForIt.length === 0,
    askedForIt.map((message) => textOf(message).slice(0, 180)).join(' | '),
  )

  const designs = await app.deps.workflows.listDesigns({ workspaceId, limit: 20 })
  check(
    'a proposal exists, and this driver wrote no graph',
    designs.length > 0,
    `${designs.length} proposal(s)`,
  )
  const mine = designs.filter((design) => design.proposedByRunId === runId)
  check(
    'every proposal was written by the design session, through the tool',
    mine.length === designs.length && mine.length > 0,
    `${mine.length} of ${designs.length} carry the run`,
  )

  /**
   * The refusal loop, and the reason the graph crosses as loose JSON rather than as a schema on
   * the Runner: a schema could not express "a fan may only fan over a list", so the refusal has
   * to come back as a tool result the session still has time to act on. A session that was
   * refused and then stored a shape is that loop working end to end.
   */
  if (refusals.length > 0) {
    check(
      'a refused submission was corrected inside the same session rather than ending it',
      mine.length > 0,
      `${refusals.length} refusal(s), ${mine.length} stored`,
    )
  }

  const proposal = mine[0]
  if (proposal === undefined) {
    console.log(`\n${failures + 1} check(s) FAILED — nothing was drawn, so nothing else can be asked`)
    runner.kill('SIGTERM')
    await app.fastify.close()
    await closeDb()
    process.exit(1)
  }

  const nodes = (proposal.graph as any).nodes as any[]
  const edges = (proposal.graph as any).edges as any[]
  console.log(`\nthe model drew "${proposal.name}":`)
  for (const node of nodes) {
    console.log(`  ${node.kind} ${node.id}${node.persona ? ` · ${node.persona}` : ''} — ${node.title ?? ''}`)
  }
  console.log(`  edges: ${edges.map((edge) => `${edge.from}→${edge.to}`).join(', ')}`)
  console.log(`  because: ${proposal.rationale}`)

  check(
    'the shape it drew is a graph rather than one node',
    nodes.length >= 2 && edges.length >= 1,
    `${nodes.length} node(s), ${edges.length} edge(s)`,
  )
  check(
    'and it is the model’s shape, not the one it was shown',
    proposal.digest !== (await client.workflow.read({ workflowId: drawn.workflowId }))?.digest,
    proposal.digest.slice(0, 12),
  )

  /**
   * The claim the whole shape rests on, asked of a model rather than of a fixture. The designer
   * holds no shell and may not hand one down, so a stored proposal naming `SHELL` would mean the
   * envelope check never ran — approval would be the only gate, which is the thing the design
   * says it is not.
   */
  const named = new Set(nodes.map((node) => node.persona).filter((persona) => typeof persona === 'string'))
  check(
    'no stored proposal names the persona outside the designer’s envelope',
    designs.every((design) =>
      ((design.graph as any).nodes as any[]).every((node) => node.persona !== SHELL),
    ),
    `named: ${[...named].join(', ')}`,
  )
  check(
    'and every persona it did name is one this workspace has',
    [...named].every((persona) => [DESIGNER, WORKER, REVIEWER].includes(String(persona))),
    [...named].join(', '),
  )

  console.log('\n— what a model drew is what a person reads, and approves —')
  const queue = await client.workflow.proposals({ status: 'proposed' })
  const onWire = queue.find((entry: any) => entry.id === proposal.id)
  check(
    'it crosses the contract as a shape a person can read, with the case for it',
    typeof onWire?.shape === 'string' &&
      onWire.shape.length > 0 &&
      String(onWire?.detail).includes('step(s)') &&
      onWire?.personaName === DESIGNER,
    `${String(onWire?.personaName)} · ${String(onWire?.shape)}`,
  )
  check(
    'and nothing was drawn by proposing it',
    !(await client.workflow.list()).some((workflow: any) => workflow.name === proposal.name),
  )

  const approved = await client.workflow.approveDesign({ designId: proposal.id })
  check('approving writes version 1', approved.version === 1, String(approved.detail))
  // `approveDesign` answers with the version it wrote, not with the harness it belongs to — the
  // name is the reference a person reads, so the harness is found the same way they would find it.
  const drawnNow = (await client.workflow.list()).find(
    (workflow: any) => workflow.name === proposal.name,
  )
  const version = await client.workflow.read({ workflowId: drawnNow?.id ?? drawnNow?.workflowId })
  check(
    'and the harness a person got is the graph the model drew, node for node',
    JSON.stringify(version?.graph) === JSON.stringify(proposal.graph),
    version?.digest === proposal.digest ? 'same digest' : `${String(version?.digest)} ≠ ${proposal.digest}`,
  )

  /**
   * The refusal loop, exercised on purpose rather than waited for.
   *
   * Three sessions across two earlier runs of this driver drew eleven shapes and were refused
   * zero times, so the loop the brief exists to support — the validator answering in its own
   * words, as a tool result, in time for the model to fix it — had never actually run. A loop
   * that has never run is a claim, not a feature.
   *
   * This ask baits it. The obvious drawing of "for every suite, work through each of its failing
   * tests" is a fan inside a fan, which `laneSources` refuses because a lane index would need two
   * dimensions — and, unlike the two-fans-into-one-node case, it is a rule the vocabulary does
   * *not* state. So the only way a session can arrive at a valid shape here is by being told, and
   * that is precisely the thing being measured: whether the refusal carries the fix.
   */
  console.log('\n— a shape whose obvious drawing is invalid, so the refusal loop runs —')
  const baitChannel = await client.channel.create({ name: 'designer-live-nested' })
  const NESTED_ASK =
    'a way to work through a flaky test report that names several suites: for every suite in the ' +
    'report, go through each failing test in that suite one at a time, and then say per suite ' +
    'whether that suite is fixed'
  const baited = await client.workflow.design({
    personaId: designer.id,
    repositoryId: repo.id,
    threadId: baitChannel.rootThread.id,
    ask: NESTED_ASK,
  })
  check('the second designer was started', baited.runId !== null, String(baited.detail))
  const baitedRunId = asAgentRunId(baited.runId)
  const baitedRun = await settle(baitedRunId)
  check(
    'it reached a model and ran to the end',
    Number(baitedRun?.totalCostUsd ?? 0) > 0 && baitedRun?.status === 'completed',
    `${String(baitedRun?.status)} · $${String(baitedRun?.totalCostUsd ?? 0)}`,
  )

  const bait = await toolTraffic(baitChannel.rootThread.id)
  console.log(
    `\nthe baited session called the design tool ${bait.calls.length} time(s); ` +
      `${bait.refusals.length} came back as a refusal`,
  )
  for (const refusal of bait.refusals) console.log(`  refused: ${bait.textOf(refusal).slice(0, 300)}`)
  /**
   * A driver whose job is to exercise the loop reports it as a failure when the loop did not run.
   * The bait not biting is a finding about the *brief* — it drew a nested shape correctly with no
   * help — and it leaves the loop exactly as unproven as it was before this ran.
   */
  check(
    'the validator refused at least one submission, so the loop ran at all',
    bait.refusals.length > 0,
    bait.refusals.length === 0
      ? `${bait.calls.length} call(s), none refused — the bait was drawn correctly first time`
      : `${bait.refusals.length} refusal(s)`,
  )
  const baitedDesigns = (await app.deps.workflows.listDesigns({ workspaceId, limit: 20 })).filter(
    (design) => design.proposedByRunId === baitedRunId,
  )
  if (bait.refusals.length > 0) {
    check(
      'the refusal came back in the validator’s own words, naming what to do instead',
      bait.refusals.some((refusal) => /lane|barrier|list|dimension/i.test(bait.textOf(refusal))),
      bait.refusals.map((refusal) => bait.textOf(refusal).slice(0, 160)).join(' | '),
    )
    check(
      'and the session corrected it inside the same turn rather than ending on it',
      baitedDesigns.length > 0,
      `${bait.refusals.length} refusal(s), ${baitedDesigns.length} stored`,
    )
  }
  const baitedShape = baitedDesigns[0]
  if (baitedShape !== undefined) {
    const baitedNodes = (baitedShape.graph as any).nodes as any[]
    console.log(`\nthe model drew "${baitedShape.name}":`)
    for (const node of baitedNodes) {
      console.log(
        `  ${node.kind} ${node.id}${node.persona ? ` · ${node.persona}` : ''} — ${node.title ?? ''}`,
      )
    }
    console.log(`  because: ${baitedShape.rationale}`)
    const fans = baitedNodes.filter((node) => node.kind === 'fan' || node.over !== undefined)
    check(
      'the shape it settled on is one the validator accepts, nested work and all',
      baitedNodes.length >= 2,
      `${fans.length} fanning node(s), ${baitedNodes.filter((node) => node.kind === 'barrier').length} barrier(s)`,
    )
    check(
      'and it names no persona outside the designer’s envelope, under correction either',
      baitedNodes.every((node) => node.persona !== SHELL),
      baitedNodes.map((node) => String(node.persona ?? '—')).join(', '),
    )
  }

  console.log(
    `\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`} — ` +
      `spent $${(Number(run?.totalCostUsd ?? 0) + Number(baitedRun?.totalCostUsd ?? 0)).toFixed(2)}`,
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
