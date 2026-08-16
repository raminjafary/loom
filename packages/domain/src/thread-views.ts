import type { Actor } from './actor.js'

/**
 * What a thread shows, and to whom.
 *
 * ## The problem this solves
 *
 * `recordAgentEvent` appends **every** event to a run's thread — assistant prose, each
 * tool call, each tool result — and a swarm's workers all share their planner's thread,
 * because the thread split happens at planners rather than at subtasks (that is where the
 * volume actually branches). Both decisions are right on their own and together they
 * produce one conversation carrying five interleaved streams, in which the line a human
 * must act on scrolls past between two file reads.
 *
 * The whole retention argument is that people collapse a stream and check the PR
 * instead. A swarm's root thread is the place that happens first.
 *
 * ## The rule, and why it needs no new taxonomy
 *
 * A message's **author** already separates the two kinds:
 *
 * - `system` is the platform's own voice: approval needed, a question waiting, a run
 * finished or failed, a plan summarized, an area delegated to its own thread, a
 * successor taking over, a window filling. Every blocking thing posts one of these —
 * `askClarifyingQuestion` and `requestApproval` both write a system pointer line, and
 * both deliberately keep the model's own words out of it.
 * - `agent_run` is what a model said or did.
 * - `user` is a person.
 *
 * So "decisions and structure" is `system` + `user`, and it is not a new classification
 * of anything — it is the **trust boundary the platform already draws**, reused. That
 * coincidence is the argument for this design rather than a happy accident: the line
 * between "the platform observed this" and "a model produced this" is the same line as
 * between "you must know this" and "this is detail", because the platform only speaks
 * when something happened that a human owns.
 *
 * ## What this deliberately does not do
 *
 * **It changes nothing about what is recorded, delivered, or prompted.** Every event
 * still lands in the thread, every frame still fans out, and no run's context is touched.
 * This is a read. An agent cannot tell which view a human is looking at, which is the
 * property that makes it safe to change the default — a filter that altered what agents
 * receive would be a redesign of the ledger wearing a UI feature's clothes.
 *
 * It also does not hide a blocked run. `headline` includes every system line, and a
 * blocking event is always one — so the failure mode mid-flight steering exists to prevent (a run waiting
 * on a question nobody saw, until the reaper takes it) cannot be introduced by choosing a
 * quieter view.
 */

export type ThreadView =
 /** Decisions and structure: the platform's voice and the humans'. The useful default. */
 | 'headline'
 /** Everything, in order. What the thread has always shown. */
 | 'all'
 /**
 * One run's own stream, plus the platform's lines about it.
 *
 * Reached by clicking a node on the swarm graph rather than by browsing a thread list —
 * the canvas is the index. This is why a *filter* beats a thread per run: workers share
 * their planner's thread on purpose, and giving each one its own would trade a noisy
 * conversation for eight conversations and a navigation problem, while the author
 * column already answers "which run said this" exactly.
 */
 | 'run'

export const THREAD_VIEWS: readonly ThreadView[] = ['headline', 'all', 'run']

export const DEFAULT_THREAD_VIEW: ThreadView = 'headline'

export const isThreadView = (value: string): value is ThreadView =>
 (THREAD_VIEWS as readonly string[]).includes(value)

/**
 * Whether a message belongs in a view.
 *
 * The one place the rule lives, so the server's SQL and any client that filters a page it
 * already holds cannot disagree about what a human is looking at — the same reason
 * `renderNotesForPrompt` is in the domain rather than at its call site.
 *
 * `focusRunId` is required by `run` and ignored by the others. A `run` view with no focus
 * shows nothing rather than everything: an empty list is a visible mistake, and a
 * silently unfiltered firehose is the bug this module exists to prevent.
 */
export const messageInView = (
 message: { readonly author: Actor },
 view: ThreadView,
 focusRunId?: string,
): boolean => {
 if (view === 'all') return true
 if (view === 'headline') return message.author.kind === 'system' || message.author.kind === 'user'
 if (focusRunId === undefined) return false
 /**
 * A human's message stays visible in a run's view, and that is deliberate: what
 * somebody typed while watching this agent is context for reading what it did next.
 * A system line is *not* included wholesale — it may be about a sibling — so the
 * caller narrows those by the run they concern; see `threadViewFilter`.
 */
 if (message.author.kind === 'user') return true
 return message.author.kind === 'agent_run' && message.author.agentRunId === focusRunId
}

/**
 * The same rule as a description a query can apply.
 *
 * Returned rather than executed because the adapter has to put it in a `where` clause:
 * filtering a fetched page in memory would make pagination lie — a page of fifty
 * containing three headline messages would render three rows and report that there was
 * nothing more to load, which is worse than the noise it set out to fix.
 */
export interface ThreadViewFilter {
 /** Author kinds to keep, or null for every kind. */
 readonly authorKinds: readonly Actor['kind'][] | null
 /** When set, agent-authored rows are narrowed to this run. */
 readonly agentRunId: string | null
}

export const threadViewFilter = (view: ThreadView, focusRunId?: string): ThreadViewFilter => {
 if (view === 'all') return { authorKinds: null, agentRunId: null }
 if (view === 'headline') return { authorKinds: ['system', 'user'], agentRunId: null }
 return {
 authorKinds: ['system', 'user', 'agent_run'],
 agentRunId: focusRunId ?? '',
 }
}
