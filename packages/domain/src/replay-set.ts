/**
 * The held-out screen — what a candidate must survive before it is
 * allowed to cost anything a human waits on.
 *
 * The self-improvement loop is a *selection* rule and says nothing about where a candidate comes from, which is
 * why the loop it describes cannot converge at the sample cost it charges: five decided runs
 * an arm across up to four arms is fifteen to twenty dispositioned runs on one persona, and
 * The open-items list records the consequence — no search has ever reached a verdict from real traffic. The
 * evidence for the fix is SkillOpt (arXiv 2605.23904): a document is edited only when the
 * edit improves a **held-out validation score**, and the transferable part is not the
 * optimizer but that a candidate is screened *before* it is allowed to occupy the one
 * measurement slot a persona has.
 *
 * Loom already owns the material, which is what makes this affordable. Every decided run
 * carries a task, a bound repository, the commit it opened at, and a definition-of-done outcome derived server-side. A set of those
 * is a replay set:
 *
 * (repository @ commit, task, observed outcome)
 *
 * ## The four decisions the generating side takes, and where each one lives here
 *
 * - **The screen gates entry; it never promotes.** `screenGate` returns `admitted` or
 * `rejected` and has no third answer. The rule — fitness is run disposition, never a
 * model's own assessment — is unchanged: a candidate that beats the set has earned an
 * *arm*, and the arms are still what decide. Anything else would make an offline proxy the
 * thing that decides, which is the one substitution this section exists to avoid.
 * - **The set is versioned, and the version travels with every score.** A screen whose tasks
 * changed between two candidates has measured two different things and will report it as a
 * comparison.
 * - **No silent truncation.** `assembleReplaySet` returns every run it did *not* use and why,
 * and `describeReplaySet` puts it in a sentence. The habit, for its reason: a bounded
 * thing that reads as complete is worse than one that reports its bound.
 * - **A candidate the screen kills is archived with the reason**, which is what makes the
 * archive rule (piece 1) and the proposer (piece 3) useful — a rejected-edit buffer is a
 * different thing from the revision history, because only one of them ever went live.
 *
 * ## And the two this file adds, because building it forced them
 *
 * - **A tie is admitted.** The arms resolve a tie *against* the candidate. The screen resolves it *for* the candidate,
 * because its only authority is to refuse a measurement, and "no worse than the prompt in
 * use" is not a reason to refuse one. Rejecting ties would quietly promote the proxy to
 * the decider.
 * - **A screen that cannot say anything admits everything.** Below `MIN_REPLAY_ITEMS` there
 * is no set worth the name, and the honest behaviour is to abstain and let the arms do
 * what they already did. Failing open is right here specifically *because* the screen has
 * no positive authority: the thing it falls back to is the real fitness, not nothing.
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
 * Four is the smallest set on which "worse" can mean more than one unlucky task. Portable expertise is
 * already candid that its five decided runs an arm is a compromise against a real power
 * calculation; this is the same compromise and is written down as one rather than defended.
 */
export const MIN_REPLAY_ITEMS = 4

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
 if (record.task === null || record.task.trim.length === 0) {
 return { ok: false, reason: 'no-task' }
 }
 return { ok: true }
}

/**
 * Builds a held-out set from this persona's decided runs.
 *
 * **Deterministic, and it does not sample.** The selection is "the most recent eligible runs,
 * newest first, up to the cap" — an ordering the caller supplies and this function only
 * respects. Randomness would make a set unreproducible from the journal, which is the same
 * objection portable expertise raises against a random trial arm; and preferring the newest is the
 * choice that keeps the tasks representative of what this persona is currently asked to do.
 *
 * A tie in `decidedAt` is broken by run id, so two assemblies of the same history produce
 * the same set rather than whatever order the query returned.
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
 const byTime = b.decidedAt.getTime - a.decidedAt.getTime
 return byTime !== 0 ? byTime: a.runId.localeCompare(b.runId)
 })

 const items = ordered.slice(0, MAX_REPLAY_ITEMS).map(
 (record): ReplayItem => ({
 sourceRunId: record.runId,
 repositoryId: record.repositoryId,
 // Non-null by `isEligible`, which is the only path into `ordered`.
 commitSha: record.baseCommitSha as string,
 task: (record.task as string).trim,
 observedOutcome: record.outcome,
 }),
)
 for (const record of ordered.slice(MAX_REPLAY_ITEMS)) {
 excluded.push({ runId: record.runId, reason: 'over-cap' })
 }

 return { items, excluded, eligible: eligible.length, considered: records.length }
}

const EXCLUSION_WORDS: Record<ReplayExclusion, string> = {
 'no-commit': 'did not record the commit they opened at',
 'no-task': 'had no task text to replay',
 'was-an-arm': 'were arms of an earlier measurement',
 'over-cap': `were eligible and over the cap of ${MAX_REPLAY_ITEMS}`,
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
 const counts = new Map<ReplayExclusion, number>
 for (const entry of draft.excluded) {
 counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1)
 }
 const clauses = [...counts.entries]
.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
.map(([reason, count]) => `${count} ${EXCLUSION_WORDS[reason]}`)

 const outcomes = new Map<ReplayOutcome, number>
 for (const item of draft.items) {
 outcomes.set(item.observedOutcome, (outcomes.get(item.observedOutcome) ?? 0) + 1)
 }
 const shape = [...outcomes.entries]
.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
.map(([outcome, count]) => `${count} ${outcome}`)
.join(', ')

 const head =
 draft.items.length === 0
 ? `No held-out items: ${draft.considered} decided runs were considered and none was usable`
: `${draft.items.length} held-out ${draft.items.length === 1 ? 'item': 'items'}` +
 `${shape === '' ? '': ` (${shape} when they were run)`}, from ${draft.considered} ` +
 'decided runs considered'
 const tail = clauses.length === 0 ? '': `. Left out: ${clauses.join('; ')}`
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
 * `skipped` and `refused` say something about the setup, not about the branch, and folding
 * them in would make every unconfigured repository look like it produced broken work.
 */
 | 'not-scored'

export interface ScreenScore {
 /** Null is the incumbent — the prompt the persona actually has, which is the control. */
 readonly variantId: string | null
 /** One entry per item attempted, in the set's order. */
 readonly outcomes: readonly ReplayCheckOutcome[]
}

export interface ScreenTally {
 readonly variantId: string | null
 readonly scored: number
 readonly passed: number
 readonly failed: number
 readonly notScored: number
 /** Passed over scored. Zero when nothing was scored — see `scored` before reading it. */
 readonly passRate: number
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
 passRate: scored === 0 ? 0: passed / scored,
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
 * thing it defers to is the real fitness.
 * 2. **The incumbent could not be scored → admitted.** Without a control there is no
 * comparison, and refusing an arm on an unmeasured baseline is exactly the silent
 * downgrade the roadmap refuses when it derives a verdict server-side.
 * 3. **The candidate could not be scored → admitted.** A screening run that errored says
 * nothing about the prompt. Rejecting here would let an infrastructure failure kill a
 * candidate, which is the failure mode where a loop quietly stops proposing anything.
 * 4. **Strictly worse → rejected.** Everything else is admitted, ties included.
 */
export const screenGate = (input: {
 readonly itemCount: number
 readonly candidate: ScreenTally
 readonly incumbent: ScreenTally
}): ScreenGateVerdict => {
 const { itemCount, candidate, incumbent } = input
 const asPercent = (rate: number) => `${Math.round(rate * 100)}%`

 if (itemCount < MIN_REPLAY_ITEMS) {
 return {
 decision: 'admitted',
 reason:
 `Not screened: this persona has ${itemCount} held-out ${itemCount === 1 ? 'item': 'items'} ` +
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
 if (candidate.passRate < incumbent.passRate) {
 return {
 decision: 'rejected',
 reason:
 `Rejected by the held-out screen: it passed ${candidate.passed} of ${candidate.scored} ` +
 `items (${asPercent(candidate.passRate)}) where the prompt in use passed ` +
 `${incumbent.passed} of ${incumbent.scored} (${asPercent(incumbent.passRate)}). It was ` +
 'not given an arm, so no live run was spent on it.',
 }
 }
 return {
 decision: 'admitted',
 reason:
 `Admitted by the held-out screen: it passed ${candidate.passed} of ${candidate.scored} ` +
 `items (${asPercent(candidate.passRate)}) against ${asPercent(incumbent.passRate)} for the ` +
 'prompt in use. The screen decides whether a candidate is measured and never whether it ' +
 'is promoted — a person still settles the search.',
 }
}
