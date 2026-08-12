import type { AgentRun } from '@loom/api-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentSession } from './agent-session.js'
import type { LoomApi } from './api.js'

/**
 * The socket-driven refresh.
 *
 * Structured run state has no realtime frame of its own and used to be chased with a
 * 1.5s interval. These are the properties that replacement has to hold: a frame
 * refreshes immediately, a burst of frames refreshes once, and the interval behind it
 * is a safety net rather than the mechanism.
 */

const run = (status: string): AgentRun =>
 ({
 id: 'run-1',
 workspaceId: 'w1',
 threadId: 't1',
 repositoryId: 'r1',
 status,
 persona: { name: 'swe' },
 totalCostUsd: null,
 }) as unknown as AgentRun

const stubApi = (status = 'running') => {
 const get = vi.fn(async => run(status))
 const listPending = vi.fn(async => [])
 const listActive = vi.fn(async => [run(status)])
 const board = vi.fn(async => null)
 const listByTree = vi.fn(async => [])
 return {
 calls: { get, listPending, listActive, board },
 api: {
 agentRun: { get, listActive },
 approval: { listPending },
 workerNote: { board, listByTree },
 } as unknown as LoomApi,
 }
}

beforeEach( => {
 vi.useFakeTimers
})

afterEach( => {
 vi.useRealTimers
})

describe('noteRealtimeActivity', => {
 it('does nothing before a run is being watched', async => {
 const { api, calls } = stubApi
 const session = createAgentSession({ api })

 session.noteRealtimeActivity
 await vi.advanceTimersByTimeAsync(500)

 expect(calls.get).not.toHaveBeenCalled
 session.dispose
 })

 it('refreshes the watched run as soon as a frame arrives', async => {
 const { api, calls } = stubApi
 const session = createAgentSession({ api })
 await session.watchRun('run-1')
 calls.get.mockClear

 session.noteRealtimeActivity
 await vi.advanceTimersByTimeAsync(200)

 expect(calls.get).toHaveBeenCalledTimes(1)
 // Well inside the old 1.5s tick, which is the point of the change.
 expect(calls.listPending).toHaveBeenCalled
 session.dispose
 })

 it('coalesces a burst of frames into one refresh', async => {
 const { api, calls } = stubApi
 const session = createAgentSession({ api })
 await session.watchRun('run-1')
 calls.get.mockClear

 // A tool call, its result and an assistant line all land inside one tick.
 for (let i = 0; i < 12; i += 1) session.noteRealtimeActivity
 await vi.advanceTimersByTimeAsync(200)

 expect(calls.get).toHaveBeenCalledTimes(1)
 session.dispose
 })

 it('keeps a slow interval underneath, for what posts no message at all', async => {
 const { api, calls } = stubApi
 const session = createAgentSession({ api })
 await session.watchRun('run-1')
 calls.get.mockClear

 // A merge queue advancing on the server's own sweep produces no thread
 // message, so something still has to look.
 await vi.advanceTimersByTimeAsync(10_500)

 expect(calls.get).toHaveBeenCalledTimes(1)
 session.dispose
 })

 /**
 * The frames keep coming — a workspace is a chat room — so the nudge has to be
 * about whether anything is *running*, not about whether anyone is talking.
 * Otherwise an ordinary message in an idle workspace costs five requests.
 */
 it('ignores frames once the watched run is done and nothing else is active', async => {
 const get = vi.fn(async => run('completed'))
 const api = {
 agentRun: { get, listActive: async => [] },
 approval: { listPending: async => [] },
 workerNote: { board: async => null, listByTree: async => [] },
 } as unknown as LoomApi

 const session = createAgentSession({ api })
 await session.watchRun('run-1')
 get.mockClear

 session.noteRealtimeActivity
 await vi.advanceTimersByTimeAsync(30_000)

 expect(get).not.toHaveBeenCalled
 session.dispose
 })

 /**
 * Stopping on the watched run alone would freeze the swarm view at whatever it
 * looked like when that one finished — which is exactly when the siblings it
 * spawned are the interesting part.
 */
 it('keeps following frames after the watched run finishes, while a sibling runs', async => {
 let watchedStatus = 'running'
 const get = vi.fn(async => run(watchedStatus))
 const api = {
 agentRun: { get, listActive: async => [run('running')] },
 approval: { listPending: async => [] },
 workerNote: { board: async => null, listByTree: async => [] },
 } as unknown as LoomApi

 const session = createAgentSession({ api })
 await session.watchRun('run-1')
 get.mockClear

 watchedStatus = 'completed'
 session.noteRealtimeActivity
 await vi.advanceTimersByTimeAsync(200)
 expect(get).toHaveBeenCalledTimes(1)

 session.noteRealtimeActivity
 await vi.advanceTimersByTimeAsync(200)
 expect(get).toHaveBeenCalledTimes(2)
 expect(session.snapshot.activeRuns).toHaveLength(1)
 session.dispose
 })

 it('drops a pending refresh on dispose rather than firing into a torn-down view', async => {
 const { api, calls } = stubApi
 const session = createAgentSession({ api })
 await session.watchRun('run-1')
 calls.get.mockClear

 session.noteRealtimeActivity
 session.dispose
 await vi.advanceTimersByTimeAsync(1_000)

 expect(calls.get).not.toHaveBeenCalled
 })
})

/**
 * Bylines for runs the thread has outlived.
 *
 * A thread outlives the runs in it, so history is full of authors this client has no
 * name for. Resolution is cheap and deduped; what matters is what happens when it
 * cannot succeed — a run whose row was cascaded away by a deleted repository or
 * runner. Left unrecorded, the byline shows a bare id, the client re-asks on every
 * render of that page, and a human cannot tell "still loading" from "gone".
 */
describe('resolvePersonaNames', => {
 it('names a run it can read', async => {
 vi.useRealTimers
 const { api, calls } = stubApi
 const session = createAgentSession({ api })
 await session.resolvePersonaNames(['run-1'])
 expect(session.snapshot.personaNameByRunId['run-1']).toBe('swe')
 expect(calls.get).toHaveBeenCalledTimes(1)
 session.dispose
 })

 it('records a run it cannot read, rather than leaving a bare id in the byline', async => {
 vi.useRealTimers
 const get = vi.fn(async => {
 throw new Error('not found')
 })
 const session = createAgentSession({
 api: {
 agentRun: { get, listActive: vi.fn(async => []) },
 approval: { listPending: vi.fn(async => []) },
 workerNote: { board: vi.fn(async => null), listByTree: vi.fn(async => []) },
 } as unknown as LoomApi,
 })
 await session.resolvePersonaNames(['d353eac8-0000-4000-8000-000000000000'])
 const label = session.snapshot.personaNameByRunId['d353eac8-0000-4000-8000-000000000000']
 // Reads as prose, and keeps the id — the only handle a human has for correlating
 // the line with anything else.
 expect(label).toBe('former run d353eac8')
 session.dispose
 })

 it('asks once per run, however often a thread re-renders', async => {
 vi.useRealTimers
 const { api, calls } = stubApi
 const session = createAgentSession({ api })
 await session.resolvePersonaNames(['run-1'])
 await session.resolvePersonaNames(['run-1', 'run-1'])
 expect(calls.get).toHaveBeenCalledTimes(1)
 session.dispose
 })
})

/**
 * Per-surface fetch errors (see `AgentSnapshot.fetchErrors`).
 *
 * The property under test is not "an error is recorded" — the global `error` already
 * did that. It is that a panel can tell **"empty" apart from "failed"**, because the
 * Inbox rendering "Nothing needs you right now" on a failed fetch is the one false
 * statement in this app that costs a human something.
 */
describe('fetchErrors', => {
 const inboxApi = (listNeedsAttention: => Promise<unknown>) =>
 ({
 agentRun: { listNeedsAttention },
 mergeQueue: { list: async => [] },
 }) as unknown as LoomApi

 it('starts with every surface clear', => {
 const session = createAgentSession({ api: stubApi.api })
 expect(session.snapshot.fetchErrors).toEqual({
 inbox: null,
 board: null,
 cost: null,
 diff: null,
 })
 session.dispose
 })

 it('records an inbox failure on the inbox, not only in the banner', async => {
 const session = createAgentSession({
 api: inboxApi(async => {
 throw new Error('backend down')
 }),
 })
 await session.refreshInbox
 expect(session.snapshot.fetchErrors.inbox).toBe('backend down')
 // The list is still empty — which is precisely why the flag has to exist.
 expect(session.snapshot.needsAttention).toEqual([])
 session.dispose
 })

 it('clears the inbox error once a fetch succeeds', async => {
 let fail = true
 const session = createAgentSession({
 api: inboxApi(async => {
 if (fail) throw new Error('backend down')
 return []
 }),
 })
 await session.refreshInbox
 expect(session.snapshot.fetchErrors.inbox).toBe('backend down')
 fail = false
 await session.refreshInbox
 expect(session.snapshot.fetchErrors.inbox).toBeNull
 session.dispose
 })

 it('does not let one surface clear another', async => {
 // `patch` replaces `fetchErrors` wholesale, so a surface writing its own key
 // without spreading the rest would silently wipe the other three.
 let fail = true
 const session = createAgentSession({
 api: {
 agentRun: {
 listNeedsAttention: async => {
 if (fail) throw new Error('inbox down')
 return []
 },
 getDiff: async => {
 throw new Error('diff down')
 },
 },
 mergeQueue: { list: async => [] },
 } as unknown as LoomApi,
 })
 await session.refreshInbox
 await session.loadDiff('run-1')
 expect(session.snapshot.fetchErrors.diff).toBe('diff down')
 expect(session.snapshot.fetchErrors.inbox).toBe('inbox down')

 fail = false
 await session.refreshInbox
 expect(session.snapshot.fetchErrors.inbox).toBeNull
 expect(session.snapshot.fetchErrors.diff).toBe('diff down')
 session.dispose
 })
})

/**
 * What the kill switch killed.
 *
 * `runControl.pauseAll` has always returned `cancelledRunIds`; the client destructured
 * `{ control }` and dropped it, so the button said "Runs paused" and never what it had
 * stopped.
 */
describe('lastPauseCancelledCount', => {
 const pauseApi = (cancelledRunIds: string[]) =>
 ({
 runControl: {
 pauseAll: async => ({
 control: { workspaceId: 'w1', paused: true, pausedAt: new Date, pausedByUserId: 'u1' },
 cancelledRunIds,
 }),
 resume: async => ({
 workspaceId: 'w1',
 paused: false,
 pausedAt: null,
 pausedByUserId: null,
 }),
 },
 agentRun: { listNeedsAttention: async => [] },
 mergeQueue: { list: async => [] },
 }) as unknown as LoomApi

 it('is null before any pause, which is not the same as zero', => {
 const session = createAgentSession({ api: stubApi.api })
 expect(session.snapshot.lastPauseCancelledCount).toBeNull
 session.dispose
 })

 it('reports how many runs the pause actually cancelled', async => {
 const session = createAgentSession({ api: pauseApi(['a', 'b', 'c']) })
 await session.pauseAllRuns
 expect(session.snapshot.lastPauseCancelledCount).toBe(3)
 session.dispose
 })

 it('reports zero rather than nothing when a pause killed nothing', async => {
 // A real and reassuring answer: the switch was pressed and there was nothing running.
 const session = createAgentSession({ api: pauseApi([]) })
 await session.pauseAllRuns
 expect(session.snapshot.lastPauseCancelledCount).toBe(0)
 session.dispose
 })

 it('forgets the count on resume', async => {
 // "3 runs stopped" beside a Resume button reads as a claim about what is starting.
 const session = createAgentSession({ api: pauseApi(['a', 'b', 'c']) })
 await session.pauseAllRuns
 await session.resumeAllRuns
 expect(session.snapshot.lastPauseCancelledCount).toBeNull
 session.dispose
 })
})
