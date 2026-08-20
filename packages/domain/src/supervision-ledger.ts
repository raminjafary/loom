/**
 * How much human decision a workspace is spending, as a countable stream.
 *
 * The organism's instrument panel, and the cheapest thing in the research program to build:
 * every act is already an audit row. What it exists to measure is the hypothesis that there
 * is a **minimum rate of human decision below which an evolving population drifts** — and
 * that the knee is observable. That curve needs a denominator long before it needs a
 * threshold, which is why this lands early and stays: the numbers are only interesting as a
 * series, and a series cannot be backfilled.
 *
 * ## What counts as supervision, and what does not
 *
 * Only acts by **humans**. A verdict the platform derived, a screen it decided, an
 * escalation it started — none of those are supervision, and counting them would make a
 * workspace look more closely watched the more automatic it became. That inversion is the
 * thing this instrument exists to catch, so it must not be built into the instrument.
 *
 * Five kinds, in rough order of how much attention one act represents:
 *
 * - **approval** — an in-flight run asked and a person answered. The most interruptive act
 *   there is: somebody was waiting.
 * - **disposition** — a person ruled on a finished branch. The fitness signal itself, and
 *   the highest-volume kind.
 * - **promotion** — a person made a candidate or a revision permanent. Rare and heavy.
 * - **veto** — a person took something back: reverted a revision, discarded a search, reset
 *   a persona. Rarer, heavier, and the one whose *absence* is most easily mistaken for
 *   agreement.
 * - **envelope** — a person changed the ceiling on what an agent may make of itself. The
 *   germline act; nothing in the loop can do it.
 *
 * A workspace's *settings* — routing on, plan review off, a repository's checks — are
 * deliberately **not** counted. They are supervision of the platform rather than of an
 * agent's work, they happen once, and mixing a one-off configuration change into a rate
 * would make the denominator jump for reasons that have nothing to do with attention paid.
 *
 * ## Not a score, and not a target
 *
 * There is no "enough". The number that matters is a *trend against work done*: acts per
 * decided run, falling while runs rise, is the drift to watch — and it is equally the shape
 * of a workspace that has learned to trust an agent correctly. The instrument cannot tell
 * those apart, and neither can anything else; what it can do is stop the change from being
 * invisible. A platform that scored operators on this would be optimising the thing it is
 * supposed to be measuring, which is the failure mode the whole program is arranged against.
 */

export type SupervisionKind = 'approval' | 'disposition' | 'promotion' | 'veto' | 'envelope'

export const SUPERVISION_KINDS: readonly SupervisionKind[] = [
  'approval',
  'disposition',
  'promotion',
  'veto',
  'envelope',
]

/**
 * Which audit actions are supervision, and of what kind.
 *
 * An explicit table rather than a prefix rule, because the prefixes lie in both directions:
 * `persona.self_revised` is an *agent* acting on itself and `agent_run.started` is a person
 * starting work rather than judging it, while `merge_queue.enqueued` — a person asking for a
 * branch to land — is a disposition under a name that says nothing about disposing.
 *
 * An action that is not here is not counted. That is the safe direction: a supervision rate
 * that silently absorbs new audit actions would drift upward every time somebody logged
 * something, which is the one way this instrument could lie about its own subject.
 */
export const SUPERVISION_ACTIONS: Readonly<Record<string, SupervisionKind>> = {
  'approval_request.approved': 'approval',
  'approval_request.denied': 'approval',
  'agent_run.kept': 'disposition',
  'agent_run.discarded': 'disposition',
  'agent_run.pushed': 'disposition',
  'merge_queue.enqueued': 'disposition',
  'merge_queue.cancelled': 'disposition',
  'persona.variant_promoted': 'promotion',
  'persona.trial_kept': 'promotion',
  'persona.reverted': 'veto',
  'persona.variants_discarded': 'veto',
  'persona.reset_to_builtin': 'veto',
  'persona.updated': 'envelope',
}

/** One audited act, as the ledger reads it. */
export interface SupervisionAct {
  readonly action: string
  /** `user` is the only kind that counts. See the header. */
  readonly actorKind: string
  readonly at: Date
  /** Which persona the act was about, where the act says. Null when it was not about one. */
  readonly personaName: string | null
  /**
   * Set on a `persona.updated` act: whether the ceiling itself moved.
   *
   * A save that left the envelope alone is still an act, and still `envelope`-kind — the
   * kind names the *authority* exercised, not the size of the diff — but a curve about the
   * germline wants to separate the two, so the flag is carried rather than inferred later.
   */
  readonly envelopeChanged: boolean | null
}

export interface SupervisionLedger {
  /** Counted acts, by kind. Zeroes are present — a kind nobody exercised is a fact. */
  readonly byKind: Readonly<Record<SupervisionKind, number>>
  readonly total: number
  /** Human acts that were audited and are not supervision of an agent's work. */
  readonly uncounted: number
  /** Acts by anything other than a person, which are never supervision. */
  readonly automatic: number
  /**
   * Decided runs over the same window — the denominator.
   *
   * Runs and not tokens or dollars: the question is how much *judgement* was spent per unit
   * of work that needed judging, and a decided run is exactly one such unit.
   */
  readonly decidedRuns: number
  /** How many envelope acts actually moved the ceiling. */
  readonly envelopeChanges: number
}

const EMPTY: Readonly<Record<SupervisionKind, number>> = {
  approval: 0,
  disposition: 0,
  promotion: 0,
  veto: 0,
  envelope: 0,
}

/**
 * Counts a window of audited acts.
 *
 * Takes the rows rather than querying, so the classification is testable without a database
 * and identical for every caller — the same division `screenOutcomeFor` makes with the
 * verification statuses it reads and does not fetch.
 */
export const tallySupervision = (
  acts: readonly SupervisionAct[],
  decidedRuns: number,
): SupervisionLedger => {
  const byKind = { ...EMPTY }
  let uncounted = 0
  let automatic = 0
  let envelopeChanges = 0

  for (const act of acts) {
    if (act.actorKind !== 'user') {
      automatic += 1
      continue
    }
    const kind = SUPERVISION_ACTIONS[act.action]
    if (kind === undefined) {
      uncounted += 1
      continue
    }
    byKind[kind] += 1
    if (act.envelopeChanged === true) envelopeChanges += 1
  }

  const total = SUPERVISION_KINDS.reduce((sum, kind) => sum + byKind[kind], 0)
  return { byKind, total, uncounted, automatic, decidedRuns, envelopeChanges }
}

/**
 * The ledger in a sentence, with the ratio and without a verdict.
 *
 * The ratio leads because the count alone says nothing: forty acts is close attention over a
 * week of ten runs and near-abdication over a week of four hundred. The sentence names what
 * a falling ratio *could* mean in both directions and picks neither, deliberately — see the
 * header. An instrument that told an operator they were supervising too little would be
 * making a claim this platform cannot support, from data it cannot interpret.
 */
export const describeSupervision = (ledger: SupervisionLedger): string => {
  if (ledger.total === 0) {
    return ledger.decidedRuns === 0
      ? 'No decided runs and no human decisions in this window — nothing to measure yet.'
      : `${ledger.decidedRuns} runs reached a decision in this window and no human act was ` +
          'recorded against any of them. Either the definition of done is ruling on ' +
          'everything, or nobody is looking.'
  }
  const perRun =
    ledger.decidedRuns === 0
      ? 'no runs were decided in the same window, so there is no rate yet'
      : `${(ledger.total / ledger.decidedRuns).toFixed(2)} human acts per decided run`
  const spread = SUPERVISION_KINDS.filter((kind) => ledger.byKind[kind] > 0)
    .map((kind) => `${ledger.byKind[kind]} ${kind}`)
    .join(', ')
  const germline =
    ledger.envelopeChanges === 0
      ? ''
      : ` ${ledger.envelopeChanges} of them moved a persona's envelope — the ceiling on what ` +
        'it may make of itself, which nothing but a person can change.'
  return (
    `${ledger.total} human decisions in this window (${spread}), against ` +
    `${ledger.decidedRuns} decided runs: ${perRun}.${germline} Read it as a series rather ` +
    'than a level — a ratio falling while the work rises is either trust being earned or ' +
    'attention being withdrawn, and nothing here can tell you which.'
  )
}
