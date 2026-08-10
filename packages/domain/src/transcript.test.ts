import { describe, expect, it } from 'vitest'
import { asAgentRunId } from './ids.js'
import {
 prepareTranscriptLine,
 redactTranscriptLine,
 transcriptChunkKey,
 transcriptPrefix,
 TRANSCRIPT_MAX_LINE_BYTES,
} from './transcript.js'

/**
 * The event-tiering design says the raw tier is "redacted at write". The raw tier
 * is the one artifact deliberately not summarized, so it is precisely where a
 * leaked credential would sit verbatim and indefinitely.
 *
 * The second half of these tests matters as much as the first: a redactor that
 * eats ordinary content destroys the evidence it exists to protect.
 */

describe('redactTranscriptLine', => {
 it('redacts the credential this platform actually handles', => {
 const line = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-AbCdEf0123456789xyz' } })
 const out = redactTranscriptLine(line)
 expect(out).not.toContain('sk-ant-api03-AbCdEf0123456789xyz')
 expect(out).toContain('<redacted>')
 })

 it('redacts a bearer token but keeps the header it was in', => {
 const out = redactTranscriptLine('"authorization": "Bearer abc123def456ghi789"')
 expect(out).not.toContain('abc123def456ghi789')
 // The shape of the record survives — a reader can still see that a request
 // carried authorization, which is often the fact they need.
 expect(out.toLowerCase).toContain('authorization')
 expect(out.toLowerCase).toContain('bearer')
 })

 /**
 * The per-run egress lease is opaque random text with no distinguishing
 * shape. The only thing marking it as a secret is the field it sits under, which
 * is why field-name matching exists alongside shape matching.
 */
 it('redacts a secret whose shape is unremarkable, by the field it sits under', => {
 const out = redactTranscriptLine('{"access_token":"9f2c4a1e8b","runId":"abc"}')
 expect(out).not.toContain('9f2c4a1e8b')
 //...without touching the neighbouring field.
 expect(out).toContain('"runId":"abc"')
 })

 it('redacts env-assignment syntax as well as JSON', => {
 const out = redactTranscriptLine('CLIENT_SECRET=hunter2andthensome')
 expect(out).not.toContain('hunter2andthensome')
 })

 it('redacts common third-party token shapes', => {
 const cases = [
 'ghp_abcdefghijklmnopqrstuvwxyz012345',
 'AKIAIOSFODNN7EXAMPLE',
 'xoxb-1234567890-abcdefghij',
 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
 ]
 for (const secret of cases) {
 expect(redactTranscriptLine(`value: ${secret}`)).not.toContain(secret)
 }
 })

 it('redacts a PEM private key block', => {
 const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END RSA PRIVATE KEY-----'
 const out = redactTranscriptLine(pem)
 expect(out).not.toContain('MIIEowIBAAKCAQ')
 })

 /**
 * The counterweight. "Anything long and random" would match base64 images, hashes,
 * minified bundles and file content — and a transcript with those gone is not
 * worth keeping.
 */
 it('leaves ordinary content alone', => {
 const untouched = [
 '{"kind":"tool_result","summary":"3 files changed, 42 insertions(+)"}',
 'const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"',
 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
 'Reading /work/src/index.ts (2481 bytes)',
 'The password field should be validated before submit',
 ]
 for (const line of untouched) {
 expect(redactTranscriptLine(line)).toBe(line)
 }
 })

 it('is idempotent — redacting twice changes nothing further', => {
 const line = '{"api_key":"sk-ant-api03-AbCdEf0123456789xyz"}'
 const once = redactTranscriptLine(line)
 expect(redactTranscriptLine(once)).toBe(once)
 })
})

describe('prepareTranscriptLine', => {
 it('marks truncation rather than silently shortening', => {
 const out = prepareTranscriptLine('x'.repeat(TRANSCRIPT_MAX_LINE_BYTES + 5_000))
 expect(out).toContain('[truncated by Loom')
 expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(TRANSCRIPT_MAX_LINE_BYTES + 200)
 })

 it('leaves a normal line exactly as redaction produced it', => {
 expect(prepareTranscriptLine('{"kind":"assistant_text"}')).toBe('{"kind":"assistant_text"}')
 })

 it('redacts before truncating, so a secret past the cut is still removed', => {
 const line = `${'x'.repeat(TRANSCRIPT_MAX_LINE_BYTES)}sk-ant-api03-SecretPastTheCut123`
 expect(prepareTranscriptLine(line)).not.toContain('sk-ant-api03-SecretPastTheCut123')
 })
})

describe('transcript keys', => {
 /** Object stores sort by key; a transcript read back out of order is not a transcript. */
 it('pads the index so lexicographic order is chronological', => {
 const runId = asAgentRunId('run-1')
 const keys = [transcriptChunkKey(runId, 9), transcriptChunkKey(runId, 10), transcriptChunkKey(runId, 100)]
 expect([...keys].sort).toEqual(keys)
 })

 it('puts every chunk of a run under one deletable prefix', => {
 const runId = asAgentRunId('run-1')
 expect(transcriptChunkKey(runId, 3).startsWith(transcriptPrefix(runId))).toBe(true)
 })
})
