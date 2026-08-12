import type { Thread } from '@loom/api-contract'

/**
 * Area threads.
 *
 * A sub-planner runs in its own thread, hung off the message in its parent's
 * conversation that announced the area. Without that split a depth-2 tree writes every
 * plan, every tool call and every summary from every branch into one conversation, and
 * stops being readable at exactly the size the corporation exists to enable.
 *
 * The rendering question is therefore "which message has a conversation under it", and
 * the answer is already in the data: a reply thread's `parentMessageId`. This module is
 * the lookup and the trail, kept out of the component because both are ordinary logic
 * and this app's rendering decisions have historically had no tests at all.
 */

/** Message id → the thread hanging off it. At most one, by construction. */
export const threadsByParentMessage = (threads: readonly Thread[]): Map<string, Thread> => {
 const byParent = new Map<string, Thread>
 for (const thread of threads) {
 if (thread.parentMessageId === null) continue
 // First wins rather than last: threads come back oldest-first, and if a message
 // ever ended up with two, the one the announcement described is the older.
 if (!byParent.has(thread.parentMessageId)) byParent.set(thread.parentMessageId, thread)
 }
 return byParent
}

export interface ThreadTrailStep {
 readonly threadId: string
 readonly label: string
 /** The step the user is currently in — rendered as text, not as a link back to itself. */
 readonly current: boolean
}

/**
 * The path from the channel root to the active thread.
 *
 * **Two steps, and that is a real limit rather than a simplification.** A `thread` row
 * records the *message* it hangs off, not the thread that message is in, so walking up
 * an arbitrary chain needs a message-id → thread-id map this client does not hold —
 * the announcement for a deeper thread is usually not on the loaded page at all.
 * `MAX_DELEGATION_DEPTH` is 2, so root → area is the whole chain that can exist today,
 * and the honest thing is to render exactly that and say why rather than to build a
 * walk that would silently produce a wrong trail the moment depth 3 is allowed.
 *
 * If depth ever grows, the fix is a `parentThreadId` on the row — not a cleverer
 * traversal here.
 *
 * `labelFor` resolves the announcement message id to something human. A callback
 * rather than a message list, so this stays a pure function over ids.
 */
export const buildThreadTrail = (
 threads: readonly Thread[],
 activeThreadId: string | null,
 labelFor: (parentMessageId: string) => string | null,
): ThreadTrailStep[] => {
 const root = threads.find((thread) => thread.isRoot) ?? null
 const active =
 activeThreadId === null ? null: (threads.find((t) => t.id === activeThreadId) ?? null)
 if (!active || !root) return []
 // A channel whose active thread is its root has no trail to draw: one step that is
 // also the root is a breadcrumb reading "you are here", which is noise on every
 // ordinary channel and on every channel that has never run a swarm.
 if (active.id === root.id) return []

 return [
 { threadId: root.id, label: 'Channel', current: false },
 {
 threadId: active.id,
 label: (active.parentMessageId && labelFor(active.parentMessageId)) || 'Area',
 current: true,
 },
 ]
}

/**
 * A short label for an area thread, from the announcement message that spawned it.
 *
 * The announcement is platform-authored and shaped `"<title> → <persona>:..."`, so the
 * part before the arrow is the subtask title the Planner chose. Falls back to the whole
 * line trimmed, then to "Area" — a breadcrumb that says nothing is still better than
 * one that says `undefined`.
 */
export const areaLabelFromAnnouncement = (text: string | null | undefined): string => {
 if (!text) return 'Area'
 const beforeArrow = text.split('→')[0]?.trim
 if (beforeArrow && beforeArrow.length > 0) return beforeArrow.slice(0, 60)
 return text.trim.slice(0, 60) || 'Area'
}
