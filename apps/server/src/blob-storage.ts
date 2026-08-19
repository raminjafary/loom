import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { BlobStoragePort } from '@loom/application'

/**
 * `BlobStoragePort` over the local filesystem — the explicit Phase 1 choice
 * ("SeaweedFS — local filesystem behind `BlobStoragePort`; swap in Phase 3").
 *
 * The only interesting part is that a key is untrusted input as far as this
 * adapter is concerned. Keys are built by the domain today, but an object-store
 * adapter would treat `../` as a literal path segment while a filesystem one
 * would walk out of the root — so the traversal check lives here, in the adapter
 * whose storage model makes it exploitable, rather than being assumed upstream.
 */
export const fileBlobStorage = (root: string): BlobStoragePort => {
  const resolvedRoot = resolve(root)

  const pathFor = (key: string): string => {
    const full = resolve(resolvedRoot, key)
    if (full !== resolvedRoot && !full.startsWith(resolvedRoot + sep)) {
      throw new Error(`blob key escapes the storage root: ${key}`)
    }
    return full
  }

  return {
    async put(key, body) {
      const target = pathFor(key)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, body, 'utf8')
    },

    async get(key) {
      try {
        return await readFile(pathFor(key), 'utf8')
      } catch {
        return null
      }
    },

    async list(prefix) {
      const dir = pathFor(prefix)
      try {
        const names = await readdir(dir)
        // Sorted here rather than relying on readdir's order, which is
        // filesystem-defined. `transcriptChunkKey` pads its index precisely so
        // this sort is chronological.
        return names.sort().map((name) => join(prefix, name))
      } catch {
        return []
      }
    },

    async deletePrefix(prefix) {
      await rm(pathFor(prefix), { recursive: true, force: true })
    },
  }
}
