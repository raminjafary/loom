/**
 * The transcript tier's object store, against a **real filer** — the half a stub cannot settle.
 *
 *   docker compose --profile blobs up -d seaweedfs
 *   npx tsx tools/blob-check.mts
 *
 * Zero tokens. What it exists for: `seaweed-blob-storage.test.ts` proves this adapter's own
 * decisions against a stub of the filer's protocol, which means it proves them against *this
 * repository's belief about* that protocol. Whether a filer accepts a raw `PUT` body, what its
 * JSON listing actually contains, whether `lastFileName` pages the way the docs read and whether
 * a recursive delete of a prefix that was never written is a 404 or a 204 are all facts about
 * the filer, and every one of them is a place a swap silently loses a transcript.
 *
 * The claim is **differential**, and that is the point of a port: the same sequence of
 * operations is run against the filesystem adapter and the filer, and their answers are compared
 * to each other rather than to what this file expects. A port whose two implementations disagree
 * about "a key that is not there" has one adapter that will surprise the use case above it, and
 * which one is right is a question the port's own comments answer — so an assertion written here
 * would be a third opinion.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobStoragePort } from '../packages/application/src/index.js'
import { fileBlobStorage } from '../apps/server/src/blob-storage.js'
import { seaweedBlobStorage } from '../apps/server/src/seaweed-blob-storage.js'
import { transcriptChunkKey, transcriptPrefix } from '../packages/domain/src/index.js'
import { asAgentRunId } from '../packages/domain/src/index.js'

const FILER = process.env.BLOB_STORAGE_FILER_URL ?? 'http://localhost:8888/loom-blob-check'

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const reachable = await fetch(new URL(FILER).origin, { method: 'GET' })
  .then((response) => response.ok || response.status === 404)
  .catch(() => false)
if (!reachable) {
  console.error(
    `no filer answering at ${new URL(FILER).origin}. Start one with:\n` +
      '  docker compose --profile blobs up -d seaweedfs',
  )
  process.exit(1)
}

/**
 * One run's worth of transcript chunks, keyed by the domain rather than by this script — the
 * padding that makes a lexicographic listing chronological is the property under test, and a key
 * invented here would be a key that happens to sort.
 */
const RUN = asAgentRunId('00000000-0000-4000-8000-00000000b10b')
const OTHER = asAgentRunId('00000000-0000-4000-8000-00000000b10c')
const chunks = [
  { key: transcriptChunkKey(RUN, 11), body: '{"seq":11}\n' },
  { key: transcriptChunkKey(RUN, 2), body: '{"seq":2}\n' },
  { key: transcriptChunkKey(RUN, 1), body: '{"seq":1}\n' },
]

/** Every question the use cases above the port actually ask, in the order they ask them. */
const interrogate = async (blobs: BlobStoragePort) => {
  await blobs.deletePrefix(transcriptPrefix(RUN))
  const beforeAnything = {
    missing: await blobs.get(transcriptChunkKey(RUN, 1)),
    empty: await blobs.list(transcriptPrefix(RUN)),
  }
  for (const chunk of chunks) await blobs.put(chunk.key, chunk.body)
  await blobs.put(transcriptChunkKey(OTHER, 1), '{"other":true}\n')
  const listed = await blobs.list(transcriptPrefix(RUN))
  const read = await Promise.all(listed.map((key) => blobs.get(key)))
  await blobs.deletePrefix(transcriptPrefix(RUN))
  const after = {
    listed: await blobs.list(transcriptPrefix(RUN)),
    neighbour: await blobs.get(transcriptChunkKey(OTHER, 1)),
  }
  await blobs.deletePrefix(transcriptPrefix(OTHER))
  return { beforeAnything, listed, read, after }
}

const dir = await mkdtemp(join(tmpdir(), 'loom-blob-check-'))
const onDisk = await interrogate(fileBlobStorage(dir))
const onFiler = await interrogate(seaweedBlobStorage(FILER))
await rm(dir, { recursive: true, force: true })

console.log(`\n— the filer answers what the filesystem answers (${FILER}) —`)
check(
  'a key nothing was written to is null on both',
  onDisk.beforeAnything.missing === null && onFiler.beforeAnything.missing === null,
  `disk ${String(onDisk.beforeAnything.missing)} · filer ${String(onFiler.beforeAnything.missing)}`,
)
check(
  'a prefix nothing was written under is an empty list on both',
  onDisk.beforeAnything.empty.length === 0 && onFiler.beforeAnything.empty.length === 0,
  `disk ${onDisk.beforeAnything.empty.length} · filer ${onFiler.beforeAnything.empty.length}`,
)
check(
  'the chunks come back in the same order, and it is chronological rather than written order',
  JSON.stringify(onDisk.listed) === JSON.stringify(onFiler.listed) &&
    JSON.stringify(onFiler.read) === JSON.stringify(['{"seq":1}\n', '{"seq":2}\n', '{"seq":11}\n']),
  `filer ${onFiler.listed.join(' ')}`,
)
check(
  'every chunk reads back byte for byte',
  JSON.stringify(onDisk.read) === JSON.stringify(onFiler.read),
  `disk ${JSON.stringify(onDisk.read)} · filer ${JSON.stringify(onFiler.read)}`,
)
check(
  'discarding a run takes its prefix and nothing else',
  onDisk.after.listed.length === 0 &&
    onFiler.after.listed.length === 0 &&
    onDisk.after.neighbour === '{"other":true}\n' &&
    onFiler.after.neighbour === '{"other":true}\n',
  `filer left ${onFiler.after.listed.length} key(s), neighbour ${String(onFiler.after.neighbour).trim()}`,
)

/**
 * Paging, driven past the page bound rather than asserted about. 1,001 chunks is a run that
 * chunked for an hour, and the failure this catches is the quiet one: a listing truncated at the
 * filer's page size reads as a transcript that stops mid-run.
 */
console.log('\n— a listing longer than one page —')
const filer = seaweedBlobStorage(FILER)
const PAGED = asAgentRunId('00000000-0000-4000-8000-00000000b10d')
await filer.deletePrefix(transcriptPrefix(PAGED))
const many = 1_001
await Promise.all(
  Array.from({ length: many }, (_unused, at) =>
    filer.put(transcriptChunkKey(PAGED, at), `{"seq":${at}}\n`),
  ),
)
const pagedKeys = await filer.list(transcriptPrefix(PAGED))
check(
  'every chunk past the page bound is listed',
  pagedKeys.length === many,
  `${pagedKeys.length} of ${many}`,
)
check(
  'and the order still holds across the page seam',
  pagedKeys[0] === transcriptChunkKey(PAGED, 0) &&
    pagedKeys[many - 1] === transcriptChunkKey(PAGED, many - 1),
  `${String(pagedKeys[0])} … ${String(pagedKeys[many - 1])}`,
)
await filer.deletePrefix(transcriptPrefix(PAGED))
check('and the prefix is gone afterwards', (await filer.list(transcriptPrefix(PAGED))).length === 0)

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
