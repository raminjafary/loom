import { lookup } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'

/**
 * Who is allowed to *reach* the control plane, as opposed to who holds its secret.
 *
 * The control plane answers on the sandbox network. That was written down as a limitation
 * and left standing because the two obvious fixes both fail here: binding the listener to
 * loopback takes it away from the Runner too — the Runner is a host process reaching a
 * published port, and a published port connects to the container's network interface, not
 * its loopback — and moving control onto a Unix socket in a bind mount does not work on
 * this machine at all, where the socket file appears on the host and connecting to it is
 * refused (Docker Desktop's file sharing does not carry sockets). A separate container
 * would work and is a different shape of change: the two planes share the lease registry,
 * the usage queue and the decision queue in memory.
 *
 * So the boundary is drawn at accept time instead: **a connection from the sandbox network
 * is destroyed before a byte of it is parsed.** A sandboxed run can no longer reach lease
 * issuance even with the secret, and the secret goes back to being what it was meant to
 * be — the Runner's authentication, not the only thing between an agent and its own
 * budget.
 *
 * The subnet is discovered rather than configured, because a compose network's address
 * range is assigned by the daemon: the proxy asks DNS for the alias sandboxes reach it by,
 * and the interface holding that address names the network to refuse. An operator running
 * a different topology can state it outright instead.
 */

export interface Cidr {
  readonly base: number
  readonly prefix: number
  readonly text: string
}

const ipv4ToInt = (address: string): number | null => {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

/** `>>> 0` throughout: a /0 mask and the top bit both go wrong under signed shifts. */
const maskFor = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)

export const parseCidr = (text: string): Cidr | null => {
  const [address, prefixText] = text.trim().split('/')
  if (address === undefined || prefixText === undefined) return null
  const value = ipv4ToInt(address)
  const prefix = Number(prefixText)
  if (value === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const base = (value & maskFor(prefix)) >>> 0
  return { base, prefix, text: `${intToIpv4(base)}/${prefix}` }
}

const intToIpv4 = (value: number): string =>
  [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')

/** An interface's own address and mask, as the network it sits on. */
export const cidrForInterface = (address: string, netmask: string): Cidr | null => {
  const mask = ipv4ToInt(netmask)
  const value = ipv4ToInt(address)
  if (mask === null || value === null) return null
  let prefix = 0
  for (let bit = 31; bit >= 0; bit -= 1) {
    if (((mask >>> bit) & 1) === 0) break
    prefix += 1
  }
  // A mask with a gap in it is not a prefix, and guessing one would refuse the wrong range.
  if (maskFor(prefix) !== mask) return null
  return { base: (value & mask) >>> 0, prefix, text: `${intToIpv4((value & mask) >>> 0)}/${prefix}` }
}

/**
 * A socket's peer, normalised. Node reports an IPv4 peer on a dual-stack listener as
 * `::ffff:172.20.0.4`, and a check that did not strip that prefix would pass every
 * sandbox through while looking correct in a unit test written with bare IPv4.
 */
export const normalisePeer = (remoteAddress: string | undefined): string | null => {
  if (!remoteAddress) return null
  const stripped = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress
  return ipv4ToInt(stripped) === null ? null : stripped
}

/**
 * Whether this peer is inside one of the refused networks.
 *
 * An address that cannot be classified — an IPv6 peer, a socket with no remote address —
 * is **not** refused. This check narrows who can reach the control plane; it is not the
 * thing that authenticates them, and turning an unparsed address into a refusal would
 * take the control plane away from a deployment whose Runner reaches it over IPv6.
 */
export const peerIsRefused = (remoteAddress: string | undefined, refused: readonly Cidr[]): boolean => {
  const peer = normalisePeer(remoteAddress)
  if (peer === null) return false
  const value = ipv4ToInt(peer)
  if (value === null) return false
  return refused.some((cidr) => ((value & maskFor(cidr.prefix)) >>> 0) === cidr.base)
}

/**
 * The networks this process will not accept control connections from.
 *
 * Three sources, in order: an operator's explicit list, then the network behind the alias
 * sandboxes use to reach this container, then nothing — and "nothing" is reported by the
 * caller rather than swallowed, because a control plane that silently stopped refusing
 * anything is exactly the state this exists to end.
 */
export const discoverRefusedNetworks = async (input: {
  readonly explicit?: string | undefined
  readonly sandboxAlias: string
  readonly interfaces?: ReturnType<typeof networkInterfaces>
  readonly resolve?: (hostname: string) => Promise<string[]>
}): Promise<{ readonly cidrs: Cidr[]; readonly source: 'explicit' | 'alias' | 'none' }> => {
  const explicit = (input.explicit ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (explicit.length > 0) {
    const cidrs = explicit.map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null)
    if (cidrs.length > 0) return { cidrs, source: 'explicit' }
  }

  const resolve =
    input.resolve ??
    (async (hostname: string) => {
      const addresses = await lookup(hostname, { all: true, family: 4 })
      return addresses.map((entry) => entry.address)
    })

  let addresses: string[] = []
  try {
    addresses = await resolve(input.sandboxAlias)
  } catch {
    // No such alias: this process is not on the sandbox network, which is the topology
    // the refusal exists for in the first place.
    return { cidrs: [], source: 'none' }
  }

  const interfaces = input.interfaces ?? networkInterfaces()
  const cidrs: Cidr[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (!addresses.includes(entry.address)) continue
      const cidr = cidrForInterface(entry.address, entry.netmask)
      if (cidr && !cidrs.some((existing) => existing.text === cidr.text)) cidrs.push(cidr)
    }
  }
  return cidrs.length > 0 ? { cidrs, source: 'alias' } : { cidrs: [], source: 'none' }
}
