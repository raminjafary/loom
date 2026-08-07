/**
 * Client-side web-push plumbing. Nothing here touches the DOM or Vue: a terminal
 * client with a push-capable runtime uses the same functions.
 */

/**
 * `PushManager.subscribe` wants `applicationServerKey` as raw bytes, but VAPID
 * public keys are published as base64url — and `atob` only accepts standard
 * base64, so the two alphabet substitutions and the padding are load-bearing
 * rather than cosmetic. A malformed key surfaces here as a thrown error instead
 * of as an opaque `InvalidCharacterError` from deep inside the browser.
 */
export const applicationServerKey = (vapidPublicKey: string): Uint8Array<ArrayBuffer> => {
 const padded = vapidPublicKey.padEnd(
 vapidPublicKey.length + ((4 - (vapidPublicKey.length % 4)) % 4),
 '=',
)
 const base64 = padded.replace(/-/g, '+').replace(/_/g, '/')
 let raw: string
 try {
 raw = atob(base64)
 } catch {
 throw new Error('VAPID public key is not valid base64url')
 }
 // Backed by an explicit ArrayBuffer, not the default `ArrayBufferLike`:
 // `PushManager.subscribe` types `applicationServerKey` as a `BufferSource`
 // over `ArrayBuffer`, and a possibly-shared buffer is not assignable to it.
 const bytes = new Uint8Array(new ArrayBuffer(raw.length))
 for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
 return bytes
}

/**
 * What the server needs to reach this browser. Extracted from the browser's own
 * `PushSubscription` rather than re-derived: the keys belong to the subscription
 * and are regenerated whenever it rotates.
 */
export interface PushRegistration {
 readonly endpoint: string
 readonly credentials: Record<string, string>
}

/**
 * A `PushSubscription`'s `toJSON` shape, declared structurally so this module
 * needs no DOM lib and stays usable outside a browser.
 */
export interface PushSubscriptionJson {
 endpoint?: string | undefined
 keys?: Record<string, string> | undefined
}

export const toPushRegistration = (subscription: PushSubscriptionJson): PushRegistration => {
 if (!subscription.endpoint) throw new Error('push subscription has no endpoint')
 const keys = subscription.keys ?? {}
 // Both keys are required to encrypt to this subscription (RFC 8291); storing a
 // target missing either one would mean every later delivery fails at send time
 // for a reason nobody can see from the row.
 if (!keys.p256dh || !keys.auth) {
 throw new Error('push subscription is missing its p256dh/auth keys')
 }
 return { endpoint: subscription.endpoint, credentials: { p256dh: keys.p256dh, auth: keys.auth } }
}
