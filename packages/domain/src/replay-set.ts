/**
 * The held-out screen — what a candidate must survive before it is
 * allowed to cost anything a human waits on.
 *
 * The self-improvement loop is a *selection* rule and says nothing about where a candidate
 * comes from, which is why the loop it describes cannot converge at the sample cost it
 * charges: five decided runs an arm across up to four arms is fifteen to twenty
 * dispositioned runs on one persona, and The open-items list records the consequence — no
 * search has ever reached a verdict from real traffic. The evidence for the fix is SkillOpt
 * (arXiv 2605.23904): a document is edited only when the edit improves a **held-out
 * validation score**, and the transferable part is not the optimizer but that a candidate
 * is screened *before* it is allowed to occupy the one measurement slot a persona has.
 *
 * Loom already owns the material, which is what makes this affordable. Every decided run
 * carries a task, a bound repository, the commit it opened at, and a definition-of-done
 * outcome derived server-side. A set of those is a replay set:
 *
 *     (repository @ commit, task, observed outcome)
 *
 * ## The four decisions the generating side takes, and where each one lives here
 *
 * - **The screen gates entry; it never promotes.** `screenGate` returns `admitted` or
 *   `rejected` and has no third answer. The rule — fitness is run disposition, never a
 *   model's own assessment — is unchanged: a candidate that beats the set has earned an
 *   *arm*, and the arms are still what decide. Anything else would make an offline proxy
 *   the thing that decides, which is the one substitution this section exists to avoid.
 * - **The set is versioned, and the version travels with every score.** A screen whose tasks
 *   changed between two candidates has measured two different things and will report it as a
 *   comparison.
 * - **No silent truncation.** `assembleReplaySet` returns every run it did *not* use and why,
 *   and `describeReplaySet` puts it in a sentence. The habit, for its reason: a bounded
 *   thing that reads as complete is worse than one that reports its bound.
 * - **A candidate the screen kills is archived with the reason**, which is what makes the
 *   archive rule (piece 1) and the proposer (piece 3) useful — a rejected-edit buffer is a
 *   different thing from the revision history, because only one of them ever went live.
 *
 * ## And the two this file adds, because building it forced them
 *
 * - **A tie is admitted — unless the candidate is materially longer.** The arms resolve a tie
 *   *against* the candidate. The screen resolves it *for* the candidate, because its only
 *   authority is to refuse a measurement, and "no worse than the prompt in use" is not a
 *   reason to refuse one. Rejecting ties outright would quietly promote the proxy to the
 *   decider.
 *
 *   The one exception is length, and it is the trial's own rule rather than a new one: every
 *   comparison in this platform breaks a tie on **cost**, and a longer prompt is the single
 *   cost the screen can see without spending anything — it is paid on every future run of
 *   that persona, forever, for a measured gain of nothing. So a candidate that ties on the
 *   set and is more than `COMPACTNESS_MARGIN` longer than the prompt in use is refused an
 *   arm, and one that ties while being shorter is admitted with that said out loud.
 * - **A screen that cannot say anything admits everything.** Below `MIN_REPLAY_ITEMS` there
 *   is no set worth the name, and the honest behaviour is to abstain and let the arms do
 *   what they already did. Failing open is right here specifically *because* the screen has
 *   no positive authority: the thing it falls back to is the real fitness, not nothing.
 * - **No single observed outcome may take more than half the set.** Recency alone has an
 *   inversion in it: a bad week fills the set with failures, the incumbent scores low on
 *   them, and the bar a candidate must clear drops *exactly* when the set has stopped
 *   representing what this persona does well. `STRATUM_CEILING` bounds one outcome's share
 *   and `screenGate` names the mix it decided against, so a low bar is legible rather than
 *   silent. The ceiling relaxes rather than shrinking a set — see `assembleReplaySet`.
 *
 * ## The bias this has, stated rather than discovered later
 *
 * The items are runs the incumbent prompt produced, so the incumbent has in effect been
 * fitted to them. That makes the screen **conservative** — it will admit candidates that
 * deserve rejection more often than it rejects ones that deserve admission — and
 * conservative is the safe direction for a gate whose only power is to refuse. It is also
 * why the screen cannot promote: an overfit proxy that could promote would be the platform
 * grading its own homework at three times the token cost.
 */

/**
 * How many items a set may hold.
 *
 * Every item is one real run per arm, so a full search screens `items × (candidates + 1)`
 * times before it deals a single live run. Eight against four arms is thirty-two screening
 * runs — deliberately in the same order as the fifteen-to-twenty dispositioned runs the
 * screen exists to make affordable, because the trade SkillOpt makes is *machine* time for
 * *calendar* time and not compute for free.
 */
export const MAX_REPLAY_ITEMS = 8

/**
 * And the floor below which the screen abstains.
 *
 * Four is the smallest set on which "worse" can mean more than one unlucky task. portable
 * expertise is already candid that its five decided runs an arm is a compromise against a
 * real power calculation; this is the same compromise and is written down as one rather
 * than defended.
 */
export const MIN_REPLAY_ITEMS = 4

/**
 * How many candidates one item may help gate before it retires.
 *
 * Three, which is `MAX_VARIANTS_PER_SET` — one search's worth. The rule is the classic
 * held-out discipline and the reason is the classic overfitting channel: a rejected
 * candidate's reason is archived, a proposer reads that buffer, and the next candidates are
 * written against the very items that refused the last ones. Nothing about the set is
 * secret after it has gated a search, so a set reused across searches stops being held out
 * and starts being the thing candidates are fitted to. The screen would keep reporting
 * numbers, and they would get better while nothing improved.
 *
 * Retirement is by **rule rather than by accident**. Today's assembly happens to build a
 * fresh version per search, but it draws from the same recent history, so two consecutive
 * searches see nearly the same tasks — a new row over the same items is not a new screen.
 * Counting gates per source run is what makes the refresh real.
 *
 * The consequence is deliberate and worth stating: a persona whose recent history has all
 * been gated gets **no screen** until it does new work, and the arms decide as they did
 * before there was a screen. A screen that recycles its items is worse than no screen,
 * because it reads as evidence.
 */
export const MAX_GATES_PER_ITEM = 3

/**
 * The most items one observed outcome may contribute, before the ceiling relaxes.
 *
 * Half, because half is the weakest bound that still forbids a monoculture: a set may say
 * "mostly failures" — that is information about what this persona has been asked to do
 * lately — and may not *be* only failures while other work was available to include.
 *
 * It is a **ceiling on the share, not a quota**. Nothing here manufactures balance: a
 * history that really is all one outcome yields a set that is all one outcome, because the
 * alternative — shrinking the set to keep it balanced — drops it under `MIN_REPLAY_ITEMS`
 * and abstains the screen altogether. An unbalanced set whose composition the gate states
 * is strictly better than no screen at all.
 */
export const STRATUM_CEILING = Math.ceil(MAX_REPLAY_ITEMS / 2)

/**
 * How much longer a tying candidate may be before the screen refuses it an arm.
 *
 * A tenth, because the rule is about a *materially* longer prompt and not about whitespace:
 * two bodies within a tenth of each other are the same size for every purpose that matters,
 * and a gate that refused a candidate for eleven extra characters would be measuring the
 * author's punctuation.
 */
export const COMPACTNESS_MARGIN = 0.1

/** Why a decided run did not become an item. Every one of these is counted and reported. */
export type ReplayExclusion =
  /** No `baseCommitSha` — the run predates the column, or never got a clone. */
  | 'no-commit'
  /** No task text. A run started from the sidebar picker has none, and a replay needs one. */
  | 'no-task'
  /**
   * The run was itself an arm of a trial or a search, so its outcome is a fact about a prompt
   * this persona may not even have any more. A held-out set assembled from measurements of
   * other prompts is not held out from anything.
   */
  | 'was-an-arm'
  /** Eligible, and over `MAX_REPLAY_ITEMS`. The only exclusion that is a *bound* rather than a gap. */
  | 'over-cap'
  /**
   * This run's task has already gated `MAX_GATES_PER_ITEM` candidates, so it is retired.
   *
   * Not a gap and not a bound: it is the one exclusion that exists to keep the set *held
   * out*. See `MAX_GATES_PER_ITEM`.
   */
  | 'already-screened'
  /**
   * Eligible, recent enough that recency alone would have taken it, and passed over because
   * its observed outcome already held `STRATUM_CEILING` of the set.
   *
   * Kept apart from `over-cap` because the two say different things to a reader: `over-cap`
   * means "older than what we took", and this means "newer than something we took, and left
   * out on purpose". Folding them together would report a bound that was never the reason.
   */
  | 'stratum-full'

/** What a decided run offers a replay set. Shaped as the storage layer can aggregate it. */
export interface DecidedRunRecord {
  readonly runId: string
  readonly repositoryId: string
  readonly baseCommitSha: string | null
  readonly task: string | null
  /** True when this run was on an arm of a prompt trial or a variant search. */
  readonly wasMeasured: boolean
  /** What a human, or the definition of done, said about the branch. */
  readonly outcome: ReplayOutcome
  /**
   * How many candidates this run's task has already helped gate, across every set version
   * it has appeared in.
   *
   * Counted from the screens themselves rather than kept as a counter on the set: a set is
   * one assembly of a history that keeps moving, and the question "has this task already
   * decided about somebody's prompt" is about the task, not about the row it was written
   * into. A derived count also cannot drift out of step with the screens it describes.
   */
  readonly gatedCandidates: number
  /** Ordering key. Newest first is the caller's job; this is only carried through. */
  readonly decidedAt: Date
}

/**
 * The observed outcome, carried onto the item.
 *
 * It is **context and never the score**. A replay cannot reproduce the human who merged, so
 * scoring against a disposition would be scoring against a coin the platform cannot flip
 * again; the screen scores the definition of done, which it *can* run. What the outcome buys
 * is a reader's ability to see what kind of task the set is made of — a set of eight
 * discarded runs is a screen about failure recovery, and that is worth knowing before
 * reading a score off it.
 */
export type ReplayOutcome = 'merged' | 'discarded' | 'failed'

export interface ReplayItem {
  /** The run this item was taken from. Kept so a reader can open the original. */
  readonly sourceRunId: string
  readonly repositoryId: string
  readonly commitSha: string
  readonly task: string
  readonly observedOutcome: ReplayOutcome
}

export interface ReplaySetDraft {
  readonly items: readonly ReplayItem[]
  /** Every run that did not become an item, with why. Never summarised away. */
  readonly excluded: readonly { readonly runId: string; readonly reason: ReplayExclusion }[]
  /** How many of the offered runs were usable at all, before the cap. */
  readonly eligible: number
  /** How many were offered. */
  readonly considered: number
}

const isEligible = (
  record: DecidedRunRecord,
): { ok: true } | { ok: false; reason: ReplayExclusion } => {
  if (record.wasMeasured) return { ok: false, reason: 'was-an-arm' }
  if (record.baseCommitSha === null || record.baseCommitSha.length === 0) {
    return { ok: false, reason: 'no-commit' }
  }
  if (record.task === null || record.task.trim().length === 0) {
    return { ok: false, reason: 'no-task' }
  }
  /**
   * Last, because the gaps above are facts about whether this run can be replayed at all,
   * and this is a fact about whether it should be. A run that is both unusable and retired
   * is reported as unusable — the more basic thing a reader can act on.
   */
  if (record.gatedCandidates >= MAX_GATES_PER_ITEM) {
    return { ok: false, reason: 'already-screened' }
  }
  return { ok: true }
}

/**
 * Builds a held-out set from this persona's decided runs.
 *
 * **Deterministic, and it does not sample.** Randomness would make a set unreproducible
 * from the journal, which is the same objection portable expertise raises against a random
 * trial arm. A tie in `decidedAt` is broken by run id, so two assemblies of the same
 * history produce the same set rather than whatever order the query returned.
 *
 * Selection is recency **under a ceiling on any one observed outcome's share**, in two
 * passes over the same newest-first ordering:
 *
 * 1. Take the newest eligible runs, skipping any whose outcome already holds
 *    `STRATUM_CEILING` items.
 * 2. If slots remain — nothing else was available to fill them — take the skipped runs,
 *    newest first, until the set is full.
 *
 * Pass 2 is why this is a ceiling and not a quota, and it is the load-bearing half. Without
 * it, a persona whose last twenty runs all failed would get a four-item set instead of an
 * eight-item one, and the screen abstains under `MIN_REPLAY_ITEMS` — the ceiling would have
 * disabled the gate in precisely the situation the gate is for. With it, that persona gets
 * a full set of failures and `screenGate` says so in the sentence that decides.
 *
 * Recency stays the default because it keeps the tasks representative of what this persona
 * is currently asked to do; the ceiling only prevents one week's outcome from being the
 * whole measurement.
 */
export const assembleReplaySet = (
  records: readonly DecidedRunRecord[],
): ReplaySetDraft => {
  const excluded: { runId: string; reason: ReplayExclusion }[] = []
  const eligible: DecidedRunRecord[] = []

  for (const record of records) {
    const verdict = isEligible(record)
    if (verdict.ok) eligible.push(record)
    else excluded.push({ runId: record.runId, reason: verdict.reason })
  }

  const ordered = [...eligible].sort((a, b) => {
    const byTime = b.decidedAt.getTime() - a.decidedAt.getTime()
    return byTime !== 0 ? byTime : a.runId.localeCompare(b.runId)
  })

  const held = new Map<ReplayOutcome, number>()
  const taken: DecidedRunRecord[] = []
  const passedOver: DecidedRunRecord[] = []
  for (const record of ordered) {
    if (taken.length >= MAX_REPLAY_ITEMS) break
    if ((held.get(record.outcome) ?? 0) >= STRATUM_CEILING) {
      passedOver.push(record)
      continue
    }
    held.set(record.outcome, (held.get(record.outcome) ?? 0) + 1)
    taken.push(record)
  }
  const relaxed = passedOver.splice(0, Math.max(0, MAX_REPLAY_ITEMS - taken.length))
  taken.push(...relaxed)

  /**
   * Back into the set's own order once selection is done. The items are positioned
   * newest-first because a reader scanning them should see the persona's current work
   * first; the two passes above are about *which* runs, never about their order.
   */
  const selected = taken.sort((a, b) => {
    const byTime = b.decidedAt.getTime() - a.decidedAt.getTime()
    return byTime !== 0 ? byTime : a.runId.localeCompare(b.runId)
  })

  const items = selected.map(
    (record): ReplayItem => ({
      sourceRunId: record.runId,
      repositoryId: record.repositoryId,
      // Non-null by `isEligible`, which is the only path into `ordered`.
      commitSha: record.baseCommitSha as string,
      task: (record.task as string).trim(),
      observedOutcome: record.outcome,
    }),
  )

  /**
   * What recency alone would have taken, so an exclusion can say which of the two bounds
   * actually left a run out — the cap, or the ceiling.
   */
  const byRecency = new Set(ordered.slice(0, MAX_REPLAY_ITEMS).map((record) => record.runId))
  const chosen = new Set(selected.map((record) => record.runId))
  for (const record of ordered) {
    if (chosen.has(record.runId)) continue
    excluded.push({
      runId: record.runId,
      reason: byRecency.has(record.runId) ? 'stratum-full' : 'over-cap',
    })
  }

  return { items, excluded, eligible: eligible.length, considered: records.length }
}

const EXCLUSION_WORDS: Record<ReplayExclusion, string> = {
  'no-commit': 'did not record the commit they opened at',
  'no-task': 'had no task text to replay',
  'was-an-arm': 'were arms of an earlier measurement',
  'over-cap': `were eligible and over the cap of ${MAX_REPLAY_ITEMS}`,
  'already-screened': `had already gated ${MAX_GATES_PER_ITEM} candidates and are retired from the set`,
  'stratum-full': `were recent and eligible, and passed over so no one outcome held more than ${STRATUM_CEILING} of the set`,
}

/**
 * The set's outcome mix, as a fragment: `3 merged, 3 discarded, 2 failed`.
 *
 * One function because two callers must not disagree about it — the sentence stamped on the
 * set at assembly (`describeReplaySet`) and the sentence a gate archives with a rejection
 * (`screenGate`) are read side by side by whoever asks whether a bar was honest.
 *
 * Ordered by count, then by name, so the same mix reads the same way every time.
 */
export const describeOutcomeMix = (outcomes: readonly ReplayOutcome[]): string => {
  const counts = new Map<ReplayOutcome, number>()
  for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([outcome, count]) => `${count} ${outcome}`)
    .join(', ')
}

/**
 * One sentence naming what the set holds and what it left out.
 *
 * Written for the panel and for the archived rejection reason, which is why it names counts
 * rather than gesturing at them: "screened against a held-out set" is a claim a reader cannot
 * check, and "eight items, and 41 decided runs left out — 33 were arms of an earlier
 * measurement" is one they can.
 */
export const describeReplaySet = (draft: ReplaySetDraft): string => {
  const counts = new Map<ReplayExclusion, number>()
  for (const entry of draft.excluded) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1)
  }
  const clauses = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${count} ${EXCLUSION_WORDS[reason]}`)

  const shape = describeOutcomeMix(draft.items.map((item) => item.observedOutcome))

  const head =
    draft.items.length === 0
      ? `No held-out items: ${draft.considered} decided runs were considered and none was usable`
      : `${draft.items.length} held-out ${draft.items.length === 1 ? 'item' : 'items'}` +
        `${shape === '' ? '' : ` (${shape} when they were run)`}, from ${draft.considered} ` +
        'decided runs considered'
  const tail = clauses.length === 0 ? '' : `. Left out: ${clauses.join('; ')}`
  return `${head}${tail}.`
}

/** What running the definition of done against one replayed item said. */
export type ReplayCheckOutcome =
  /** The branch this arm produced passed the repository's definition of done. */
  | 'passed'
  /** It failed. The only outcome that counts against an arm. */
  | 'failed'
  /**
   * Nothing was measured — the screening run errored, the repository has no definition of
   * done, the checks were skipped or refused. Kept distinct from `failed` for the reason:
   * `skipped` and `refused` say something about the setup, not about the branch, and
   * folding them in would make every unconfigured repository look like it produced broken
   * work.
   */
  | 'not-scored'

/**
 * What one finished screening run said about one item.
 *
 * The mapping is the own vocabulary and adds nothing to it: `passed` and `failed` are the
 * definition of done's answers, and every other state is `not-scored`. `skipped` and
 * `refused` say something about the operator's setup rather than about the branch — the *
 * exact reason for keeping them out of `failed` — and `error` says something about the
 * Runner.
 *
 * **A run that committed nothing is `not-scored`, and that is a conservatism worth naming.**
 * A prompt so bad the agent produced no diff arguably deserves to fail its screen, but the
 * platform cannot tell that apart from a repository with no definition of done or a Runner
 * that refused to execute unsandboxed. Scoring it as a failure would let an operator's
 * configuration read as a verdict about a prompt, so the screen abstains — which errs
 * towards admitting a candidate, the direction a gate that can only refuse should err in.
 */
export const screenOutcomeFor = (input: {
  /** The screening run's terminal status. Anything but `completed` scores nothing. */
  readonly runStatus: 'completed' | 'failed' | 'cancelled'
  /** The definition-of-done verdict on the run's branch, or null when there was none. */
  readonly verificationStatus: 'passed' | 'failed' | 'skipped' | 'refused' | 'error' | null
}): { readonly outcome: ReplayCheckOutcome; readonly reason: string | null } => {
  if (input.runStatus !== 'completed') {
    return { outcome: 'not-scored', reason: `the screening run ${input.runStatus}` }
  }
  if (input.verificationStatus === 'passed') return { outcome: 'passed', reason: null }
  if (input.verificationStatus === 'failed') return { outcome: 'failed', reason: null }
  return {
    outcome: 'not-scored',
    reason:
      input.verificationStatus === null
        ? 'no definition of done ran against this branch'
        : `the definition of done was ${input.verificationStatus}`,
  }
}

export interface ScreenScore {
  /** Null is the incumbent — the prompt the persona actually has, which is the control. */
  readonly variantId: string | null
  /** One entry per item attempted, in the set's order. */
  readonly outcomes: readonly ReplayCheckOutcome[]
  /**
   * The models that actually answered this arm's items, as observed on the runs — nulls for
   * items nothing ran, and duplicates welcome; `tallyScreenScore` reduces them.
   *
   * Carried because **a pass rate is evidence about a `(document, model)` pair and not
   * about a document**. Routing makes that concrete: the same prompt body scores differently
   * on Haiku and on Opus, so a score filed without its model turns the whole rejected-edit
   * buffer into a pile of numbers nothing can be compared across.
   */
  readonly models: readonly (string | null)[]
}

export interface ScreenTally {
  readonly variantId: string | null
  readonly scored: number
  readonly passed: number
  readonly failed: number
  readonly notScored: number
  /** Passed over scored. Zero when nothing was scored — see `scored` before reading it. */
  readonly passRate: number
  /**
   * The distinct models observed on this arm, sorted, with unknowns dropped.
   *
   * Empty means nothing is known about what ran — an arm whose runs never started. More
   * than one means this arm's own score mixes models, which `screenGate` refuses to compare.
   */
  readonly models: readonly string[]
}

export const tallyScreenScore = (score: ScreenScore): ScreenTally => {
  const passed = score.outcomes.filter((outcome) => outcome === 'passed').length
  const failed = score.outcomes.filter((outcome) => outcome === 'failed').length
  const notScored = score.outcomes.filter((outcome) => outcome === 'not-scored').length
  const scored = passed + failed
  return {
    variantId: score.variantId,
    scored,
    passed,
    failed,
    notScored,
    passRate: scored === 0 ? 0 : passed / scored,
    models: [
      ...new Set(
        // A non-string is the same fact as a null here: nothing was recorded about what ran.
        score.models.filter((model): model is string => typeof model === 'string' && model !== ''),
      ),
    ].sort(),
  }
}

export type ScreenDecision = 'admitted' | 'rejected'

export interface ScreenGateVerdict {
  readonly decision: ScreenDecision
  /**
   * Why, in a sentence — and this one is load-bearing rather than cosmetic. A rejected
   * candidate is archived with it, and the piece 3 hands that buffer to a proposer:
   * "rejected" is not something to generate from, and "rejected: passed 2 of 6 held-out
   * items where the prompt in use passed 5" is.
   */
  readonly reason: string
}

/**
 * Why these two scores cannot be compared, when they cannot — otherwise null.
 *
 * Two ways they cannot: one arm's own items were answered by more than one model, or the two
 * arms were answered by different ones. Both make the difference in pass rate a difference of
 * model as much as of document, and the screen's authority is to refuse a measurement on
 * evidence about the *document*.
 *
 * Silence is not disagreement. An arm with no known model — rows from before the stamp, an
 * arm whose runs never started — falls through to the ordinary comparison, because inventing
 * a mismatch out of a missing column would abstain the gate on every historical screen.
 */
const crossModelComparison = (
  candidateModels: readonly string[],
  incumbentModels: readonly string[],
): string | null => {
  const spread = (models: readonly string[]) => models.join(' and ')
  if (candidateModels.length > 1) {
    return (
      `Not screened: this candidate's items were answered by ${spread(candidateModels)}, so its ` +
      'pass rate mixes models and is not a score for one prompt. The arms measure it instead.'
    )
  }
  if (incumbentModels.length > 1) {
    return (
      `Not screened: the prompt in use was screened across ${spread(incumbentModels)}, so there ` +
      'is no single-model control to compare against. A candidate is not refused on a baseline ' +
      'that moved underneath it.'
    )
  }
  const [candidateModel] = candidateModels
  const [incumbentModel] = incumbentModels
  if (candidateModel === undefined || incumbentModel === undefined) return null
  if (candidateModel === incumbentModel) return null
  return (
    `Not screened: this candidate ran on ${candidateModel} and the prompt in use on ` +
    `${incumbentModel}. A difference between those two is a difference of model as much as of ` +
    'prompt, and the screen only refuses on evidence about the prompt.'
  )
}

/**
 * Whether a candidate has earned an arm.
 *
 * Compared against the **incumbent screened on the same set**, never against a sibling and
 * never against a fixed threshold. A threshold would be a claim about how hard this
 * workspace's tasks are; the incumbent's score on the same items is the only figure that
 * makes "worse" mean anything.
 *
 * The order of the answers is the design:
 *
 * 1. **Too few items → admitted**, always. A screen with no set has no opinion, and the
 *    thing it defers to is the real fitness.
 * 2. **The incumbent could not be scored → admitted.** Without a control there is no
 *    comparison, and refusing an arm on an unmeasured baseline is exactly the silent
 *    downgrade the roadmap refuses when it derives a verdict server-side.
 * 3. **The candidate could not be scored → admitted.** A screening run that errored says
 *    nothing about the prompt. Rejecting here would let an infrastructure failure kill a
 *    candidate, which is the failure mode where a loop quietly stops proposing anything.
 * 4. **The two arms did not run on the same one model → admitted.** A candidate on Haiku
 *    scoring under an incumbent on Opus has been beaten by the model, and refusing it would
 *    file a fact about a price tier as a fact about a document. Mixed models *within* one
 *    arm are the same defect one level down and abstain the same way. Unknown models do not
 *    trigger it: a set of screens from before the stamp existed is silent about what ran,
 *    and silence is not disagreement.
 * 5. **Strictly worse → rejected.**
 * 6. **Level, and materially longer → rejected.** The cost tiebreak; see the header. Every
 *    other tie is admitted.
 *
 * The set arrives as its **composition** rather than as a count, and both decisions that
 * compare rates name it. A pass rate is only readable against the work it was measured on:
 * "the prompt in use passed 2 of 6" means one thing on a set of merged work and another on a
 * set of six runs a human threw away, and the second is a bar low enough that a candidate
 * clearing it has proved very little. Since the composition and the count now come from one
 * argument, a reason cannot state a mix that disagrees with the set it gated.
 */
export const screenGate = (input: {
  /** Every item's observed outcome, in the set's order. Its length is the item count. */
  readonly composition: readonly ReplayOutcome[]
  readonly candidate: ScreenTally
  readonly incumbent: ScreenTally
  /**
   * The two prompt bodies' lengths, for the cost tiebreak — null when either is unknown.
   *
   * Null skips the tiebreak rather than guessing at it: a candidate whose document could not
   * be read is not a candidate that failed a length comparison, and the gate's whole
   * discipline is that a fact about the platform's own reading never becomes a verdict about
   * a prompt.
   */
  readonly bodyLengths?: { readonly candidate: number; readonly incumbent: number } | null
}): ScreenGateVerdict => {
  const { candidate, incumbent } = input
  const itemCount = input.composition.length
  const asPercent = (rate: number) => `${Math.round(rate * 100)}%`
  const mix = describeOutcomeMix(input.composition)
  const on =
    candidate.models.length === 1 && candidate.models[0] === incumbent.models[0]
      ? ` Both arms ran on ${candidate.models[0]}.`
      : ''
  const wasMadeOf = ` The set was ${mix} when the work was originally run.${on}`

  if (itemCount < MIN_REPLAY_ITEMS) {
    return {
      decision: 'admitted',
      reason:
        `Not screened: this persona has ${itemCount} held-out ${itemCount === 1 ? 'item' : 'items'} ` +
        `and a screen needs ${MIN_REPLAY_ITEMS}. The arms measure it instead, which is what ` +
        'they did before there was a screen.',
    }
  }
  if (incumbent.scored === 0) {
    return {
      decision: 'admitted',
      reason:
        'Not screened: the prompt in use could not be scored on the held-out set, so there is ' +
        'no control to compare against. A candidate is not refused on a baseline nobody measured.',
    }
  }
  if (candidate.scored === 0) {
    return {
      decision: 'admitted',
      reason:
        `Not screened: none of the ${itemCount} held-out items produced a verdict for this ` +
        'candidate. That is a fact about the screening runs, not about the prompt.',
    }
  }
  const cross = crossModelComparison(candidate.models, incumbent.models)
  if (cross !== null) {
    return { decision: 'admitted', reason: cross }
  }
  if (candidate.passRate < incumbent.passRate) {
    return {
      decision: 'rejected',
      reason:
        `Rejected by the held-out screen: it passed ${candidate.passed} of ${candidate.scored} ` +
        `items (${asPercent(candidate.passRate)}) where the prompt in use passed ` +
        `${incumbent.passed} of ${incumbent.scored} (${asPercent(incumbent.passRate)}). It was ` +
        'not given an arm, so no live run was spent on it.' +
        wasMadeOf,
    }
  }
  /**
   * Level on the set, and the only cost this screen can see without spending anything.
   *
   * Checked after the pass-rate comparison and never instead of it: a candidate that scores
   * *better* is admitted however long it is, because the screen has no authority to trade a
   * measured improvement against a token count — that trade is the arms' (they compare cost
   * against real dispositions) and ultimately a human's.
   */
  const lengths = input.bodyLengths ?? null
  const level = candidate.passRate === incumbent.passRate
  if (level && lengths !== null && lengths.incumbent > 0) {
    const ratio = lengths.candidate / lengths.incumbent
    if (ratio > 1 + COMPACTNESS_MARGIN) {
      return {
        decision: 'rejected',
        reason:
          `Rejected by the held-out screen: it scored exactly what the prompt in use scored ` +
          `(${asPercent(candidate.passRate)} on ${candidate.scored} items) and its body is ` +
          `${Math.round((ratio - 1) * 100)}% longer — ${lengths.candidate} characters against ` +
          `${lengths.incumbent}. That length is paid on every run of this persona from now on, ` +
          'for no measured gain. A shorter candidate that ties is admitted; this one is ' +
          `archived with the reason, so a proposer reads it.${wasMadeOf}`,
      }
    }
  }

  return {
    decision: 'admitted',
    reason:
      `Admitted by the held-out screen: it passed ${candidate.passed} of ${candidate.scored} ` +
      `items (${asPercent(candidate.passRate)}) against ${asPercent(incumbent.passRate)} for the ` +
      'prompt in use. The screen decides whether a candidate is measured and never whether it ' +
      'is promoted — a person still settles the search.' +
      (level && lengths !== null && lengths.candidate < lengths.incumbent
        ? ` It is also shorter than the prompt in use — ${lengths.candidate} characters against ` +
          `${lengths.incumbent} — which is the cheaper thing to run on every future run.`
        : '') +
      wasMadeOf,
  }
}
