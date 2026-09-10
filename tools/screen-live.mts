/**
 * A screening run that produces a **real branch**, judged by a **real definition of done**.
 *
 *   docker compose up -d postgres valkey
 *   LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/screen-live.mts     # a few cents
 *
 * Why this exists alongside `screen-check.mts`. That driver proves the assembly, the dispatch,
 * the commit pinning, the gate and the arm-dealing consequence, and it spends nothing — because
 * every screening run it starts is refused by the Runner's unsandboxed guard, right after the
 * clone. Its header states the price of that honestly: **the outcomes the gate reads are written
 * by the driver rather than earned.** `recordScreenRunOutcome` called from a script is this
 * repository asserting its own preferred answer and then checking that the gate agrees with it.
 *
 * The path that is not exercised there is the one that matters most, because it is the one a
 * promotion rests on: a screening run finishes, leaves a branch, a definition of done runs
 * against *that* branch, and `resolveScreenRunOutcome` turns the verdict into the score the gate
 * compares arms on. Four components, none of which the substitution touches.
 *
 * So the runs here are real and deliberately cheap — a Haiku turn told to say one word — and the
 * commits are written into their clones by this script, the substitution `verification-check.mts`
 * and `merge-queue-check.mts` both make and for the same reason: what is under test is the
 * screen, not the model's ability to write a passing file. **The outcome is not written.** It
 * comes back through the verification queue, and this driver asserts that it did — a screen whose
 * arms scored without a verification verdict behind them would pass every check below while
 * proving nothing.
 *
 * The one thing to hold onto: a candidate arm here is refused because *its branch failed a check
 * that ran*, which is the first time that sentence has been true anywhere in this repository.
 *
 * Not a test: it spends real tokens, takes a few minutes, and is run by hand.
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
  advanceScreenQueue,
  advanceVerificationQueue,
  proposeOwnVariants,
} from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import {
  MIN_REPLAY_ITEMS,
  asAgentRunId,
  asPersonaVariantSetId,
  asWorkspaceId,
} from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'screen-live-secret-at-least-32-characters!',
  WS_SUBSCRIPTION_SECRET: 'screen-live-subscription-secret-32-chars',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const PERSONA_NAME = 'screen-live-worker'

const main = async () => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `screen-live-${Date.now()}`)
  const workspaceId = asWorkspaceId(ws.id)
  const app = await buildApp(config, devAuth({ userId: 'screen-live-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${addr.port}`
  const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
  console.log('server on', base)

  const repoPath = await mkdtemp(join(tmpdir(), 'screen-live-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  const commit = async (file: string, body: string, message: string) => {
    await writeFile(join(repoPath, file), body)
    await git(repoPath, ['add', '-A'])
    await git(repoPath, [
      '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', message,
    ])
    return git(repoPath, ['rev-parse', 'HEAD'])
  }
  await commit('README.md', '# as it was\n', 'first')
  const headCommit = await commit('README.md', '# as it is now\n', 'second')

  const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'screen-live-runner' })
  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: tmpdir(),
      /**
       * The one difference from `screen-check.mts`, and the whole reason this file exists:
       * there, the acknowledgement is deliberately empty so every screening run is refused
       * after its clone and nothing is spent. Here the runs have to *finish*, because a run
       * that never ran leaves no branch and a definition of done has nothing to judge.
       */
      LOOM_SANDBOX_ENABLED: '0',
      LOOM_ALLOW_UNSANDBOXED: 'i-understand-the-agent-gets-my-privileges',
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `screen-live-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 4000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: repoPath,
    displayName: 'screen live repo',
  })

  /**
   * The definition of done a branch is judged by. Two named checks rather than one boolean,
   * because "the build broke" and "one test failed" are different next actions — and because
   * the gate's rejection sentence is only actionable if the verdict underneath it was.
   */
  await client.repository.setVerificationChecks({
    repositoryId: repo.id,
    checks: [
      { name: 'shape', command: 'test -f answer.txt' },
      { name: 'content', command: 'grep -q ready answer.txt' },
    ],
  })

  const persona = await client.persona.create({
    markdownSource: [
      '---',
      `name: ${PERSONA_NAME}`,
      'description: Says one word. The branch is what is under test, not the prose.',
      'model: claude-haiku-4-5-20251001',
      'tools: [Read]',
      'envelope:',
      '  tools: [Read]',
      '---',
      '',
      'THE PROMPT IN USE.',
    ].join('\n'),
  })
  const channel = await client.channel.create({ name: 'screen-live' })

  /**
   * Starts a run and waits for a terminal status, answering anything it asks on the way.
   * `ask_human` is offered to every run the platform starts, and a Haiku turn given a bare
   * fixture repository will sometimes use it — unanswered, the run sits in `awaiting_approval`
   * until the SLA sweep and this driver would report the screen never finished.
   */
  const finishRun = async (task: string): Promise<any> => {
    const run = await client.agentRun.start({
      threadId: channel.rootThread.id,
      repositoryId: repo.id,
      personaId: persona.id,
      task,
    })
    return waitForRun(run.id)
  }

  const waitForRun = async (runId: string): Promise<any> => {
    let current = await client.agentRun.get({ agentRunId: runId })
    for (let i = 0; i < 120; i += 1) {
      if (['completed', 'failed', 'cancelled'].includes(current.status)) return current
      if (current.status === 'awaiting_approval') {
        for (const pending of await client.approval.listPending({ agentRunId: runId })) {
          await client.approval.decide({
            approvalRequestId: pending.id,
            decision: 'approve',
            answer: 'Nothing else is expected of you. Reply with the single word ready.',
          })
        }
      }
      await new Promise((r) => setTimeout(r, 2000))
      current = await client.agentRun.get({ agentRunId: runId })
    }
    throw new Error(`run ${runId} never finished — last status ${current.status}`)
  }

  /** The commit an agent would have left, written into the run's own clone. */
  const commitIn = async (clonePath: string, files: Record<string, string>, message: string) => {
    for (const [file, body] of Object.entries(files)) {
      await writeFile(join(clonePath, file), body)
    }
    await git(clonePath, ['add', '-A'])
    await git(clonePath, [
      '-c', 'user.email=agent@loom.invalid', '-c', 'user.name=agent', 'commit', '-qm', message,
    ])
    return git(clonePath, ['rev-parse', 'HEAD'])
  }

  console.log('\n— the material: decided runs, each with the commit it opened at —')
  /**
   * Decided, which for replay material means a branch a human answered about — a disposition,
   * a failed run, or a branch that failed its checks. `screen-check.mts` gets this for free
   * because its runs are *refused* and therefore fail; these runs finish, so each one is given
   * a branch and then discarded through the contract, which is what a person does to work they
   * looked at and did not want.
   */
  for (let i = 0; i < MIN_REPLAY_ITEMS + 1; i += 1) {
    const run = await finishRun(`Held-out task ${i}. Reply with the single word ready.`)
    if (run.clonePath) await commitIn(run.clonePath, { 'answer.txt': 'ready\n' }, `answer ${i}`)
    await client.agentRun.discard({ agentRunId: run.id })
  }
  const seeded = await app.deps.screens.listDecidedRunsForPersona(workspaceId, PERSONA_NAME, 50)
  check(
    `${MIN_REPLAY_ITEMS + 1} runs are on record as replay material`,
    seeded.length >= MIN_REPLAY_ITEMS,
    `${seeded.length} decided`,
  )

  console.log('\n— the search, and the screen it opens —')
  const proposer = await finishRun('Reply with the single word ready.')
  const proposed = await proposeOwnVariants(app.deps, {
    workspaceId,
    agentRunId: asAgentRunId(proposer.id),
    proposals: [
      { kind: 'body' as const, body: 'A FIRST CANDIDATE.', rationale: 'terser' },
      { kind: 'body' as const, body: 'A SECOND CANDIDATE.', rationale: 'more explicit' },
    ],
  })
  check('the search opened', proposed.ok === true, proposed.ok ? '' : proposed.reason)

  const search = (await client.persona.variantSearches()).find(
    (entry: any) => entry.personaId === persona.id,
  )
  const setId = asPersonaVariantSetId(search.setId)

  console.log('\n— the sweep starts screening runs, and this time they run —')

  const screensNow = () => app.deps.screens.screensForSet(workspaceId, setId)
  const first = await screensNow()
  const worseVariantId = first.filter((entry) => entry.screen.variantId !== null)[0]!.screen.variantId
  const levelVariantId = first.filter((entry) => entry.screen.variantId !== null)[1]!.screen.variantId
  const armCount = first.reduce((total, entry) => total + entry.runs.length, 0)

  /**
   * Every arm gets a branch. The incumbent's and the second candidate's satisfy the definition
   * of done; the first candidate's does not — it commits a file with the wrong contents, so
   * `shape` passes and `content` fails, which is the case a single boolean could not express.
   */
  const heads = new Map<string, string>()
  const verdictFor = new Map<string, any>()

  /**
   * The production loop, rather than three calls in a row.
   *
   * Two things make it a loop and both were found by running it. `advanceScreenQueue` starts a
   * bounded number of arms per tick — that is what stops a search from putting fifteen runs on a
   * Runner at once — and `advanceVerificationQueue` dispatches **one verification per
   * repository** per sweep, for the same reason. A driver that swept twice and then read the
   * rows found every one of them pending and would have reported the queue broken.
   */
  for (let round = 0; round < 12; round += 1) {
    /**
     * A generous per-tick budget, because the queue is **global** and the test database is
     * shared with every other driver that has ever opened a search. A previous run's screens
     * are older than this one's, so a production-sized budget of five is spent entirely on
     * arms belonging to workspaces whose Runner is long gone — this driver started zero of
     * its own fifteen and looked like a broken queue. What is under test here is the screen,
     * not the throttle.
     */
    await advanceScreenQueue(app.deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 60 })
    await new Promise((r) => setTimeout(r, 3000))

    const fresh = (await screensNow()).flatMap((entry) =>
      entry.runs
        .filter((run) => run.agentRunId !== null && !heads.has(run.agentRunId))
        .map((run) => ({ screen: entry.screen, run })),
    )

    for (const { screen, run } of fresh) {
      await waitForRun(run.agentRunId as string)
      const record = await app.deps.agentRuns.findById(workspaceId, run.agentRunId!)
      if (!record?.clonePath) throw new Error(`screening run ${run.agentRunId} has no clone`)
      const passes = screen.variantId !== worseVariantId
      heads.set(
        run.agentRunId as string,
        await commitIn(
          record.clonePath,
          { 'answer.txt': passes ? 'ready\n' : 'not what the check looks for\n' },
          passes ? 'answer' : 'answer, wrong contents',
        ),
      )
    }

    // Sweep until the verdicts this round is waiting on have landed. One per repository per
    // sweep, and the Runner answers asynchronously, so both the call and the wait repeat.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await advanceVerificationQueue(app.deps, { verificationStuckMs: 1_800_000 })
      const rows = await app.deps.runVerifications.listByRuns(
        workspaceId,
        [...heads.keys()].map((id) => asAgentRunId(id)),
      )
      for (const row of rows) verdictFor.set(row.agentRunId as string, row)
      if (rows.length === heads.size && rows.every((row) => row.status !== 'pending')) break
      await new Promise((r) => setTimeout(r, 2000))
    }

    await advanceScreenQueue(app.deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 0 })
    const outstanding = (await screensNow())
      .flatMap((entry) => entry.runs)
      .filter((run) => run.outcome === 'pending')
    console.log(`  round ${round + 1}: ${heads.size}/${armCount} arms run, ${outstanding.length} still pending`)
    if (outstanding.length === 0) break
  }

  check('every arm of every screen ran', heads.size === armCount, `${heads.size} of ${armCount}`)
  /**
   * A branch each, and a head commit on each. Not *distinct* commits: two arms that committed
   * identical content onto the same base legitimately share a sha, and asserting otherwise
   * failed on the first run for a reason that had nothing to do with the screen.
   */
  check(
    'every screening run left a real branch',
    heads.size > 0 && [...heads.values()].every((sha) => /^[0-9a-f]{40}$/.test(sha)),
  )
  check(
    'and each clone opened at the commit the replay item pinned, not at HEAD',
    (
      await Promise.all(
        [...heads.keys()].map(async (id) =>
          (await app.deps.agentRuns.findById(workspaceId, asAgentRunId(id)))?.baseCommitSha,
        ),
      )
    ).every((sha) => sha === headCommit),
  )

  console.log('\n— the definition of done ran against those branches —')
  const verdicts = [...verdictFor.values()]
  check(
    'every screening run has a verdict, and none is still pending',
    verdicts.length === heads.size && verdicts.every((entry) => entry.status !== 'pending'),
    verdicts.map((entry) => entry.status).join(','),
  )
  const worseRunIds = (await screensNow())
    .filter((entry) => entry.screen.variantId === worseVariantId)
    .flatMap((entry) => entry.runs.map((run) => run.agentRunId as string))
  check(
    'the branch that failed a check is the one that was meant to',
    worseRunIds.length > 0 && worseRunIds.every((id) => verdictFor.get(id)?.status === 'failed'),
    worseRunIds.map((id) => verdictFor.get(id)?.status ?? '?').join(','),
  )
  check(
    'and the verdict names the check rather than only failing',
    (verdictFor.get(worseRunIds[0]!)?.checks ?? []).some(
      (entry: any) => entry.name === 'content' && entry.status === 'failed',
    ),
    JSON.stringify(
      (verdictFor.get(worseRunIds[0]!)?.checks ?? []).map((c: any) => [c.name, c.status]),
    ),
  )

  console.log('\n— the gate, on outcomes nobody wrote —')
  await advanceScreenQueue(app.deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 0 })
  const decided = await app.deps.screens.screensForSet(workspaceId, setId)

  /**
   * The assertion this whole driver is for. Every other check here would also pass if the
   * outcomes had been written by the script — this is the one that says they were not: each
   * scored run has a verification verdict behind it, and the score agrees with the verdict.
   */
  const scored = decided.flatMap((entry) => entry.runs)
  check(
    'every outcome was earned from a verification verdict, not written by this driver',
    scored.length > 0 &&
      scored.every((run) => {
        const verdict = verdictFor.get(run.agentRunId as string)
        if (!verdict) return false
        return verdict.status === 'passed' ? run.outcome === 'passed' : run.outcome === 'failed'
      }),
    scored.map((run) => run.outcome).join(','),
  )

  const rejected = decided.find((entry) => entry.screen.variantId === worseVariantId)
  const admitted = decided.find((entry) => entry.screen.variantId === levelVariantId)
  const incumbent = decided.find((entry) => entry.screen.variantId === null)
  check('the candidate whose branch failed is refused an arm', rejected?.screen.decision === 'rejected', rejected?.screen.decision ?? 'null')
  check('the level one is admitted — a tie is not a refusal', admitted?.screen.decision === 'admitted', admitted?.screen.decision ?? 'null')
  check(
    'and the rejection names the numbers a proposer could act on',
    /\d+ of \d+/.test(rejected?.screen.reason ?? ''),
    rejected?.screen.reason ?? '',
  )
  check(
    'the incumbent is scored too — it is what the gate compares to',
    (incumbent?.runs ?? []).every((run) => run.outcome !== 'pending'),
    (incumbent?.runs ?? []).map((run) => run.outcome).join(','),
  )

  const spend = await Promise.all(
    [...heads.keys()].map(
      async (id) =>
        (await app.deps.agentRuns.findById(workspaceId, asAgentRunId(id)))?.totalCostUsd ?? 0,
    ),
  )
  console.log(
    `\nscreening spend: $${spend.reduce((sum: number, cost) => sum + Number(cost), 0).toFixed(4)}`,
  )

  runner.kill('SIGTERM')
  await app.close()
  await closeDb()
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
