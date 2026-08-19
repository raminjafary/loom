import type { ThreadView } from '@loom/client-core'
import {
  createApi,
  createWorkspaceSession,
  type WorkspaceSnapshot,
} from '@loom/client-core'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'

/**
 * Pinia holds view state and forwards intent. All logic lives in
 * `@loom/client-core`, which is what keeps Vue (and Pinia itself) a swappable
 * detail rather than the place the app actually lives.
 */

const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'http://localhost:3001/rpc'
const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3002/ws/client'

export const useWorkspaceStore = defineStore('workspace', () => {
  const api = createApi({ rpcUrl: RPC_URL })
  const session = createWorkspaceSession({ api, wsUrl: WS_URL })

  // shallowRef: snapshots are replaced wholesale, never mutated in place, so
  // deep reactivity would only add proxy overhead on every message.
  const snapshot = shallowRef<WorkspaceSnapshot>(session.snapshot())
  const started = ref(false)

  session.onChange((next) => {
    snapshot.value = next
  })

  const start = async () => {
    if (started.value) return
    started.value = true
    await session.init()
  }

  return {
    snapshot,
    start,
    selectChannel: (channelId: string) => session.selectChannel(channelId),
    openThread: (threadId: string) => session.openThread(threadId),
    /** What the thread shows. */
    setThreadView: (view: ThreadView, focusRunId?: string) =>
      session.setThreadView(view, focusRunId),
    createChannel: (name: string) => session.createChannel(name),
    deleteChannel: (input: { channelId: string; acknowledge?: boolean }) =>
      session.deleteChannel(input),
    send: (text: string) => session.send(text),
    loadOlderMessages: () => session.loadOlderMessages(),
    onServerEvent: (listener: Parameters<typeof session.onServerEvent>[0]) =>
      session.onServerEvent(listener),
    dispose: () => session.dispose(),
  }
})
