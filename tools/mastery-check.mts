/**
 * Live driver for a mastery run: real server, real Runner *process*,
 * real Claude Agent SDK, one repository actually read and mapped.
 *
 *   docker compose up -d
 *   LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/mastery-check.mts
 *
 * Exists because the automated suite drives the map protocol with a fake Runner and an
 * in-memory repository. That proves the server's half — the fragment is validated, the
 * provenance rule holds, the bi-temporal write supersedes. It cannot prove the half only
 * a real model exercises, and this repository has already shipped a feature that passed
 * every test while the model was never offered the tool at all:
 *
 * 1. The SDK actually *offers* `record_map`, and only on a mastery run.
 * 2. The map is durable **while the run is still going**, which is the whole reason it
 *    is written per fragment — a run killed at 80% must leave 80% of a map.
 * 3. The revision resolves from the Runner's clone, so the map is not a rumour.
 * 4. A model asked for a map produces *concepts*, not a directory listing — the failure
 *    mastery names, and the one that looks like success.
 * 5. A later ordinary run is handed the map, which is the gate on the whole
 *    feature: until retrieval demonstrably works, nothing after the map should be built.
 *
 * It **asserts** rather than prints. A printed value cannot fail, and two handoffs in
 * this repository mis-recorded a missing field as a model's choice because a driver
 * printed where it should have checked. It spends real tokens; Haiku and a 0.5 USD cap
 * keep it to a few cents.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildApp, devAuth } from '../apps/server/src/index.js'
import { loadConfig } from '../apps/server/src/config.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'
import { CONCEPT_NODE_KINDS, UNTRUSTED_MAP_OPEN } from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'mastery-secret-at-least-32-characters-long-value',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
  results.push({ ok, what })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
}

const PERSONA = (name: string, prompt: string) =>
  [
    '---',
    `name: ${name}`,
    'description: An agent that learns a codebase.',
    'model: claude-haiku-4-5-20251001',
    'tools: [Read, Grep, Glob]',
    'harness:',
    '  autoApprove: true',
    '  budgetCapUsd: 0.5',
    '---',
    '',
    prompt,
  ].join('\n')

/**
 * A fixture with something to *conclude*, not just something to list.
 *
 * Three files that only make sense together, and a convention stated in one of them
 * that governs the other two. A model that merely enumerates files produces no concept
 * node, and check 4 is what catches that — the failure mastery warns about is a map that
 * looks fine and holds nothing a `grep` could not have produced.
 */
const writeFixture = async (root: string) => {
  await mkdir(join(root, 'src', 'booking'), { recursive: true })
  await writeFile(
    join(root, 'CONVENTIONS.md'),
    '# Conventions\n\nEvery price in this codebase is an integer number of minor units.\n' +
      'Floating point money is a bug. The canonical helper is `toMinorUnits`.\n',
  )
  await writeFile(
    join(root, 'src', 'booking', 'fare.ts'),
    "import { toMinorUnits } from '../money.js'\n\nexport const fareFor = (base: number) => toMinorUnits(base)\n",
  )
  await writeFile(
    join(root, 'src', 'booking', 'refund.ts'),
    "import { toMinorUnits } from '../money.js'\n\nexport const refundFor = (fare: number) => toMinorUnits(fare / 2)\n",
  )
  await writeFile(
    join(root, 'src', 'money.ts'),
    'export const toMinorUnits = (value: number): number => Math.round(value * 100)\n',
  )
  await writeFile(join(root, 'README.md'), '# mastery fixture\n\nA tiny booking domain.\n')
}

const main = async () => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `mastery-${Date.now()}`)
  const app = await buildApp(config, devAuth({ userId: 'mastery-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${addr.port}`
  const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
  console.log('server on', base)

  const repoPath = await mkdtemp(join(tmpdir(), 'mastery-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  await writeFixture(repoPath)
  await execFileAsync('git', ['-C', repoPath, 'add', '.'])
  await execFileAsync('git', [
    '-C', repoPath, '-c', 'user.email=mastery@example.test', '-c', 'user.name=mastery',
    'commit', '-qm', 'init',
  ])
  const { stdout: headOut } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD'])
  const headSha = headOut.trim()

  const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'mastery-runner' })

  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: tmpdir(),
      LOOM_SANDBOX_ENABLED: process.env.LOOM_SANDBOX_ENABLED ?? '0',
      // Withheld when the sandbox was asked for — see notes-check.mts. Supplying it
      // unconditionally turns LOOM_SANDBOX_ENABLED=1 into a silent downgrade and a
      // clean pass about the path that was not tested.
      ...(process.env.LOOM_SANDBOX_ENABLED === '1'
        ? {}
        : {
            LOOM_ALLOW_UNSANDBOXED:
              process.env.LOOM_ALLOW_UNSANDBOXED ?? 'i-understand-the-agent-gets-my-privileges',
          }),
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `mastery-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))

  await new Promise((r) => setTimeout(r, 4000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: repoPath,
    displayName: 'booking',
  })
  const channel = await client.channel.create({ name: 'mastery' })

  const scholar = await client.persona.create({
    markdownSource: PERSONA(
      'booking-expert',
      'You study codebases and record what you learn so that others do not have to ' +
        'rediscover it. You never change code.',
    ),
  })

  const awaitRun = async (runId: string): Promise<any> => {
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 2000))
      const current = await client.agentRun.get({ agentRunId: runId })
      if (['completed', 'failed', 'cancelled'].includes(current.status)) return current
    }
    return client.agentRun.get({ agentRunId: runId })
  }

  // ── The mastery run ─────────────────────────────────────────────────────────
  const run = await client.mastery.start({
    threadId: channel.rootThread.id,
    repositoryId: repo.id,
    personaId: scholar.id,
    task:
      'Map this repository. Pay particular attention to any convention it states and ' +
      'which files obey it.',
  })
  console.log('mastery run', run.id)

  /**
   * The map itself, unwrapped from its listing.
   *
   * `listForPersona` returns `{ map, retrievalState, decided }` — portable expertise made
   * expertise legible before it is used, and this driver went on reading the row as though
   * it were the map. Every `map.id` was then `undefined`, which the server rejected as a
   * bad request: a live driver that is not run is a test that has stopped compiling in a
   * language nobody typechecks.
   */
  const mapOf = async (): Promise<any> => {
    const listings = await client.mastery.listForPersona({ personaId: scholar.id })
    return listings[0]?.map ?? null
  }

  const opened = await mapOf()
  check(opened !== null, 'a map row exists from the moment the run starts, not once it succeeds')

  /**
   * Polled *during* the run, which is the point. Checking only afterwards would
   * pass identically if fragments were flushed at the end — and the runs whose maps
   * matter most are the ones that never reach an end.
   */
  let midRunNodes = 0
  let revisionDuringRun: string | null = null
  const settled = await Promise.race([
    awaitRun(run.id),
    (async () => {
      for (let i = 0; i < 120; i += 1) {
        await new Promise((r) => setTimeout(r, 2000))
        const map = await mapOf()
        if (!map) continue
        if (revisionDuringRun === null && map.revision !== 'pending') revisionDuringRun = map.revision
        const view = await client.mastery.get({ mapId: map.id })
        if (view.nodes.length > 0) {
          const status = (await client.agentRun.get({ agentRunId: run.id })).status
          if (status === 'running') {
            midRunNodes = view.nodes.length
            break
          }
        }
      }
      return awaitRun(run.id)
    })(),
  ])
  check(midRunNodes > 0, `the map was durable while the run was still going (${midRunNodes} node(s))`)
  console.log('run finished:', settled.status, 'cost', settled.totalCostUsd)
  // A driver that reports "failed" without the reason wastes the run it just paid for.
  if (settled.errorMessage) console.log('  reason:', settled.errorMessage)

  const map = await mapOf()
  if (!map) throw new Error('no map was created at all')
  check(map.revision === headSha, `the map is versioned at the real commit (${map.revision.slice(0, 8)})`)
  check(map.status === 'ready', `the map closed as ready (was: ${map.status})`)

  const view = await client.mastery.get({ mapId: map.id })
  check(view.nodes.length > 0, `the model called record_map (${view.nodes.length} node(s))`)

  /**
   * The central quality claim, checked rather than hoped for. A map of only `file`
   * nodes is the directory listing the section warns about — it costs a model call and
   * replaces nothing.
   */
  const concepts = view.nodes.filter((n: any) => CONCEPT_NODE_KINDS.includes(n.kind))
  check(
    concepts.length > 0,
    `the map holds concepts, not just files (${concepts.map((n: any) => n.kind).join(', ') || 'none'})`,
  )
  check(
    view.edges.length > 0,
    `the map holds typed edges (${[...new Set(view.edges.map((e: any) => e.kind))].join(', ') || 'none'})`,
  )

  /**
   * **Coverage, which only a real Runner can produce.** The suite drives
   * `mastery_progress` by injecting the frame, which proves the server's handler and says
   * nothing about whether the Runner ever sends one — the exact shape the lesson names,
   * and the reason three handoffs in a row recorded this path as missing after it had
   * shipped. The numbers come from a `git ls-files` and a set of observed tool calls on
   * the Runner's own machine, so this driver is the only place the claim can be checked.
   */
  check(
    view.progress !== null,
    'the Runner sent measured progress, so coverage is a number rather than "not measured"',
  )
  if (view.progress) {
    /**
     * The **denominator**, not the ratio. `git ls-files` on the Runner's own clone is
     * what this driver can assert; the numerator is the agent's behaviour, and a run that
     * mapped this repository entirely from `Grep` and `Glob` reported 0% — honestly, since
     * a glob matching four hundred files is not four hundred files read. Asserting on
     * coverage would fail on a legitimate run and say nothing about the measurement.
     */
    check(
      view.progress.filesInScope > 0,
      `the tree at the mastered revision was counted (${view.progress.filesRead} of ${view.progress.filesInScope} files opened)`,
    )
    check(
      view.progress.spendUsd > 0,
      `the checkpoint carries what the proxy metered ($${view.progress.spendUsd.toFixed(4)})`,
    )
  }

  /**
   * The trust boundary, on the real path. `parseMapFragment` refuses a model's claim of
   * `extracted`, and every node here came from a model — so a single extracted node
   * would mean the refusal is not reached where it matters.
   */
  check(
    view.nodes.every((n: any) => n.provenance !== 'extracted'),
    'nothing a model wrote claims parsed provenance',
  )

  for (const node of view.nodes.slice(0, 12)) {
    console.log(`  node: (${node.kind}/${node.provenance}) ${node.label}`)
  }
  for (const edge of view.edges.slice(0, 12)) {
    console.log(`  edge: ${edge.fromKey} --${edge.kind}--> ${edge.toKey}`)
  }

  // ── Retrieval: The gate ───────────────────────────────────────────
  //
  // Two ordinary runs by the same persona against the same repository, and **the first
  // one is supposed to be denied the map**. That is the trial: a brand-new
  // expertise is off until it beats the unaided baseline, and `nextTrialArm` sends the
  // very first run to `withheld` precisely so a pairing used once has measured the
  // unaided case rather than having handed a run an untested map and learned nothing.
  //
  // This driver used to assert that the first ordinary run quoted the map, which was
  // right when it was written and became a check against the platform's own design the
  // day the trial shipped. It then reported a failure every time the measurement worked.
  // Both arms are asserted here, from the platform's record rather than from prose.
  const marker = concepts[0]?.label ?? view.nodes[0]?.label ?? ''

  const ordinaryRun = async (label: string): Promise<any> => {
    const started = await client.agentRun.start({
      threadId: channel.rootThread.id,
      repositoryId: repo.id,
      personaId: scholar.id,
      task:
        'Without reading any file, quote back the single most important thing you were ' +
        'already told about this repository before you started, word for word. If you ' +
        'were told nothing, say exactly: I WAS TOLD NOTHING.',
    })
    console.log(`${label} run`, started.id)
    const done = await awaitRun(started.id)
    console.log(`${label} run finished:`, done.status, 'cost', done.totalCostUsd)
    if (done.errorMessage) console.log('  reason:', done.errorMessage)
    return started
  }

  const baseline = await ordinaryRun('baseline (expected withheld)')
  const second = await ordinaryRun('retrieval (expected retrieved)')

  /**
   * The arms, as the platform recorded them. This is the half that cannot be flaky: a
   * model may paraphrase or refuse to quote, but which arm a run went on is a row.
   */
  const uses = await client.mastery.usedByRuns({ agentRunIds: [baseline.id, second.id] })
  const armOf = (runId: string) =>
    uses.find((use: any) => use.agentRunId === runId)?.arm ?? 'none'
  check(
    armOf(baseline.id) === 'withheld',
    `the first ordinary run is the unaided baseline (arm: ${armOf(baseline.id)})`,
  )
  check(
    armOf(second.id) === 'retrieved',
    `the next one is handed the map (arm: ${armOf(second.id)})`,
  )
  const shown = uses.find((use: any) => use.agentRunId === second.id)
  check(
    (shown?.nodesShown ?? 0) > 0,
    `the retrieved run was shown map nodes (${shown?.nodesShown ?? 0})`,
  )

  /**
   * Asserted against what the **agent** said, not against the thread.
   *
   * The first version of this check searched every message for a phrase the *task* also
   * contained, so it matched the platform's own echo of the instruction and reported a
   * failure that had not happened. That is the third time a driver in this repository
   * has matched its own input: `corporation-check.mts` did it twice, once against
   * `submit_plan`'s tool-result echo and once against a `✗` in an unrelated message.
   * The rule that comes out of it is to assert on the *author* as well as the text.
   */
  const page = await client.message.list({ threadId: channel.rootThread.id })
  const saidBy = (runId: string): string =>
    page.messages
      .filter((m: any) => m.author?.kind === 'agent_run' && m.author.agentRunId === runId)
      .map((m: any) => m.body.text ?? '')
      .join('\n')
      .toLowerCase()

  /**
   * Map vocabulary from **every** node it was shown, not from one node this driver
   * picked.
   *
   * The earlier version asked the model to quote "the most important thing" and then
   * looked for the label of `concepts[0]` — two independent choices of what matters, so
   * a run that received the whole map and quoted a different node of it failed. What is
   * being checked is whether the map *arrived*, and a run shown nothing cannot produce
   * this vocabulary at all.
   */
  const mapWords = [
    ...new Set(
      view.nodes
        .flatMap((n: any) => String(n.label).split(/[^A-Za-z]+/))
        .filter((w: string) => w.length > 5)
        .map((w: string) => w.toLowerCase()),
    ),
  ]
  const usedMapWords = (runId: string) =>
    mapWords.filter((word) => saidBy(runId).includes(String(word)))

  /**
   * **Where the prompt is not.** Worth recording, because checking it here was the
   * obvious idea and it is wrong.
   *
   * The raw tier stores the verbatim *provider stream* — what the model sent back,
   * not what it was sent — so the fence `buildMapContext` wraps map claims in never
   * appears there, and a check for it would fail on a run that had received the map and
   * pass trivially on the baseline for the same reason. The platform's record of the arm
   * and the node count above is the deterministic answer; this is the model's own.
   */
  const retrievedWords = usedMapWords(second.id)
  check(
    retrievedWords.length > 0,
    `the retrieved run answered in the map's own vocabulary (${retrievedWords.slice(0, 5).join(', ') || 'nothing matched'})`,
  )

  /**
   * The control, and the reason the pair is worth more than either half. The baseline was
   * given the same task and denied the map, so it is the same model on the same
   * repository with the same instruction — vocabulary the retrieved run has and this one
   * does not is the map arriving, rather than a word both runs could have guessed.
   */
  const baselineWords = usedMapWords(baseline.id)
  check(
    retrievedWords.length > baselineWords.length,
    `the withheld run could not answer in it (${baselineWords.length} shared word(s) against ${retrievedWords.length})`,
  )

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) console.log('failed:', failed.map((f) => f.what).join('; '))
  console.log('  first concept the retrieval run could have quoted:', JSON.stringify(marker))
  console.log('  the withheld run said:', JSON.stringify(saidBy(baseline.id).slice(0, 200)))
  console.log('  the retrieved run said:', JSON.stringify(saidBy(second.id).slice(0, 200)))
  console.log('  fence marker in use:', UNTRUSTED_MAP_OPEN)

  runner.kill('SIGKILL')
  await app.close()
  await closeDb()
  process.exit(failed.length === 0 ? 0 : 1)
}

void main().catch((e) => {
  console.error('MASTERY CHECK FAILED', e)
  process.exit(1)
})
