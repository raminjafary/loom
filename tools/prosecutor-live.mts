/**
 * The prosecutor with a model in it: a real session reads a real diff, writes a probe that did
 * not exist before that diff did, runs it, and reports what it saw.
 *
 *   docker compose up -d postgres valkey egress-proxy
 *   export $(grep -E "^LOOM_EGRESS_CONTROL_SECRET=" .env | xargs)
 *   LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/prosecutor-live.mts
 *
 * Why this exists alongside `prosecutor-check.mts`. That driver spends no tokens, which is what
 * makes it runnable on every change — but it buys that by *standing in for the container*: it
 * calls `recordProsecution` itself, so every observation it stores is one this repository wrote.
 * It settles the plumbing and the three negatives, and says nothing about the only question the
 * pass is actually built around: whether a model handed this brief, these tools and somebody
 * else's diff produces evidence rather than a re-run of the suite.
 *
 * That gap has a track record. `designer-live.mts` was written for the same reason and found a
 * channel that was never offered — a zero-token driver writes the answer, so it cannot see a
 * tool the container was never given. The prosecutor's channel is gated three layers deep
 * (`start_run.prosecute` → the sandbox frame → the SDK server), and until this file ran, no
 * report in this system had ever crossed it from a model.
 *
 * Five things only a real session can settle, each an assertion below:
 *
 * 1. **The channel is actually offered inside the container.** Not that the frame carries a
 *    flag — that the model reaches for `report_prosecution` and it is there. The failure mode
 *    is silent and expensive: a session that cannot find the tool asks a human, parks, and is
 *    reported as a run that cost a dollar and refused nothing.
 * 2. **A prosecutor writes a new probe rather than re-running the suite.** This is the whole
 *    economic argument for the pass and it is a claim about a *model's* behaviour, so it is
 *    measured rather than asserted in prose: the fixture's standing suite appends a line to
 *    `.check-runs` whenever it executes, and that file must not exist in the prosecutor's clone
 *    when it is done. A prosecutor that re-ran the suite has spent its tokens learning what the
 *    reviewer already had.
 * 3. **It finds what the standing suite structurally cannot.** The branch under prosecution
 *    enforces half of a documented contract — the upper bound, not the lower — and the standing
 *    suite passes on it, because it was written before the contract had a lower bound to miss.
 *    An observation that `broke` is the pass doing the thing it exists for.
 * 4. **Evidence, never a verdict — after a *model* said so.** The three negatives that
 *    `prosecutor-check.mts` proves against its own writes are re-proved here against a report
 *    that came out of a container: the branch's verdict, the run's status, and what the
 *    contract hands a client are the same on both sides of a broken probe.
 * 5. **It opens on the right tree, and leaves it as it found it.** The prompt says "your clone
 *    is that branch" and says to commit nothing — and a clone is a real tree, so both are facts
 *    about the world rather than about the prompt. The first of them was false: a prosecutor was
 *    started like any other run, which means on a fresh branch off the default, which is the
 *    *base* of the diff it was sent to examine. Nothing failed. The session read its task, went
 *    looking for the branch it named, found no diff anywhere, and spent nine minutes and a third
 *    of a dollar searching the filesystem for it.
 *
 * The worker's diff is dictated rather than invented, and that is deliberate: the subject of
 * this driver is the prosecutor, so the thing under prosecution has to be the same diff every
 * run. `prosecutor-check.mts` writes that branch by hand for the same reason; here it goes
 * through a real run because the sandbox is a property of the Runner, not of a run, and this
 * one has to be sandboxed. If the worker deviates, the precondition below fails and says so
 * rather than letting the prosecutor be blamed for a fixture that was never planted.
 *
 * Not a test: it spends real tokens and is run by hand. It asserts loudly and exits non-zero.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildApp, devAuth } from '../apps/server/src/index.js'
import { loadConfig } from '../apps/server/src/config.js'
import { advanceVerificationQueue, seedBuiltinPersonas } from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import { asAgentRunId, asWorkspaceId, summariseProsecution } from '../packages/domain/src/index.js'
import { REPORT_PROSECUTION_TOOL_NAME } from '../apps/runner/src/prosecution-tool.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'prosecutor-live-secret-at-least-32-charact',
  WS_SUBSCRIPTION_SECRET: 'prosecutor-live-subscription-secret-32ch',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const WORKER = 'prosecutor-live-worker'

/**
 * The fixture, in three files.
 *
 * `CONTRACT.md` states a two-sided bound. `discount.mjs` implements neither side yet, and the
 * standing suite checks the two cases anybody would have written before the bound existed — so
 * it is exactly the suite the change is least likely to be caught by, which is the asymmetry
 * the whole pass is about, made small enough to run in a second.
 *
 * The witness line in the standing suite is what turns "a prosecutor should not re-run the
 * checks" from prose into something a driver can fail on. It is in the suite rather than in the
 * check *command* so that running it by any route is recorded — `node test.mjs` counts as
 * re-running the repository's checks whether or not it went through the check the repository
 * declared.
 */
const CONTRACT = `# Discounts

\`applyDiscount(price, percent)\` takes a percentage off a price.

**\`percent\` must be between 0 and 50 inclusive.** A percentage outside that range is a
programming error and must be rejected with a \`RangeError\` rather than applied. A discount
may never increase a price.
`

const DISCOUNT_BEFORE = `export const applyDiscount = (price, percent) => price - (price * percent) / 100
`

/** What the worker is told to write, verbatim. Half the contract: the upper bound only. */
const DISCOUNT_AFTER = `export const applyDiscount = (price, percent) => {
  if (percent > 50) throw new RangeError('discount too large')
  return price - (price * percent) / 100
}
`

const STANDING_SUITE = `import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { applyDiscount } from './discount.mjs'

appendFileSync(new URL('./.check-runs', import.meta.url), \`\${Date.now()}\\n\`)

assert.equal(applyDiscount(100, 10), 90)
assert.equal(applyDiscount(100, 0), 100)
console.log('ok')
`

const main = async () => {
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
        '  LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/prosecutor-live.mts',
    )
    process.exit(1)
  }

  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `prosecutor-live-${Date.now()}`)
  const workspaceId = asWorkspaceId(ws.id)
  const app = await buildApp(config, devAuth({ userId: 'prosecutor-live-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))
  console.log('server on', `http://127.0.0.1:${addr.port}`)

  const repoPath = await mkdtemp(join(tmpdir(), 'prosecutor-live-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  await writeFile(join(repoPath, 'CONTRACT.md'), CONTRACT)
  await writeFile(join(repoPath, 'discount.mjs'), DISCOUNT_BEFORE)
  await writeFile(join(repoPath, 'test.mjs'), STANDING_SUITE)
  // Never committed, so its presence in a clone means that clone ran the suite.
  await writeFile(join(repoPath, '.gitignore'), '.check-runs\n')
  await git(repoPath, ['add', '-A'])
  await git(repoPath, [
    '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'discounts, uncapped',
  ])

  const { runnerId, rawToken } = await client.runner.createPairingToken({
    name: 'prosecutor-live-runner',
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
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `prosecutor-live-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 5000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: repoPath,
    displayName: 'prosecutor live repo',
  })
  await client.repository.setVerificationChecks({
    repositoryId: repo.id,
    checks: [{ name: 'tests', command: 'node test.mjs' }],
  })

  /**
   * The built-ins, because the prosecutor under test has to be the persona this repository
   * ships rather than one written here to pass. The worker beside it is local and cheap: it is
   * scenery, and its model choice should not cost what the subject costs.
   */
  await seedBuiltinPersonas(app.deps, { workspaceId })
  const prosecutorPersona = (await client.persona.list()).find(
    (entry: any) => entry.name === 'prosecutor',
  )
  check('the workspace ships a prosecutor persona', prosecutorPersona !== undefined)

  const worker = await client.persona.create({
    markdownSource: [
      '---',
      `name: ${WORKER}`,
      'description: Applies one dictated edit and stops.',
      'model: claude-haiku-4-5-20251001',
      'tools: [Read, Edit, Write]',
      'harness:',
      '  approvalMode: auto',
      '  budgetCapUsd: 0.5',
      '---',
      '',
      'You apply the edit you are given, exactly, and stop.',
    ].join('\n'),
  })

  const channel = await client.channel.create({ name: 'prosecutor-live' })
  console.log('\n— a branch to prosecute —')
  const startedRun = await client.agentRun.start({
    threadId: channel.rootThread.id,
    repositoryId: repo.id,
    personaId: worker.id,
    task:
      'Read CONTRACT.md, then replace the whole contents of `discount.mjs` with exactly this ' +
      'and nothing else:\n\n' +
      '```js\n' +
      DISCOUNT_AFTER +
      '```\n\n' +
      'Do not edit any other file. Do not add or run tests. Stop when discount.mjs matches.',
  })

  const settle = async (id: string, label: string, deadlineMs: number, onTick?: () => void) => {
    const startedAt = Date.now()
    let run = await app.deps.agentRuns.findById(workspaceId, asAgentRunId(id))
    while (Date.now() - startedAt < deadlineMs) {
      run = await app.deps.agentRuns.findById(workspaceId, asAgentRunId(id))
      onTick?.()
      if (
        run !== null &&
        ['completed', 'failed', 'cancelled', 'awaiting_approval'].includes(run.status)
      ) {
        break
      }
      // Fast, because one of the things being sampled is a file the session writes, runs and
      // deletes inside a single tool call. At three seconds a 57-second run missed it.
      await new Promise((r) => setTimeout(r, 400))
    }
    console.log(
      `\n${label} ${String(run?.status)} after ${Math.round((Date.now() - startedAt) / 1000)}s, ` +
        `cost $${String(run?.totalCostUsd ?? 0)}${run?.errorMessage ? ` — ${run.errorMessage}` : ''}`,
    )
    /**
     * A session that is not finished is stopped here rather than left running, and
     * `awaiting_approval` counts: it ends the wait because a prosecutor has no approval to
     * give — it reads, writes, runs and reports — so a parked one is a finding, but the
     * *container* is still up and will sit there until something kills it.
     *
     * `designer-live.mts` learned this by walking away from one for twenty-five minutes. This
     * driver did the same thing on the run that found the missing local `main`: the session
     * asked a human why its clone was on the wrong branch, the driver reported the finding and
     * exited, and the container was still up forty-two minutes later. The Runner that would
     * reap it starts with a fresh state directory each time and cannot know the container was
     * its predecessor's, so the only process that knows is this one. The workspace-wide
     * control is the right instrument because this workspace is the driver's own.
     */
    if (run !== null && !['completed', 'failed', 'cancelled'].includes(run.status)) {
      await client.runControl.pauseAll()
      await client.runControl.resume()
      console.log(`  (${label} was still open and has been stopped — nothing was reading it)`)
    }
    return run
  }

  const workerRun = await settle(startedRun.id, 'the worker', 8 * 60 * 1000)
  check(
    'the worker ran to the end',
    workerRun?.status === 'completed',
    `${String(workerRun?.status)}${workerRun?.errorMessage ? ` — ${workerRun.errorMessage}` : ''}`,
  )

  /**
   * The fixture, verified rather than assumed. Everything below is about the prosecutor, and a
   * prosecutor handed a diff that does not contain the defect has been set an easier question
   * than this driver claims to be asking — so the planting is checked before the claiming.
   */
  if (!workerRun?.clonePath) throw new Error('the worker run never got a clone')
  const branchHead = await git(workerRun.clonePath, ['rev-parse', 'HEAD'])
  const onBranch = await git(workerRun.clonePath, ['show', 'HEAD:discount.mjs'])
  check(
    'the branch enforces the contract’s upper bound',
    /percent\s*>\s*50/.test(onBranch),
    onBranch.replace(/\n/g, ' ').slice(0, 90),
  )
  check(
    'and not its lower one — the defect the standing suite cannot see is planted',
    !/percent\s*<\s*0/.test(onBranch),
  )
  const { stdout: standingOutput } = await execFileAsync('node', ['test.mjs'], {
    cwd: workerRun.clonePath,
  })
  check(
    'the standing suite still passes on it, which is the whole asymmetry',
    standingOutput.trim() === 'ok',
    standingOutput.trim(),
  )

  console.log('\n— the platform opens a prosecution —')
  let prosecution = await app.deps.prosecutions.findByRun(workspaceId, asAgentRunId(startedRun.id))
  for (let i = 0; i < 20 && prosecution === null; i += 1) {
    await new Promise((r) => setTimeout(r, 1000))
    prosecution = await app.deps.prosecutions.findByRun(workspaceId, asAgentRunId(startedRun.id))
  }
  check('a prosecution row exists for the finished run', prosecution !== null)
  if (prosecution?.prosecutorRunId == null) {
    console.log('\nno prosecutor was started, so there is nothing to watch')
    runner.kill('SIGTERM')
    await app.close()
    await closeDb()
    process.exit(1)
  }

  /**
   * The verdict is snapshotted once the repository's own checks have actually finished, rather
   * than at whatever moment this driver happens to reach — a verdict that was still `pending`
   * on the way in would compare equal to itself for the boring reason.
   */
  const verdictOf = async () =>
    (await app.deps.runVerifications.listByRuns(workspaceId, [asAgentRunId(startedRun.id)]))[0]
  /**
   * Swept by this driver, because nothing else does: `enqueueRunVerification` writes the row
   * and `advanceVerificationQueue` is what runs the checks. Left unswept the verdict stays
   * `pending`, and "the verdict is untouched" would compare `pending` to `pending` — true, and
   * about nothing.
   */
  const sweep = () => advanceVerificationQueue(app.deps, { verificationStuckMs: 1_800_000 })
  let verdictBefore = await verdictOf()
  for (let i = 0; i < 60 && (verdictBefore === undefined || verdictBefore.status === 'pending'); i += 1) {
    await sweep().catch(() => undefined)
    await new Promise((r) => setTimeout(r, 2000))
    verdictBefore = await verdictOf()
  }
  console.log(`the repository’s own checks said: ${verdictBefore?.status ?? 'nothing yet'}`)

  const prosecutorRunId = prosecution.prosecutorRunId
  let prosecutorClone: string | null = null

  /**
   * Sampled while it works rather than read once at the end. What the prosecutor wrote is the
   * evidence for check 2 and check 5, and a clone is a live tree — a probe written, run and
   * tidied away would be invisible to a driver that only looked afterwards.
   */
  const wroteFiles = new Set<string>()
  let ranStandingSuite = false
  const sample = () => {
    if (prosecutorClone === null) {
      void app.deps.agentRuns
        .findById(workspaceId, asAgentRunId(prosecutorRunId))
        .then((row) => {
          prosecutorClone = row?.clonePath ?? null
        })
        .catch(() => undefined)
      return
    }
    if (!existsSync(prosecutorClone)) return
    if (existsSync(join(prosecutorClone, '.check-runs'))) ranStandingSuite = true
    void git(prosecutorClone, ['status', '--porcelain', '--untracked-files=all'])
      .then((out) => {
        for (const line of out.split('\n')) {
          const path = line.slice(3).trim()
          if (path !== '') wroteFiles.add(path)
        }
      })
      .catch(() => undefined)
  }

  console.log('\n— and a model prosecutes the diff —')
  const prosecutorRun = await settle(prosecutorRunId, 'the prosecutor', 20 * 60 * 1000, sample)
  sample()

  check(
    'the session reached a model rather than being refused before one',
    Number(prosecutorRun?.totalCostUsd ?? 0) > 0,
    `$${String(prosecutorRun?.totalCostUsd ?? 0)}`,
  )
  check(
    'and it ran to the end',
    prosecutorRun?.status === 'completed',
    `${String(prosecutorRun?.status)}${prosecutorRun?.errorMessage ? ` — ${prosecutorRun.errorMessage}` : ''}`,
  )

  /**
   * The tool traffic, read from the thread a person reads. Matched on the tool's own name at the
   * head of the line rather than anywhere in the text: `designer-live.mts` learned that the hard
   * way, passing on the run that found the bug because the model had asked a human why the tool
   * was missing and the question quoted its name.
   */
  const messages: any[] = []
  let cursor: string | undefined
  do {
    const page = await client.message.list({
      threadId: channel.rootThread.id,
      limit: 100,
      view: 'all',
      ...(cursor === undefined ? {} : { cursor }),
    })
    messages.push(...page.messages)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined && messages.length < 2000)
  const textOf = (message: any) => String(message?.body?.text ?? message?.text ?? '')
  const calls = messages.filter((message) =>
    textOf(message).startsWith(`→ ${REPORT_PROSECUTION_TOOL_NAME}`),
  )
  const callIds = new Set(calls.map((message) => String(message.toolUseId)))
  const results = messages.filter(
    (message) =>
      message.toolUseId !== null &&
      callIds.has(String(message.toolUseId)) &&
      !textOf(message).startsWith('→'),
  )
  const askedForIt = messages.filter(
    (message) => textOf(message).startsWith('→') && textOf(message).includes('ask_human'),
  )

  console.log(`the session called the prosecution tool ${calls.length} time(s)`)
  check(
    'the channel exists inside the container and a model reached for it',
    calls.length > 0,
    `${calls.length} call(s)`,
  )
  check(
    'and it did not have to ask a human where that tool was',
    askedForIt.length === 0,
    askedForIt.map((message) => textOf(message).slice(0, 160)).join(' | '),
  )
  check(
    'every call it made came back with an answer it could read',
    results.length === calls.length,
    `${results.length} of ${calls.length}`,
  )

  console.log('\n— what a model wrote, and what it did not run —')
  const probes = [...wroteFiles].filter((path) => path !== '.check-runs')
  console.log(`  it left ${probes.length} file(s) in its clone: ${probes.join(', ') || '(none)'}`)
  /**
   * Sampled rather than read at the end, because a tidy session deletes what it wrote in the
   * same tool call that ran it. What is asserted is that a file appeared in the clone at some
   * point that was not in the branch — which, with the standing suite untouched, is the pass
   * doing the thing it exists for.
   */
  check(
    'it wrote a probe that did not exist before this diff did',
    probes.length > 0,
    probes.join(', '),
  )
  /**
   * The economic argument for the whole pass, as an observation rather than a promise. A
   * prosecutor that re-ran the standing suite has spent its tokens producing the one thing the
   * reviewer already has.
   */
  check(
    'and it did not re-run the repository’s standing suite',
    !ranStandingSuite,
    ranStandingSuite ? '.check-runs exists in the prosecutor’s clone' : '',
  )
  /**
   * The check this driver was missing on the run that found the defect. A prosecutor is
   * started like any other run unless the frame says otherwise, and "like any other run"
   * means a fresh branch off the default — which is the base of the change it was sent to
   * examine. Everything downstream still looks healthy: the session starts, reaches a model,
   * reads its task, and spends its budget looking for a branch its clone does not have.
   */
  if (prosecutorClone === null) {
    check('the prosecutor got a clone', false)
  } else {
    /**
     * The exact command the prosecutor's own task hands it, run here for the same reason: an
     * error and an empty diff are different sentences, and a driver that swallowed the error
     * reported "the diff was empty" about a clone whose `main` did not exist.
     */
    const diffStat = await git(prosecutorClone, [
      '-c', 'safe.directory=*', 'diff', '--stat', 'main...HEAD',
    ]).catch((error: unknown) => `ERROR ${error instanceof Error ? error.message : String(error)}`)
    check(
      'the diff its task tells it to run is a diff it can run',
      !diffStat.startsWith('ERROR'),
      diffStat.startsWith('ERROR') ? diffStat.replace(/\n/g, ' ').slice(0, 160) : '',
    )
    check(
      'its clone opens on the branch under prosecution, not on that branch’s base',
      /discount\.mjs/.test(diffStat),
      diffStat.replace(/\n/g, ' ').slice(0, 120) || '(the diff was empty)',
    )
    check(
      'so the change is actually in the tree it reads',
      /percent\s*>\s*50/.test(
        await git(prosecutorClone, ['-c', 'safe.directory=*', 'show', 'HEAD:discount.mjs']).catch(
          () => '',
        ),
      ),
    )
    check(
      'it committed nothing, as its prompt asks',
      (await git(prosecutorClone, ['-c', 'safe.directory=*', 'rev-parse', 'HEAD'])) === branchHead,
    )
  }

  console.log('\n— the evidence —')
  const after = await app.deps.prosecutions.findByRun(workspaceId, asAgentRunId(startedRun.id))
  for (const observation of after?.observations ?? []) {
    console.log(
      `  ${observation.outcome === 'broke' ? '✗' : '·'} ${observation.name}` +
        `${observation.detail ? `\n      ${observation.detail.replace(/\n/g, '\n      ').slice(0, 400)}` : ''}`,
    )
  }
  /**
   * Whatever the session did, the row is finished — `inconclusive` is the domain's word for a
   * prosecutor that produced nothing, and until a live run left one `running` for ever,
   * nothing wrote it.
   */
  check(
    'the prosecution is closed either way, never left running',
    after?.status !== 'running',
    after?.status ?? 'none',
  )
  check(
    'it reported rather than giving up',
    after?.status === 'reported',
    `${after?.status ?? 'none'}${after?.reason ? ` — ${after.reason}` : ''}`,
  )
  check('with observations a person can read', (after?.observations.length ?? 0) > 0)
  check(
    'in the vocabulary that is not a verdict',
    (after?.observations ?? []).every((entry) => entry.outcome === 'held' || entry.outcome === 'broke'),
    (after?.observations ?? []).map((entry) => entry.outcome).join(','),
  )
  /**
   * The pass doing the thing it exists for. The lower bound is missing, the contract states it,
   * the standing suite passes anyway — so a probe written *because of this diff* should break,
   * and if none does then either the model did not read the diff or the brief did not ask it to.
   */
  check(
    'and at least one probe broke on the half of the contract the suite cannot see',
    (after?.observations ?? []).some((entry) => entry.outcome === 'broke'),
    summariseProsecution(after!),
  )
  check(
    'the summary reads as evidence rather than as a result',
    after !== null && !/fail|reject|block/i.test(summariseProsecution(after)),
    after ? summariseProsecution(after) : '',
  )

  console.log('\n— and none of it moved anything —')
  const verdictAfter = await verdictOf()
  check(
    'the branch’s verdict is untouched by a broken probe from a model',
    verdictBefore?.status === verdictAfter?.status,
    `${verdictBefore?.status ?? 'none'} → ${verdictAfter?.status ?? 'none'}`,
  )
  check(
    'and every check inside it says what it said',
    JSON.stringify(verdictBefore?.checks ?? []) === JSON.stringify(verdictAfter?.checks ?? []),
  )
  const runAfter = await client.agentRun.get({ agentRunId: startedRun.id })
  check(
    'the prosecuted run is the same run',
    runAfter.status === workerRun?.status,
    `${String(workerRun?.status)} → ${runAfter.status}`,
  )
  const onTheWire = await client.agentRun.listProsecutions({ agentRunIds: [startedRun.id] })
  check('the evidence reaches a client over the contract', onTheWire.length === 1)
  check(
    'as its own call, not folded into the verdicts',
    onTheWire[0]?.observations !== undefined &&
      (await client.agentRun.listVerifications({ agentRunIds: [startedRun.id] }))[0]?.checks !==
        undefined,
  )

  /**
   * If the model reported twice, the second one is a refusal rather than an overwrite — the
   * same rule `prosecutor-check.mts` proves against its own second call, checked here against
   * whatever the session actually did.
   */
  if (calls.length > 1) {
    const refused = results.filter((message) => /not recorded/i.test(textOf(message)))
    check(
      'a second report was refused rather than overwriting the first',
      refused.length === calls.length - 1,
      `${refused.length} refusal(s) for ${calls.length} call(s)`,
    )
  }

  runner.kill('SIGTERM')
  await app.close()
  await closeDb()
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
