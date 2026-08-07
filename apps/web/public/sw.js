/*
 * Loom's service worker. Its only job is notifications — no
 * caching, no offline shell, no fetch handler at all: a stale cached bundle
 * talking to a live contract is a bug factory, and nothing here needs it.
 *
 * Plain JS in public/ deliberately. A service worker is fetched by the browser
 * at a stable URL and must control the whole origin, so it cannot be a hashed
 * module inside the app bundle.
 */

self.addEventListener('install', => {
 // Take over immediately rather than waiting for every tab to close — an
 // operator who just enabled notifications expects the next run to reach them.
 self.skipWaiting
})

self.addEventListener('activate', (event) => {
 event.waitUntil(self.clients.claim)
})

self.addEventListener('push', (event) => {
 if (!event.data) return

 let payload
 try {
 payload = event.data.json
 } catch {
 return
 }

 event.waitUntil(
 self.registration.showNotification(payload.title ?? 'Loom', {
 body: payload.body ?? '',
 // Coalescing key from the server (Notification.tag): a run that needed
 // approval and then finished replaces its own earlier notification
 // instead of stacking two, because the question has changed.
 tag: payload.tag,
 renotify: true,
 data: { runId: payload.runId, kind: payload.kind },
 requireInteraction: payload.kind === 'approval_needed',
 }),
)
})

self.addEventListener('notificationclick', (event) => {
 event.notification.close
 const runId = event.notification.data?.runId

 event.waitUntil(
 (async => {
 const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

 // Reuse an open tab rather than opening a second copy of the app: a second
 // window means a second WebSocket and a confusing duplicate view.
 for (const client of clientList) {
 if (new URL(client.url).origin !== self.location.origin) continue
 await client.focus
 if (runId) client.postMessage({ type: 'loom:open-run', runId })
 return
 }

 // Nothing open — the deep link is the only way to carry the run through a
 // cold start (apps/web has no router; it reads `?run=` on mount).
 await self.clients.openWindow(runId ? `/?run=${encodeURIComponent(runId)}`: '/')
 }),
)
})
