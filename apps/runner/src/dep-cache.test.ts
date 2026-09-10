import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildWarmArgs, depCacheDirFor, prepareDepCache } from './dep-cache.js'

/**
 * Real filesystem, because the property under test *is* filesystem behaviour: that a
 * run's cache is genuinely its own copy and not the shared directory under another
 * name. A mock would assert the shape this file already assumes.
 */

const REPO = 'repo-1'

/**
 * A warmed cache for one repository, returned as the pair the tests need: the configured
 * root, and the per-repository directory under it that a run actually copies from.
 */
const warmedCache = async (repositoryId = REPO) => {
  const root = await mkdtemp(join(tmpdir(), 'dep-cache-root-'))
  const dir = join(root, repositoryId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'warmed.tgz'), 'from the platform warm step')
  return { root, dir }
}

describe('prepareDepCache in copy mode', () => {
  it('gives the run its own copy of the warmed cache', async () => {
    const { root, dir } = await warmedCache()
    const mount = await prepareDepCache({ root, mode: 'copy' }, 'run-1', REPO)

    expect(mount.path).not.toBe(dir)
    expect(await readFile(join(mount.path, 'warmed.tgz'), 'utf8')).toBe(
      'from the platform warm step',
    )
    await mount.release()
  })

  it('never lets one run see what another wrote — the whole point of copy mode', async () => {
    // The `shared` mode's failure is that a malicious run can plant a cache entry a
    // later run installs. Under `copy` that is structurally impossible, and this is
    // the assertion that says so.
    const { root, dir } = await warmedCache()
    const first = await prepareDepCache({ root, mode: 'copy' }, 'run-1', REPO)
    await writeFile(join(first.path, 'poisoned.tgz'), 'planted by a malicious run')

    const second = await prepareDepCache({ root, mode: 'copy' }, 'run-2', REPO)
    expect(existsSync(join(second.path, 'poisoned.tgz'))).toBe(false)
    // ...and it never reached the shared root either, so no later warm inherits it.
    expect(await readdir(dir)).toEqual(['warmed.tgz'])

    await first.release()
    await second.release()
  })

  it('releases the copy without touching the shared root', async () => {
    const { root, dir } = await warmedCache()
    const mount = await prepareDepCache({ root, mode: 'copy' }, 'run-1', REPO)
    await mount.release()

    expect(existsSync(mount.path)).toBe(false)
    expect(existsSync(join(dir, 'warmed.tgz'))).toBe(true)
  })

  it('creates the shared root when it does not exist yet', async () => {
    // Otherwise the container runtime creates it as root and the non-root agent
    // silently cannot write, so the cache stays empty while looking configured.
    const root = join(await mkdtemp(join(tmpdir(), 'dep-cache-missing-')), 'not-yet')
    const mount = await prepareDepCache({ root, mode: 'copy' }, 'run-1', REPO)
    expect(existsSync(join(root, REPO))).toBe(true)
    await mount.release()
  })
})

describe('prepareDepCache in shared mode', () => {
  it('hands over the shared root itself, and release leaves it alone', async () => {
    // Release must be a no-op here: deleting the shared root after one run would throw
    // away every other run's cache.
    const { root, dir } = await warmedCache()
    const mount = await prepareDepCache({ root, mode: 'shared' }, 'run-1', REPO)

    // The repository's own directory, not the configured root: shared mode is still
    // shared, and now only between the runs of one repository.
    expect(mount.path).toBe(dir)
    await mount.release()
    expect(existsSync(join(dir, 'warmed.tgz'))).toBe(true)
  })
})

/**
 * The keying itself, and the failure it closes: one repository's install command wrote
 * what every other repository's runs then copied.
 */
describe('one cache per repository', () => {
  it('never hands one repository’s cache to another’s run', async () => {
    const { root, dir } = await warmedCache()
    await writeFile(join(dir, 'private-registry-response.json'), 'resolved for repo-1 only')

    const other = await prepareDepCache({ root, mode: 'copy' }, 'run-2', 'repo-2')
    expect(existsSync(join(other.path, 'private-registry-response.json'))).toBe(false)
    expect(existsSync(join(other.path, 'warmed.tgz'))).toBe(false)
    await other.release()
  })

  it('is the same directory the warm step writes, so a run copies what was warmed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dep-cache-agree-'))
    const config = { root, mode: 'copy' as const }
    // What the warm step is handed for this repository...
    const warmTarget = depCacheDirFor(config, REPO)
    await mkdir(warmTarget, { recursive: true })
    await writeFile(join(warmTarget, 'warmed.tgz'), 'from the platform warm step')
    // ...is what a run of that repository then reads.
    const mount = await prepareDepCache(config, 'run-1', REPO)
    expect(await readFile(join(mount.path, 'warmed.tgz'), 'utf8')).toBe(
      'from the platform warm step',
    )
    await mount.release()
  })
})

describe('the warm step', () => {
  const args = buildWarmArgs({
    runtime: 'docker',
    image: 'loom-agent-sandbox:latest',
    network: 'loom-sandbox',
    cacheRoot: '/host/cache',
    clonePath: '/host/clone',
    command: 'npm ci',
    env: { HTTPS_PROXY: 'http://loom-egress:8080' },
    timeoutMs: 600_000,
  }).join(' ')

  it('mounts a writable clone, because installers write into the project', () => {
    // Read-only was the first instinct and it broke every warm with
    // `ENOENT: mkdir '/work/node_modules'`. What is mounted is a throwaway clone,
    // discarded when the install finishes; the operator's repository is never mounted.
    expect(args).toContain('/host/clone:/work:rw')
  })

  it('writes to the shared cache, which is the only writer it ever has', () => {
    expect(args).toContain('/host/cache:/deps:rw')
  })

  it('gets the same kernel boundary the runs do, when one was asked for', () => {
    // An install command pulls and executes package scripts from a registry: untrusted
    // code by a different route, and the one write to the cache every later run inherits.
    const isolated = buildWarmArgs({
      runtime: 'docker',
      ociRuntime: 'kata-runtime',
      image: 'loom-agent-sandbox:latest',
      network: 'loom-sandbox',
      cacheRoot: '/host/cache',
      clonePath: '/host/clone',
      command: 'npm ci',
      env: {},
      timeoutMs: 600_000,
    }).join(' ')
    expect(isolated).toContain('--runtime kata-runtime')
    expect(args).not.toContain('--runtime')
  })

  it('keeps the container restrictions', () => {
    // A warm step is still executing a command inside a container on the operator's
    // machine — the fact that a human authored the command is not a reason to drop the
    // sandbox around it.
    for (const flag of ['--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only']) {
      expect(args).toContain(flag)
    }
    expect(args).toContain('--user 1000:1000')
    expect(args).not.toContain('docker.sock')
  })
})
