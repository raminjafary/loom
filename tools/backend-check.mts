/**
 * Live driver for the **second execution backend**: real server, real Runner *process*, real
 * git repository, real Postgres, real HTTP — and a real endpoint speaking the
 * chat-completions protocol, served by this driver.
 *
 *   docker compose up -d
 *   npx tsx tools/backend-check.mts
 *
 * Point it at a model you actually serve, and the same driver exercises the same path against
 * a real one:
 *
 *   LOOM_CHAT_COMPLETIONS_BASE_URL=http://127.0.0.1:8000/v1 npx tsx tools/backend-check.mts
 *
 * **What is scripted and what is real.** Without that variable the endpoint is this file: an
 * HTTP server that answers the protocol from a script, so the model's *decisions* are fixed
 * and everything else is not. The Runner is a real process, the clone is a real git working
 * copy at a real commit, the tool calls really write files and really run `git commit`, the
 * events really cross the socket, and the branch is really there at the end. Stated plainly
 * because it is the limit: what this cannot show is that a model would choose those calls.
 *
 * Five things only a live run can settle, and the first is the whole point of the item:
 *
 * 1. **A second adapter really is behind the port.** A persona whose model says `local/` is
 *    dispatched, executed and completed without any other part of the platform knowing which
 *    backend ran it — the run row, the thread, the branch and the diff are the same shapes.
 * 2. **The work lands.** A file written and a commit made by tool calls this adapter executed
 *    itself, on the run's own branch, in the run's own clone.
 * 3. **The persona's tool list means the same thing on both backends.** The endpoint is told
 *    exactly the tools the document declares, by the platform's own names.
 * 4. **The platform's channels are here, not merely declarable.** A mastery run on this backend
 *    is offered `record_map` — read off the same in-process server the other backend mounts —
 *    calls it, and the map is in the database afterwards. This is the check that changed when
 *    the channels landed: it used to assert the run *failed* with the channel named.
 * 5. **The cost figure is zero for a self-hosted model** — the honest answer about dollars,
 *    and the one the reviewed price table gives rather than a guess.
 *
 * It **asserts** rather than prints, and spends no tokens against any provider.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildApp, devAuth } from '../apps/server/src/index.js'
import { loadConfig } from '../apps/server/src/config.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'backend-check-secret-at-least-32-characters',
  WS_SUBSCRIPTION_SECRET: 'backend-check-subscription-secret-32-chs',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** The marker the scripted model writes, so "the work landed" cannot pass by accident. */
const MARKER = `LOOM-BACKEND-${Date.now().toString(36).toUpperCase()}`

/** The label the scripted model records, so "a map was written" cannot pass by accident. */
const MAP_MARKER = `the merge queue (${MARKER})`

/**
 * What the scripted model sends on a channel it is offered.
 *
 * By tool name rather than derived from the declared schema: a valid map fragment is a
 * structure, and a caller inventing one from JSON Schema would be testing its own generator.
 * The names are the platform's exported constants — if a name here is wrong, the channel is
 * simply never called and check 4 fails, which is the correct outcome for a driver whose claim
 * is that both backends offer the same names.
 */
const CHANNEL_ARGUMENTS: Record<string, unknown> = {
  'mcp__loom_map__record_map': {
    nodes: [
      {
        key: 'merge-queue',
        kind: 'concept',
        label: MAP_MARKER,
        summary: 'Serialized per repository, so two branches cannot land at once.',
        paths: ['README.md'],
        observationCount: 3,
      },
    ],
    edges: [],
  },
}

/**
 * The scripted endpoint.
 *
 * Three turns: write a file, commit it, say it is done. The requests it received are kept, so
 * the driver can assert what the platform actually sent — which is where check 3 lives.
 *
 * One departure from a fixed script, and it is the point of check 4: when a request offers a
 * **platform channel** — any tool named `mcp__…` — the scripted model calls it instead of
 * following the script. The arguments come from the table below, because a generic caller
 * cannot invent a valid map fragment; what is *not* scripted is whether the channel was
 * offered at all, which is the thing being measured.
 */
const startScriptedModel = async (): Promise<{
  url: string
  requests: { model: string; tools: string[]; messages: { role: string; content: string | null }[] }[]
  close: () => Promise<void>
}> => {
  const requests: {
    model: string
    tools: string[]
    messages: { role: string; content: string | null }[]
  }[] = []
  let turn = 0

  const answers = [
    {
      tool_calls: [
        {
          id: 'call_write',
          type: 'function',
          function: {
            name: 'Write',
            arguments: JSON.stringify({ file_path: 'BACKEND.md', content: `# ${MARKER}\n` }),
          },
        },
      ],
    },
    {
      tool_calls: [
        {
          id: 'call_commit',
          type: 'function',
          function: {
            name: 'Bash',
            arguments: JSON.stringify({
              command:
                'git add -A && git -c user.email=b@b.invalid -c user.name=backend commit -qm "add BACKEND.md"',
            }),
          },
        },
      ],
    },
    { content: `Wrote and committed BACKEND.md (${MARKER}).` },
  ]

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as {
        model?: string
        tools?: { function: { name: string } }[]
        messages?: { role: string; content: string | null }[]
      }
      const offered = (parsed.tools ?? []).map((tool) => tool.function.name)
      requests.push({
        model: parsed.model ?? '',
        tools: offered,
        messages: parsed.messages ?? [],
      })
      /**
       * A channel is called once, and only if this backend offered it. The reply for the turn
       * after it is the script's last line, so the run ends rather than calling it forever.
       */
      const channel = offered.find((name) => name in CHANNEL_ARGUMENTS)
      const alreadyCalled = (parsed.messages ?? []).some((entry) => entry.role === 'tool')
      const answer =
        channel !== undefined && !alreadyCalled
          ? {
              tool_calls: [
                {
                  id: 'call_channel',
                  type: 'function',
                  function: {
                    name: channel,
                    arguments: JSON.stringify(CHANNEL_ARGUMENTS[channel]),
                  },
                },
              ],
            }
          : channel !== undefined
            ? { content: 'Recorded what I found.' }
            : answers[Math.min(turn, answers.length - 1)]
      turn += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: null, ...answer } }],
          usage: { prompt_tokens: 500, completion_tokens: 40 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const main = async () => {
  const scripted = process.env.LOOM_CHAT_COMPLETIONS_BASE_URL
    ? { url: process.env.LOOM_CHAT_COMPLETIONS_BASE_URL, requests: [], close: async () => {} }
    : await startScriptedModel()
  /** A second serving stack, so "which stack" is a real question rather than a setting. */
  const second = await startScriptedModel()
  console.log(
    process.env.LOOM_CHAT_COMPLETIONS_BASE_URL
      ? `driving a real endpoint at ${scripted.url}`
      : `scripted endpoint on ${scripted.url}`,
  )

  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const ws = await seedWorkspace(db, `backend-check-${Date.now()}`)
  const app = await buildApp(config, devAuth({ userId: 'backend-check-user', workspaceId: ws.id }))
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.fastify.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${addr.port}`
  const client: any = createORPCClient(new RPCLink({ url: `${base}/rpc` }))
  console.log('server on', base)

  const repoPath = await mkdtemp(join(tmpdir(), 'backend-check-repo-'))
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', repoPath])
  await writeFile(join(repoPath, 'README.md'), '# a repository\n')
  await git(repoPath, ['add', '-A'])
  await git(repoPath, [
    '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'init',
  ])

  const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'backend-check-runner' })
  const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
      LOOM_PAIRING_TOKEN: rawToken,
      LOOM_ALLOWED_ROOTS: tmpdir(),
      // Unsandboxed: the sandbox image carries the agent host, and what is under test here is
      // the adapter the host would load. The sandboxed path is the same code one layer down.
      LOOM_SANDBOX_ENABLED: '0',
      LOOM_ALLOW_UNSANDBOXED: 'i-understand-the-agent-gets-my-privileges',
      LOOM_CHAT_COMPLETIONS_BASE_URL: scripted.url,
      // A second stack, named. What is under test is that a persona naming it lands there
      // and not on the default — the failure being prevented is a run silently going to the
      // wrong serving stack, which produces a completed run against the wrong model.
      LOOM_CHAT_COMPLETIONS_ENDPOINTS: `second=${second.url}`,
      LOOM_RUNNER_STATE_DIR: join(tmpdir(), `backend-check-state-${Date.now()}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
  runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
  await new Promise((r) => setTimeout(r, 4000))

  const repo = await client.repository.bindExisting({
    runnerId,
    path: repoPath,
    displayName: 'backend check repo',
  })
  const channel = await client.channel.create({ name: 'backend-check' })

  /** `local/` is what selects the backend, and `autoApprove` keeps the driver unattended. */
  const persona = await client.persona.create({
    markdownSource: [
      '---',
      'name: local-worker',
      'description: A worker on a model the operator serves themselves.',
      'model: local/scripted-small',
      'tools: [Read, Write, Bash]',
      'harness:',
      '  autoApprove: true',
      '---',
      '',
      'You work on this repository.',
    ].join('\n'),
  })

  const awaitRun = async (runId: string): Promise<any> => {
    for (let i = 0; i < 90; i += 1) {
      await new Promise((r) => setTimeout(r, 1000))
      const current = await client.agentRun.get({ agentRunId: runId })
      if (['completed', 'failed', 'cancelled'].includes(current.status)) return current
    }
    return client.agentRun.get({ agentRunId: runId })
  }

  console.log('\n— a run on the second backend, end to end —')
  const started = await client.agentRun.start({
    threadId: channel.rootThread.id,
    repositoryId: repo.id,
    personaId: persona.id,
    task: 'Add BACKEND.md and commit it.',
  })
  const done = await awaitRun(started.id)
  check('the run completed', done.status === 'completed', `${done.status} ${done.errorMessage ?? ''}`)
  check(
    'and it cost zero, which is the honest figure for a model the operator serves',
    done.totalCostUsd === 0,
    `$${done.totalCostUsd}`,
  )

  check(
    'the work landed on the run’s own branch, in its own clone',
    typeof done.clonePath === 'string' && done.clonePath.length > 0,
    done.clonePath ?? 'no clone',
  )
  if (typeof done.clonePath === 'string' && done.clonePath.length > 0) {
    const log = await git(done.clonePath, ['log', '--oneline', '-1'])
    const file = await git(done.clonePath, ['show', '--name-only', '--format=', 'HEAD'])
    check('a commit the adapter’s own tool calls made', log.includes('add BACKEND.md'), log)
    check('touching the file it wrote', file.includes('BACKEND.md'), file.trim())
    const contents = await execFileAsync('cat', [join(done.clonePath, 'BACKEND.md')])
    check('with the content it was told to write', contents.stdout.includes(MARKER))
  }

  /**
   * The run is an ordinary run to everything else — which is the replaceability claim, and the
   * one assertion that would fail if the second backend needed a special case anywhere.
   */
  const page = await client.message.list({ threadId: channel.rootThread.id })
  const mine = page.messages.filter(
    (m: any) => m.author?.kind === 'agent_run' && m.author.agentRunId === started.id,
  )
  check(
    'its tool calls and result render in the thread like any other run’s',
    mine.length > 0,
    `${mine.length} messages`,
  )

  if (scripted.requests.length > 0) {
    check(
      'the endpoint was sent the operator’s own model id, without the prefix',
      scripted.requests.every((request) => request.model === 'scripted-small'),
      scripted.requests[0]?.model ?? 'none',
    )
    const first = scripted.requests[0]?.tools ?? []
    check(
      'and the tools the persona document declares, by the platform’s names',
      JSON.stringify(first.filter((name) => !name.startsWith('mcp__'))) ===
        JSON.stringify(['Read', 'Write', 'Bash']),
      first.join(','),
    )
    /**
     * Everything else offered is a platform channel, and `ask_human` and the notes ledger are
     * among them — both are documented as belonging to *every* run the platform starts.
     *
     * This is the check that recorded the gap. Before the channels were bridged, a run on this
     * backend held no `ask_human`, no notes, no atlas and no handover, and nothing refused it:
     * the refusal only covered the eight channels somebody had remembered to list. An agent
     * that cannot ask a question does not report being unable to ask one.
     */
    check(
      'along with the channels every run gets, which this backend used to be missing in silence',
      first.includes('mcp__loom_ask__ask_human') && first.includes('mcp__loom_notes__write_note'),
      first.filter((name) => name.startsWith('mcp__')).join(','),
    )
    check(
      'the persona’s prompt arrived as the system message, not folded into the task',
      scripted.requests[0]?.messages[0]?.role === 'system' &&
        (scripted.requests[0]?.messages[0]?.content ?? '').includes('You work on this repository'),
    )
    check(
      'and the tool result was fed back on the next turn',
      (scripted.requests[1]?.messages ?? []).some((entry) => entry.role === 'tool'),
      `${scripted.requests.length} requests`,
    )
  }

  console.log('\n— the platform’s channels are on this backend too —')
  const mastery = await client.mastery.start({
    threadId: channel.rootThread.id,
    repositoryId: repo.id,
    personaId: persona.id,
  })
  const masteryDone = await awaitRun(mastery.id)
  check(
    'a mastery run on this backend completes rather than being refused for a missing channel',
    masteryDone.status === 'completed',
    `${masteryDone.status} ${masteryDone.errorMessage ?? ''}`,
  )
  const masteryRequests = scripted.requests.filter((request) =>
    request.tools.includes('mcp__loom_map__record_map'),
  )
  check(
    'the endpoint was offered record_map, under the name the other backend uses for it',
    masteryRequests.length > 0,
    scripted.requests.map((request) => request.tools.join('+')).join(' | '),
  )
  /**
   * The claim a declaration cannot make: the call reached the callback the Runner holds, the
   * server validated the fragment, and the map is in the database. Read back over the contract
   * a person reads it through, rather than out of the row this driver could have written.
   */
  const maps = await client.mastery.listForRepository({ repositoryId: repo.id })
  const mapId = maps[0]?.map?.id
  const view = mapId === undefined ? null : await client.mastery.get({ mapId })
  const labels = ((view?.nodes ?? []) as { label: string }[]).map((node) => node.label).join(' | ')
  check(
    'and what it recorded is in the map a person reads, not only in the transcript',
    labels.includes(MAP_MARKER),
    labels.slice(0, 300) || `${maps.length} map(s), no nodes`,
  )

  console.log('\n— a second serving stack, named by the persona that wants it —')
  const onSecond = await client.persona.create({
    markdownSource: [
      '---',
      'name: second-stack-worker',
      'description: A worker on the operator’s other serving stack.',
      'model: local/second:other-small',
      'tools: [Read, Write, Bash]',
      'harness:',
      '  autoApprove: true',
      '---',
      '',
      'You work on this repository.',
    ].join('\n'),
  })
  const onSecondRun = await awaitRun(
    (
      await client.agentRun.start({
        threadId: channel.rootThread.id,
        repositoryId: repo.id,
        personaId: onSecond.id,
        task: 'Add BACKEND.md and commit it.',
      })
    ).id,
  )
  check(
    'a run on the named stack completed',
    onSecondRun.status === 'completed',
    `${onSecondRun.status} ${onSecondRun.errorMessage ?? ''}`,
  )
  check(
    'it reached the second endpoint, with the id that endpoint knows the model by',
    second.requests.length > 0 && second.requests.every((request) => request.model === 'other-small'),
    `${second.requests.length} request(s) — ${second.requests[0]?.model ?? 'none'}`,
  )
  const defaultSaw = scripted.requests.filter((request) => request.model === 'other-small')
  check(
    'and the default endpoint was not sent it, which is the failure worth preventing',
    defaultSaw.length === 0,
    `${defaultSaw.length} stray request(s)`,
  )

  const unserved = await client.persona.create({
    markdownSource: [
      '---',
      'name: nowhere-worker',
      'description: A worker naming a stack this Runner does not serve.',
      'model: local/nowhere:some-model',
      'tools: [Read]',
      'harness:',
      '  autoApprove: true',
      '---',
      '',
      'You work on this repository.',
    ].join('\n'),
  })
  const unservedRun = await awaitRun(
    (
      await client.agentRun.start({
        threadId: channel.rootThread.id,
        repositoryId: repo.id,
        personaId: unserved.id,
        task: 'Anything.',
      })
    ).id,
  )
  check(
    'a persona naming a stack this host does not serve is refused, not redirected',
    unservedRun.status === 'failed' && (unservedRun.errorMessage ?? '').includes('"nowhere"'),
    `${unservedRun.status} — ${unservedRun.errorMessage ?? 'no reason'}`,
  )

  runner.kill('SIGTERM')
  await app.close()
  await closeDb()
  await scripted.close()
  await second.close()
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
