import type {
 NotificationPort,
 NotificationTargetRepositoryPort,
} from '@loom/application'
import type { Notification, NotificationTarget } from '@loom/domain'
import webpush from 'web-push'

/**
 * The `NotificationPort`, web push adapter (the "is notified
 * when it needs them").
 *
 * Web push is end-to-end encrypted per RFC 8291: the push service routes an
 * opaque ciphertext it cannot read, and only the subscribing browser holds the
 * key. That is why this is the Phase 1 transport rather than email — it reaches
 * a closed laptop without handing a third party the contents. The payload still
 * carries no tool arguments (see buildNotification), because deciding from a
 * notification is the failure mode effect-based classification exists to prevent, encryption or not.
 */

export interface VapidKeys {
 readonly publicKey: string
 readonly privateKey: string
 /** `mailto:` or an https URL identifying the operator to the push service. */
 readonly subject: string
}

/** What a delivery attempt did, so the caller can prune and log without knowing HTTP. */
export type SendResult =
 | { readonly ok: true }
 /** The subscription is permanently gone (404/410) — the row must go. */
 | { readonly ok: false; readonly gone: true }
 | { readonly ok: false; readonly gone: false; readonly error: string }

export type PushSender = (target: NotificationTarget, payload: string) => Promise<SendResult>

/**
 * The real sender. Split out as a seam so the adapter's fan-out, pruning and
 * failure-isolation behaviour can be tested without a push service — which is
 * the part that has bugs, since `webpush.sendNotification` is one call.
 */
export const webPushSender = (keys: VapidKeys): PushSender => {
 webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey)

 return async (target, payload) => {
 try {
 await webpush.sendNotification(
 {
 endpoint: target.endpoint,
 keys: {
 p256dh: target.credentials.p256dh ?? '',
 auth: target.credentials.auth ?? '',
 },
 },
 payload,
)
 return { ok: true }
 } catch (error) {
 const statusCode = (error as { statusCode?: number }).statusCode
 // 404/410 are the push protocol's "this subscription is dead" — every
 // other status (429, 5xx, a network error) may succeed next time and must
 // not delete a live target.
 if (statusCode === 404 || statusCode === 410) return { ok: false, gone: true }
 return { ok: false, gone: false, error: error instanceof Error ? error.message: String(error) }
 }
 }
}

/**
 * Delivers to every registered target in the notification's workspace, not to
 * one user: any human in the workspace can answer an approval or review a
 * branch, and Phase 1 has no per-user routing (no assignment model, single
 * active run). When teams and assignment land, this is the seam that narrows.
 */
export const webPushNotificationPort = (options: {
 targets: NotificationTargetRepositoryPort
 keys: VapidKeys | null
 send?: PushSender
 log?: (event: Record<string, unknown>) => void
}): NotificationPort => {
 const { keys } = options
 // Keys alone decide whether this port is configured, so `clientConfig` and
 // `deliver` can never disagree — an injected sender is a test seam for *how*
 // a send behaves, never a way to deliver on a deployment that told its
 // clients notifications are off. (A browser could not have subscribed there
 // anyway: `applicationServerKey` is the VAPID public key.)
 const send = keys === null ? null: (options.send ?? webPushSender(keys))
 const log = options.log ?? ( => {})

 return {
 clientConfig: =>
 keys === null || send === null
 ? { transport: null, publicKey: null }
: { transport: 'web_push' as const, publicKey: keys.publicKey },

 async deliver(notification: Notification) {
 // Unconfigured is a supported state, not an error: a local dev stack with
 // no VAPID keys must still run every other Phase 1 path. Logged once per
 // notification so it is visible rather than mysterious.
 if (send === null) {
 log({ msg: 'notification dropped: no VAPID keys configured', kind: notification.kind })
 return
 }

 const targets = await options.targets.listByWorkspace(notification.workspaceId)
 if (targets.length === 0) return

 const payload = JSON.stringify({
 title: notification.title,
 body: notification.body,
 tag: notification.tag,
 kind: notification.kind,
 runId: notification.runId,
 })

 // Sequential rather than Promise.all: a workspace has a handful of
 // browsers, and one slow push service must not be able to hold open N
 // concurrent sockets on a background sweep. Each target is isolated —
 // one failure never skips the rest.
 for (const target of targets) {
 const result = await send(target, payload)
 if (result.ok) continue
 if (result.gone) {
 await options.targets.unregister(notification.workspaceId, target.endpoint)
 log({ msg: 'pruned a dead notification target', endpoint: target.endpoint })
 continue
 }
 log({ msg: 'notification delivery failed', endpoint: target.endpoint, error: result.error })
 }
 },
 }
}
