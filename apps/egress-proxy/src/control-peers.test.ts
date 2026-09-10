import { describe, expect, it } from 'vitest'
import {
  cidrForInterface,
  createRefusedNetworks,
  defaultRouteInterface,
  discoverRefusedNetworks,
  normalisePeer,
  parseCidr,
  peerIsRefused,
  refusedNetworksFromRoutes,
} from './control-peers.js'

/**
 * Who may reach the control plane.
 *
 * The two cases worth the file are the two that would pass a careless implementation while
 * letting every sandbox through: an IPv4 peer reported in IPv6-mapped form, and a discovery
 * that found nothing and returned an empty list that reads like "refuse nothing".
 */

const cidr = (text: string) => {
  const parsed = parseCidr(text)
  if (!parsed) throw new Error(`not a CIDR: ${text}`)
  return parsed
}

describe('peerIsRefused', () => {
  it('refuses an address inside the network', () => {
    expect(peerIsRefused('172.20.0.7', [cidr('172.20.0.0/16')])).toBe(true)
    expect(peerIsRefused('172.21.0.7', [cidr('172.20.0.0/16')])).toBe(false)
  })

  // Node reports an IPv4 peer on a dual-stack listener like this. A check written only
  // against bare IPv4 passes its own tests and refuses nothing in production.
  it('sees through the IPv6-mapped form Node actually reports', () => {
    expect(peerIsRefused('::ffff:172.20.0.7', [cidr('172.20.0.0/16')])).toBe(true)
    expect(normalisePeer('::ffff:10.0.0.1')).toBe('10.0.0.1')
  })

  /** Narrowing who can reach it, never authenticating them: an unclassifiable peer still
   *  meets the secret. */
  it('does not refuse a peer it cannot classify', () => {
    expect(peerIsRefused(undefined, [cidr('172.20.0.0/16')])).toBe(false)
    expect(peerIsRefused('fd00::1', [cidr('172.20.0.0/16')])).toBe(false)
  })

  it('refuses nothing when nothing was discovered', () => {
    expect(peerIsRefused('172.20.0.7', [])).toBe(false)
  })
})

describe('cidrForInterface', () => {
  it('reads the prefix off the mask', () => {
    expect(cidrForInterface('172.20.0.3', '255.255.0.0')?.text).toBe('172.20.0.0/16')
    expect(cidrForInterface('10.1.2.3', '255.255.255.0')?.text).toBe('10.1.2.0/24')
  })

  // A mask with a hole in it is not a prefix; guessing one would refuse the wrong range.
  it('refuses a mask that is not contiguous', () => {
    expect(cidrForInterface('10.1.2.3', '255.0.255.0')).toBeNull()
  })
})

describe('discoverRefusedNetworks', () => {
  const interfaces = {
    eth0: [
      { address: '172.20.0.3', netmask: '255.255.0.0', family: 'IPv4', internal: false, mac: '', cidr: null },
    ],
    eth1: [
      { address: '10.9.0.5', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null },
    ],
    lo: [
      { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '', cidr: null },
    ],
  } as unknown as ReturnType<typeof import('node:os').networkInterfaces>

  it('finds the sandbox network behind the alias, and only that one', async () => {
    const found = await discoverRefusedNetworks({
      sandboxAlias: 'loom-egress',
      interfaces,
      resolve: async () => ['172.20.0.3'],
    })
    expect(found.source).toBe('alias')
    expect(found.cidrs.map((entry) => entry.text)).toEqual(['172.20.0.0/16'])
  })

  it('says so rather than guessing when the alias does not resolve', async () => {
    const found = await discoverRefusedNetworks({
      sandboxAlias: 'loom-egress',
      interfaces,
      resolve: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    expect(found).toEqual({ cidrs: [], source: 'none' })
  })

  it('takes an operator’s list over discovery', async () => {
    const found = await discoverRefusedNetworks({
      explicit: '192.168.5.0/24, 10.0.0.0/8',
      sandboxAlias: 'loom-egress',
      interfaces,
      resolve: async () => ['172.20.0.3'],
    })
    expect(found.source).toBe('explicit')
    expect(found.cidrs.map((entry) => entry.text)).toEqual(['192.168.5.0/24', '10.0.0.0/8'])
  })
})

/**
 * The route table as the kernel writes it: a header line, then columns of little-endian
 * hex. Only the first, sixth and eighth fields are read here — interface, destination and
 * mask — but the rows are kept full-width so a change to the parser meets the real shape.
 */
const routeTable = (rows: { iface: string; destination: string; mask: string }[]): string =>
  [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
    ...rows.map(
      (row) =>
        `${row.iface}\t${row.destination}\t0100007F\t0003\t0\t0\t0\t${row.mask}\t0\t0\t0`,
    ),
  ].join('\n')

const NETWORKS = {
  // The routable one: the default route leaves by it.
  eth0: [
    { address: '10.9.0.5', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null },
  ],
  // The shared sandbox network.
  eth1: [
    { address: '172.20.0.3', netmask: '255.255.0.0', family: 'IPv4', internal: false, mac: '', cidr: null },
  ],
  // A network attached after boot, for one run.
  eth2: [
    { address: '172.31.4.2', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null },
  ],
  lo: [
    { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '', cidr: null },
  ],
} as unknown as ReturnType<typeof import('node:os').networkInterfaces>

const ROUTES = routeTable([
  { iface: 'eth0', destination: '00000000', mask: '00000000' },
  { iface: 'eth0', destination: '0000090A', mask: '00FFFFFF' },
  { iface: 'eth1', destination: '000014AC', mask: '0000FFFF' },
])

describe('defaultRouteInterface', () => {
  it('reads the interface a default route leaves by', () => {
    expect(defaultRouteInterface(ROUTES)).toBe('eth0')
  })

  it('is unknown rather than wrong when there is no default route', () => {
    expect(
      defaultRouteInterface(routeTable([{ iface: 'eth1', destination: '000014AC', mask: '0000FFFF' }])),
    ).toBeNull()
    expect(defaultRouteInterface('')).toBeNull()
  })
})

describe('refusedNetworksFromRoutes', () => {
  /**
   * The point of the whole change: eth2 did not exist when the proxy booted, and the alias
   * discovery could not have found it. Classifying by route finds it without being told.
   */
  it('refuses every internal network, including one attached after boot', () => {
    expect(refusedNetworksFromRoutes(NETWORKS, ROUTES).map((entry) => entry.text)).toEqual([
      '172.20.0.0/16',
      '172.31.4.0/24',
    ])
  })

  it('never refuses the network the default route leaves by', () => {
    expect(refusedNetworksFromRoutes(NETWORKS, ROUTES).map((entry) => entry.text)).not.toContain(
      '10.9.0.0/24',
    )
  })

  /**
   * An unreadable route table must not turn into a proxy that refuses its own Runner —
   * the failure has to land on "refuse nothing", which is loud in the startup line.
   */
  it('refuses nothing when the route table says nothing', () => {
    expect(refusedNetworksFromRoutes(NETWORKS, '')).toEqual([])
  })
})

describe('createRefusedNetworks', () => {
  it('sees a network that appeared after the process started', () => {
    let interfaces = {
      eth0: NETWORKS.eth0,
      eth1: NETWORKS.eth1,
    } as unknown as ReturnType<typeof import('node:os').networkInterfaces>
    let clock = 1000
    const refused = createRefusedNetworks({
      explicit: [],
      fallback: [],
      fallbackSource: 'none',
      ttlMs: 250,
      interfaces: () => interfaces,
      readRouteTable: () => ROUTES,
      now: () => clock,
    })

    expect(refused.current().map((entry) => entry.text)).toEqual(['172.20.0.0/16'])
    expect(peerIsRefused('172.31.4.9', refused.current())).toBe(false)

    interfaces = NETWORKS
    clock += 300
    expect(peerIsRefused('172.31.4.9', refused.current())).toBe(true)
  })

  it('answers from the cache inside the TTL rather than reading the interfaces again', () => {
    let reads = 0
    const refused = createRefusedNetworks({
      explicit: [],
      fallback: [],
      fallbackSource: 'none',
      ttlMs: 250,
      interfaces: () => {
        reads += 1
        return NETWORKS
      },
      readRouteTable: () => ROUTES,
      now: () => 1000,
    })
    refused.current()
    refused.current()
    refused.current()
    expect(reads).toBe(1)
  })

  it('keeps an operator’s explicit list fixed, whatever the daemon later attaches', () => {
    const refused = createRefusedNetworks({
      explicit: [cidr('192.168.5.0/24')],
      fallback: [],
      fallbackSource: 'none',
      interfaces: () => NETWORKS,
      readRouteTable: () => ROUTES,
    })
    expect(refused.current().map((entry) => entry.text)).toEqual(['192.168.5.0/24'])
    expect(refused.describe()).toContain('explicit')
  })

  /**
   * A host with no readable route table is the one case the boot-time alias answer is still
   * the best available, and the startup line has to say which of the two spoke.
   */
  it('falls back to the alias answer when the route table cannot be read', () => {
    const refused = createRefusedNetworks({
      explicit: [],
      fallback: [cidr('172.20.0.0/16')],
      fallbackSource: 'alias',
      interfaces: () => NETWORKS,
      readRouteTable: () => '',
    })
    expect(refused.current().map((entry) => entry.text)).toEqual(['172.20.0.0/16'])
    expect(refused.describe()).toContain('alias')
  })

  it('says it refuses nothing rather than staying silent', () => {
    const refused = createRefusedNetworks({
      explicit: [],
      fallback: [],
      fallbackSource: 'none',
      interfaces: () => ({}) as ReturnType<typeof import('node:os').networkInterfaces>,
      readRouteTable: () => ROUTES,
    })
    expect(refused.describe()).toContain('refuses no network')
  })
})
