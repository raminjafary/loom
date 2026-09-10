import { describe, expect, it } from 'vitest'
import {
  createRunNetwork,
  findProxyContainer,
  networkNameFor,
  removeOrphanedNetworks,
  runNetworkFromEnv,
  runNetworkVerdict,
  subnetsInPool,
} from './run-network.js'

/**
 * A network per sandbox.
 *
 * The cases worth the file are the ones that would pass a careless implementation while
 * leaving two runs able to reach each other: a verdict that says yes without having
 * attached anything, a create that silently falls back to the shared network when the
 * proxy cannot be attached, and a release that leaves the network behind so the pool
 * drains until creation fails.
 */

const config = {
  ...runNetworkFromEnv({} as NodeJS.ProcessEnv),
  runtime: 'docker',
}

/** Records every argv the module would have handed the container runtime. */
const recorder = (
  outcomes: Record<string, string | Error> = {},
): { calls: string[][]; exec: (command: string, args: string[]) => Promise<{ stdout: string }> } => {
  const calls: string[][] = []
  return {
    calls,
    exec: async (_command, args) => {
      calls.push(args)
      for (const [prefix, outcome] of Object.entries(outcomes)) {
        if (args.join(' ').startsWith(prefix)) {
          if (outcome instanceof Error) throw outcome
          return { stdout: outcome }
        }
      }
      return { stdout: '' }
    },
  }
}

const PROXY_FOUND = {
  'network inspect loom-sandbox': 'agents-swarm-egress-proxy-1\n',
  'inspect agents-swarm-egress-proxy-1': 'loom-egress\negress\n',
}

describe('subnetsInPool', () => {
  it('carves a /16 into 256 usable /24s', () => {
    const subnets = subnetsInPool('10.201.0.0/16')
    expect(subnets).toHaveLength(256)
    expect(subnets[0]).toBe('10.201.0.0/24')
    expect(subnets[255]).toBe('10.201.255.0/24')
  })

  it('refuses a pool it cannot carve, rather than inventing one', () => {
    expect(subnetsInPool('not-a-pool')).toEqual([])
    expect(subnetsInPool('10.201.0.0/28')).toEqual([])
  })
})

describe('findProxyContainer', () => {
  it('finds the container answering to the alias on the shared network', async () => {
    const { exec } = recorder(PROXY_FOUND)
    expect(await findProxyContainer(config, exec)).toBe('agents-swarm-egress-proxy-1')
  })

  it('is null rather than a guess when nothing answers to the alias', async () => {
    const { exec } = recorder({
      'network inspect loom-sandbox': 'some-other-container\n',
      'inspect some-other-container': 'nothing-like-it\n',
    })
    expect(await findProxyContainer(config, exec)).toBeNull()
  })

  it('takes an operator’s name over discovery', async () => {
    const { exec, calls } = recorder(PROXY_FOUND)
    expect(await findProxyContainer({ ...config, proxyContainer: 'my-proxy' }, exec)).toBe('my-proxy')
    expect(calls).toEqual([])
  })
})

describe('runNetworkVerdict', () => {
  /**
   * The load-bearing half. A verdict that returned ok without attaching anything would let
   * every run start on a network with nothing on it and die at its first model call.
   */
  it('proves the cycle by running it, and cleans the probe up', async () => {
    const { exec, calls } = recorder(PROXY_FOUND)
    const verdict = await runNetworkVerdict(config, exec)
    expect(verdict).toEqual({ ok: true, mode: 'per-run', proxyContainer: 'agents-swarm-egress-proxy-1' })
    const verbs = calls.map((args) => args.slice(0, 2).join(' '))
    expect(verbs).toContain('network create')
    expect(verbs).toContain('network connect')
    expect(verbs).toContain('network disconnect')
    expect(verbs).toContain('network rm')
  })

  it('refuses, naming the way out, when the proxy cannot be found', async () => {
    const { exec } = recorder({ 'network inspect loom-sandbox': '' })
    const verdict = await runNetworkVerdict(config, exec)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.reason).toContain('LOOM_EGRESS_CONTAINER')
    expect(verdict.reason).toContain('LOOM_SANDBOX_NETWORK_MODE=shared')
  })

  it('refuses when the proxy cannot be attached, rather than running without it', async () => {
    const { exec } = recorder({
      ...PROXY_FOUND,
      'network connect': new Error('Error response from daemon: endpoint already exists'),
    })
    const verdict = await runNetworkVerdict(config, exec)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.reason).toContain('endpoint already exists')
  })

  it('asks nothing of the daemon under shared mode', async () => {
    const { exec, calls } = recorder(PROXY_FOUND)
    expect(await runNetworkVerdict({ ...config, mode: 'shared' }, exec)).toEqual({
      ok: true,
      mode: 'shared',
    })
    expect(calls).toEqual([])
  })
})

describe('createRunNetwork', () => {
  it('creates an internal network for the run and puts the proxy on it', async () => {
    const { exec, calls } = recorder()
    const net = await createRunNetwork(config, 'run-1', 'proxy', exec)
    expect(net.name).toBe(networkNameFor('run-1'))
    const create = calls.find((args) => args[0] === 'network' && args[1] === 'create')
    expect(create).toContain('--internal')
    expect(create).toContain('--subnet')
    const connect = calls.find((args) => args[0] === 'network' && args[1] === 'connect')
    expect(connect).toEqual(['network', 'connect', '--alias', 'loom-egress', 'loom-net-run-1', 'proxy'])
  })

  it('retries a subnet the daemon already gave to another Runner', async () => {
    let attempts = 0
    const exec = async (_command: string, args: string[]) => {
      if (args[0] === 'network' && args[1] === 'create') {
        attempts += 1
        if (attempts < 3) throw new Error('Pool overlaps with other one on this address space')
      }
      return { stdout: '' }
    }
    const net = await createRunNetwork(config, 'run-2', 'proxy', exec)
    expect(net.name).toBe('loom-net-run-2')
    expect(attempts).toBe(3)
  })

  it('gives up with the pool and the daemon’s own words rather than falling back to the shared network', async () => {
    const { exec } = recorder({ 'network create': new Error('all predefined address pools have been fully subnetted') })
    const failure = createRunNetwork(config, 'run-3', 'proxy', exec, 2)
    await expect(failure).rejects.toThrow(/10\.201\.0\.0\/16/)
    // The daemon's own message, carried through: this one is Docker's *default* pools being
    // exhausted, which is a different remedy from widening ours, and the old text advised
    // widening ours for it.
    await expect(failure).rejects.toThrow(/fully subnetted/)
  })

  /**
   * Occupancy, which the retry alone could not handle.
   *
   * The pick used to be uniform over the whole pool, so a nearly-full host failed runs while
   * free /24s remained — `(taken/256)^8`, which is 14% of runs at 200 concurrent sandboxes,
   * and the error blamed a pool that had 56 free. Asking the daemon which subnets are taken
   * turns eight tries from a lottery into a race with rival Runners.
   */
  it('picks a free subnet at the first attempt on a pool that is nearly full', async () => {
    const pool = subnetsInPool(config.pool)
    const free = pool[137]!
    const calls: string[][] = []
    const exec = async (_command: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'network' && args[1] === 'ls') return { stdout: 'n1\n' }
      if (args[0] === 'network' && args[1] === 'inspect' && args.includes('--format')) {
        return { stdout: pool.filter((subnet) => subnet !== free).join(' ') }
      }
      if (args[0] === 'network' && args[1] === 'create') {
        const subnet = args[args.indexOf('--subnet') + 1]
        if (subnet !== free) throw new Error('Pool overlaps with other one on this address space')
      }
      return { stdout: '' }
    }
    const net = await createRunNetwork(config, 'run-full', 'proxy', exec)
    expect(net.name).toBe('loom-net-run-full')
    const creates = calls.filter((args) => args[0] === 'network' && args[1] === 'create')
    expect(creates).toHaveLength(1)
    expect(creates[0]).toContain(free)
  })

  /** And a pool with nothing left says so, which is the one case "widen it" is the answer to. */
  it('refuses immediately when every subnet in the pool is allocated', async () => {
    const pool = subnetsInPool(config.pool)
    let created = 0
    const exec = async (_command: string, args: string[]) => {
      if (args[0] === 'network' && args[1] === 'ls') return { stdout: 'n1\n' }
      if (args[0] === 'network' && args[1] === 'inspect' && args.includes('--format')) {
        return { stdout: pool.join(' ') }
      }
      if (args[0] === 'network' && args[1] === 'create') created += 1
      return { stdout: '' }
    }
    await expect(createRunNetwork(config, 'run-none', 'proxy', exec)).rejects.toThrow(
      /pool .* is full[\s\S]*Widen LOOM_SANDBOX_NETWORK_POOL/,
    )
    // Nothing attempted: the daemon was asked and it had no room to offer.
    expect(created).toBe(0)
  })

  /**
   * A network that cannot hold the proxy is `--network=none` with extra steps, and the run
   * would fail at its first model call with an error about the model. Fail here instead —
   * and take the half-made network with it, or the pool drains one run at a time.
   */
  it('removes the network it made when the proxy will not attach', async () => {
    const { exec, calls } = recorder({ 'network connect': new Error('no such container') })
    await expect(createRunNetwork(config, 'run-4', 'proxy', exec)).rejects.toThrow(/no such container/)
    expect(calls.some((args) => args[0] === 'network' && args[1] === 'rm')).toBe(true)
  })

  it('detaches the proxy before removing the network on release', async () => {
    const { exec, calls } = recorder()
    const net = await createRunNetwork(config, 'run-5', 'proxy', exec)
    await net.release()
    const tail = calls.slice(-2).map((args) => args.slice(0, 2).join(' '))
    expect(tail).toEqual(['network disconnect', 'network rm'])
  })

  it('stays on the shared network, and touches nothing, under shared mode', async () => {
    const { exec, calls } = recorder()
    const net = await createRunNetwork({ ...config, mode: 'shared' }, 'run-6', 'proxy', exec)
    expect(net.name).toBe('loom-sandbox')
    await net.release()
    expect(calls).toEqual([])
  })
})

describe('removeOrphanedNetworks', () => {
  it('removes only the networks of the runs it is given', async () => {
    const { exec, calls } = recorder()
    const removed = await removeOrphanedNetworks(['run-a', 'run-b'], config, exec)
    expect(removed).toBe(2)
    expect(calls).toEqual([
      ['network', 'rm', 'loom-net-run-a'],
      ['network', 'rm', 'loom-net-run-b'],
    ])
  })

  it('counts only what it removed when one is already gone', async () => {
    const { exec } = recorder({ 'network rm loom-net-run-a': new Error('no such network') })
    expect(await removeOrphanedNetworks(['run-a', 'run-b'], config, exec)).toBe(1)
  })
})
