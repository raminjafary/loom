/**
 * The raw transcript tier: "complete provider event
 * stream, verbatim | blob storage, batched writes (chunked JSONL, flushed on
 * size/interval) | policy-bound, **redacted at write**".
 *
 * This module owns the two pure parts of that sentence — what a chunk is called,
 * and what "redacted at write" actually removes. The blob store itself is a port
 * (`BlobStoragePort`), and the tech stack puts a local filesystem behind it until SeaweedFS
 * lands in Phase 3.
 *
 * Why redact at write rather than at read. A raw transcript is the one artifact that is
 * *deliberately* not summarized, so it is where a credential that leaked into a tool result
 * or an error message would sit verbatim and indefinitely. The security model the
 * credential broker's whole design is that a run holds no real credential — redaction here
 * is the backstop for the cases that design does not cover: an agent that read a `.env` in
 * its own clone, a provider error echoing an Authorization header, a developer's key pasted
 * into a task description.
 */

import type { AgentRunId } from './ids.js'

/**
 * Chunk size, in lines. The event-tiering design asks for "batched writes ... flushed on
 * size/interval" — this is the size half; the interval is the Runner's, since
 * only it knows when a run has gone quiet.
 *
 * Small enough that a killed Runner loses little, large enough that a chatty run
 * does not produce a blob per event.
 */
export const TRANSCRIPT_CHUNK_LINES = 200

/**
 * Hard per-line ceiling. One provider event carrying a megabyte of file content
 * is ordinary, and a transcript is not a reason to hold that in memory or ship it
 * twice. Truncation is marked in the line itself rather than silent.
 */
export const TRANSCRIPT_MAX_LINE_BYTES = 64_000

/**
 * `runs/<runId>/raw/<index>.jsonl`, zero-padded so a lexicographic key listing is
 * also chronological — object stores sort by key, and a transcript read back in
 * the wrong order is not a transcript.
 */
export const transcriptChunkKey = (runId: AgentRunId, index: number): string =>
  `runs/${runId}/raw/${String(index).padStart(6, '0')}.jsonl`

/** Everything belonging to one run, for deletion when its branch is discarded. */
export const transcriptPrefix = (runId: AgentRunId): string => `runs/${runId}/raw/`

export const REDACTED = '<redacted>'

/**
 * Patterns that identify a secret by *shape*, independent of surrounding syntax.
 *
 * Deliberately specific rather than "anything long and random": a transcript is
 * evidence, and a redactor that eats file contents and base64 images destroys the
 * thing it is protecting. Each entry here matches something that is a credential
 * and essentially nothing else.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  // Anthropic keys and OAuth tokens — the credential this platform actually handles.
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  // OpenAI-style, in case a persona's task or an MCP server carries one.
  /\bsk-[A-Za-z0-9]{32,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // JWTs: three base64url segments. Matches access tokens without matching prose.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]

/** `Authorization: Bearer <token>`, in a header dump or a provider error echo. */
const BEARER = /\b(authorization"?\s*[:=]\s*"?\s*)(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi

/**
 * Values of fields *named* like a secret, in JSON or env syntax. This is what
 * catches a credential whose shape is unremarkable — the per-run egress lease is
 * opaque random text, indistinguishable from an id by inspection, and the only
 * thing marking it is the key it sits under.
 */
const SECRET_FIELD =
  /("?)\b(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|password|passwd|secret|private[-_]?key|credential|vapid_private_key)\1(\s*[:=]\s*)("([^"\\]|\\.)*"|'[^']*'|[^\s,;}]+)/gi

/** PEM blocks, which carry their own delimiters and are unmistakable. */
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

/**
 * Applied to every transcript line before it leaves the process that produced it.
 *
 * Order matters: field-name matching runs last, so a value already reduced to
 * `<redacted>` by a shape rule is not re-quoted oddly by the field rule.
 *
 * This is a backstop, not a guarantee, and the code should not pretend otherwise. A secret
 * with no recognizable shape, sitting under a field name nobody thought of, survives. That
 * is why the credential broker keeps real credentials out of the sandbox in the first place
 * rather than relying on this.
 */
export const redactTranscriptLine = (line: string): string => {
  let out = line

  out = out.replace(PEM, `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`)
  for (const pattern of SECRET_SHAPES) out = out.replace(pattern, REDACTED)
  out = out.replace(BEARER, (_match, prefix: string, bearer: string) => `${prefix}${bearer}${REDACTED}`)
  out = out.replace(
    SECRET_FIELD,
    (_match, quote: string, field: string, sep: string, value: string) => {
      const quoted = value.startsWith('"') || value.startsWith("'")
      return `${quote}${field}${quote}${sep}${quoted ? `"${REDACTED}"` : REDACTED}`
    },
  )

  return out
}

/**
 * One transcript line: redacted, then bounded.
 *
 * Truncation is reported inline. A silently shortened transcript is worse than an
 * obviously shortened one — the whole reason tier 3 exists is that tiers 1 and 2
 * already dropped things, and a reader has to be able to tell what they are
 * looking at.
 */
export const prepareTranscriptLine = (raw: string): string => {
  const redacted = redactTranscriptLine(raw)
  if (Buffer.byteLength(redacted, 'utf8') <= TRANSCRIPT_MAX_LINE_BYTES) return redacted
  const kept = Buffer.from(redacted, 'utf8').subarray(0, TRANSCRIPT_MAX_LINE_BYTES).toString('utf8')
  return `${kept}…[truncated by Loom at ${TRANSCRIPT_MAX_LINE_BYTES} bytes]`
}
