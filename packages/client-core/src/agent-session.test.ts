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
