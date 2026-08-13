import {
 createAgentSession,
 createApi,
 type AgentSnapshot,
 type PushRegistration,
 type RunActivity,
} from '@loom/client-core'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'

const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'http://localhost:3001/rpc'

export const useAgentStore = defineStore('agent', => {
 const api = createApi({ rpcUrl: RPC_URL })
 const session = createAgentSession({ api })

 const snapshot = shallowRef<AgentSnapshot>(session.snapshot)
 const started = ref(false)

 session.onChange((next) => {
 snapshot.value = next
 })

 const start = async => {
 if (started.value) return
 started.value = true
 await session.init
 }

 return {
 snapshot,
 start,
 refresh: => session.refresh,
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
 // The mastery. Not in the snapshot: expertise is per persona and a workspace has
 // many, so folding every map in would put an unbounded read on app open.
 listPersonaMaps: (personaId: string) => session.listPersonaMaps(personaId),
 getMastery: (mapId: string) => session.getMastery(mapId),
 listRepositoryMaps: (repositoryId: string) => session.listRepositoryMaps(repositoryId),
 /** Which maps one run read, and which it was deliberately denied. */
 listWorkspaceMaps: => session.listWorkspaceMaps,
 listColosseumSessions: => session.listColosseumSessions,
 getColosseumSession: (sessionId: string) => session.getColosseumSession(sessionId),
 conveneColosseum: (input: Parameters<typeof session.conveneColosseum>[0]) =>
 session.conveneColosseum(input),
 recordColosseumClaim: (input: Parameters<typeof session.recordColosseumClaim>[0]) =>
 session.recordColosseumClaim(input),
 settleColosseumClaim: (input: Parameters<typeof session.settleColosseumClaim>[0]) =>
 session.settleColosseumClaim(input),
 concludeColosseum: (sessionId: string) => session.concludeColosseum(sessionId),
 curateMap: (mapId: string) => session.curateMap(mapId),
 listExpertiseUsedByRuns: (agentRunIds: readonly string[]) =>
 session.listExpertiseUsedByRuns(agentRunIds),
 setMapRetrieval: (mapId: string, override: 'on' | 'off' | null) =>
 session.setMapRetrieval(mapId, override),
 startMastery: (input: Parameters<typeof session.startMastery>[0]) =>
 session.startMastery(input),

 parsePersona: (markdownSource: string) => session.parsePersona(markdownSource),
 previewDelegation: (input: Parameters<typeof session.previewDelegation>[0]) =>
 session.previewDelegation(input),
 updatePersona: (input: { personaId: string; markdownSource: string }) =>
 session.updatePersona(input),
 deletePersona: (personaId: string) => session.deletePersona(personaId),
 resetPersonaToBuiltin: (personaId: string) => session.resetPersonaToBuiltin(personaId),
 unbindRepository: (input: { repositoryId: string; acknowledge?: boolean }) =>
 session.unbindRepository(input),
 removeRunner: (runnerId: string) => session.removeRunner(runnerId),
 registerCapability: (input: Parameters<typeof session.registerCapability>[0]) =>
 session.registerCapability(input),
 removeCapability: (capabilityId: string) => session.removeCapability(capabilityId),
 attachCapability: (input: { personaId: string; capabilityId: string; allowedTools?: string[] }) =>
 session.attachCapability(input),
 detachCapability: (input: { personaId: string; capabilityId: string }) =>
 session.detachCapability(input),
 createPersonaGroup: (input: { name: string; personaIds: string[] }) =>
 session.createPersonaGroup(input),
 updatePersonaGroup: (input: {
 personaGroupId: string
 name: string
 personaIds: string[]
 layout?: Record<string, { x: number; y: number }>
 fleet?: Record<string, number>
 reviewers?: Record<string, string[]>
 orchestratorId?: string | null
 }) => session.updatePersonaGroup(input),
 deletePersonaGroup: (personaGroupId: string) => session.deletePersonaGroup(personaGroupId),
 // Typed from the session rather than restated: the local copy had already fallen
 // behind `responseStyle`, `model` and `budgetCapUsd`, and a store that silently
 // drops a field is worse than one that will not compile.
 startRun: (input: Parameters<typeof session.startRun>[0]) => session.startRun(input),
 watchRun: (agentRunId: string) => session.watchRun(agentRunId),
 decide: (approvalRequestId: string, decision: 'approve' | 'deny', answer?: string) =>
 session.decide(approvalRequestId, decision, answer),
 steer: (agentRunId: string, message: string) => session.steer(agentRunId, message),
 loadDiff: (agentRunId: string) => session.loadDiff(agentRunId),
 keepRun: (agentRunId: string) => session.keepRun(agentRunId),
 discardRun: (agentRunId: string) => session.discardRun(agentRunId),
 pushRun: (agentRunId: string, acknowledgeCiChange?: boolean) =>
 session.pushRun(agentRunId, acknowledgeCiChange),
 enqueueMerge: (agentRunId: string, override?: boolean) =>
 session.enqueueMerge(agentRunId, override),
 cancelMerge: (entryId: string) => session.cancelMerge(entryId),
 refreshMergeQueue: => session.refreshMergeQueue,
 refreshBoard: (agentRunId: string) => session.refreshBoard(agentRunId),
 refreshCostSummary: (windowHours?: number | null) => session.refreshCostSummary(windowHours),
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
 pauseAllRuns: => session.pauseAllRuns,
 resumeAllRuns: => session.resumeAllRuns,
 getRawTranscript: (agentRunId: string) => session.getRawTranscript(agentRunId),
 refreshInbox: => session.refreshInbox,
 inspectRun: (agentRunId: string) => session.inspectRun(agentRunId),
 noteRealtimeActivity: => session.noteRealtimeActivity,
 noteRunActivity: (activity: RunActivity, treeRunId: string) =>
 session.noteRunActivity(activity, treeRunId),
 resolvePersonaNames: (agentRunIds: readonly string[]) =>
 session.resolvePersonaNames(agentRunIds),
 dispose: => session.dispose,
 }
})
