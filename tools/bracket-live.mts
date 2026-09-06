/**
 * The bracket with a model in it: real attempts, judged two at a time by a real judge, and
 * nothing in this file writes a winner.
 *
 *   docker compose up -d postgres valkey egress-proxy
 *   export $(grep -E "^LOOM_EGRESS_CONTROL_SECRET=" .env | xargs)
 *   LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/bracket-live.mts
 *
 * Why this exists alongside `workflow-check.mts`. That driver settles the *rounds* — that three
 * entrants make one match and a bye, that a second round is dealt from what the first answered,
 * that a side outside the vocabulary is refused. It buys that at zero tokens by calling
 * `recordWorkflowAnswer` itself, which means every attempt it judges is a string this repository
 * wrote (`'the alpha attempt'`) and every winner is a side this repository picked. No judge had
 * ever compared two real attempts.
 *
 * That substitution hides one specific thing, and it is the reason the bracket exists rather than
 * one wide "pick the best of six" call: **the seeding is over content nobody chose**. Judged
 * against fixture strings, a seed derived from the execution's id and a seed derived from list
 * order are indistinguishable — the fixtures are in list order. Judged against what a fan
 * actually produced, they are not.
 *
 * Four things only a real tournament can settle:
 *
 * 1. **The pairing a real judge was dealt is the one the execution's own id seats**, re-derived
 *    here from the attempts the fan actually wrote rather than from anything this file chose.
 * 2. **A model answers with a side rather than about one.** The vocabulary crosses the wire as
 *    the tool's own enum; whether a judge handed two paragraphs picks `left` or explains its
 *    preference in prose is a question about a model, and the platform's answer has to hold.
 * 3. **A second round is dealt from what the first round decided** — winners advancing, by
 *    content, with no row anywhere naming a bracket position.
 * 4. **The step below the bracket is given the champion**, and a champion is an entrant rather
 *    than a side, which is what makes a walkover expressible.
 *
 * Not a test: it spends real tokens and is run by hand. It asserts loudly and prints the
 * tournament so a human can read who beat whom.
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
import { advanceWorkflowQueue } from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import {
  asWorkflowRunId,
  asWorkspaceId,
  bracketMatches,
  bracketSeeding,
} from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'bracket-live-secret-at-least-32-characters',
  WS_SUBSCRIPTION_SECRET: 'bracket-live-subscription-secret-32-chrs',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const SCOUT = 'bracket-live-scout'
const HAND = 'bracket-live-hand'
const CHECKER = 'bracket-live-checker'

/**
 * Short answers, said in the document rather than in every task. A judge comparing two pages of
 * prose is a judge whose verdict is mostly about which page it read more of, and the tournament
 * is dealt one match at a time — so length is paid for on every round.
 */
const personaDoc = (name: string, role: string) =>
  [
    '---',
    `name: ${name}`,
    `description: ${role}`,
    'model: claude-haiku-4-5-20251001',
    'tools: [Read]',
    'harness:',
    '  approvalMode: auto',
    '  budgetCapUsd: 0.35',
    '---',
    '',
    `You are the ${name}. ${role}`,
    '',
    'Answer with the tool you were given, and nothing else. Keep every field under 60 words —',
    'this is one step of a larger piece of work, not the whole of it.',
  ].join('\n')

/**
 * approaches -> attempt each -> barrier -> a bracket that judges them two at a time -> ship.
 *
 * Four entrants rather than three, unlike the no-token driver: four is the smallest field with a
 * full second round, so "a round is dealt from what the last one answered" is a claim about
 * winners advancing rather than about a bye being carried.
 */
const graph = {
  nodes: [
    {
      kind: 'step',
      id: 'approaches',
      title: 'Name the ways',
      persona: SCOUT,
      task: 'Name four genuinely different ways to: {{input}}. One short line each.',
      answer: { fields: [{ kind: 'list', name: 'ways' }] },
    },
    {
      kind: 'fan',
      id: 'attempt',
      title: 'Work each way out',
      persona: HAND,
      task:
        'Work out this one way, and only this one: {{item}}. Say what it does and what it costs.',
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
      task:
        'Two proposals for the same job. Which is better?\n\nLEFT:\n{{left}}\n\nRIGHT:\n{{right}}',
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
      task: 'Say how you would start on this, in three lines: {{judge.champion}}',
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
  const missing = [
    process.env.LOOM_EGRESS_CONTROL_SECRET ? null : 'LOOM_EGRESS_CONTROL_SECRET',
    process.env.LOOM_USE_HOST_CLAUDE_AUTH === '1' ? null : 'LOOM_USE_HOST_CLAUDE_AUTH=1',
  ].filter((name): name is string => name !== null)
  if (missing.length > 0) {
    console.error(
      `Refusing to run: ${missing.join(' and ')} not set.\n` +
        'This driver reaches a model, so it runs sandboxed with the credential in the egress\n' +
        'proxy. Without the secret the Runner builds no egress client and every run takes the\n' +
        'unsandboxed branch; without the host auth the proxy presents the placeholder key from\n' +
        '.env and every model call comes back 401.',
    )
    process.exit(1)
  }

  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `bracket-live-${Date.now()}`)
  const workspaceId = asWorkspaceId(ws.id)
  const app = await buildApp(config, devAuth({ userId: 'bracket-live-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))
  console.log('server on', `http://127.0.0.1:${addr.port}`)

  const repoPath = await mkdtemp(join(tmpdir(), 'bracket-live-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  await writeFile(join(repoPath, 'README.md'), '# the tree each step opens on\n')
  await git(repoPath, ['add', '-A'])
  await git(repoPath, [
    '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'first',
  ])

  const { runnerId, rawToken } = await client.runner.createPairingToken({
    name: 'bracket-live-runner',
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
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `bracket-live-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 5000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: repoPath,
    displayName: 'bracket live repo',
  })
  await client.persona.create({
    markdownSource: personaDoc(SCOUT, 'Names the ways a job could be done, and starts on one.'),
  })
  await client.persona.create({
    markdownSource: personaDoc(HAND, 'Works one approach out far enough to be judged.'),
  })
  await client.persona.create({
    markdownSource: personaDoc(CHECKER, 'Compares two proposals and picks one.'),
  })
  const channel = await client.channel.create({ name: 'bracket-live' })

  const created = await client.workflow.create({
    name: 'bracket-live tournament',
    description: 'name the ways, work each out, judge them two at a time, start on the winner',
    graph,
  })
  check('the tournament was drawn', created.workflowId !== null, String(created.detail))

  const INPUT = 'make a half-failed database migration recoverable without a human reading logs'
  const started = await client.workflow.start({
    workflowId: created.workflowId,
    repositoryId: repo.id,
    threadId: channel.rootThread.id,
    input: INPUT,
    capUsd: 6,
  })
  const runId = asWorkflowRunId(started.runId)
  console.log(`\nexecution ${started.runId} — seating is derived from this id\n`)

  /**
   * The sweep, run by hand. In a deployment this is a timer; here it is a loop, because a driver
   * that slept a fixed interval would be asserting about its own timing rather than about the
   * shape. Each pass deals whatever the last pass settled, so the tournament advances one round
   * per pass once the fan is in.
   */
  const DEADLINE_MS = 25 * 60 * 1000
  const startedAt = Date.now()
  let execution = await app.deps.workflows.findRun(workspaceId, runId)
  while (Date.now() - startedAt < DEADLINE_MS) {
    await advanceWorkflowQueue(app.deps, { stepStuckMs: 3_600_000, maxStartsPerTick: 16 })
    await new Promise((r) => setTimeout(r, 6000))
    execution = await app.deps.workflows.findRun(workspaceId, runId)
    if (execution !== null && execution.status !== 'running') break
  }
  const elapsed = Math.round((Date.now() - startedAt) / 1000)

  const steps = await app.deps.workflows.stepsForRun(workspaceId, runId)
  const spent = steps.reduce((total, step) => total + (step.costUsd ?? 0), 0)
  console.log(
    `\nexecution ${String(execution?.status)} after ${elapsed}s, ` +
      `${steps.length} step(s), $${spent.toFixed(4)}\n`,
  )

  const attempts = steps.filter((step) => step.nodeId === 'attempt')
  const entrantsWritten = attempts
    .filter((step) => step.status === 'answered')
    .map((step) => String((step.answer as any)?.result ?? ''))
    .filter((result) => result !== '')

  // Barriers are excluded because a barrier is not a run: it is written when the lanes above it
  // settle, costs nothing, and a check that expected it to spend would fail on a correct
  // tournament forever.
  const ranSomewhere = steps.filter((step) => step.agentRunId !== null)
  check(
    'every step that was a run reached a model',
    ranSomewhere.length > 0 &&
      ranSomewhere.every((step) => step.status !== 'answered' || (step.costUsd ?? 0) > 0),
    ranSomewhere.map((step) => `${step.nodeId}:$${(step.costUsd ?? 0).toFixed(3)}`).join(' '),
  )
  check(
    'the fan produced real attempts for the bracket to judge',
    entrantsWritten.length >= 2,
    `${entrantsWritten.length} of ${attempts.length} lane(s) answered`,
  )
  for (const [index, entrant] of entrantsWritten.entries()) {
    console.log(`  entrant ${index}: ${entrant.replace(/\s+/g, ' ').slice(0, 110)}…`)
  }

  /**
   * The claim a fixture cannot make. `bracketSeeding` is re-derived here from the execution's id
   * and from the text the *fan* wrote — so if the seating were a function of list order, of a
   * clock, or of the graph alone, the pairing the judge was actually given would differ from this
   * one. Against fixture strings in list order it could not.
   */
  const seeded = bracketSeeding(started.runId, 'judge', entrantsWritten, 4)
  const roundZero = steps.filter((step) => step.nodeId === 'judge' && step.pass === 0)
  const expected = bracketMatches(started.runId, 'judge', 0, seeded)
  check(
    `${entrantsWritten.length} entrants make ${expected.matches.length} first-round match(es)`,
    roundZero.length === expected.matches.length,
    `${roundZero.length} dealt, ${expected.matches.length} seated`,
  )

  const taskOf = async (step: (typeof steps)[number]) =>
    step.agentRunId === null
      ? ''
      : String((await app.deps.agentRuns.findById(workspaceId, step.agentRunId))?.task ?? '')
  let seatingHeld = roundZero.length > 0
  for (const [index, match] of expected.matches.entries()) {
    const dealt = roundZero[index]
    if (dealt === undefined) {
      seatingHeld = false
      continue
    }
    const task = await taskOf(dealt)
    if (!task.includes(String(match?.left)) || !task.includes(String(match?.right))) {
      seatingHeld = false
      console.log(`  match ${index} was dealt a pair this id does not seat`)
    }
  }
  check(
    'the pairing each real judge was dealt is the one this execution’s id seats',
    seatingHeld,
    're-derived from the attempts the fan wrote, not from anything this file chose',
  )

  /**
   * A side, not a sentence. The vocabulary is the tool's own enum, so a judge that wanted to
   * answer "the second one" was told so while it still had a turn left — this asserts what
   * survived that.
   */
  const judged = steps.filter((step) => step.nodeId === 'judge' && step.status === 'answered')
  check(
    'every judged match answered with a side from the vocabulary',
    judged.length > 0 &&
      judged.every((step) => ['left', 'right'].includes(String((step.answer as any)?.winner))),
    judged.map((step) => `p${step.pass}:${String((step.answer as any)?.winner)}`).join(' '),
  )
  check(
    'and gave a reason with it, in its own words',
    judged.every((step) => String((step.answer as any)?.why ?? '').length > 0),
  )
  for (const step of judged) {
    console.log(
      `  round ${step.pass} → ${String((step.answer as any)?.winner)}: ` +
        `${String((step.answer as any)?.why).replace(/\s+/g, ' ').slice(0, 130)}…`,
    )
  }

  /**
   * Printed rather than asserted, and deliberately. Position bias is the whole reason the seating
   * is blinded, but three matches is not evidence about it either way — a driver that failed on a
   * left-heavy run would be a driver that fails at random.
   */
  const leftWins = judged.filter((step) => (step.answer as any)?.winner === 'left').length
  console.log(`  sides: ${leftWins} left, ${judged.length - leftWins} right`)

  const roundOne = steps.filter((step) => step.nodeId === 'judge' && step.pass === 1)
  if (expected.matches.length > 1) {
    check(
      'a second round was dealt from what the first round decided',
      roundOne.length > 0,
      `${roundOne.length} match(es) in round 1`,
    )
    /**
     * Read from the *seating* rather than from the row's `item`, which is an abbreviated label —
     * two entrants elided to fit a journal line. The first version of this check split that label
     * and compared the halves, and failed on a tournament that had advanced its winners
     * correctly: round 0 and round 1 elide the same entrant at different lengths, so the strings
     * never matched. The pair the seed seats is full text, and so is the prompt a judge was
     * given, which is what makes them comparable.
     */
    const winners = roundZero
      .filter((step) => step.status === 'answered')
      .map((step, index) => {
        const match = expected.matches[index]
        return (step.answer as any)?.winner === 'left' ? match?.left : match?.right
      })
      .filter((winner): winner is string => winner !== undefined)
    const secondRoundTask = roundOne[0] === undefined ? '' : await taskOf(roundOne[0])
    check(
      'and the entrants it advanced are the winners, by content rather than by position',
      winners.length === 2 && winners.every((winner) => secondRoundTask.includes(winner)),
      `${winners.length} winner(s), ${winners.filter((w) => secondRoundTask.includes(w)).length} of them seated in round 1`,
    )
  }

  const ship = steps.find((step) => step.nodeId === 'ship')
  const shipTask = ship === undefined ? '' : await taskOf(ship)
  check(
    'the step below the bracket ran at all',
    ship !== undefined,
    ship === undefined ? 'the tournament never resolved a champion' : String(ship.status),
  )
  check(
    'and it was given a champion rather than a match',
    shipTask !== '' && !shipTask.includes('⟂') && entrantsWritten.some((entrant) => shipTask.includes(entrant)),
    shipTask.replace(/\s+/g, ' ').slice(0, 160),
  )
  check(
    'the execution finished rather than stalling',
    execution?.status === 'finished',
    `${String(execution?.status)}${execution?.haltReason ? ` — ${execution.haltReason}` : ''}`,
  )

  console.log(
    `\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`} — ` +
      `spent $${spent.toFixed(4)} over ${steps.length} step(s)`,
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
