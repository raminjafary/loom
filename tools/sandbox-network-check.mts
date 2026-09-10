/**
 * A network per sandbox, against the **real daemon** — the half a mocked `docker` cannot settle.
 *
 *   docker compose up -d egress-proxy
 *   docker build -f apps/runner/Dockerfile.sandbox -t loom-agent-sandbox:latest .
 *   npx tsx tools/sandbox-network-check.mts
 *
 * Zero tokens. `run-network.test.ts` proves what argv this repository *believes* isolates two
 * sandboxes from each other. Whether an internal network created after the proxy booted is one
 * the proxy's control plane refuses, whether the data plane still answers on it, and whether one
 * run can resolve another run's container name are three facts about Docker and about a process
 * that was already running — and every one of them is a place the isolation could be nominal.
 *
 * It **asserts** rather than prints. A printed value cannot fail, and the whole claim here is a
 * set of negatives: a connection that must be destroyed, a name that must not resolve. A driver
 * that printed `EAI_AGAIN` beside a hopeful sentence would pass on the day DNS started working.
 *
 * The load-bearing case is the first one. Before the refusal became live (see `control-peers.ts`)
 * the proxy discovered the network it refuses once, at boot, from the interfaces it had then — so
 * a per-run network, which by construction did not exist yet, answered `401` instead of closing.
 * This driver is the reason that is known rather than assumed.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  createRunNetwork,
  runNetworkFromEnv,
  runNetworkVerdict,
} from '../apps/runner/src/run-network.js'

const exec = promisify(execFile)

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const config = runNetworkFromEnv()
if (config.mode !== 'per-run') {
  console.error(
    'LOOM_SANDBOX_NETWORK_MODE=shared is set, so there is nothing here to check: every sandbox ' +
      'is on one network and can reach every other by container name.',
  )
  process.exit(1)
}

const verdict = await runNetworkVerdict(config)
if (!verdict.ok) {
  console.error(`the verdict refused: ${verdict.reason}`)
  process.exit(1)
}
if (verdict.mode !== 'per-run') process.exit(1)
console.log(`egress proxy: ${verdict.proxyContainer}\n`)

/** One short-lived container on a named network, reporting what its script printed. */
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

const a = await createRunNetwork(config, 'check-a', verdict.proxyContainer)
const b = await createRunNetwork(config, 'check-b', verdict.proxyContainer)

/**
 * A neighbour to fail to reach. Named exactly as a run's container is — `loom-run-<id>` is
 * also its DNS name — because the reachability this closes was never hypothetical: a run id is
 * not a secret, and a model that guessed one had a peer to open a socket to.
 */
const neighbour = exec('docker', [
  'run', '--rm', '--name', 'loom-run-check-b', '--network', b.name,
  '--entrypoint', 'node', 'loom-agent-sandbox:latest', '-e', 'setTimeout(()=>{},30000)',
])

try {
  /**
   * The network was created after the proxy started, so nothing it discovered at boot could
   * have named this range. A `401` here is the old behaviour and a reachable control plane.
   */
  const control = await probe(a.name, get(8081, '/_control/usage'))
  check(
    'the control plane refuses a network that did not exist when it booted',
    control === 'ECONNRESET',
    control,
  )

  /**
   * An internal network with nothing else on it is `--network=none` with extra steps. 403 is
   * the proxy answering without a lease, which is the answer that proves it is there.
   */
  const data = await probe(a.name, get(8080))
  check('the data plane still answers on that network', data.startsWith('HTTP'), data)

  const neighbourLookup = await probe(a.name, resolves('loom-run-check-b'))
  check(
    'one run cannot resolve another run’s container name',
    neighbourLookup.startsWith('EAI_') || neighbourLookup.startsWith('ENOTFOUND'),
    neighbourLookup,
  )

  const proxyLookup = await probe(a.name, resolves('loom-egress'))
  check('and can still resolve the egress proxy', proxyLookup.startsWith('RESOLVED'), proxyLookup)

  /** The two networks must not share a subnet, or the isolation is a name rather than a route. */
  const subnetOf = async (name: string) => {
    const { stdout } = await exec('docker', [
      'network', 'inspect', name, '--format', '{{range .IPAM.Config}}{{.Subnet}}{{end}}',
    ])
    return stdout.trim()
  }
  const [subnetA, subnetB] = [await subnetOf(a.name), await subnetOf(b.name)]
  check('two runs get two subnets', subnetA !== '' && subnetA !== subnetB, `${subnetA} vs ${subnetB}`)

  /** Internal, so there is no route off the host even before the allowlist is consulted. */
  const { stdout: internal } = await exec('docker', [
    'network', 'inspect', a.name, '--format', '{{.Internal}}',
  ])
  check('the network is internal', internal.trim() === 'true', internal.trim())
} finally {
  await exec('docker', ['kill', 'loom-run-check-b']).catch(() => {})
  await neighbour.catch(() => {})
  await a.release()
  await b.release()
}

/**
 * Released, not merely stopped. A leaked network costs a /24 out of the pool every run, and the
 * failure that follows is a creation error hundreds of runs later with nothing pointing here.
 */
const { stdout: remaining } = await exec('docker', ['network', 'ls', '--format', '{{.Name}}'])
const leaked = remaining.split('\n').filter((name) => name.startsWith('loom-net-check-'))
check('release takes the network with it', leaked.length === 0, leaked.join(', '))

console.log(
  failures === 0
    ? '\nall checks passed'
    : `\n${failures} check(s) failed`,
)
process.exit(failures === 0 ? 0 : 1)
