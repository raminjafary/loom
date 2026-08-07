import { describe, expect, it } from 'vitest'
import { asAgentRunId, asWorkspaceId } from './ids.js'
import { buildNotification } from './notifications.js'

const base = {
  workspaceId: asWorkspaceId('ws-1'),
  runId: asAgentRunId('run-1'),
  personaName: 'Security Reviewer',
}

describe('buildNotification', () => {
  it('names the tool an approval is waiting on', () => {
    const notification = buildNotification({ ...base, kind: 'approval_needed', toolName: 'Bash' })
    expect(notification.title).toBe('Security Reviewer needs approval')
    expect(notification.body).toContain('Bash')
  })

  it('never leaks tool arguments into any kind', () => {
    const argv = 'rm -rf /important'
    for (const kind of ['approval_needed', 'approval_expired', 'run_finished', 'run_failed'] as const) {
      const notification = buildNotification({
        ...base,
        kind,
        toolName: 'Bash',
        // A caller passing argv through `detail` must not get it forwarded for
        // the approval kinds — deciding against argv happens in the app (§6 A3).
        detail: argv,
      })
      if (kind === 'run_failed') continue
      expect(notification.body).not.toContain(argv)
    }
  })

  it('coalesces every kind for one run onto the same tag', () => {
    const needed = buildNotification({ ...base, kind: 'approval_needed', toolName: 'Bash' })
    const finished = buildNotification({ ...base, kind: 'run_finished', branchName: 'loom/run-1' })
    expect(needed.tag).toBe(finished.tag)
    expect(needed.tag).toContain('run-1')
  })

  it('points a finished run at its branch and cost', () => {
    const notification = buildNotification({
      ...base,
      kind: 'run_finished',
      branchName: 'loom/run-1',
      totalCostUsd: 0.5,
    })
    expect(notification.body).toBe('loom/run-1 is ready to review. $0.50')
  })

  it('still says something useful for a run with no branch and no cost', () => {
    const notification = buildNotification({ ...base, kind: 'run_finished', branchName: null })
    expect(notification.body).toBe('Ready to review.')
  })

  it('carries the failure reason', () => {
    const notification = buildNotification({
      ...base,
      kind: 'run_failed',
      detail: 'no heartbeat for over 90s',
    })
    expect(notification.title).toContain('failed')
    expect(notification.body).toContain('no heartbeat')
  })

  it('falls back to a generic reason when a failure has none', () => {
    expect(buildNotification({ ...base, kind: 'run_failed' }).body).toMatch(/without finishing/)
  })

  it('says the run continued after an expired approval', () => {
    const notification = buildNotification({ ...base, kind: 'approval_expired', toolName: 'Bash' })
    expect(notification.body).toMatch(/auto-denied/)
    expect(notification.body).toMatch(/continued/)
  })
})
