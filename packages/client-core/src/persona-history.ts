import type { PersonaRevision } from '@loom/api-contract'

/**
 * Reading a persona's prompt history.
 *
 * **The one thing worth understanding before using any of this**: a revision holds the
 * prompt that was *replaced*, not the one that replaced it. The persona row is always the
 * live version, so the history is what was lost — which makes the list total (every
 * version exists exactly once, counting the live row) and makes a revert a restore rather
 * than a computation.
 *
 * The consequence that reads backwards until you have it: **the newest revision names the
 * author of the prompt that is live now.** "An agent rewrote this persona" is not a fact
 * about the newest stored text; it is a fact about who replaced it.
 *
 * Here rather than in a component because it is the same reasoning `thread.ts` and
 * `inbox-board.ts` follow: this is a reading of data, it has edge cases worth naming in
 * tests, and a Vue file is where such a reading goes to be untestable.
 */

/** Who wrote the prompt a persona currently has, or null if nobody has replaced it. */
export const currentPromptAuthor = (
  revisions: PersonaRevision[],
  personaId: string,
): PersonaRevision['replacedByKind'] | null => newestRevision(revisions, personaId)?.replacedByKind ?? null

/**
 * Whether an agent wrote the prompt this persona is running with.
 *
 * The predicate a list of personas badges on — and the reason `persona.revisions` reads
 * the whole workspace in one call rather than one call per row.
 */
export const promptWrittenByAgent = (revisions: PersonaRevision[], personaId: string): boolean =>
  currentPromptAuthor(revisions, personaId) === 'agent_run'

/** This persona's revisions, newest first. Assumes nothing about the input's order. */
export const personaHistory = (
  revisions: PersonaRevision[],
  personaId: string,
): PersonaRevision[] =>
  revisions
    .filter((revision) => revision.personaId === personaId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

const newestRevision = (
  revisions: PersonaRevision[],
  personaId: string,
): PersonaRevision | null => personaHistory(revisions, personaId)[0] ?? null

/**
 * How a revision is introduced in the list, in one line.
 *
 * Phrased around **who replaced it** rather than who wrote it, because that is what the
 * row records and the other reading is the mistake this module's header is about. An
 * agent's edit says so plainly: it is the one thing a reader needs to notice, and a UI
 * that renders it identically to a colleague's edit has hidden the only fact that
 * distinguishes tier 1 from an ordinary save.
 */
export const describeRevision = (revision: PersonaRevision): string => {
  const when = revision.createdAt.slice(0, 16).replace('T', ' ')
  if (revision.replacedByKind === 'agent_run') return `Replaced by an agent, ${when}`
  if (revision.replacedByKind === 'human') return `Replaced by a person, ${when}`
  return `Replaced by the platform, ${when}`
}
