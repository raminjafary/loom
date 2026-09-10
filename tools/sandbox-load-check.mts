/**
 * A network per sandbox, **under load** — the half two networks cannot settle.
 *
 *   docker compose up -d egress-proxy
 *   docker build -f apps/runner/Dockerfile.sandbox -t loom-agent-sandbox:latest .
 *   npx tsx tools/sandbox-load-check.mts          # 24 networks
 *   LOOM_LOAD_NETWORKS=48 npx tsx tools/sandbox-load-check.mts
 *
 * Zero tokens. `sandbox-network-check.mts` proves the isolation with two networks up, which
 * settles the topology and says nothing about scale. Three things only concurrency can answer,
 * and every one of them is a place the isolation could hold at two and be nominal at twenty:
 *
 * 1. **The control plane's refusal is per-connection**, classified from the kernel's route
 *    table. With one per-run network attached to the proxy that is one interface to walk; with
 *    twenty-five it is twenty-five, and a classifier that was really answering "the interface I
 *    found at boot" would start letting one through.
 * 2. **The proxy still routes.** Every per-run network attaches the same container, so the
 *    proxy accumulates an interface per live sandbox. The data plane answering on the *last*
 *    network created is the fact worth having.
 * 3. **Release is complete.** A leaked network costs a /24 out of the pool for the life of the
 *    host, and a leaked *interface* on the proxy costs nothing visible until the daemon refuses
 *    to attach the next one. Both are checked by counting, before and after.
 *
 * What this driver deliberately does **not** do is fill the pool. A /16 holds 256 /24s, and
 * finding the allocator's edge by really creating 256 bridges and attaching all of them to one
 * container would take the daemon down rather than find a bug. That edge is arithmetic and it
 * is checked where arithmetic belongs — `run-network.test.ts` drives `createRunNetwork` against
 * a stubbed daemon with 255 of 256 subnets taken, which is the case that used to fail: the
 * subnet was picked uniformly at random with eight attempts, so the chance of failing a run was
 * `(taken/256)^8` — 6% at 180 concurrent sandboxes, 14% at 200, and the error told the operator
 * to widen a pool with fifty free /24s in it.
 *
 * It **asserts** rather than prints. The load-bearing checks are negatives — a control plane
 * that must refuse, a name that must not resolve, a count that must return to where it started.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  createRunNetwork,
  runNetworkFromEnv,
  runNetworkVerdict,
  subnetsInPool,
  type RunNetwork,
} from '../apps/runner/src/run-network.js'

const exec = promisify(execFile)

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const COUNT = Number(process.env.LOOM_LOAD_NETWORKS ?? 24)
if (!Number.isInteger(COUNT) || COUNT < 2) {
  console.error('LOOM_LOAD_NETWORKS must be an integer of 2 or more.')
  process.exit(1)
}

const config = runNetworkFromEnv()
if (config.mode !== 'per-run') {
  console.error(
    'LOOM_SANDBOX_NETWORK_MODE=shared is set, so there is nothing here to load: every sandbox ' +
      'is on one network already.',
  )
  process.exit(1)
}

const verdict = await runNetworkVerdict(config)
if (!verdict.ok) {
  console.error(`the verdict refused: ${verdict.reason}`)
  process.exit(1)
}
if (verdict.mode !== 'per-run') process.exit(1)
const proxy = verdict.proxyContainer
console.log(`egress proxy: ${proxy}\npool: ${config.pool} (${subnetsInPool(config.pool).length} /24s)\n`)

/** Every subnet the daemon has allocated, the way the allocator asks. */
const allocatedSubnets = async (): Promise<Set<string>> => {
  const { stdout: ids } = await exec('docker', ['network', 'ls', '--quiet'])
  const list = ids.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const { stdout } = await exec('docker', [
    'network', 'inspect', ...list, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}',
  ])
  return new Set(stdout.split(/\s+/).map((entry) => entry.trim()).filter((entry) => entry !== ''))
}

/** How many networks the proxy is attached to — one interface each. */
const proxyAttachments = async (): Promise<number> => {
  const { stdout } = await exec('docker', [
    'inspect', proxy, '--format', '{{len .NetworkSettings.Networks}}',
  ])
  return Number(stdout.trim())
}

const probe = async (network: string, script: string): Promise<string> => {
  const { stdout, stderr } = await exec('docker', [
    'run', '--rm', '--network', network,
    '--entrypoint', 'node', 'loom-agent-sandbox:latest', '-e', script,
  ])
  return (stdout + stderr).trim()
}

const get = (port: number, path = '/') =>
  `require('http').get({host:'loom-egress',port:${port},path:'${path}'},` +
  `r=>console.log('HTTP '+r.statusCode)).on('error',e=>console.log(e.code))`

const resolves = (host: string) =>
  `require('dns').lookup('${host}',(e,a)=>console.log(e?e.code:'RESOLVED '+a))`

const subnetsBefore = await allocatedSubnets()
const attachmentsBefore = await proxyAttachments()
console.log(
  `${subnetsBefore.size} subnet(s) already allocated on this host; the proxy holds ` +
    `${attachmentsBefore} network(s)\n`,
)

const ids = Array.from({ length: COUNT }, (_, index) => `load-${process.pid}-${index}`)
const networks: RunNetwork[] = []

try {
  /**
   * Created all at once, because sequential creation is not the case that breaks. Two Runners
   * draw from one pool with no lock between them, so what has to hold is a burst.
   */
  const startedAt = Date.now()
  const settled = await Promise.allSettled(
    ids.map((id) => createRunNetwork(config, id, proxy)),
  )
  const elapsed = Date.now() - startedAt
  for (const outcome of settled) if (outcome.status === 'fulfilled') networks.push(outcome.value)
  const refused = settled
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    .map((outcome) => String(outcome.reason instanceof Error ? outcome.reason.message : outcome.reason))

  console.log(`${networks.length} of ${COUNT} networks created in ${elapsed}ms\n`)
  check(
    `all ${COUNT} concurrent networks were created`,
    networks.length === COUNT,
    refused.slice(0, 2).join(' | '),
  )

  const subnetsAfter = await allocatedSubnets()
  check(
    'each one took exactly one /24 out of the pool',
    subnetsAfter.size === subnetsBefore.size + networks.length,
    `${subnetsBefore.size} → ${subnetsAfter.size} for ${networks.length} network(s)`,
  )
  check(
    'and the proxy is attached to every one of them',
    (await proxyAttachments()) === attachmentsBefore + networks.length,
    `${attachmentsBefore} → ${await proxyAttachments()}`,
  )

  const subnetOf = async (name: string) => {
    const { stdout } = await exec('docker', [
      'network', 'inspect', name, '--format', '{{range .IPAM.Config}}{{.Subnet}}{{end}}',
    ])
    return stdout.trim()
  }
  const mine = await Promise.all(networks.map((network) => subnetOf(network.name)))
  check(
    'no two runs share a subnet',
    new Set(mine).size === mine.length,
    `${new Set(mine).size} distinct of ${mine.length}`,
  )

  /**
   * The last network created, probed while every other one is still up. This is the question
   * the two-network driver cannot ask: a classifier that answers from a boot-time snapshot
   * would refuse the first network and let the twenty-fourth through.
   */
  const last = networks[networks.length - 1]
  const first = networks[0]
  if (!last || !first) throw new Error('no networks to probe')

  console.log(`\n— probing the last of ${networks.length} networks, with all of them up —`)
  const control = await probe(last.name, get(8081, '/_control/usage'))
  check(
    'the control plane still refuses the newest network',
    control === 'ECONNRESET',
    control,
  )
  const data = await probe(last.name, get(8080))
  check('and the data plane still answers on it', data.startsWith('HTTP'), data)
  const proxyLookup = await probe(last.name, resolves('loom-egress'))
  check('the proxy is still reachable by its alias', proxyLookup.startsWith('RESOLVED'), proxyLookup)

  /**
   * A neighbour to fail to reach, named exactly as a run's container is. Under load this is
   * the check that matters most: every one of these networks holds the same proxy, so a
   * misconfigured attachment is a route between two runs through it.
   */
  const neighbour = exec('docker', [
    'run', '--rm', '--name', `loom-run-${ids[0]}`, '--network', first.name,
    '--entrypoint', 'node', 'loom-agent-sandbox:latest', '-e', 'setTimeout(()=>{},60000)',
  ])
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const neighbourLookup = await probe(last.name, resolves(`loom-run-${ids[0]}`))
    check(
      'one run still cannot resolve another run’s container name',
      neighbourLookup.startsWith('EAI_') || neighbourLookup.startsWith('ENOTFOUND'),
      neighbourLookup,
    )
  } finally {
    await exec('docker', ['kill', `loom-run-${ids[0]}`]).catch(() => {})
    await neighbour.catch(() => {})
  }
} finally {
  console.log('\n— releasing —')
  await Promise.all(networks.map((network) => network.release()))
}

const { stdout: remaining } = await exec('docker', ['network', 'ls', '--format', '{{.Name}}'])
const leaked = remaining.split('\n').filter((name) => name.startsWith(`loom-net-load-${process.pid}-`))
check('release takes every network with it', leaked.length === 0, leaked.slice(0, 3).join(', '))
check(
  'and gives the proxy back every interface it lent',
  (await proxyAttachments()) === attachmentsBefore,
  `${attachmentsBefore} → ${await proxyAttachments()}`,
)
check(
  'the pool is back to where it started',
  (await allocatedSubnets()).size === subnetsBefore.size,
  `${subnetsBefore.size} → ${(await allocatedSubnets()).size}`,
)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
