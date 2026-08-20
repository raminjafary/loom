/**
 * Live driver for the replay campaign: real server, real Runner *process*, real WebSocket
 * protocol, real git repository, real Postgres, real HTTP contract.
 *
 *   docker compose up -d
 *   npx tsx tools/campaign-check.mts
 *
 * Why this exists alongside the tests. `campaign-queue.test.ts` drives the sweep against
 * stubbed ports, `repositories.integration.test.ts` drives the rows against real Postgres, and
 * `PersonaEditor.test.ts` drives the panel against fixture props. **No campaign had ever dealt
 * a real run against a real repository** — the same gap the screen had before
 * `screen-check.mts`, which then found two defects.
 *
 * Spends **no tokens**, the substitution `screen-check.mts` and `merge-queue-check.mts` make:
 * the campaign runs it starts are refused by the Runner's own unsandboxed guard, which fires
 * *after* the clone. So every campaign run has a real workspace at a real commit — which is
 * what the pinning claim is about — and no model is ever called.
 *
 * Four things only this can settle, and the first two are the ones a campaign has and a
 * screen does not:
 *
 * 1. **An arm really is a different document.** A campaign's arms are vintages, so what has to
 *    reach the Runner is the *old* persona body — not the one on the row. This checks the
 *    substituted system prompt on each dispatched run, per arm, and that the live persona row
 *    was never touched by any of it.
 * 2. **A campaign run opens at the item's commit and not at HEAD**, checked where it can
 *    actually be wrong: the repository is moved on *after* the history is recorded, so a clone
 *    that ignored the pin would open at a commit that did not exist when the work was done.
 * 3. **A campaign's own runs never become the material of the next one.** They are
 *    `relation: 'screen'` for exactly this reason, and a campaign that fed its output back
 *    into the population it measures would look identical from the outside.
 * 4. **The cap halts rather than degrades, and the score then says "Partial." first.**
 *
 * The outcomes and the one spend figure below are written by this driver rather than earned —
 * the unsandboxed refusal means no campaign run produces a branch for a definition of done to
 * judge. Stated plainly, because it is this driver's limit: what it proves is the assembly,
 * the dispatch, the arm substitution, the pinning, the exclusion, the cap and the report.
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
import { advanceCampaignQueue, campaignReport } from '../packages/application/src/index.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import {
  MIN_REPLAY_ITEMS,
  asReplayCampaignId,
  asWorkspaceId,
} from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'campaign-check-secret-at-least-32-characters',
  WS_SUBSCRIPTION_SECRET: 'campaign-check-subscription-secret-32-ch',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const PERSONA_NAME = 'campaign-check-worker'

/**
 * Two markers, so "which document did this arm actually run" is answerable from the row
 * rather than inferred. A vintage arm carrying the live marker would be a campaign measuring
 * the same document twice and reporting it as two.
 */
const VINTAGE_MARKER = `VINTAGE-${Date.now().toString(36).toUpperCase()}`
const LIVE_MARKER = `LIVE-${Date.now().toString(36).toUpperCase()}`

const personaDoc = (body: string) =>
  [
    '---',
    `name: ${PERSONA_NAME}`,
    'description: Never actually runs; the workspace and the prompt are what matter.',
    'model: claude-haiku-4-5-20251001',
    'tools: [Read]',
    '---',
    '',
    body,
  ].join('\n')

const main = async () => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `campaign-check-${Date.now()}`)
  const workspaceId = asWorkspaceId(ws.id)
  const app = await buildApp(config, devAuth({ userId: 'campaign-check-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${addr.port}`
  const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
  console.log('server on', base)

  const repoPath = await mkdtemp(join(tmpdir(), 'campaign-check-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  const commit = async (file: string, body: string, message: string) => {
    await writeFile(join(repoPath, file), body)
    await git(repoPath, ['add', '-A'])
    await git(repoPath, [
      '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', message,
    ])
    return git(repoPath, ['rev-parse', 'HEAD'])
  }
  const workedAt = await commit('README.md', '# as it was when the work was done\n', 'first')

  const { runnerId, rawToken } = await client.runner.createPairingToken({
    name: 'campaign-check-runner',
  })
  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: tmpdir(),
      // Unsandboxed and unacknowledged, exactly as `screen-check.mts` does: the run is refused
      // right after its clone is prepared, which costs nothing and still leaves a real
      // workspace at the real commit this driver is about.
      LOOM_SANDBOX_ENABLED: '0',
      LOOM_ALLOW_UNSANDBOXED: '',
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `campaign-check-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 4000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: repoPath,
    displayName: 'campaign check repo',
  })
  const persona = await client.persona.create({
    markdownSource: personaDoc(`THE PROMPT IT USED TO HAVE. ${VINTAGE_MARKER}`),
  })
  const channel = await client.channel.create({ name: 'campaign-check' })

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

  console.log('\n— the material: this persona’s own decided work, at the commit it opened at —')
  for (let i = 0; i < MIN_REPLAY_ITEMS + 1; i += 1) await startRun(`Past task ${i}.`)
  const material = await app.deps.screens.listDecidedRunsForPersona(workspaceId, PERSONA_NAME, 50)
  check(
    `${MIN_REPLAY_ITEMS + 1} decided runs are on record`,
    material.length >= MIN_REPLAY_ITEMS,
    `${material.length} decided`,
  )
  check(
    'each carrying the commit its clone actually opened at',
    material.every((record) => record.baseCommitSha === workedAt),
    material[0]?.baseCommitSha?.slice(0, 12) ?? 'none',
  )

  /**
   * The repository moves on, and the persona is rewritten — in that order, so that by the time
   * the campaign runs, *both* the code and the document have changed since the work was done.
   * A campaign that ignored either would be measuring today's prompt against today's tree and
   * calling it history.
   */
  const movedOn = await commit('README.md', '# and here is a later commit\n', 'second')
  await client.persona.update({
    personaId: persona.id,
    markdownSource: personaDoc(`THE PROMPT IT HAS NOW. ${LIVE_MARKER}`),
  })
  const revisions = await client.persona.revisions({ personaId: persona.id })
  check('the rewrite left a vintage to replay', revisions.length === 1, `${revisions.length} revision(s)`)
  check(
    'and the vintage is the document that was replaced, not the one that replaced it',
    (revisions[0]?.markdownSource ?? '').includes(VINTAGE_MARKER),
  )
  console.log(`  worked at ${workedAt.slice(0, 12)}, HEAD is now ${movedOn.slice(0, 12)}`)

  console.log('\n— a person opens a campaign over the real contract —')
  const opened = await client.campaign.open({
    personaId: persona.id,
    label: 'campaign-check',
    capUsd: 5,
    revisionIds: [revisions[0].id],
  })
  check('the campaign opened', opened.opened === true, opened.detail)
  check(
    'and the sentence says how many runs it is authorizing, before any of them start',
    /\d+ arms over \d+ items — up to \d+ runs/.test(opened.detail ?? ''),
    opened.detail ?? '',
  )
  const campaignId = asReplayCampaignId(opened.campaignId)

  console.log('\n— the sweep deals real runs, one arm per vintage —')
  // Generously above arms × items, because what is being checked is the dispatch and not the
  // sweep's own pacing, which `campaign-queue.test.ts` covers against stubs.
  await advanceCampaignQueue(app.deps, { campaignStuckMs: 3_600_000, maxStartsPerTick: 64 })
  await new Promise((r) => setTimeout(r, 10_000))

  const dealt = await app.deps.campaigns.armsForCampaign(workspaceId, campaignId)
  const dealtRunIds = dealt
    .flatMap((entry) => entry.runs)
    .map((entry) => entry.agentRunId)
    .filter((id): id is NonNullable<typeof id> => id !== null)
  check('campaign runs were started', dealtRunIds.length > 0, `${dealtRunIds.length} started`)

  const dealtRuns = await Promise.all(
    dealtRunIds.map((id) => app.deps.agentRuns.findById(workspaceId, id)),
  )
  check(
    'each is a parentless run carrying `relation: screen`',
    dealtRuns.every((run) => run?.parentRunId === null && run?.relation === 'screen'),
    dealtRuns.map((run) => `${run?.parentRunId === null ? 'root' : 'child'}/${run?.relation ?? 'null'}`).join(' '),
  )
  check(
    'and each clone opened at the commit the item pinned, not at the HEAD it has now',
    dealtRuns.length > 0 &&
      dealtRuns.every((run) => run?.baseCommitSha === workedAt) &&
      dealtRuns.every((run) => run?.baseCommitSha !== movedOn),
    dealtRuns.map((run) => run?.baseCommitSha?.slice(0, 12) ?? '?').join(','),
  )

  console.log('\n— the campaign closes, and reports what it measured —')
  for (let i = 0; i < 6; i += 1) {
    await advanceCampaignQueue(app.deps, { campaignStuckMs: 3_600_000, maxStartsPerTick: 64 })
    const current = await app.deps.campaigns.findById(workspaceId, campaignId)
    if (current?.status !== 'running') break
    await new Promise((r) => setTimeout(r, 3_000))
  }
  /**
   * The assertion this driver exists for. An arm *is* a document, so the run dispatched for the
   * vintage arm has to carry the vintage's body in the snapshot it was started with — and the
   * control's has to carry the live one. Read off the stored run rather than off the frame,
   * because the row is what every later reader of this campaign will see.
   */
  const settled = await app.deps.campaigns.armsForCampaign(workspaceId, campaignId)
  const vintageArm = settled.find((entry) => entry.arm.revisionId !== null)
  const controlArm = settled.find((entry) => entry.arm.revisionId === null)
  const promptsFor = async (runs: readonly { agentRunId: string | null }[]) => {
    const rows = await Promise.all(
      runs
        .map((entry) => entry.agentRunId)
        .filter((id): id is string => id !== null)
        .map((id) => app.deps.agentRuns.findById(workspaceId, id as never)),
    )
    return rows.map((row) => row?.persona.systemPrompt ?? '')
  }
  const vintagePrompts = await promptsFor(vintageArm?.runs ?? [])
  const controlPrompts = await promptsFor(controlArm?.runs ?? [])
  /**
   * Both arms over the whole set, checked before the prompts are — because "every dispatched
   * run carried the right document" is satisfied trivially by an arm that was dealt one run,
   * and the first pass of this driver read the arms mid-sweep and asserted over six rows out
   * of ten without noticing.
   */
  check(
    'every arm was dealt every item',
    vintagePrompts.length === controlPrompts.length && controlPrompts.length > 0,
    `${controlPrompts.length} control vs ${vintagePrompts.length} vintage`,
  )
  check(
    'the vintage arm’s runs were dispatched with the vintage document',
    vintagePrompts.length > 0 && vintagePrompts.every((prompt) => prompt.includes(VINTAGE_MARKER)),
    `${vintagePrompts.length} run(s)`,
  )
  check(
    'the control arm’s runs were dispatched with the document in use',
    controlPrompts.length > 0 && controlPrompts.every((prompt) => prompt.includes(LIVE_MARKER)),
    `${controlPrompts.length} run(s)`,
  )
  check(
    'and no arm ran the other one’s prompt',
    vintagePrompts.every((prompt) => !prompt.includes(LIVE_MARKER)) &&
      controlPrompts.every((prompt) => !prompt.includes(VINTAGE_MARKER)),
  )

  const liveNow = (await client.persona.list()).find((entry: any) => entry.id === persona.id)
  check(
    'the persona row itself was never touched — a campaign measures, it does not promote',
    (liveNow?.markdownSource ?? '').includes(LIVE_MARKER) &&
      !(liveNow?.markdownSource ?? '').includes(VINTAGE_MARKER),
  )

  const report = await campaignReport(app.deps, { workspaceId, campaignId })
  check('the campaign reached a terminal state', report?.campaign.status !== 'running', report?.campaign.status ?? 'gone')
  check(
    'the report names every arm, the control included',
    (report?.arms.length ?? 0) === 2,
    (report?.arms ?? []).map((arm) => arm.label).join(' | '),
  )
  check(
    'and says, in the same paragraph as the numbers, that it is not reporting growth',
    (report?.detail ?? '').includes('it does not report growth'),
  )
  check(
    'the spend it reports is summed from its own rows',
    report?.spentUsd === 0,
    `$${report?.spentUsd?.toFixed(4) ?? '?'} — zero because these runs never reached a model`,
  )

  console.log('\n— and the campaign’s own runs are not material for the next one —')
  const materialAfter = await app.deps.screens.listDecidedRunsForPersona(
    workspaceId,
    PERSONA_NAME,
    50,
  )
  check(
    'a campaign run never becomes an item of the set that measures the persona',
    materialAfter.length === material.length,
    `${material.length} before, ${materialAfter.length} after ` +
      `${settled.flatMap((entry) => entry.runs).filter((entry) => entry.agentRunId !== null).length} campaign runs`,
  )

  console.log('\n— the cap: a campaign halts rather than quietly costing more —')
  const capped = await client.campaign.open({
    personaId: persona.id,
    label: 'campaign-check-capped',
    capUsd: 0.5,
    revisionIds: [],
  })
  check('a second campaign opened once the first had closed', capped.opened === true, capped.detail)
  const cappedId = asReplayCampaignId(capped.campaignId)

  /**
   * One row scored with a real cost, written here rather than earned — see the header. The cap
   * is checked against `spentOnCampaign`, a sum over these rows, so this is the cheapest honest
   * way to put a campaign over its ceiling without spending the ceiling.
   */
  const cappedArms = await app.deps.campaigns.armsForCampaign(workspaceId, cappedId)
  const firstRow = cappedArms[0]?.runs[0]
  if (!firstRow) {
    check('the capped campaign has rows to score', false)
  } else {
    await app.deps.campaigns.recordCampaignRunOutcome(workspaceId, firstRow.id, {
      outcome: 'passed',
      reason: null,
      model: 'claude-haiku-4-5-20251001',
      costUsd: 1.0,
    })
  }
  await advanceCampaignQueue(app.deps, { campaignStuckMs: 3_600_000, maxStartsPerTick: 64 })

  const halted = await campaignReport(app.deps, { workspaceId, campaignId: cappedId })
  check(
    'it halted rather than running on',
    halted?.campaign.status === 'halted',
    halted?.campaign.status ?? 'gone',
  )
  check(
    'the halt reason names the cap and what was spent against it',
    /cap of \$0\.50 is reached/.test(halted?.campaign.haltReason ?? ''),
    halted?.campaign.haltReason ?? '',
  )
  check(
    'and the score leads with **Partial.**, so a rate over half a set cannot read as a whole one',
    (halted?.detail ?? '').startsWith('**Partial.**'),
    (halted?.detail ?? '').slice(0, 80),
  )

  runner.kill('SIGTERM')
  await app.close()
  await closeDb()
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
