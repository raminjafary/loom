/**
 * A persona, in a form that can leave the workspace it was written in.
 *
 * Two workspaces cannot see each other's rows, and Phase 4's multi-org is where a registry
 * would live. What is missing before then is smaller and is the thing an operator actually
 * asks for: a way to take a persona that works and put it in another workspace — the one they
 * run on another host, a colleague's, or a fresh one after a reset.
 *
 * ## The document is the unit
 *
 * A persona already *is* a markdown document — that is what `persona_revision` snapshots, what
 * a human edits and what `parsePersonaMarkdown` is the authority on. So a bundle carries the
 * document and nothing else that describes the persona. The alternative, a row export, would
 * carry ids, a workspace, and thirteen columns that are all derived from the document by the
 * one parser that gets to decide what it means.
 *
 * ## What deliberately does not travel, and why each would be a lie
 *
 * - **Expertise.** Maps and lessons are `(persona, subject)` claims about *one repository*,
 *   ranked by what became of the runs that read them. Carrying them into a workspace whose
 *   repositories the persona has never seen would be importing conclusions about code that is
 *   not there, and dressing them as things this persona knows.
 * - **Capabilities.** MCP servers and skills are workspace-owned rows an operator attached
 *   deliberately; that is the whole security story of the registry. An adopted persona arrives
 *   with none attached, which is *narrower* than where it came from — the safe direction.
 * - **History.** Variants, screens, revisions and the runs behind them are the evidence for a
 *   promotion in that workspace. A lineage that arrived by import would make a search look
 *   settled by work nobody there has done.
 *
 * ## What the digest is for, stated so it is not mistaken for security
 *
 * Nothing signs a bundle. The digest catches the failure that actually happens when a document
 * moves between machines by hand — a truncated paste, a mangled newline, an editor that helped
 * — and it cannot catch an edit, because whoever edits the document can recompute it. Signed
 * identity is Phase 4's, and claiming it here would be worse than not having it.
 */

/** The bundle's shape. A version, so a later format can be refused by name rather than crash. */
export const PERSONA_BUNDLE_VERSION = 1

export interface PersonaBundle {
  readonly loomPersonaBundle: number
  /**
   * What the exporting workspace said about itself — a **claim**, not a fact the importer can
   * check. Recorded because "where did this come from" is the first question a reader has, and
   * labelled as a claim everywhere it is stored.
   */
  readonly origin: {
    readonly workspace: string
    readonly personaName: string
    readonly exportedAt: string
  }
  /** The persona document, verbatim. */
  readonly document: string
  /** `sha256:…` over `document`, for corruption in transit. See the header on what it is not. */
  readonly digest: string
}

export const serializePersonaBundle = (bundle: PersonaBundle): string =>
  `${JSON.stringify(bundle, null, 2)}\n`

export type PersonaBundleVerdict =
  | { readonly ok: true; readonly bundle: PersonaBundle }
  | { readonly ok: false; readonly reason: string }

/**
 * Reads a bundle, refusing anything it cannot fully account for.
 *
 * Every refusal names what was wrong with the text rather than saying it was invalid: the
 * person holding it is an operator who pasted something, and "the digest does not match the
 * document — it may have been truncated" tells them what to do next, where "malformed bundle"
 * sends them to a support channel.
 */
export const parsePersonaBundle = (
  raw: string,
  digestOf: (document: string) => string,
): PersonaBundleVerdict => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      reason: 'That is not a persona bundle: it is not JSON at all. Paste the whole file, including the outer braces.',
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'A persona bundle is a JSON object, and that is not one.' }
  }
  const candidate = parsed as Partial<PersonaBundle>
  if (typeof candidate.loomPersonaBundle !== 'number') {
    return {
      ok: false,
      reason:
        'That JSON is not a persona bundle — it carries no `loomPersonaBundle` version. A ' +
        'persona document on its own is not a bundle; export it from the workspace it lives in.',
    }
  }
  if (candidate.loomPersonaBundle > PERSONA_BUNDLE_VERSION) {
    return {
      ok: false,
      reason:
        `This bundle is version ${candidate.loomPersonaBundle} and this deployment reads up to ` +
        `${PERSONA_BUNDLE_VERSION}. Refused rather than read as far as it goes: a field this ` +
        'version does not know about could be a ceiling it would silently drop.',
    }
  }
  if (typeof candidate.document !== 'string' || candidate.document.trim() === '') {
    return { ok: false, reason: 'The bundle carries no persona document.' }
  }
  if (typeof candidate.digest !== 'string' || candidate.digest === '') {
    return { ok: false, reason: 'The bundle carries no digest, so a truncated document could not be told from a whole one.' }
  }
  const recomputed = digestOf(candidate.document)
  if (recomputed !== candidate.digest) {
    return {
      ok: false,
      reason:
        'The digest does not match the document, which usually means the text was truncated or ' +
        'reflowed on its way here. Re-export it and copy the whole file.',
    }
  }
  const origin = candidate.origin
  return {
    ok: true,
    bundle: {
      loomPersonaBundle: candidate.loomPersonaBundle,
      document: candidate.document,
      digest: candidate.digest,
      origin: {
        workspace: typeof origin?.workspace === 'string' ? origin.workspace : 'unknown',
        personaName: typeof origin?.personaName === 'string' ? origin.personaName : 'unknown',
        exportedAt: typeof origin?.exportedAt === 'string' ? origin.exportedAt : '',
      },
    },
  }
}

/**
 * How an adopted persona's provenance reads, in one line, wherever a reader meets it.
 *
 * A sentence rather than fields on a card, and it says *claimed* out loud. The importing
 * deployment has no way to verify the origin — only the digest, and only against corruption —
 * so a surface that rendered it as a fact would be asserting something the platform does not
 * know.
 */
export const describePersonaOrigin = (bundle: PersonaBundle): string =>
  `Adopted from "${bundle.origin.personaName}", claimed to come from workspace ` +
  `"${bundle.origin.workspace}"${bundle.origin.exportedAt === '' ? '' : ` on ${bundle.origin.exportedAt}`}. ` +
  'Nothing signs a bundle, so the origin is what it says about itself; the digest only rules ' +
  'out a document that changed in transit.'
