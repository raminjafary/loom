import { createAgentSession, createApi, type AgentSnapshot } from '@loom/client-core'
import type { PersonaSpec } from '@loom/api-contract'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'

const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'http://localhost:3001/rpc'

export const useAgentStore = defineStore('agent', () => {
  const api = createApi({ rpcUrl: RPC_URL })
  const session = createAgentSession({ api })

  const snapshot = shallowRef<AgentSnapshot>(session.snapshot())
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
    createPairingToken: (name: string) => session.createPairingToken(name),
    bindRepository: (input: { runnerId: string; path: string; displayName: string }) =>
      session.bindRepository(input),
    startRun: (input: { threadId: string; repositoryId: string; persona: PersonaSpec }) =>
      session.startRun(input),
    decide: (approvalRequestId: string, decision: 'approve' | 'deny') =>
      session.decide(approvalRequestId, decision),
    dispose: () => session.dispose(),
  }
})
