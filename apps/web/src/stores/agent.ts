import { createAgentSession, createApi, type AgentSnapshot } from '@loom/client-core'
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
    createPersona: (markdownSource: string) => session.createPersona(markdownSource),
    createPersonaGroup: (input: { name: string; personaIds: string[] }) =>
      session.createPersonaGroup(input),
    updatePersonaGroup: (input: { personaGroupId: string; name: string; personaIds: string[] }) =>
      session.updatePersonaGroup(input),
    deletePersonaGroup: (personaGroupId: string) => session.deletePersonaGroup(personaGroupId),
    startRun: (input: { threadId: string; repositoryId: string; personaId: string; task?: string }) =>
      session.startRun(input),
    decide: (approvalRequestId: string, decision: 'approve' | 'deny') =>
      session.decide(approvalRequestId, decision),
    loadDiff: (agentRunId: string) => session.loadDiff(agentRunId),
    dispose: () => session.dispose(),
  }
})
