import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * A network per sandbox, so two runs on one host cannot reach each other.
 *
 * The limitation this closes was written down and left standing for a long time: every
 * sandbox sat on one internal network, and Docker's embedded DNS resolves a container by
 * name to anyone on it. Two concurrent runs are two agents with model-written code, and
 * "they cannot reach the internet" was never the same claim as "they cannot reach each
 * other" — a run could have opened a socket to `loom-run-<the other run's id>`, whose id
 * is not a secret, and the only reason nothing did is that nothing tried.
 *
 * Three things make it more than a flag:
 *
 * 1. **The proxy has to be on the network too.** An internal network with nothing else on
 *    it is `--network=none` with extra steps: no model call, no registry, no run. So the
 *    egress proxy is attached to each run's network under the alias sandboxes reach it by,
 *    and detached when the run ends. That is the one shared thing left, and it is the one
 *    that authenticates every byte.
 * 2. **The control plane's refusal had to stop being a boot-time snapshot** — a network
 *    that appears after the proxy started is one its discovery could never have found. See
 *    `control-peers.ts`; that change landed first, deliberately, because shipping this one
 *    without it would have re-opened the exposure it closed.
 * 3. **The address pool is ours, not the daemon's.** Docker's default pool hands out /16s
 *    from 172.17.0.0/12 — about a dozen of them — so a network per run would exhaust it
 *    somewhere around the thirteenth concurrent run and fail the ones after. A /24 carved
 *    out of a pool this module owns gives 256 concurrent sandboxes on the default setting
 *    and fails loudly rather than mysteriously when it runs out.
 *
 * Like `isolationVerdict`, the capability is **proved once by doing it** — a probe network
 * created, the proxy attached and detached, the network removed — and an unprovable one
 * refuses every run rather than falling back to the shared network. A fallback here would
 * be a claim of isolation that is false everywhere it is read.
 */

export type SandboxNetworkMode = 'shared' | 'per-run'

export interface RunNetworkConfig {
  readonly runtime: string
  readonly mode: SandboxNetworkMode
  /** The one every sandbox used to share, and still the proxy's own home. */
  readonly shared: string
  /** Named by an operator, or discovered on the shared network by its alias. */
  readonly proxyContainer: string | null
  /** The name a sandbox resolves the proxy by — `loom-egress` under compose. */
  readonly proxyAlias: string
  /** The block per-run networks are carved out of, as `a.b.c.d/prefix`. */
  readonly pool: string
}

export const runNetworkFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  shared = env.LOOM_SANDBOX_NETWORK ?? 'loom-sandbox',
  runtime = env.LOOM_CONTAINER_RUNTIME ?? 'docker',
): RunNetworkConfig => ({
  runtime,
  /**
   * Per-run by default. Unlike the dependency cache's `copy`, neither setting here claims
   * a boundary it does not have — a deployment that cannot do this is *refused*, not
   * quietly downgraded — so the default is the one that isolates, and an operator who
   * needs the old topology says so.
   */
  mode: env.LOOM_SANDBOX_NETWORK_MODE === 'shared' ? 'shared' : 'per-run',
  shared,
  proxyContainer: env.LOOM_EGRESS_CONTAINER ?? null,
  proxyAlias: env.LOOM_EGRESS_ALIAS ?? 'loom-egress',
  pool: env.LOOM_SANDBOX_NETWORK_POOL ?? '10.201.0.0/16',
})

/**
 * Distinct from the container's own name (`loom-run-<id>`), which doubles as its DNS name.
 * A network sharing that name would collide with the container's record on it.
 */
export const networkNameFor = (id: string): string => `loom-net-${id}`

type Exec = (command: string, args: string[]) => Promise<{ stdout: string }>

const defaultExec: Exec = (command, args) => execFileAsync(command, args)

/**
 * The /24s a pool contains, in order. A `/16` gives 256 of them, which is the concurrency
 * ceiling for sandboxes on one host until an operator widens the pool.
 */
export const subnetsInPool = (pool: string): string[] => {
  const [base, prefixText] = pool.split('/')
  const prefix = Number(prefixText)
  if (!base || !Number.isInteger(prefix) || prefix < 8 || prefix > 24) return []
  const octets = base.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return []
  }
  const [a, b] = octets as [number, number, number, number]
  const count = prefix === 24 ? 1 : 2 ** (24 - prefix)
  const start = (a * 256 + b) * 256
  return Array.from({ length: count }, (_, index) => {
    const value = start + index
    return `${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}.0/24`
  })
}

/**
 * Which container answers to the proxy's alias on the shared network.
 *
 * Discovered rather than configured for the reason the refused range is: a compose project
 * names its containers after the directory it was started from, so hard-coding one would
 * work on this machine and nowhere else. The alias is the thing the topology actually
 * fixes — a sandbox reaches the proxy by it, so whatever answers to it *is* the proxy.
 */
export const findProxyContainer = async (
  config: RunNetworkConfig,
  exec: Exec = defaultExec,
): Promise<string | null> => {
  if (config.proxyContainer) return config.proxyContainer
  let names: string[] = []
  try {
    const { stdout } = await exec(config.runtime, [
      'network',
      'inspect',
      config.shared,
      '--format',
      '{{range .Containers}}{{.Name}}\n{{end}}',
    ])
    names = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  } catch {
    return null
  }
  for (const name of names) {
    try {
      const { stdout } = await exec(config.runtime, [
        'inspect',
        name,
        '--format',
        `{{range $network, $settings := .NetworkSettings.Networks}}{{if eq $network "${config.shared}"}}{{range $settings.Aliases}}{{.}}\n{{end}}{{end}}{{end}}`,
      ])
      const aliases = stdout.split('\n').map((line) => line.trim())
      if (aliases.includes(config.proxyAlias)) return name
    } catch {
      // A container that vanished between listing and inspecting is not the proxy's
      // problem; keep looking rather than failing the whole discovery on it.
    }
  }
  return null
}

export type RunNetworkVerdict =
  | { readonly ok: true; readonly mode: 'shared' }
  | { readonly ok: true; readonly mode: 'per-run'; readonly proxyContainer: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Proves the whole cycle once, at startup, by doing it: create, attach the proxy, detach,
 * remove. Anything short of that is a claim, and the failure this guards against is a
 * deployment where `network connect` is refused — a proxy that is not a container, a
 * daemon the Runner cannot reach for it — where every run would otherwise start on a
 * network with nothing to talk to and die at its first model call.
 */
export const runNetworkVerdict = async (
  config: RunNetworkConfig,
  exec: Exec = defaultExec,
): Promise<RunNetworkVerdict> => {
  if (config.mode === 'shared') return { ok: true, mode: 'shared' }

  const opt = (reason: string): RunNetworkVerdict => ({
    ok: false,
    reason:
      `${reason} Set LOOM_SANDBOX_NETWORK_MODE=shared to put every sandbox back on ` +
      `${config.shared} — which is a working deployment, and one where two concurrent runs ` +
      'can reach each other by container name.',
  })

  if (subnetsInPool(config.pool).length === 0) {
    return opt(`LOOM_SANDBOX_NETWORK_POOL="${config.pool}" is not a /8–/24 IPv4 block.`)
  }

  const proxyContainer = await findProxyContainer(config, exec)
  if (proxyContainer === null) {
    return opt(
      `A network per run needs the egress proxy attached to each one, and nothing on ` +
        `"${config.shared}" answers to the alias "${config.proxyAlias}". Name the container ` +
        'with LOOM_EGRESS_CONTAINER, or the alias with LOOM_EGRESS_ALIAS.',
    )
  }

  const probe = networkNameFor(`probe-${process.pid}`)
  try {
    await exec(config.runtime, ['network', 'create', '--internal', probe])
  } catch (error) {
    return opt(`Could not create a network with ${config.runtime}: ${detailOf(error)}.`)
  }
  try {
    await exec(config.runtime, ['network', 'connect', '--alias', config.proxyAlias, probe, proxyContainer])
    await exec(config.runtime, ['network', 'disconnect', '--force', probe, proxyContainer])
    return { ok: true, mode: 'per-run', proxyContainer }
  } catch (error) {
    return opt(`Could not attach ${proxyContainer} to a per-run network: ${detailOf(error)}.`)
  } finally {
    await exec(config.runtime, ['network', 'rm', probe]).catch(() => {})
  }
}

const detailOf = (error: unknown): string =>
  error instanceof Error ? error.message.split('\n').slice(-2).join(' ').trim() : String(error)

export interface RunNetwork {
  /** What to pass as `--network`. The shared one under `shared` mode. */
  readonly name: string
  /** Detaches the proxy and removes the network. A no-op under `shared` mode. */
  readonly release: () => Promise<void>
}

/**
 * The network one sandbox runs on, for as long as it runs.
 *
 * A subnet collision is expected rather than exceptional: two Runners on one host draw
 * from the same pool and neither can see the other's allocations, so the /24 is chosen at
 * random and a clash is retried. Retrying is what makes the pool safe to share without a
 * lock — the daemon is the arbiter, and it already refuses an overlapping subnet.
 */
export const createRunNetwork = async (
  config: RunNetworkConfig,
  id: string,
  proxyContainer: string,
  exec: Exec = defaultExec,
  attempts = 8,
): Promise<RunNetwork> => {
  if (config.mode === 'shared') {
    return { name: config.shared, release: async () => {} }
  }

  const name = networkNameFor(id)
  const subnets = subnetsInPool(config.pool)
  let lastError: unknown = null
  let created = false
  for (let attempt = 0; attempt < attempts && !created; attempt += 1) {
    const subnet = subnets[Math.floor(Math.random() * subnets.length)]
    try {
      await exec(config.runtime, [
        'network',
        'create',
        '--internal',
        '--subnet',
        subnet ?? '',
        '--label',
        `loom.sandbox=${id}`,
        name,
      ])
      created = true
    } catch (error) {
      lastError = error
    }
  }
  if (!created) {
    throw new Error(
      `Could not create a network for ${id} after ${attempts} attempts on pool ${config.pool}: ` +
        `${detailOf(lastError)}. Widen LOOM_SANDBOX_NETWORK_POOL if this host runs more ` +
        'concurrent sandboxes than the pool holds.',
    )
  }

  try {
    await exec(config.runtime, ['network', 'connect', '--alias', config.proxyAlias, name, proxyContainer])
  } catch (error) {
    await exec(config.runtime, ['network', 'rm', name]).catch(() => {})
    throw new Error(`Could not attach the egress proxy to ${name}: ${detailOf(error)}`)
  }

  return {
    name,
    release: async () => {
      // Force, because the proxy is a live container; then the network itself. Both
      // best-effort: a leaked network costs a /24 out of the pool, and throwing here would
      // turn cleanup into a run failure after the work is already committed.
      await exec(config.runtime, ['network', 'disconnect', '--force', name, proxyContainer]).catch(() => {})
      await exec(config.runtime, ['network', 'rm', name]).catch(() => {})
    },
  }
}

/**
 * Networks this Runner left behind, removed at startup.
 *
 * The mirror of `killOrphanedContainers`, and scoped the same way — by the label this
 * module writes, and only for ids this Runner knows it started. A blanket sweep would take
 * the network out from under a second Runner's live run, which is an ordinary arrangement
 * here since every live driver in `tools/` spawns its own.
 */
export const removeOrphanedNetworks = async (
  ids: string[],
  config: RunNetworkConfig,
  exec: Exec = defaultExec,
  log: (message: string) => void = () => {},
): Promise<number> => {
  if (config.mode === 'shared') return 0
  let removed = 0
  for (const id of ids) {
    try {
      await exec(config.runtime, ['network', 'rm', networkNameFor(id)])
      removed += 1
      log(`removed the orphaned network for ${id}`)
    } catch {
      // Already gone, never created, or still in use by a container that outlived us —
      // `killOrphanedContainers` runs first, and a network still in use is one to leave.
    }
  }
  return removed
}
