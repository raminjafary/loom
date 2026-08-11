import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildWarmArgs, prepareDepCache } from './dep-cache.js'

/**
 * Real filesystem, because the property under test *is* filesystem behaviour: that a
 * run's cache is genuinely its own copy and not the shared directory under another
 * name. A mock would assert the shape this file already assumes.
 */

const warmedCache = async => {
 const root = await mkdtemp(join(tmpdir, 'dep-cache-root-'))
 await writeFile(join(root, 'warmed.tgz'), 'from the platform warm step')
 return root
}

describe('prepareDepCache in copy mode', => {
 it('gives the run its own copy of the warmed cache', async => {
 const root = await warmedCache
 const mount = await prepareDepCache({ root, mode: 'copy' }, 'run-1')

 expect(mount.path).not.toBe(root)
 expect(await readFile(join(mount.path, 'warmed.tgz'), 'utf8')).toBe(
 'from the platform warm step',
)
 await mount.release
 })

 it('never lets one run see what another wrote — the whole point of copy mode', async => {
 // The `shared` mode's failure is that a malicious run can plant a cache entry a
 // later run installs. Under `copy` that is structurally impossible, and this is
 // the assertion that says so.
 const root = await warmedCache
 const first = await prepareDepCache({ root, mode: 'copy' }, 'run-1')
 await writeFile(join(first.path, 'poisoned.tgz'), 'planted by a malicious run')

 const second = await prepareDepCache({ root, mode: 'copy' }, 'run-2')
 expect(existsSync(join(second.path, 'poisoned.tgz'))).toBe(false)
 //...and it never reached the shared root either, so no later warm inherits it.
 expect(await readdir(root)).toEqual(['warmed.tgz'])

 await first.release
 await second.release
 })

 it('releases the copy without touching the shared root', async => {
 const root = await warmedCache
 const mount = await prepareDepCache({ root, mode: 'copy' }, 'run-1')
 await mount.release

 expect(existsSync(mount.path)).toBe(false)
 expect(existsSync(join(root, 'warmed.tgz'))).toBe(true)
 })

 it('creates the shared root when it does not exist yet', async => {
 // Otherwise the container runtime creates it as root and the non-root agent
 // silently cannot write, so the cache stays empty while looking configured.
 const root = join(await mkdtemp(join(tmpdir, 'dep-cache-missing-')), 'not-yet')
 const mount = await prepareDepCache({ root, mode: 'copy' }, 'run-1')
 expect(existsSync(root)).toBe(true)
 await mount.release
 })
})

describe('prepareDepCache in shared mode', => {
 it('hands over the shared root itself, and release leaves it alone', async => {
 // Release must be a no-op here: deleting the shared root after one run would throw
 // away every other run's cache.
 const root = await warmedCache
 const mount = await prepareDepCache({ root, mode: 'shared' }, 'run-1')

 expect(mount.path).toBe(root)
 await mount.release
 expect(existsSync(join(root, 'warmed.tgz'))).toBe(true)
 })
})

describe('the warm step', => {
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

 it('mounts a writable clone, because installers write into the project', => {
 // Read-only was the first instinct and it broke every warm with
 // `ENOENT: mkdir '/work/node_modules'`. What is mounted is a throwaway clone,
 // discarded when the install finishes; the operator's repository is never mounted.
 expect(args).toContain('/host/clone:/work:rw')
 })

 it('writes to the shared cache, which is the only writer it ever has', => {
 expect(args).toContain('/host/cache:/deps:rw')
 })

 it('keeps the A5 container restrictions', => {
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
