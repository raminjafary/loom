import { describe, expect, it } from 'vitest'
import { seaweedBlobStorage } from './seaweed-blob-storage.js'

/**
 * The filer adapter, against a stub of the filer's own protocol.
 *
 * What a stub can settle and what it cannot is worth being explicit about, because this file
 * would otherwise read as proof the swap works. It settles the parts that are *this adapter's*
 * decisions — which verb and URL each operation uses, that a 404 from `get` is null rather than
 * an error, that a listing is paged to the end and sorted, and that a key cannot escape the
 * prefix. It settles nothing about whether a real filer accepts a raw `PUT` body or shapes its
 * listing the way this parses it; those are `tools/blob-check.mts`, against a real one.
 */

interface Call {
  readonly method: string
  readonly url: string
}

const filer = (
  handler: (url: URL, init: RequestInit | undefined) => Response,
): { fetch: typeof fetch; calls: Call[] } => {
  const calls: Call[] = []
  const stub = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    calls.push({ method: init?.method ?? 'GET', url: url.toString() })
    return handler(url, init)
  }) as unknown as typeof fetch
  return { fetch: stub, calls }
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('seaweedBlobStorage', () => {
  it('puts a chunk at the key, as a raw body', async () => {
    let seen: { body?: unknown } = {}
    const { fetch: stub, calls } = filer((_url, init) => {
      seen = { body: init?.body }
      return new Response(null, { status: 201 })
    })
    const blobs = seaweedBlobStorage('http://filer:8888/loom', { fetch: stub })
    await blobs.put('transcripts/run-1/000001.jsonl', '{"a":1}\n')
    expect(calls[0]).toEqual({
      method: 'PUT',
      url: 'http://filer:8888/loom/transcripts/run-1/000001.jsonl',
    })
    expect(seen.body).toBe('{"a":1}\n')
  })

  it('reads a chunk back', async () => {
    const { fetch: stub } = filer(() => new Response('{"a":1}\n', { status: 200 }))
    const blobs = seaweedBlobStorage('http://filer:8888/loom', { fetch: stub })
    expect(await blobs.get('transcripts/run-1/000001.jsonl')).toBe('{"a":1}\n')
  })

  /**
   * The ordinary case, not an error: a reader asks for a run's transcript before the Runner has
   * written any of it. An adapter that threw here would turn an empty transcript into a failed
   * request in the surface that reads it.
   */
  it('answers null for a key that is not there', async () => {
    const { fetch: stub } = filer(() => new Response(null, { status: 404 }))
    const blobs = seaweedBlobStorage('http://filer:8888/loom', { fetch: stub })
    expect(await blobs.get('transcripts/nothing/000001.jsonl')).toBeNull()
  })

  it('refuses to be quiet about a failure that is not a 404', async () => {
    const { fetch: stub } = filer(() => new Response(null, { status: 500, statusText: 'boom' }))
    const blobs = seaweedBlobStorage('http://filer:8888/loom', { fetch: stub })
    await expect(blobs.get('transcripts/run-1/000001.jsonl')).rejects.toThrow('500')
  })

  it('lists a prefix in lexicographic order, whatever order the filer answered in', async () => {
    const { fetch: stub, calls } = filer(() =>
      json({ Entries: [{ Name: '000003.jsonl' }, { Name: '000001.jsonl' }, { Name: '000002.jsonl' }] }),
    )
    const blobs = seaweedBlobStorage('http://filer:8888/loom', { fetch: stub })
    expect(await blobs.list('transcripts/run-1')).toEqual([
      'transcripts/run-1/000001.jsonl',
      'transcripts/run-1/000002.jsonl',
      'transcripts/run-1/000003.jsonl',
    ])
    // Asked for as a directory, with the JSON listing rather than the filer's HTML page.
    expect(calls[0]?.url).toContain('/loom/transcripts/run-1/?limit=')
  })

  /**
   * A run that chunked for an hour has more chunks than any page bound anybody would pick, and a
   * silently truncated list is a silently truncated transcript.
   */
  it('pages to the end of a prefix', async () => {
    const page = 1000
    const first = Array.from({ length: page }, (_unused, at) => ({
      Name: String(at).padStart(6, '0'),
    }))
    let served = 0
    const { fetch: stub, calls } = filer(() => {
      served += 1
      return served === 1 ? json({ Entries: first }) : json({ Entries: [{ Name: '999999' }] })
    })
    const blobs = seaweedBlobStorage('http://filer:8888/loom', { fetch: stub })
    const keys = await blobs.list('transcripts/run-1')
    expect(keys).toHaveLength(page + 1)
    expect(calls[1]?.url).toContain('lastFileName=000999')
  })

  it('reads an empty prefix as no keys, not as an error', async () => {
    const { fetch: stub } = filer(() => new Response(null, { status: 404 }))
    const blobs = seaweedBlobStorage('http://filer:8888/loom', { fetch: stub })
    expect(await blobs.list('transcripts/run-1')).toEqual([])
  })

  it('deletes a prefix recursively, and tolerates one that was never there', async () => {
    const { fetch: stub, calls } = filer(() => new Response(null, { status: 204 }))
    const blobs = seaweedBlobStorage('http://filer:8888/loom', { fetch: stub })
    await blobs.deletePrefix('transcripts/run-1')
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.url).toContain('recursive=true')

    const gone = filer(() => new Response(null, { status: 404 }))
    await expect(
      seaweedBlobStorage('http://filer:8888/loom', { fetch: gone.fetch }).deletePrefix('nope'),
    ).resolves.toBeUndefined()
  })

  /**
   * The check the port's own comment says belongs in the filesystem adapter — kept here because
   * URL resolution normalizes `..` exactly as a path does, so on a shared filer an escaping key
   * lands in another deployment's tree rather than merely looking odd.
   */
  it('refuses a key that would climb out of the prefix', async () => {
    const { fetch: stub, calls } = filer(() => new Response(null, { status: 200 }))
    const blobs = seaweedBlobStorage('http://filer:8888/loom', { fetch: stub })
    await expect(blobs.get('transcripts/../../etc/passwd')).rejects.toThrow('escapes')
    expect(calls).toEqual([])
  })
})
