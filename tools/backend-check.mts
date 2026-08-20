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
 * 4. **A missing channel is a refusal, not a lesser run.** A mastery run on this backend fails
 *    with the channel named, rather than running as an agent that quietly cannot map.
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

/**
 * The scripted endpoint.
 *
 * Three turns: write a file, commit it, say it is done. The requests it received are kept, so
 * the driver can assert what the platform actually sent — which is where check 3 lives.
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
      requests.push({
        model: parsed.model ?? '',
        tools: (parsed.tools ?? []).map((tool) => tool.function.name),
        messages: parsed.messages ?? [],
      })
      const answer = answers[Math.min(turn, answers.length - 1)]
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
    check(
      'and exactly the tools the persona document declares, by the platform’s names',
      JSON.stringify(scripted.requests[0]?.tools) === JSON.stringify(['Read', 'Write', 'Bash']),
      (scripted.requests[0]?.tools ?? []).join(','),
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

  console.log('\n— a channel this backend does not have is a refusal, not a lesser run —')
  const mastery = await client.mastery.start({
    threadId: channel.rootThread.id,
    repositoryId: repo.id,
    personaId: persona.id,
  })
  const masteryDone = await awaitRun(mastery.id)
  check(
    'a mastery run on this backend failed rather than running without record_map',
    masteryDone.status === 'failed',
    masteryDone.status,
  )
  check(
    'and the reason names the channel it could not offer',
    (masteryDone.errorMessage ?? '').includes('record_map'),
    masteryDone.errorMessage ?? 'no reason',
  )

  runner.kill('SIGTERM')
  await app.close()
  await closeDb()
  await scripted.close()
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
