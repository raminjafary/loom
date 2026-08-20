import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeDeployment } from '@loom/domain'
import { describe, expect, it } from 'vitest'
import { fileSelfDeploymentStore } from './self-deployment-store.js'

/**
 * The running-revision pointer, on disk.
 *
 * One property matters here and it is not the round trip: that a reader never meets a
 * half-written file. The reader in question is a recovery script trying to find out which
 * revision to put back, so losing the pointer at the moment it is needed is the failure this
 * adapter exists to make impossible.
 */

const deployment = {
  running: { commit: 'b'.repeat(40), builtAt: new Date(0), retained: true, health: 'healthy' as const },
  previous: { commit: 'a'.repeat(40), builtAt: new Date(0), retained: true, health: 'healthy' as const },
}

describe('fileSelfDeploymentStore', () => {
  it('reads back what it wrote', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-deployment-'))
    const store = fileSelfDeploymentStore(join(dir, 'deployment.json'))
    await store.write(serializeDeployment(deployment))
    expect(await store.read()).toBe(serializeDeployment(deployment))
  })

  /** A deployment that has never promoted, which is every installation until it does. */
  it('reads null when nothing has been written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-deployment-'))
    expect(await fileSelfDeploymentStore(join(dir, 'deployment.json')).read()).toBeNull()
  })

  it('creates the directory it was pointed at', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-deployment-'))
    const store = fileSelfDeploymentStore(join(dir, 'nested', 'deep', 'deployment.json'))
    await store.write('{}\n')
    expect(await store.read()).toBe('{}\n')
  })

  /**
   * The write is a rename, so nothing is left behind and the pointer is never the truncated
   * file `writeFile` would leave if it were interrupted. Asserted by what the directory holds
   * after two writes: a staging file that lingered would be a reader's next surprise.
   */
  it('leaves no staging file behind, because the pointer is moved by rename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-deployment-'))
    const store = fileSelfDeploymentStore(join(dir, 'deployment.json'))
    await store.write(serializeDeployment({ running: deployment.running, previous: null }))
    await store.write(serializeDeployment(deployment))
    expect(await readdir(dir)).toEqual(['deployment.json'])
    expect(await store.read()).toContain('a'.repeat(40))
  })

  /**
   * Replacing an existing pointer, which is the only kind of write a promotion ever makes after
   * the first — and the one where a truncate-in-place would destroy the old value before the new
   * one is durable.
   */
  it('replaces an existing pointer without ever emptying it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-deployment-'))
    const path = join(dir, 'deployment.json')
    await writeFile(path, serializeDeployment({ running: deployment.previous, previous: null }))
    const store = fileSelfDeploymentStore(path)
    await store.write(serializeDeployment(deployment))
    const text = await store.read()
    expect(text).toContain('b'.repeat(40))
    expect(JSON.parse(String(text)).previous.commit).toBe('a'.repeat(40))
  })
})
