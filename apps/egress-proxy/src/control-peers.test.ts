import { describe, expect, it } from 'vitest'
import {
  cidrForInterface,
  discoverRefusedNetworks,
  normalisePeer,
  parseCidr,
  peerIsRefused,
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
