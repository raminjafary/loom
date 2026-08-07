import type { NotificationTargetRepositoryPort } from '@loom/application'
import { asAgentRunId, asUserId, asWorkspaceId, buildNotification, type NotificationTarget } from '@loom/domain'
import { describe, expect, it } from 'vitest'
import { webPushNotificationPort, type PushSender } from './notifications.js'

/**
 * The adapter's own behaviour — fan-out, dead-target pruning, failure isolation
 * and the unconfigured case — with the push service replaced by the `send`
 * seam. Whether a real push service accepts the ciphertext is `web-push`'s
 * concern and cannot be proven here; delivery to a real browser is a live check
 * (see HANDOFF.md).
 */

const workspaceId = asWorkspaceId('ws-1')

const target = (endpoint: string): NotificationTarget => ({
  id: `t-${endpoint}`,
  workspaceId,
  userId: asUserId('u-1'),
  transport: 'web_push',
  endpoint,
  credentials: { p256dh: 'key', auth: 'auth' },
  createdAt: new Date(),
})

const fakeTargets = (initial: NotificationTarget[]): NotificationTargetRepositoryPort & {
  rows: NotificationTarget[]
} => {
  const rows = [...initial]
  return {
    rows,
    async register() {
      throw new Error('not used')
    },
    async unregister(_workspaceId, endpoint) {
      const index = rows.findIndex((row) => row.endpoint === endpoint)
      if (index >= 0) rows.splice(index, 1)
    },
    async listByWorkspace() {
      return rows
    },
  }
}

const keys = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:o@example.com' }

const notification = buildNotification({
  workspaceId,
  runId: asAgentRunId('run-1'),
  kind: 'approval_needed',
  personaName: 'SWE',
  toolName: 'Bash',
})

describe('webPushNotificationPort', () => {
  it('reports itself unconfigured with no VAPID keys, and delivers nothing', async () => {
    const sent: string[] = []
    const logged: Record<string, unknown>[] = []
    const port = webPushNotificationPort({
      targets: fakeTargets([target('https://push.example/a')]),
      keys: null,
      send: async (t) => {
        sent.push(t.endpoint)
        return { ok: true }
      },
      log: (event) => logged.push(event),
    })

    expect(port.clientConfig()).toEqual({ transport: null, publicKey: null })
    await port.deliver(notification)
    expect(sent).toEqual([])
    // Visible rather than silent: an operator who forgot the keys must be able
    // to find out from the logs why nothing arrived.
    expect(logged).toHaveLength(1)
  })

  it('publishes the VAPID public key once configured', () => {
    const port = webPushNotificationPort({ targets: fakeTargets([]), keys, send: async () => ({ ok: true }) })
    expect(port.clientConfig()).toEqual({ transport: 'web_push', publicKey: 'pub' })
  })

  it('delivers to every registered target in the workspace', async () => {
    const payloads: { endpoint: string; payload: string }[] = []
    const port = webPushNotificationPort({
      targets: fakeTargets([target('https://push.example/a'), target('https://push.example/b')]),
      keys,
      send: async (t, payload) => {
        payloads.push({ endpoint: t.endpoint, payload })
        return { ok: true }
      },
    })

    await port.deliver(notification)

    expect(payloads.map((p) => p.endpoint)).toEqual([
      'https://push.example/a',
      'https://push.example/b',
    ])
    const parsed = JSON.parse(payloads[0]!.payload) as Record<string, unknown>
    expect(parsed.title).toContain('SWE')
    expect(parsed.runId).toBe('run-1')
    expect(parsed.tag).toBe('run:run-1')
  })

  it('prunes a target the push service reports gone, and keeps the live one', async () => {
    const targets = fakeTargets([target('https://push.example/dead'), target('https://push.example/live')])
    const send: PushSender = async (t) =>
      t.endpoint.endsWith('dead') ? { ok: false, gone: true } : { ok: true }

    const port = webPushNotificationPort({ targets, keys, send })
    await port.deliver(notification)

    expect(targets.rows.map((row) => row.endpoint)).toEqual(['https://push.example/live'])
  })

  it('keeps a target whose delivery failed for a retryable reason', async () => {
    const targets = fakeTargets([target('https://push.example/a')])
    const logged: Record<string, unknown>[] = []
    const port = webPushNotificationPort({
      targets,
      keys,
      send: async () => ({ ok: false, gone: false, error: 'service unavailable' }),
      log: (event) => logged.push(event),
    })

    await port.deliver(notification)

    expect(targets.rows).toHaveLength(1)
    expect(logged[0]?.error).toBe('service unavailable')
  })

  it('does not let one failing target skip the ones after it', async () => {
    const reached: string[] = []
    const port = webPushNotificationPort({
      targets: fakeTargets([target('https://push.example/a'), target('https://push.example/b')]),
      keys,
      send: async (t) => {
        reached.push(t.endpoint)
        return t.endpoint.endsWith('a') ? { ok: false, gone: false, error: 'boom' } : { ok: true }
      },
    })

    await port.deliver(notification)

    expect(reached).toHaveLength(2)
  })
})
