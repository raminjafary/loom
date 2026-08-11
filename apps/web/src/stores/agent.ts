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
    refresh: () => session.refresh(),
    createPairingToken: (name: string) => session.createPairingToken(name),
    bindRepository: (input: { runnerId: string; path: string; displayName: string }) =>
      session.bindRepository(input),
    listDirectory: (input: { runnerId: string; path: string }) => session.listDirectory(input),
    createRepository: (input: {
      runnerId: string
      parentPath: string
      name: string
      displayName: string
    }) => session.createRepository(input),
    createPersona: (markdownSource: string) => session.createPersona(markdownSource),
    registerCapability: (input: Parameters<typeof session.registerCapability>[0]) =>
      session.registerCapability(input),
    removeCapability: (capabilityId: string) => session.removeCapability(capabilityId),
    attachCapability: (input: { personaId: string; capabilityId: string; allowedTools?: string[] }) =>
      session.attachCapability(input),
    detachCapability: (input: { personaId: string; capabilityId: string }) =>
      session.detachCapability(input),
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
    refreshBoard: (agentRunId: string) => session.refreshBoard(agentRunId),
    writeNote: (input: Parameters<typeof session.writeNote>[0]) => session.writeNote(input),
    setVerifyCommand: (repositoryId: string, verifyCommand: string | null) =>
      session.setVerifyCommand(repositoryId, verifyCommand),
    setInstallCommand: (repositoryId: string, installCommand: string | null) =>
      session.setInstallCommand(repositoryId, installCommand),
    warmCache: (repositoryId: string) => session.warmCache(repositoryId),
    registerNotificationTarget: (registration: PushRegistration) =>
      session.registerNotificationTarget(registration),
    unregisterNotificationTarget: (endpoint: string) =>
      session.unregisterNotificationTarget(endpoint),
    pauseAllRuns: () => session.pauseAllRuns(),
    resumeAllRuns: () => session.resumeAllRuns(),
    getRawTranscript: (agentRunId: string) => session.getRawTranscript(agentRunId),
    refreshInbox: () => session.refreshInbox(),
    inspectRun: (agentRunId: string) => session.inspectRun(agentRunId),
    dispose: () => session.dispose(),
  }
})
