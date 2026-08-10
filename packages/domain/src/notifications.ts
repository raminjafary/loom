import type { AgentRunId, UserId, WorkspaceId } from './ids.js'

/**
 * PLAN.md §3's retention hook, second half: the Inbox answers "what needs me"
 * once a human is looking, and this is what makes them look. §7's Phase 1 ship
 * criterion says the human "is notified when it needs them" — not that they can
 * go and check.
 *
 * `NotificationPort` (packages/application/src/ports.ts) is the boundary; the
 * §4a port table lists web push as its first adapter, with email/Slack/desktop/
 * webhook as later swaps. Nothing in this module knows which one is in use.
 */

/** The one transport built so far. Widened when a second adapter lands (§4a). */
export type NotificationTransport = 'web_push'

/**
 * One registered destination — a browser's push subscription today. `endpoint`
 * is the transport's address (a push service URL for web push, a mailbox for a
 * future email adapter) and is the natural identity of a target: the same
 * browser re-subscribing yields the same endpoint, so registration is an upsert
 * rather than a way to accumulate duplicates.
 *
 * `credentials` is transport-specific and opaque here on purpose — for web push
 * it holds the subscription's `p256dh`/`auth` keys, which only the adapter and
 * the browser that issued them can make sense of.
 */
export interface NotificationTarget {
  readonly id: string
  readonly workspaceId: WorkspaceId
  readonly userId: UserId
  readonly transport: NotificationTransport
  readonly endpoint: string
  readonly credentials: Readonly<Record<string, string>>
  readonly createdAt: Date
}

export type NotificationKind =
  | 'approval_needed'
  | 'approval_expired'
  | 'run_finished'
  | 'run_failed'
  /**
   * The merge queue's outcomes (PLAN.md §7 Phase 2). A queued merge is the case
   * §3's retention hook is most about: the human handed the branch over and stopped
   * watching precisely because a queue is supposed to be unattended.
   */
  | 'merge_succeeded'
  | 'merge_failed'

/**
 * What a transport actually sends. `tag` is a coalescing key — a run that needs
 * approval and then finishes should replace its own earlier notification rather
 * than stack two, because the question a human is being asked has changed.
 *
 * `runId` rather than a full URL: what a deep link looks like is a client
 * concern (apps/web has no router and reads `?run=`), and baking one in here
 * would put the web app's URL shape into the domain.
 */
export interface Notification {
  readonly workspaceId: WorkspaceId
  readonly kind: NotificationKind
  readonly runId: AgentRunId
  readonly title: string
  readonly body: string
  readonly tag: string
}

/**
 * Deliberately free of tool arguments. §6 A3's rule is that a human decides
 * against the *exact argv*, which the approval card renders in the app — a
 * notification is the pointer that gets them there, never the evidence they
 * decide on. Naming the tool is enough to judge urgency; a `command` string in
 * a notification body invites deciding from the lock screen, which is the whole
 * failure mode A3 exists to prevent.
 */
export const buildNotification = (input: {
  workspaceId: WorkspaceId
  runId: AgentRunId
  kind: NotificationKind
  personaName: string
  /** Present for approval kinds. */
  toolName?: string | undefined
  /** Failure reason, or the run's result summary. */
  detail?: string | undefined
  branchName?: string | null | undefined
  totalCostUsd?: number | null | undefined
}): Notification => {
  const base = { workspaceId: input.workspaceId, runId: input.runId, kind: input.kind, tag: `run:${input.runId}` }

  switch (input.kind) {
    case 'approval_needed':
      return {
        ...base,
        title: `${input.personaName} needs approval`,
        body: input.toolName
          ? `Waiting on you to allow or deny ${input.toolName}.`
          : 'Waiting on you to allow or deny a risky tool call.',
      }
    case 'approval_expired':
      return {
        ...base,
        title: `${input.personaName}'s approval expired`,
        body: input.toolName
          ? `${input.toolName} was auto-denied with no decision; the run continued.`
          : 'The request was auto-denied with no decision; the run continued.',
      }
    case 'run_finished':
      return {
        ...base,
        title: `${input.personaName} finished`,
        body: [
          input.branchName ? `${input.branchName} is ready to review.` : 'Ready to review.',
          typeof input.totalCostUsd === 'number' ? `$${input.totalCostUsd.toFixed(2)}` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' '),
      }
    case 'run_failed':
      return {
        ...base,
        title: `${input.personaName} failed`,
        body: input.detail ?? 'The run ended without finishing its task.',
      }
    case 'merge_succeeded':
      return {
        ...base,
        title: `${input.branchName ?? input.personaName} merged`,
        body: input.detail ?? 'The branch is in the default branch.',
      }
    case 'merge_failed':
      return {
        ...base,
        // Deliberately the short per-reason line, never the raw detail: a
        // conflicted file list or a test-log tail is what the thread is for. Same
        // instinct as keeping tool argv out of a notification — the notification
        // gets someone to the place where they can actually decide.
        title: `${input.branchName ?? input.personaName} did not merge`,
        body: input.detail ?? 'The merge queue could not merge this branch.',
      }
  }
}
