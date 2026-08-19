import type { Actor } from '@loom/api-contract'

/**
 * What the thread shows, on the client.
 *
 * **A deliberate duplicate of the domain's `thread-views.ts`**, for the reason
 * `persona-form.ts` duplicates the persona serializer: this package may not import
 * `@loom/domain`, and the rule is needed on both sides for a reason that is not
 * cosmetic. The server applies it in the query, because filtering a fetched page would
 * make pagination lie. The client applies it to messages arriving **live over the
 * socket**, which never went through that query at all — without it, a quiet thread
 * refills with the firehose the moment anything happens.
 *
 * `apps/web/src/thread-view.conformance.test.ts` pins the two together with the real
 * domain function on the far side. Two implementations of one rule is a thing this
 * repository accepts exactly twice, and both times with a test that fails when they part.
 */

export type ThreadView = 'headline' | 'all' | 'run'

export const DEFAULT_THREAD_VIEW: ThreadView = 'headline'

/**
 * Whether a message belongs in a view.
 *
 * The headline is `system` + `user` — the platform's own voice and the humans'. That is
 * the trust boundary reused as the noise boundary, and it is what makes a quieter default
 * safe: every blocking thing (an approval, a question) posts a system line, so no view
 * can hide a run that is waiting.
 */
export const messageInView = (
  message: { readonly author: Actor },
  view: ThreadView,
  focusRunId?: string,
): boolean => {
  if (view === 'all') return true
  if (view === 'headline') return message.author.kind === 'system' || message.author.kind === 'user'
  if (focusRunId === undefined) return false
  if (message.author.kind === 'user') return true
  return message.author.kind === 'agent_run' && message.author.agentRunId === focusRunId
}
