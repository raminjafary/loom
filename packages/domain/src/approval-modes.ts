/**
 * How much a run may do without asking.
 *
 * This replaces a boolean. `harness.autoApprove` had exactly two settings — ask about
 * every risky call, or ask about none — and the second is the only escape from
 * approval fatigue on a run that edits twenty files. Operators want the middle: take
 * the file edits, keep asking about the shell. A third state cannot be bolted onto a
 * boolean, because the boolean is compared in three places that each have to agree
 * about ordering (the attenuation, the Runner's `canUseTool`, and the roster that
 * predicts both), and two of them would have kept reading it as "auto or not".
 *
 * **Ordered, and the order is the security property.** `ask` is narrowest, `auto`
 * widest, and a child run may never hold a wider mode than its parent — the
 * generalization of "a parent that must ask cannot hand down the right to skip
 * asking". `approvalModeRank` is the single definition of that order; nothing else
 * compares modes.
 *
 * **What each mode does *not* change**, because this is where a permission boundary
 * could quietly become a preference:
 *
 * - The path-scoped write boundary. A target outside the run's clone is
 *   denied outright, in every mode, before a mode is consulted. `accept-edits`
 *   therefore only ever skips a gate on a file *inside the run's own clone*, which is
 *   what makes it a defensible middle rather than a smaller `auto`.
 * - The denied Bash effects (pushing, privilege escalation, credential reads). Those
 *   are refusals, not questions, and no mode turns one into an allow.
 * - The sandbox, which is the actual boundary either way.
 */

export type ApprovalMode = 'ask' | 'accept-edits' | 'auto'

/** Narrowest first. The array order *is* the ordering — see `approvalModeRank`. */
export const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'accept-edits', 'auto']

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'ask'

export const isApprovalMode = (value: unknown): value is ApprovalMode =>
  typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value)

/**
 * Higher is wider. The one definition of the order, so a child-start check, a
 * composition canvas and a delegation roster cannot disagree about which of two
 * modes is more permissive.
 */
export const approvalModeRank = (mode: ApprovalMode): number => APPROVAL_MODES.indexOf(mode)

export const isWiderApprovalMode = (child: ApprovalMode, parent: ApprovalMode): boolean =>
  approvalModeRank(child) > approvalModeRank(parent)

/**
 * The tools `accept-edits` covers: writing a file inside the run's own clone.
 *
 * Deliberately not `Bash`, and that is the whole distinction. A shell can write a file too,
 * but it can also push, install, read a credential and run anything the model wrote —
 * `classifyBashCommand` triages those and cannot be made sound (effect-based classification
 * says so itself), so "accept edits" must not silently mean "accept a shell that happens to
 * edit".
 */
export const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit']

/**
 * Whether this mode lets a call that would otherwise gate proceed without a human.
 *
 * Only ever consulted *after* the boundary checks: an out-of-clone target is already
 * denied and a denied Bash effect is already refused by the time this runs. So a
 * `true` here means "a human would have been asked, and this mode says do not bother"
 * — never "a rule was skipped".
 */
export const approvalModeAllows = (mode: ApprovalMode, toolName: string): boolean => {
  if (mode === 'auto') return true
  if (mode === 'accept-edits') return EDIT_TOOLS.includes(toolName)
  return false
}

/** One line for a UI, in the terms a human chooses between. */
export const describeApprovalMode = (mode: ApprovalMode): string => {
  switch (mode) {
    case 'ask':
      return 'Asks before every risky call.'
    case 'accept-edits':
      return 'Takes file edits inside its own clone; still asks before running a shell.'
    case 'auto':
      return 'Runs unattended — asks about nothing.'
  }
}

/**
 * Reads a stored persona snapshot's approval setting, tolerating the boolean this
 * replaced.
 *
 * Runs that predate the mode have `autoApprove` in their persona JSON and nothing
 * else, and a completed run must still be readable — its cost, its diff and its
 * transcript are all still wanted. Two settings map onto three cleanly because the
 * boolean's two states were the outer two.
 */
export const approvalModeFromSnapshot = (snapshot: {
  readonly approvalMode?: unknown
  readonly autoApprove?: unknown
}): ApprovalMode => {
  if (isApprovalMode(snapshot.approvalMode)) return snapshot.approvalMode
  return snapshot.autoApprove === true ? 'auto' : DEFAULT_APPROVAL_MODE
}
