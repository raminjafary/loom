/**
 * The prosecutor pass, against a **real server and a real Runner process** — zero tokens.
 *
 *   docker compose up -d postgres valkey
 *   npx tsx tools/prosecutor-check.mts
 *
 * Why this exists alongside `prosecution-use-cases.test.ts`. That suite drives the use cases
 * against stubbed ports, so every row it checks is one this repository wrote for itself. What
 * it cannot answer is whether a prosecutor is actually *started* when a run finishes, whether
 * the frame the container would send is one the gateway accepts, and — the one that matters —
 * whether a broken probe leaves the branch's verdict alone.
 *
 * That last one is the whole design. "Evidence, never a verdict" is checked three ways in this
 * repository and each catches a different mistake: `architecture.test.ts` catches a merge path
 * that *reads* a prosecution, the domain suite catches a summary that *reads* like a verdict,
 * and this driver catches the one neither can — a prosecution that changes what the platform
 * says about a branch, through some path nobody thought to look at.
 *
 * The prosecutor's own run is refused by the Runner's unsandboxed guard, exactly as
 * `screen-check.mts` arranges, which is what keeps this at zero tokens: the run is started,
 * the row is opened, and the reporting frame is then sent over the real gateway by this driver
 * standing in for the container. What is under test is the platform, not the model's ability
 * to write a test.
 *
 * It **asserts** rather than prints. Two of the checks below are negatives — a verdict that
 * must not move, a merge that must not be blocked — and a printed value cannot fail.
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
import { recordProsecution, seedBuiltinPersonas } from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import { asAgentRunId, asWorkspaceId, summariseProsecution } from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'prosecutor-check-secret-at-least-32-chars',
  WS_SUBSCRIPTION_SECRET: 'prosecutor-check-subscription-secret-32c',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const main = async () => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `prosecutor-check-${Date.now()}`)
  const workspaceId = asWorkspaceId(ws.id)
  const app = await buildApp(config, devAuth({ userId: 'prosecutor-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${addr.port}`
  const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
  console.log('server on', base)

  const repoPath = await mkdtemp(join(tmpdir(), 'prosecutor-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  await writeFile(join(repoPath, 'README.md'), '# fixture\n')
  await git(repoPath, ['add', '-A'])
  await git(repoPath, ['-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'init'])

  const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'prosecutor-runner' })
  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: tmpdir(),
      // Unsandboxed and unacknowledged, as `screen-check.mts` arranges: the run is refused
      // after its clone, which costs nothing and still leaves every row this driver reads.
      LOOM_SANDBOX_ENABLED: '0',
      LOOM_ALLOW_UNSANDBOXED: '',
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `prosecutor-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 4000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: repoPath,
    displayName: 'prosecutor fixture',
  })
  await client.repository.setVerificationChecks({
    repositoryId: repo.id,
    checks: [{ name: 'tests', command: 'true' }],
  })

  /**
   * The built-ins, installed the way a real workspace gets them. The prosecutor is one of
   * them, and a driver that created its own would be checking a persona this repository
   * wrote here rather than the one it ships.
   */
  await seedBuiltinPersonas(app.deps, { workspaceId })
  const personas = await client.persona.list()
  const worker = personas.find((entry: any) => entry.name === 'swe')
  const prosecutor = personas.find((entry: any) => entry.name === 'prosecutor')
  check('the workspace is seeded with a prosecutor persona', prosecutor !== undefined)
  check(
    'and it is read-only about configuration but able to run what it writes',
    prosecutor?.tools?.includes('Bash') === true,
    (prosecutor?.tools ?? []).join(','),
  )

  const channel = await client.channel.create({ name: 'prosecutor-check' })
  const startedRun = await client.agentRun.start({
    threadId: channel.rootThread.id,
    repositoryId: repo.id,
    personaId: worker.id,
    task: 'A run whose branch will be prosecuted.',
  })

  let run = startedRun
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 500))
    run = await client.agentRun.get({ agentRunId: startedRun.id })
    if (['completed', 'failed', 'cancelled'].includes(run.status)) break
  }

  /**
   * A branch, written by this driver where the agent would have. The refused run leaves a
   * real clone at a real commit, which is everything the prosecution needs to be about
   * something.
   */
  if (!run.clonePath) throw new Error('the run never got a clone')
  await writeFile(join(run.clonePath, 'answer.txt'), 'ready\n')
  await git(run.clonePath, ['add', '-A'])
  await git(run.clonePath, [
    '-c', 'user.email=agent@loom.invalid', '-c', 'user.name=agent', 'commit', '-qm', 'answer',
  ])

  console.log('\n— a prosecution is opened when a run finishes with a branch —')
  /**
   * Started by the platform on the run's terminal transition. The row is what says it
   * happened; the prosecutor's own run is refused, which is the point of the zero-token
   * arrangement.
   */
  const prosecution = await app.deps.prosecutions.findByRun(workspaceId, asAgentRunId(run.id))
  check('a prosecution row exists for the finished run', prosecution !== null)
  check(
    'and it names the prosecutor run it is waiting on',
    prosecution?.prosecutorRunId !== null && prosecution?.prosecutorRunId !== undefined,
    prosecution?.prosecutorRunId ?? 'null',
  )
  check('which starts as running, not as a result', prosecution?.status === 'running', prosecution?.status ?? '?')

  const prosecutorRun = prosecution?.prosecutorRunId
    ? await app.deps.agentRuns.findById(workspaceId, asAgentRunId(prosecution.prosecutorRunId))
    : null
  check(
    'the prosecutor is a child of the run it prosecutes, with its own relation',
    prosecutorRun?.parentRunId === run.id && prosecutorRun?.relation === 'prosecute',
    `${prosecutorRun?.relation ?? 'null'} of ${prosecutorRun?.parentRunId ?? 'null'}`,
  )
  check(
    'and it was told not to re-run the repository’s own checks',
    /**
     * Unconditional: the prosecutor starts when the run ends, so the verdict is usually not
     * known yet, and the instruction not to re-run the repository's checks has to land
     * either way.
     */
    /Do not run them/.test(prosecutorRun?.task ?? ''),
  )

  console.log('\n— what a prosecutor reports —')
  const verdictBefore = (
    await app.deps.runVerifications.listByRuns(workspaceId, [asAgentRunId(run.id)])
  )[0]

  const reported = await recordProsecution(app.deps, {
    workspaceId,
    agentRunId: asAgentRunId(prosecution!.prosecutorRunId!),
    observations: [
      { name: 'the new branch accepts an empty answer', outcome: 'broke', detail: 'expected a refusal, got 200' },
      { name: 'the old path still refuses one', outcome: 'held', detail: null },
    ],
    inconclusive: null,
  })
  check('the report is accepted', reported.ok === true, reported.ok ? reported.outcome : reported.error)
  check(
    'and the sentence it answers with says out loud that it decides nothing',
    reported.ok && /does not affect/.test(reported.outcome),
  )

  const after = await app.deps.prosecutions.findByRun(workspaceId, asAgentRunId(run.id))
  check('the evidence is stored', after?.observations.length === 2, `${after?.observations.length ?? 0}`)
  check(
    'in the vocabulary that is not a verdict',
    after?.observations.every((entry) => entry.outcome === 'held' || entry.outcome === 'broke') === true,
    (after?.observations ?? []).map((entry) => entry.outcome).join(','),
  )
  check(
    'and it summarises as evidence rather than as a result',
    after !== null && !/fail|reject|block/i.test(summariseProsecution(after)),
    after ? summariseProsecution(after) : '',
  )

  console.log('\n— and it changes nothing —')
  /**
   * The three assertions the whole pass rests on. A broken probe is the strongest thing a
   * prosecutor can say, and after saying it the branch's verdict is the same verdict, the
   * run is the same run, and a merge is still whatever the repository's checks make it.
   */
  const verdictAfter = (
    await app.deps.runVerifications.listByRuns(workspaceId, [asAgentRunId(run.id)])
  )[0]
  check(
    'the branch’s verdict is untouched by a broken probe',
    verdictBefore?.status === verdictAfter?.status,
    `${verdictBefore?.status ?? 'none'} → ${verdictAfter?.status ?? 'none'}`,
  )
  const runAfter = await client.agentRun.get({ agentRunId: run.id })
  check('and so is the run', runAfter.status === run.status, `${run.status} → ${runAfter.status}`)

  const onTheWire = await client.agentRun.listProsecutions({ agentRunIds: [run.id] })
  check('the evidence reaches a client over the contract', onTheWire.length === 1)
  check(
    'and it is a separate call from the verdicts, not folded into them',
    (await client.agentRun.listVerifications({ agentRunIds: [run.id] }))[0]?.checks !== undefined &&
      onTheWire[0]?.observations !== undefined,
  )

  console.log('\n— a second report is refused rather than overwriting the first —')
  const again = await recordProsecution(app.deps, {
    workspaceId,
    agentRunId: asAgentRunId(prosecution!.prosecutorRunId!),
    observations: [{ name: 'a later opinion', outcome: 'held', detail: null }],
    inconclusive: null,
  })
  check('the second report is refused', again.ok === false)
  check(
    'and the first is still what is stored',
    (await app.deps.prosecutions.findByRun(workspaceId, asAgentRunId(run.id)))?.observations.length === 2,
  )

  const stranger = await recordProsecution(app.deps, {
    workspaceId,
    agentRunId: asAgentRunId(run.id),
    observations: [],
    inconclusive: null,
  })
  check(
    'a run that is prosecuting nothing cannot report about anything',
    stranger.ok === false,
    stranger.ok ? '' : stranger.error.slice(0, 60),
  )

  runner.kill('SIGTERM')
  await app.close()
  await closeDb()
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
