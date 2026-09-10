/**
 * A run that keeps making the same call.
 *
 * The reaper has two signals and both are about *silence*: no heartbeat means the Runner
 * is gone, no progress means nothing has been emitted for a long time. Neither sees the
 * failure mode that costs the most money — a model that calls one tool with one input over
 * and over, reads the same answer, and calls it again. Every call is an event, so the run
 * looks alive; the heartbeat is fresh, the event stream is moving, and the only thing that
 * ends it is the budget cap.
 *
 * The rule is deliberately narrow: **the same tool, the same input, consecutively, with
 * nothing else in between.** A model that alternates two calls is exploring badly and might
 * still get there; one that re-reads a file after editing it is doing the right thing, and
 * the input digest keeps that case out because the arguments differ. What is left is the
 * shape with no honest reading — a loop with no variable in it.
 *
 * Consecutive from the *tail*, because that is the only ordering a sweep can act on: a run
 * that made the same call eight times an hour ago and has been working since is not stuck,
 * and a count over the whole run would say it was.
 */

export interface ToolCallFingerprint {
  readonly toolName: string
  /** A digest of the call's arguments — see `recentToolCalls`; equal digests mean equal input. */
  readonly inputDigest: string
}

/**
 * The repeated call at the end of this run's tool history, if it has repeated enough.
 *
 * `calls` is newest-first. Returns null when the tail is not a repetition, when the limit
 * is not met, or when the limit is zero — which is how a deployment turns the check off,
 * and it is off rather than defaulted so that a caller which never passes a limit keeps the
 * behaviour it had.
 */
export const repeatedTailCall = (
  calls: readonly ToolCallFingerprint[],
  limit: number,
): { readonly toolName: string; readonly count: number } | null => {
  if (limit <= 0) return null
  const head = calls[0]
  if (!head) return null
  let count = 0
  for (const call of calls) {
    if (call.toolName !== head.toolName || call.inputDigest !== head.inputDigest) break
    count += 1
  }
  return count >= limit ? { toolName: head.toolName, count } : null
}

/**
 * What the human and the thread are told. Names the tool and the count, for the reason the
 * verification harness names the check: "reaped" sends someone to a log, "called Bash with
 * the same input 12 times" is already the diagnosis.
 */
export const describeStuckLoop = (loop: { toolName: string; count: number }): string =>
  `called ${loop.toolName} with the same input ${loop.count} times in a row`
