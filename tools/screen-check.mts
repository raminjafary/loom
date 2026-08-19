/**
 * Live driver for the held-out screen: real server, real Runner *process*, real
 * WebSocket protocol, real git repository, real Postgres, real HTTP contract.
 *
 *   docker compose up -d
 *   npx tsx tools/screen-check.mts
 *
 * Why this exists alongside the tests. `screen-queue.test.ts` drives the sweep against stubbed
 * ports; `repositories.integration.test.ts` drives the queries against real Postgres;
 * `PersonaEditor.test.ts` drives the panel against fixture props. **Nothing had watched a
 * screen decide.** The open-items list recorded that as its own limitation, and this is the
 * driver that closes it — with the one assertion none of the three can make: that the
 * commit a replay item pins is the commit the Runner's clone actually opened at.
 *
 * Spends **no tokens**, the substitution `merge-queue-check.mts` makes and for the same reason:
 * the screening runs it starts are refused by the Runner's own unsandboxed guard, which fires
 * *after* the clone. So every screening run has a real workspace at a real commit — which is
 * exactly what the pinning claim is about — and no model is ever called.
 *
 * That refusal also means the runs cannot produce a *branch*, so the outcomes the gate reads are
 * written here rather than earned. Stated plainly because it is the limit of this driver: what it
 * proves is the assembly, the dispatch, the pinning, the gate, the arm-dealing consequence and
 * the wire shape. What it does not prove is a definition of done running against an agent's
 * branch, which `verification-check.mts` already drives on its own.
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
import { advanceScreenQueue, proposeOwnVariants } from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import {
  MIN_REPLAY_ITEMS,
  asAgentPersonaId,
  asAgentRunId,
  asPersonaVariantSetId,
  asWorkspaceId,
} from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'screen-check-secret-at-least-32-characters',
  WS_SUBSCRIPTION_SECRET: 'screen-check-subscription-secret-32-chars',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const PERSONA_NAME = 'screen-check-worker'

const main = async () => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `screen-check-${Date.now()}`)
  const workspaceId = asWorkspaceId(ws.id)
  const app = await buildApp(config, devAuth({ userId: 'screen-check-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${addr.port}`
  const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
  console.log('server on', base)

  /**
   * Two commits, because the whole pinning claim is that a screening run opens at the *older*
   * one. A one-commit repository cannot tell a pinned clone from an unpinned one.
   */
  const repoPath = await mkdtemp(join(tmpdir(), 'screen-check-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  const commit = async (file: string, body: string, message: string) => {
    await writeFile(join(repoPath, file), body)
    await git(repoPath, ['add', '-A'])
    await git(repoPath, [
      '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', message,
    ])
    return git(repoPath, ['rev-parse', 'HEAD'])
  }
  const oldCommit = await commit('README.md', '# as it was\n', 'first')
  const headCommit = await commit('README.md', '# as it is now\n', 'second')
  console.log(`repo ${repoPath}\n  old  ${oldCommit.slice(0, 12)}\n  head ${headCommit.slice(0, 12)}`)

  const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'screen-check-runner' })
  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: tmpdir(),
      // Unsandboxed and unacknowledged, exactly as merge-queue-check.mts does: the run is
      // refused right after its clone is prepared, which costs nothing and still leaves the
      // real workspace at the real commit that this driver is about.
      LOOM_SANDBOX_ENABLED: '0',
      LOOM_ALLOW_UNSANDBOXED: '',
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `screen-check-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 4000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: repoPath,
    displayName: 'screen check repo',
  })
  const persona = await client.persona.create({
    markdownSource: [
      '---',
      `name: ${PERSONA_NAME}`,
      'description: Never actually runs; the workspace is what matters.',
      'model: claude-haiku-4-5-20251001',
      'tools: [Read]',
      'envelope:',
      '  tools: [Read]',
      '---',
      '',
      'THE PROMPT IN USE.',
    ].join('\n'),
  })
  const channel = await client.channel.create({ name: 'screen-check' })

  /** Starts a run and waits for its clone, the way `merge-queue-check.mts` does. */
  const startRun = async (task?: string) => {
    const run = await client.agentRun.start({
      threadId: channel.rootThread.id,
      repositoryId: repo.id,
      personaId: persona.id,
      ...(task === undefined ? {} : { task }),
    })
    let current = run
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 500))
      current = await client.agentRun.get({ agentRunId: run.id })
      if (current.clonePath && ['completed', 'failed', 'cancelled'].includes(current.status)) break
    }
    return current
  }

  console.log('\n— the material: decided runs with a task and the commit they opened at —')
  const history: string[] = []
  for (let i = 0; i < MIN_REPLAY_ITEMS + 1; i += 1) {
    // The task travels through the real contract, because a run with no task is ineligible
    // material and that eligibility rule is part of what this driver is checking.
    const run = await startRun(`Held-out task ${i}.`)
    history.push(run.id)
  }
  const seeded = await app.deps.screens.listDecidedRunsForPersona(workspaceId, PERSONA_NAME, 50)
  check(
    `${MIN_REPLAY_ITEMS + 1} runs are on record with the commit they opened at`,
    seeded.length >= MIN_REPLAY_ITEMS,
    `${seeded.length} decided, ${seeded.filter((r) => r.baseCommitSha !== null).length} with a commit`,
  )
  check(
    'and that commit is the repository HEAD they were actually cloned from',
    seeded.every((record) => record.baseCommitSha === headCommit),
    seeded[0]?.baseCommitSha?.slice(0, 12) ?? 'none',
  )

  console.log('\n— the search, and the screen it opens —')
  const proposer = await startRun()
  const proposed = await proposeOwnVariants(app.deps, {
    workspaceId,
    agentRunId: asAgentRunId(proposer.id),
    proposals: [
      { body: 'A FIRST CANDIDATE.', rationale: 'terser' },
      { body: 'A SECOND CANDIDATE.', rationale: 'more explicit' },
    ],
  })
  check('the search opened', proposed.ok === true, proposed.ok ? '' : proposed.reason)

  const searches = await client.persona.variantSearches()
  const search = searches.find((entry: any) => entry.personaId === persona.id)
  check('the search is on the wire', search !== undefined)
  check(
    'and it carries a screen rather than null',
    search?.screen !== null && search?.screen !== undefined,
    search?.screen ? `set v${search.screen.replaySetVersion}` : 'null',
  )
  check(
    'whose sentence names what it left out, not only what it holds',
    typeof search?.screen?.detail === 'string' && search.screen.detail.includes('considered'),
    search?.screen?.detail ?? '',
  )
  check(
    'one screen per arm, incumbent included',
    search?.screen?.arms.length === 3,
    `${search?.screen?.arms.length ?? 0} arms`,
  )

  console.log('\n— the sweep starts screening runs, pinned at the item’s commit —')
  await advanceScreenQueue(app.deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 4 })
  await new Promise((r) => setTimeout(r, 8000))

  const setId = asPersonaVariantSetId(search.setId)
  const screens = await app.deps.screens.screensForSet(workspaceId, setId)
  const startedIds = screens
    .flatMap((entry) => entry.runs)
    .map((entry) => entry.agentRunId)
    .filter((id): id is NonNullable<typeof id> => id !== null)
  check('screening runs were started', startedIds.length > 0, `${startedIds.length} started`)

  const startedRuns = await Promise.all(
    startedIds.map((id) => app.deps.agentRuns.findById(workspaceId, id)),
  )
  check(
    'each is a child of the proposing run, with relation `screen`',
    startedRuns.every((run) => run?.parentRunId === proposer.id && run?.relation === 'screen'),
    startedRuns.map((run) => run?.relation ?? 'null').join(','),
  )
  /**
   * The assertion nothing else in this repository can make. The item pins the commit the
   * original runs opened at; the Runner reports the sha its clone *actually* opened at on
   * `run_workspace_ready`; and the server stores that. Equal means the pin travelled the whole
   * way and was honoured by real git — and, because the repository has moved on since, unequal
   * would mean it silently opened at HEAD.
   */
  const withClone = startedRuns.filter((run) => run?.baseCommitSha)
  check(
    'and each clone opened at the commit the replay item pinned, not at HEAD',
    withClone.length > 0 && withClone.every((run) => run?.baseCommitSha === headCommit),
    withClone.map((run) => run?.baseCommitSha?.slice(0, 12) ?? '?').join(','),
  )

  console.log('\n— the gate: a candidate that does worse is refused an arm —')
  /**
   * The outcomes are written here rather than earned. See the header: the unsandboxed refusal
   * means no screening run produces a branch, so there is nothing for a definition of done to
   * judge. What is under test from here down is the gate and its consequence.
   */
  const incumbent = screens.find((entry) => entry.screen.variantId === null)!
  const candidates = screens.filter((entry) => entry.screen.variantId !== null)
  for (const entry of incumbent.runs) {
    await app.deps.screens.recordScreenRunOutcome(workspaceId, entry.id, {
      outcome: 'passed',
      reason: null,
    })
  }
  for (const entry of candidates[0]!.runs) {
    await app.deps.screens.recordScreenRunOutcome(workspaceId, entry.id, {
      outcome: 'failed',
      reason: null,
    })
  }
  for (const entry of candidates[1]!.runs) {
    await app.deps.screens.recordScreenRunOutcome(workspaceId, entry.id, {
      outcome: 'passed',
      reason: null,
    })
  }
  await advanceScreenQueue(app.deps, { screenStuckMs: 3_600_000, maxStartsPerTick: 0 })

  const decided = await app.deps.screens.screensForSet(workspaceId, setId)
  const rejected = decided.find((entry) => entry.screen.variantId === candidates[0]!.screen.variantId)
  const admitted = decided.find((entry) => entry.screen.variantId === candidates[1]!.screen.variantId)
  check('the worse candidate is rejected', rejected?.screen.decision === 'rejected', rejected?.screen.decision ?? 'null')
  check('the level one is admitted — a tie is not a refusal', admitted?.screen.decision === 'admitted', admitted?.screen.decision ?? 'null')
  check(
    'and the rejection names the numbers a proposer could act on',
    /\d+ of \d+/.test(rejected?.screen.reason ?? ''),
    rejected?.screen.reason ?? '',
  )
  check(
    'the incumbent is not gated — it is what the gate compares to',
    decided.find((entry) => entry.screen.variantId === null)?.screen.decision === null,
  )

  console.log('\n— the consequence: the rejected candidate is never dealt a live run —')
  const armIds = await app.deps.screens.admittedVariantIds(workspaceId, setId)
  check(
    'only the admitted candidate may be an arm',
    armIds?.length === 1 && armIds[0] === admitted?.screen.variantId,
    `${armIds?.length ?? 'null'} admitted`,
  )

  // Four live runs, which is more than enough for round-robin to reach every arm it is
  // allowed to reach — and therefore enough for the rejected one to have been dealt if the
  // gate were not doing anything.
  for (let i = 0; i < 4; i += 1) await startRun(`Live work ${i}.`)
  const arms = await app.deps.personaVariants.countVariantArms(workspaceId, setId)
  const rejectedArmCount = arms.find((arm) => arm.variantId === rejected?.screen.variantId)?.count ?? 0
  check(
    'no live run was spent on the rejected candidate',
    rejectedArmCount === 0,
    `${rejectedArmCount} runs on it, arms: ${arms.map((a) => `${a.variantId === null ? 'incumbent' : 'candidate'}=${a.count}`).join(' ')}`,
  )

  console.log('\n— the wire, again, now that the screen has decided —')
  const after = (await client.persona.variantSearches()).find(
    (entry: any) => entry.personaId === persona.id,
  )
  const wireRejected = after?.screen?.arms.find(
    (arm: any) => arm.variantId === rejected?.screen.variantId,
  )
  check('the panel is told the decision', wireRejected?.decision === 'rejected', wireRejected?.decision ?? 'null')
  check('and the reason, so the empty arm beside it is explained', typeof wireRejected?.reason === 'string' && wireRejected.reason.length > 0)
  check(
    'and the counts, so `0 passed` is distinguishable from `not screened`',
    wireRejected?.failed === incumbent.runs.length,
    `${wireRejected?.passed ?? '?'} passed / ${wireRejected?.failed ?? '?'} failed`,
  )

  runner.kill('SIGTERM')
  await app.close()
  await closeDb()
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
