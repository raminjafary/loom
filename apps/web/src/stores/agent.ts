import {
  createAgentSession,
  createApi,
  type AgentSnapshot,
  type PushRegistration,
} from '@loom/client-core'
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
    watchRun: (agentRunId: string) => session.watchRun(agentRunId),
    decide: (approvalRequestId: string, decision: 'approve' | 'deny') =>
      session.decide(approvalRequestId, decision),
    loadDiff: (agentRunId: string) => session.loadDiff(agentRunId),
    keepRun: (agentRunId: string) => session.keepRun(agentRunId),
    discardRun: (agentRunId: string) => session.discardRun(agentRunId),
    pushRun: (agentRunId: string, acknowledgeCiChange?: boolean) =>
      session.pushRun(agentRunId, acknowledgeCiChange),
    enqueueMerge: (agentRunId: string) => session.enqueueMerge(agentRunId),
    cancelMerge: (entryId: string) => session.cancelMerge(entryId),
    refreshMergeQueue: () => session.refreshMergeQueue(),
    setVerifyCommand: (repositoryId: string, verifyCommand: string | null) =>
      session.setVerifyCommand(repositoryId, verifyCommand),
    registerNotificationTarget: (registration: PushRegistration) =>
      session.registerNotificationTarget(registration),
    unregisterNotificationTarget: (endpoint: string) =>
      session.unregisterNotificationTarget(endpoint),
    pauseAllRuns: () => session.pauseAllRuns(),
    resumeAllRuns: () => session.resumeAllRuns(),
    refreshInbox: () => session.refreshInbox(),
    inspectRun: (agentRunId: string) => session.inspectRun(agentRunId),
    dispose: () => session.dispose(),
  }
})
