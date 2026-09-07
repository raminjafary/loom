import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  describePersonaOrigin,
  parsePersonaBundle,
  PERSONA_BUNDLE_VERSION,
  serializePersonaBundle,
  type PersonaBundle,
} from './persona-bundle.js'

/**
 * The bundle format, and specifically its refusals.
 *
 * Every one of them is read by an operator who has just pasted something, so what is asserted
 * is not that a refusal happened but that it says what to do next. "Malformed bundle" sends a
 * person to a support channel; "the digest does not match — it may have been truncated" sends
 * them back to copy the whole file.
 */

const digestOf = (document: string): string =>
  `sha256:${createHash('sha256').update(document).digest('hex')}`

const DOCUMENT = ['---', 'name: reviewer', 'description: Checks work it did not do.', '---', '', 'You review.'].join('\n')

const bundle = (over: Partial<PersonaBundle> = {}): PersonaBundle => ({
  loomPersonaBundle: PERSONA_BUNDLE_VERSION,
  origin: { workspace: 'theirs', personaName: 'reviewer', exportedAt: '2026-09-07' },
  document: DOCUMENT,
  digest: digestOf(DOCUMENT),
  ...over,
})

describe('parsePersonaBundle', () => {
  it('reads back what serialize wrote', () => {
    const read = parsePersonaBundle(serializePersonaBundle(bundle()), digestOf)
    expect(read.ok).toBe(true)
    expect(read.ok && read.bundle.document).toBe(DOCUMENT)
  })

  it('tells an operator who pasted the wrong thing what they pasted', () => {
    const read = parsePersonaBundle('---\nname: reviewer\n---\n\nYou review.', digestOf)
    expect(read.ok).toBe(false)
    expect(!read.ok && read.reason).toContain('not JSON')
  })

  /** A persona document on its own is the likeliest wrong paste after that one. */
  it('refuses JSON that is not a bundle, and says a document is not one', () => {
    const read = parsePersonaBundle(JSON.stringify({ document: DOCUMENT }), digestOf)
    expect(read.ok).toBe(false)
    expect(!read.ok && read.reason).toContain('not a persona bundle')
  })

  /**
   * A newer bundle is refused whole rather than read as far as this version understands. The
   * field a future version adds could be a *ceiling* — an envelope key, a tier bound — and
   * dropping one of those silently is how an import becomes a widening.
   */
  it('refuses a version it does not know, rather than reading the parts it recognizes', () => {
    const read = parsePersonaBundle(
      serializePersonaBundle(bundle({ loomPersonaBundle: PERSONA_BUNDLE_VERSION + 1 })),
      digestOf,
    )
    expect(read.ok).toBe(false)
    expect(!read.ok && read.reason).toContain('silently drop')
  })

  it('refuses a document that changed on the way here, naming the likely cause', () => {
    const truncated = serializePersonaBundle(bundle({ document: DOCUMENT.slice(0, 20) }))
    const read = parsePersonaBundle(truncated, digestOf)
    expect(read.ok).toBe(false)
    expect(!read.ok && read.reason).toContain('truncated')
  })

  it('refuses a bundle with no digest at all', () => {
    const read = parsePersonaBundle(serializePersonaBundle(bundle({ digest: '' })), digestOf)
    expect(read.ok).toBe(false)
    expect(!read.ok && read.reason).toContain('truncated document could not be told')
  })

  /** An origin nobody filled in is "unknown", not a crash and not an invented workspace. */
  it('reads a bundle whose origin is missing without inventing one', () => {
    const raw = JSON.stringify({
      loomPersonaBundle: PERSONA_BUNDLE_VERSION,
      document: DOCUMENT,
      digest: digestOf(DOCUMENT),
    })
    const read = parsePersonaBundle(raw, digestOf)
    expect(read.ok && read.bundle.origin.workspace).toBe('unknown')
  })
})

describe('describePersonaOrigin', () => {
  /**
   * The sentence says *claimed* out loud, and says what the digest does not cover. A surface
   * that rendered this as verified provenance would be asserting something the platform has no
   * way to know — nothing signs a bundle.
   */
  it('says the origin is a claim, and that the digest is not a signature', () => {
    const sentence = describePersonaOrigin(bundle())
    expect(sentence).toContain('claimed to come from workspace "theirs"')
    expect(sentence).toContain('Nothing signs a bundle')
  })
})
