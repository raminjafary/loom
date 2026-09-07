import type { BlobStoragePort } from '@loom/application'

/**
 * `BlobStoragePort` over a SeaweedFS filer — the Phase 3 swap the tech stack named, and the
 * reason the port exists at all.
 *
 * The filer's own HTTP API rather than its S3 gateway, and that is the whole design decision
 * here. The port stores append-once chunks under an opaque key and never asks for a bucket, an
 * ACL, a multipart upload or a presigned URL, so the S3 surface would mean carrying a signing
 * implementation — SigV4 is the sort of code that is either exactly right or silently broken on
 * one header — to reach a subset of it that four plain HTTP verbs already cover. An operator who
 * wants Garage or Ceph instead writes the sibling adapter the replaceability table promises;
 * they do not inherit a signer nobody here can test against.
 *
 * What the port promises and this has to preserve, because the filesystem adapter gets both for
 * free from the filesystem:
 *
 * - **`list` is lexicographic**, which `transcriptChunkKey`'s zero-padding makes chronological.
 *   The filer returns entries in its own order, so they are sorted here.
 * - **`get` of a missing key is null, not an error.** A 404 from the filer is the ordinary case
 *   — the reader asks for a transcript before anything has been written to it.
 */
export const seaweedBlobStorage = (
  filerUrl: string,
  options: { readonly fetch?: typeof fetch } = {},
): BlobStoragePort => {
  const call = options.fetch ?? fetch
  /** One trailing slash, so a key never resolves against the wrong parent. */
  const base = filerUrl.endsWith('/') ? filerUrl : `${filerUrl}/`

  /**
   * The traversal guard the filesystem adapter has, kept for a different reason.
   *
   * An object store treats `../` as a literal segment, which is why the port's comment says the
   * check belongs in the filesystem adapter — but this adapter builds a *URL*, and URL
   * resolution normalizes `..` exactly the way a path does. `new URL('a/../../b', base)` walks
   * out of the prefix, so a key that escapes here escapes into another deployment's tree on a
   * shared filer.
   */
  const urlFor = (key: string): URL => {
    const trimmed = key.replace(/^\/+/, '')
    if (trimmed.split('/').some((segment) => segment === '..' || segment === '.')) {
      throw new Error(`blob key escapes the storage root: ${key}`)
    }
    return new URL(trimmed, base)
  }

  const refuse = (what: string, response: Response): never => {
    throw new Error(`seaweed filer ${what} failed: ${response.status} ${response.statusText}`)
  }

  return {
    async put(key, body) {
      /**
       * A raw body rather than a multipart form. The filer accepts both; multipart is what its
       * documentation shows because that is what a browser sends, and it would mean this adapter
       * inventing a filename for a key that already is one.
       */
      const response = await call(urlFor(key), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body,
      })
      if (!response.ok) refuse('put', response)
    },

    async get(key) {
      const response = await call(urlFor(key), { method: 'GET' })
      if (response.status === 404) return null
      if (!response.ok) refuse('get', response)
      return await response.text()
    },

    async list(prefix) {
      /**
       * `Accept: application/json` is what turns the filer's directory listing from HTML into
       * entries, and the page size is the filer's `limit`. Paged through with `lastFileName`
       * rather than raised to a large limit: a run that chunked for an hour has more chunks than
       * any single page bound anybody would pick, and a truncated list reads as a truncated
       * transcript rather than as an error.
       */
      const names: string[] = []
      let lastFileName = ''
      for (;;) {
        const url = urlFor(`${prefix.replace(/\/+$/, '')}/`)
        url.searchParams.set('limit', String(PAGE))
        if (lastFileName !== '') url.searchParams.set('lastFileName', lastFileName)
        const response = await call(url, { headers: { accept: 'application/json' } })
        // A prefix nothing has been written under is an empty list, the same as on a filesystem.
        if (response.status === 404) break
        if (!response.ok) refuse('list', response)
        const page = (await response.json()) as {
          Entries?: { FullPath?: string; Name?: string }[] | null
        }
        const entries = page.Entries ?? []
        if (entries.length === 0) break
        for (const entry of entries) {
          const name = entry.Name ?? entry.FullPath?.split('/').pop() ?? ''
          if (name !== '') names.push(name)
        }
        const last = entries[entries.length - 1]
        lastFileName = last?.Name ?? last?.FullPath?.split('/').pop() ?? ''
        if (entries.length < PAGE || lastFileName === '') break
      }
      // Sorted here rather than trusted from the filer, for the filesystem adapter's reason:
      // `transcriptChunkKey` pads its index precisely so this sort is chronological.
      return names.sort().map((name) => `${prefix.replace(/\/+$/, '')}/${name}`)
    },

    async deletePrefix(prefix) {
      const url = urlFor(`${prefix.replace(/\/+$/, '')}/`)
      url.searchParams.set('recursive', 'true')
      // `ignoreRecursiveError`, because a prefix that was never written is not a failed delete —
      // the filesystem adapter passes `force: true` for the same case.
      url.searchParams.set('ignoreRecursiveError', 'true')
      const response = await call(url, { method: 'DELETE' })
      if (response.status === 404) return
      if (!response.ok) refuse('deletePrefix', response)
    },
  }
}

/** One filer listing page. Bounded per request, not per prefix — `list` pages to the end. */
const PAGE = 1000
