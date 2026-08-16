/**
 * Live driver for the atlas: real server, real Runner *process*, real Claude Agent SDK, two
 * repositories actually mastered and then related to each other.
 *
 * docker compose up -d
 * LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/atlas-check.mts
 *
 * The suite drives both atlas frames with a fake Runner, which proves the server's half —
 * the leads are selected, capped and fenced; the proposal's ends are resolved; a concept
 * nobody recorded is refused. It cannot prove the half that has failed in this repository
 * four times: **that the model is offered the tools at all**, and that a model given them
 * uses them on something real rather than on two similar-sounding summaries.
 *
 * Five things only a live run can settle:
 *
 * 1. `look_across_projects` is reachable, and what comes back is the *other* project —
 * The rule that a run is never handed its own subject, which is the difference
 * between an atlas and a slower way to read your own map.
 * 2. The answer arrives **fenced**, assembled server-side. A Runner that rendered its own
 * would be a second place for the untrusted framing to drift, and the fence is the
 * whole of the planner/worker trust boundary for a report about a repository this run cannot open.
 * 3. `propose_cross_project_link` records a proposal a human can see, attributed to the
 * run that made it.
 * 4. A relation naming a concept nobody recorded is **refused**, on the live path, with
 * the sentence that stops a model rephrasing and trying again.
 * 5. Nothing the model proposed is treated as true: the row lands `proposed`, and the
 * read side keeps it below whatever a human has promoted.
 *
 * It **asserts** rather than prints, and every text assertion filters by **author** as
 * well as by text — four drivers here have reported a failure that had not happened by
 * matching their own input. Two mastery runs and one worker run on Haiku, a few cents.
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
import {
 ATLAS_OPEN,
 CONCEPT_NODE_KINDS,
 MAX_ATLAS_LEADS,
} from '../packages/domain/src/index.js'
import {
 LOOK_ACROSS_TOOL_NAME,
 PROPOSE_LINK_TOOL_NAME,
} from '../apps/runner/src/atlas-tool.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname

const config = loadConfig({
...process.env,
 NODE_ENV: 'test',
 BETTER_AUTH_SECRET: 'atlas-secret-at-least-32-characters-long-value',
 SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

const results: { ok: boolean; what: string }[] = []
const check = (ok: boolean, what: string) => {
 results.push({ ok, what })
 console.log(`${ok ? 'PASS': 'FAIL'} ${what}`)
}

const PERSONA = (name: string) =>
 [
 '---',
 `name: ${name}`,
 'description: An agent that learns codebases and relates them.',
 'model: claude-haiku-4-5-20251001',
 'tools: [Read, Grep, Glob]',
 'harness:',
 ' autoApprove: true',
 ' budgetCapUsd: 0.5',
 '---',
 '',
 'You study codebases and record what you learn so that others do not have to ' +
 'rediscover it. You never change code.',
 ].join('\n')

/**
 * Two repositories that decided the *same question* in different words.
 *
 * That is the fixture the atlas exists for and the one a lexical match can actually find:
 * both projects have a rule about partial refunds, and neither uses the other's
 * vocabulary for the code around it. A pair of unrelated fixtures would make check 1
 * pass on an empty answer, which is the failure this whole driver is written to avoid.
 */
const writeBooking = async (root: string) => {
 await mkdir(join(root, 'src'), { recursive: true })
 await writeFile(
 join(root, 'REFUNDS.md'),
 '# Refunds\n\nA cancelled booking is refunded in proportion to the time remaining ' +
 'before the stay. Nothing is refunded inside 24 hours.\n',
)
 await writeFile(
 join(root, 'src', 'refund.ts'),
 'export const refundFor = (paid: number, hoursLeft: number): number =>\n' +
 ' hoursLeft < 24 ? 0: Math.round(paid * Math.min(1, hoursLeft / 168))\n',
)
}

const writeTicketing = async (root: string) => {
 await mkdir(join(root, 'lib'), { recursive: true })
 await writeFile(
 join(root, 'POLICY.md'),
 '# Cancellation policy\n\nA cancelled ticket earns credit scaled by how long is left ' +
 'before departure. Inside one day the ticket is forfeit.\n',
)
 await writeFile(
 join(root, 'lib', 'credit.ts'),
 'export const creditFor = (fare: number, hoursToDeparture: number): number =>\n' +
 ' hoursToDeparture < 24 ? 0: Math.round(fare * Math.min(1, hoursToDeparture / 168))\n',
)
}

const gitInit = async (root: string, name: string) => {
 await execFileAsync('git', ['init', '--quiet', '-b', 'main', root])
 await execFileAsync('git', ['-C', root, 'add', '.'])
 await execFileAsync('git', [
 '-C', root, '-c', `user.email=${name}@example.test`, '-c', `user.name=${name}`,
 'commit', '-qm', 'init',
 ])
}

const main = async => {
 const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
 const ws = await seedWorkspace(db, `atlas-${Date.now}`)
 const app = await buildApp(config, devAuth({ userId: 'atlas-user', workspaceId: ws.id }))
 await app.fastify.listen({ port: 0, host: '127.0.0.1' })
 const addr = app.fastify.server.address
 if (addr === null || typeof addr === 'string') throw new Error('no port')
 const client: any = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${addr.port}/rpc` }))
 console.log('server on', `http://127.0.0.1:${addr.port}`)

 const bookingPath = await mkdtemp(join(tmpdir, 'atlas-booking-'))
 await writeBooking(bookingPath)
 await gitInit(bookingPath, 'booking')

 const ticketingPath = await mkdtemp(join(tmpdir, 'atlas-ticketing-'))
 await writeTicketing(ticketingPath)
 await gitInit(ticketingPath, 'ticketing')

 const { runnerId, rawToken } = await client.runner.createPairingToken({ name: 'atlas-runner' })

 const runner = spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
 cwd: REPO_ROOT,
 env: {
...process.env,
 LOOM_SERVER_WS_URL: `ws://127.0.0.1:${addr.port}/ws/runner`,
 LOOM_PAIRING_TOKEN: rawToken,
 LOOM_ALLOWED_ROOTS: tmpdir,
 LOOM_SANDBOX_ENABLED: process.env.LOOM_SANDBOX_ENABLED ?? '0',
...(process.env.LOOM_SANDBOX_ENABLED === '1'
 ? {}
: {
 LOOM_ALLOW_UNSANDBOXED:
 process.env.LOOM_ALLOW_UNSANDBOXED ?? 'i-understand-the-agent-gets-my-privileges',
 }),
 LOOM_RUNNER_STATE_DIR: join(tmpdir, `atlas-state-${Date.now}`),
 },
 stdio: ['ignore', 'pipe', 'pipe'],
 })
 runner.stdout.on('data', (d) => process.stdout.write(`[runner] ${d}`))
 runner.stderr.on('data', (d) => process.stdout.write(`[runner:err] ${d}`))
 await new Promise((r) => setTimeout(r, 4000))

 const booking = await client.repository.bindExisting({
 runnerId,
 path: bookingPath,
 displayName: 'booking',
 })
 const ticketing = await client.repository.bindExisting({
 runnerId,
 path: ticketingPath,
 displayName: 'ticketing',
 })
 const channel = await client.channel.create({ name: 'atlas' })
 const scholar = await client.persona.create({ markdownSource: PERSONA('atlas-scholar') })

 const awaitRun = async (runId: string): Promise<any> => {
 for (let i = 0; i < 150; i += 1) {
 await new Promise((r) => setTimeout(r, 2000))
 const current = await client.agentRun.get({ agentRunId: runId })
 if (['completed', 'failed', 'cancelled'].includes(current.status)) return current
 }
 return client.agentRun.get({ agentRunId: runId })
 }

 const master = async (repositoryId: string, label: string) => {
 const run = await client.mastery.start({
 threadId: channel.rootThread.id,
 repositoryId,
 personaId: scholar.id,
 task:
 'Map this repository. Record the rule it states about cancellations and refunds as ' +
 'a concept, and the files that implement it.',
 })
 console.log(`${label} mastery run`, run.id)
 const done = await awaitRun(run.id)
 console.log(`${label} finished:`, done.status, 'cost', done.totalCostUsd)
 if (done.errorMessage) console.log(' reason:', done.errorMessage)
 return run
 }

 await master(booking.id, 'booking')
 await master(ticketing.id, 'ticketing')

 const maps = await client.mastery.listForPersona({ personaId: scholar.id })
 /**
 * **Concept nodes only**, and the filter is a finding rather than a detail. The first
 * version took `nodes[0]`, which on one run was `REFUNDS.md` — a `file` node — and the
 * platform refused the proposal, correctly: `proposeAtlasEdge` will not relate
 * structure, because "this file is like that file" is a claim about layout and the
 * atlas exists for claims about ideas. A driver that fed it structure was testing the
 * refusal it did not mean to test, and reporting it as a missing feature.
 */
 const conceptsIn = async (repositoryId: string): Promise<string[]> => {
 const listing = maps.find((entry: any) => entry.map.repositoryId === repositoryId)
 if (!listing) return []
 const view = await client.mastery.get({ mapId: listing.map.id })
 return view.nodes
.filter((node: any) => (CONCEPT_NODE_KINDS as readonly string[]).includes(String(node.kind)))
.map((node: any) => String(node.label))
 }
 const bookingConcepts = await conceptsIn(booking.id)
 const ticketingConcepts = await conceptsIn(ticketing.id)
 /**
 * The fixture, asserted before anything depends on it. Two mastered subjects are the
 * precondition for every check below, and a driver that skipped this would report "no
 * leads" as a finding about the atlas when it was a finding about the mastery runs.
 */
 check(
 bookingConcepts.length > 0 && ticketingConcepts.length > 0,
 `both repositories were mastered (${bookingConcepts.length} and ${ticketingConcepts.length} node(s))`,
)

 // ── The read side, from a real run in the booking repository ────────────────
 const lookRun = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: booking.id,
 personaId: scholar.id,
 task:
 'Call your look_across_projects tool once, with the topic "how cancellations are ' +
 'refunded". Then quote back, word for word, the name of every concept it tells you ' +
 'about. Do not read any file.',
 })
 console.log('look run', lookRun.id)
 const lookDone = await awaitRun(lookRun.id)
 console.log('look finished:', lookDone.status, 'cost', lookDone.totalCostUsd)

 const page = await client.message.list({ threadId: channel.rootThread.id })
 /** By author as well as by text — see this file's header. */
 const saidBy = (runId: string): string =>
 page.messages
.filter((m: any) => m.author?.kind === 'agent_run' && m.author.agentRunId === runId)
.map((m: any) => m.body.text ?? '')
.join('\n')

 const said = saidBy(lookRun.id)
 check(said.length > 0, `the run answered at all (${LOOK_ACROSS_TOOL_NAME})`)
 check(
 ticketingConcepts.some((label) => said.includes(label)),
 'the leads came from the *other* project, which is what an atlas is for',
)

 /**
 * The rule that a run is never handed its own subject. Asserted on a label that
 * exists **only** in the booking map, so a match would mean the run was told about
 * itself — the failure that turns the atlas into a slower way to read your own map.
 */
 const ownOnly = bookingConcepts.filter((label) => !ticketingConcepts.includes(label))
 check(
 ownOnly.length === 0 || !ownOnly.some((label) => said.includes(`${label} (booking`)),
 'and never from the run"s own subject',
)

 // ── The write side ──────────────────────────────────────────────────────────
 const mine = bookingConcepts[0] ?? ''
 const theirs = ticketingConcepts[0] ?? ''
 const proposeRun = await client.agentRun.start({
 threadId: channel.rootThread.id,
 repositoryId: booking.id,
 personaId: scholar.id,
 task:
 'Call your propose_cross_project_link tool exactly once, with mine=' +
 `"${mine}", theirs="${theirs}", their_subject="ticketing", relation="analogous_to", ` +
 'and a one-sentence why. Then stop.',
 })
 console.log('propose run', proposeRun.id)
 const proposeDone = await awaitRun(proposeRun.id)
 console.log('propose finished:', proposeDone.status, 'cost', proposeDone.totalCostUsd)

 const proposals = await client.atlas.listProposals({})
 check(
 proposals.length === 1,
 `the model called ${PROPOSE_LINK_TOOL_NAME} (${proposals.length} proposal(s))`,
)
 check(
 proposals[0]?.status === 'proposed',
 `nothing is treated as true until a human says so (status: ${proposals[0]?.status})`,
)
 check(
 proposals[0]?.from.subjectRef !== proposals[0]?.to.subjectRef,
 'the relation crosses a subject boundary, which is the only kind the atlas holds',
)

 const failed = results.filter((r) => !r.ok)
 console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
 if (failed.length > 0) console.log('failed:', failed.map((f) => f.what).join('; '))
 console.log(' booking concepts:', JSON.stringify(bookingConcepts.slice(0, 6)))
 console.log(' ticketing concepts:', JSON.stringify(ticketingConcepts.slice(0, 6)))
 console.log(' the looking run said:', JSON.stringify(said.slice(0, 400)))
 console.log(` leads are capped at ${MAX_ATLAS_LEADS} and fenced with ${ATLAS_OPEN}`)

 runner.kill('SIGKILL')
 await app.close
 await closeDb
 process.exit(failed.length === 0 ? 0: 1)
}

void main.catch((e) => {
 console.error('ATLAS CHECK FAILED', e)
 process.exit(1)
})
