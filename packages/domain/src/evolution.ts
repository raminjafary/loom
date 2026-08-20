import { parsePersonaMarkdown } from './persona-markdown.js'
import { parsedPromptBody } from './self-edit.js'
import type { AgentPersonaId, AgentRunId, PersonaRevisionId, PersonaVariantSetId } from './ids.js'

/**
 * How a persona got to be what it is — the walk from its first document to its current one,
 * with what changed at each step and what, if anything, measured it.
 *
 * The platform has recorded every part of this since tier 1 shipped and nothing has ever read
 * it end to end. A revision says what a persona used to say; a trial says what the runs on
 * that edit came to; a search says which candidates were dealt arms, which the screen refused
 * before they cost a run, and which one a human promoted. Separately each is a row. Together
 * they are the answer to "how has this agent evolved", which is a question an operator asks
 * about an agent that has been rewriting itself for a month and which nothing here could
 * answer.
 *
 * ## Three things this module is careful about
 *
 * **1. A change is classified by *component*, not summarized.** Every revision stores the
 * whole document that was replaced, so what actually changed is derivable: parse the two
 * documents and compare the fields. That is a fact rather than a description, and it is the
 * difference between a timeline a human can scan and a list of dates. The classification is
 * also the machine substrate the instruction-level attribution hypothesis needs — clause
 * presence across winning lineages is a reading of this same walk.
 *
 * **2. It says when something was captured and never measured.** Tier 2 writes a tool-list
 * change into the history and nothing ever puts it on trial: the measurement is a prompt
 * trial over a prompt body, and a tool list is not one. That is a real gap in the loop and it
 * is invisible in every existing surface, so the timeline states it per entry rather than
 * leaving a reader to notice an absence.
 *
 * **3. Nothing here scores anything.** A timeline that ranked revisions would be a second
 * fitness beside the one `summarizeVariantSearch` owns, and two panels reading the same
 * evidence and reporting different verdicts is a worse defect than a wrong threshold. What
 * this produces is the *walk* — the counts as they were recorded, and the sentence each
 * decision was recorded with.
 */

/**
 * Which part of a persona document a revision changed.
 *
 * A closed set, in the order a reader cares about: the body is what a self-edit is normally
 * about, the tool list is the tier that is captured and never measured, and the rest are
 * fields only a human is supposed to be able to move. `envelope` being on this list is the
 * point of having the list at all — a revision that moved a persona's own ceiling is the one
 * event in this history that should never occur, and a timeline that could not name it would
 * be the wrong instrument to look for it with.
 */
export type RevisionComponent =
  | 'body'
  | 'tools'
  | 'model'
  | 'envelope'
  | 'approval-mode'
  | 'budget'
  | 'delegates'
  | 'name'

export const REVISION_COMPONENTS: readonly RevisionComponent[] = [
  'body',
  'tools',
  'model',
  'envelope',
  'approval-mode',
  'budget',
  'delegates',
  'name',
]

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index])

/**
 * What changed between two versions of a persona document.
 *
 * Both sides are parsed rather than diffed as text, and that is the whole reliability of it: a
 * text diff of two markdown documents reports whitespace and re-wrapping as change, and this
 * has to be able to say "the tool list moved" without saying it about a reflowed paragraph.
 *
 * A document that no longer parses yields an empty list rather than throwing. One unreadable
 * row out of twenty is not a reason to refuse a persona its whole history — the same call the
 * proposer's buffer makes — and the entry still renders with its date, its author and its
 * rationale, which is most of what a reader came for.
 */
export const classifyRevisionChange = (
  before: string,
  after: string,
): RevisionComponent[] => {
  let older: ReturnType<typeof parsePersonaMarkdown>
  let newer: ReturnType<typeof parsePersonaMarkdown>
  try {
    older = parsePersonaMarkdown(before)
    newer = parsePersonaMarkdown(after)
  } catch {
    return []
  }

  const changed: RevisionComponent[] = []
  if ((parsedPromptBody(before) ?? '') !== (parsedPromptBody(after) ?? '')) changed.push('body')
  if (!sameList(older.tools, newer.tools)) changed.push('tools')
  if (older.model !== newer.model) changed.push('model')
  if (JSON.stringify(older.envelope) !== JSON.stringify(newer.envelope)) changed.push('envelope')
  if (older.harnessApprovalMode !== newer.harnessApprovalMode) changed.push('approval-mode')
  if (older.harnessBudgetCapUsd !== newer.harnessBudgetCapUsd) changed.push('budget')
  if (!sameList(older.harnessDelegates, newer.harnessDelegates)) changed.push('delegates')
  if (older.name !== newer.name) changed.push('name')
  return changed
}

/** What the runs on one arm of a measurement came to. The tally as recorded, not a score. */
export interface EvolutionArm {
  readonly label: string
  readonly decided: number
  readonly kept: number
}

/** One edit of the persona document, and whatever measured it. */
export interface RevisionEntry {
  readonly kind: 'revision'
  readonly at: Date
  readonly revisionId: PersonaRevisionId
  /** Who replaced it: a human, one of this persona's own runs, or the platform. */
  readonly authorKind: 'human' | 'agent_run' | 'platform'
  readonly authorRunId: AgentRunId | null
  readonly rationale: string
  /** What moved between the replaced document and the one that replaced it. */
  readonly components: readonly RevisionComponent[]
  /**
   * The trial's arms, or empty when nothing measured this edit.
   *
   * Empty is the interesting case rather than a missing value: every tier-2 edit is empty,
   * and so is every human edit — a human's edit is a decision rather than a hypothesis.
   */
  readonly arms: readonly EvolutionArm[]
  /** Whether a human has settled the trial on this edit. Null when there was no trial. */
  readonly trialDecidedAt: Date | null
}

/** One search over candidate prompts, from what was proposed to what a human did about it. */
export interface SearchEntry {
  readonly kind: 'search'
  readonly at: Date
  readonly setId: PersonaVariantSetId
  readonly status: 'open' | 'settled'
  /** The session that wrote the candidates — a proposer, or the run being edited. */
  readonly proposedByRunId: AgentRunId | null
  readonly candidates: readonly {
    readonly variantId: string
    readonly rationale: string
    /** `refused` is the screen's decision before any live run was dealt to it. */
    readonly outcome: 'refused' | 'measured' | 'promoted' | 'not-kept'
    /** The screen's own sentence, where it refused. */
    readonly reason: string | null
    readonly decided: number
    readonly kept: number
  }[]
  /** The verifier's pick, recorded beside the measurement and counting for nothing. */
  readonly verifierPickedVariantId: string | null
  readonly settledAt: Date | null
}

export type EvolutionEntry = RevisionEntry | SearchEntry

export interface PersonaLineage {
  readonly personaId: AgentPersonaId
  readonly personaName: string
  /** Newest first — the reading order of every other history surface in this platform. */
  readonly entries: readonly EvolutionEntry[]
  /**
   * How many edits are on record that nothing ever measured, and what that is out of.
   *
   * The headline of the whole panel, because it is the thing this walk makes visible and
   * nothing else does: an agent that has rewritten itself eleven times with two measurements
   * behind it is a different situation from one with eleven, and both look identical from a
   * revision list.
   */
  readonly measured: number
  readonly unmeasured: number
}

/**
 * Assembles the walk.
 *
 * Pure, and it takes the successor of each revision rather than computing it, because the
 * successor of the newest revision is the **live document** — a fact that lives on the persona
 * row and not in the history. Tier 1's storage rule is that the history holds what was
 * *replaced*, so the live row plus the history is every version exactly once, and a walker
 * that forgot the live row would silently classify the newest edit against the wrong document.
 */
export const buildLineage = (input: {
  readonly personaId: AgentPersonaId
  readonly personaName: string
  /** The document in use, which is the successor of the newest revision. */
  readonly liveMarkdown: string
  /** Newest first, as storage returns them. */
  readonly revisions: readonly {
    readonly id: PersonaRevisionId
    readonly markdownSource: string
    readonly replacedByKind: 'human' | 'agent_run' | 'platform'
    readonly replacedByRunId: AgentRunId | null
    readonly rationale: string
    readonly createdAt: Date
    readonly trialDecidedAt: Date | null
    readonly arms: readonly EvolutionArm[]
  }[]
  readonly searches: readonly Omit<SearchEntry, 'kind'>[]
}): PersonaLineage => {
  const revisionEntries: RevisionEntry[] = input.revisions.map((revision, index) => ({
    kind: 'revision' as const,
    at: revision.createdAt,
    revisionId: revision.id,
    authorKind: revision.replacedByKind,
    authorRunId: revision.replacedByRunId,
    rationale: revision.rationale,
    /**
     * Against its successor: the next-newer revision, or the live document for the newest.
     * The list is newest first, so the successor is at `index - 1`.
     */
    components: classifyRevisionChange(
      revision.markdownSource,
      index === 0 ? input.liveMarkdown : (input.revisions[index - 1]?.markdownSource ?? ''),
    ),
    arms: revision.arms,
    trialDecidedAt: revision.trialDecidedAt,
  }))

  const searchEntries: SearchEntry[] = input.searches.map((search) => ({
    kind: 'search' as const,
    ...search,
  }))

  const entries = [...revisionEntries, ...searchEntries].sort(
    (a, b) => b.at.getTime() - a.at.getTime(),
  )

  /**
   * An edit counts as measured when something was actually dealt to it — arms with decided
   * runs — rather than when a trial row exists. A trial nobody ever dealt a run to says the
   * same thing about the edit as no trial at all, and counting it would make the headline
   * figure flattering in precisely the case it exists to expose.
   */
  const measured = revisionEntries.filter((entry) =>
    entry.arms.some((arm) => arm.decided > 0),
  ).length

  return {
    personaId: input.personaId,
    personaName: input.personaName,
    entries,
    measured,
    unmeasured: revisionEntries.length - measured,
  }
}

const componentPhrase = (components: readonly RevisionComponent[]): string => {
  if (components.length === 0) return 'nothing this walk could identify'
  const names: Record<RevisionComponent, string> = {
    body: 'the prompt body',
    tools: 'the tool list',
    model: 'the model',
    envelope: 'the envelope',
    'approval-mode': 'the approval mode',
    budget: 'the budget cap',
    delegates: 'what it may hand down',
    name: 'the name',
  }
  const parts = components.map((component) => names[component])
  return parts.length === 1
    ? (parts[0] as string)
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * One entry, in a sentence.
 *
 * Written here rather than in the panel for the reason every other rendered sentence in this
 * platform is: the honest phrasing is the feature. "Captured, and nothing measured it" is the
 * line that makes the gap visible, and a client free to write its own would be free to write
 * "recorded" instead.
 */
export const describeEvolutionEntry = (entry: EvolutionEntry): string => {
  if (entry.kind === 'search') {
    const refused = entry.candidates.filter((candidate) => candidate.outcome === 'refused').length
    const promoted = entry.candidates.find((candidate) => candidate.outcome === 'promoted')
    const head =
      entry.status === 'open'
        ? `A search over ${entry.candidates.length} candidates is running.`
        : promoted
          ? `A search over ${entry.candidates.length} candidates ended with one promoted.`
          : `A search over ${entry.candidates.length} candidates ended with none kept.`
    const screened =
      refused === 0
        ? ''
        : ` The held-out screen refused ${refused} of them an arm, so no live run was spent on ${refused === 1 ? 'it' : 'them'}.`
    const verifier =
      entry.verifierPickedVariantId === null
        ? ''
        : ' A surrogate verifier gave a second opinion, recorded beside the measurement and counted in nothing.'
    return `${head}${screened}${verifier}`
  }

  const author =
    entry.authorKind === 'agent_run'
      ? 'A run of this persona rewrote'
      : entry.authorKind === 'human'
        ? 'A person changed'
        : 'The platform changed'
  const dealt = entry.arms.reduce((sum, arm) => sum + arm.decided, 0)
  const measured =
    dealt === 0
      ? entry.authorKind === 'human'
        ? ' Nothing measured it, which is what a human edit is: a decision rather than a hypothesis.'
        : ' **Captured, and nothing measured it** — the trial measures a prompt body, so an edit that changed anything else is on record and untested.'
      : ` Measured over ${dealt} decided ${dealt === 1 ? 'run' : 'runs'}: ` +
        `${entry.arms.map((arm) => `${arm.label} kept ${arm.kept} of ${arm.decided}`).join(', ')}.` +
        (entry.trialDecidedAt === null ? ' A human has not settled it yet.' : '')
  return `${author} ${componentPhrase(entry.components)}.${measured}`
}
