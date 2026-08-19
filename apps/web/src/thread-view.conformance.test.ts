import { messageInView as domainInView, THREAD_VIEWS } from '@loom/domain'
import { messageInView as clientInView } from '@loom/client-core'
import { describe, expect, it } from 'vitest'

/**
 * The guard on the second thing `client-core` duplicates.
 *
 * The server filters a thread in its query; the client filters what arrives live over the
 * socket, which never went through that query. Both need the same rule and `client-core`
 * may not import `@loom/domain`, so there are two implementations — and the way that goes
 * wrong is silent and specific: if the client's copy drifts *wider*, a quiet thread
 * refills with the firehose; if it drifts *narrower*, a live approval line never appears
 * and a run waits until the reaper takes it.
 *
 * Lives in `apps/web` for the reason `persona-form.conformance.test.ts` does — it is the
 * only place that can see both sides, and `@loom/domain` is a devDependency here imported
 * by no source file.
 */

const actors = [
  { kind: 'system' as const },
  { kind: 'user' as const, userId: 'u1' as never },
  { kind: 'agent_run' as const, agentRunId: 'r1' as never },
  { kind: 'agent_run' as const, agentRunId: 'r2' as never },
]

describe('the thread view rule, on both sides of the boundary', () => {
  it('agrees for every view, every author, focused and unfocused', () => {
    for (const view of THREAD_VIEWS) {
      for (const author of actors) {
        for (const focus of [undefined, 'r1']) {
          expect({
            view,
            author: author.kind,
            focus,
            allowed: clientInView({ author }, view, focus),
          }).toEqual({
            view,
            author: author.kind,
            focus,
            allowed: domainInView({ author }, view, focus),
          })
        }
      }
    }
  })

  /**
   * Named separately because it is the one that must never regress in the narrow
   * direction: a blocking line is system-authored, and losing it from the headline is the
   * failure mid-flight steering exists to prevent.
   */
  it('keeps the platform"s voice in the headline on both sides', () => {
    expect(clientInView({ author: { kind: 'system' } }, 'headline')).toBe(true)
    expect(domainInView({ author: { kind: 'system' } }, 'headline')).toBe(true)
  })
})
