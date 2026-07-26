import type {
  AgentPersona,
  AgentRun,
  ApprovalRequest,
  PersonaGroup,
  Repository,
  Runner,
} from '@loom/api-contract'
import type { LoomApi } from './api.js'

/**
 * Agent-pipeline client logic (PLAN.md §4c), separate from
 * `WorkspaceSession` — chat and agent-run state change independently and
 * mixing them would force every chat-only view to also carry run/approval
 * concerns.
 *
 * There is no realtime frame for agent-run/approval state yet (`ServerEvent`
 * only carries message/channel/thread — see workspace-session.ts). Rather
 * than extend that contract now, this session polls the real objects once it
 * knows a run exists; the chat message stream already tells a viewer that
 * *something* happened, this just hydrates the structured state behind it.
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const POLL_INTERVAL_MS = 1500

export interface AgentSnapshot {
  readonly runners: Runner[]
  readonly repositories: Repository[]
  readonly personas: AgentPersona[]
  readonly personaGroups: PersonaGroup[]
  readonly activeRun: AgentRun | null
  readonly pendingApprovals: ApprovalRequest[]
  readonly lastPairing: { runnerId: string; rawToken: string } | null
  readonly diff: string | null
  readonly loading: boolean
  readonly error: string | null
}

export interface AgentSession {
  snapshot(): AgentSnapshot
  onChange(listener: (snapshot: AgentSnapshot) => void): () => void
  init(): Promise<void>
  createPairingToken(name: string): Promise<void>
  bindRepository(input: { runnerId: string; path: string; displayName: string }): Promise<void>
  createPersona(markdownSource: string): Promise<void>
  createPersonaGroup(input: { name: string; personaIds: string[] }): Promise<void>
  updatePersonaGroup(input: { personaGroupId: string; name: string; personaIds: string[] }): Promise<void>
  deletePersonaGroup(personaGroupId: string): Promise<void>
  startRun(input: {
    threadId: string
    repositoryId: string
    personaId: string
    task?: string
  }): Promise<void>
  decide(approvalRequestId: string, decision: 'approve' | 'deny'): Promise<void>
  loadDiff(agentRunId: string): Promise<void>
  dispose(): void
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const createAgentSession = (options: { api: LoomApi }): AgentSession => {
  let state: AgentSnapshot = {
    runners: [],
    repositories: [],
    personas: [],
    personaGroups: [],
    activeRun: null,
    pendingApprovals: [],
    lastPairing: null,
    diff: null,
    loading: false,
    error: null,
  }

  const listeners = new Set<(snapshot: AgentSnapshot) => void>()
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const patch = (next: Partial<AgentSnapshot>) => {
    state = { ...state, ...next }
    for (const listener of listeners) listener(state)
  }

  const stopPolling = () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  const pollActiveRun = (agentRunId: string) => {
    stopPolling()
    pollTimer = setInterval(() => {
      void (async () => {
        try {
          const [run, pendingApprovals] = await Promise.all([
            options.api.agentRun.get({ agentRunId }),
            options.api.approval.listPending({ agentRunId }),
          ])
          patch({ activeRun: run, pendingApprovals })
          if (TERMINAL_STATUSES.has(run.status)) stopPolling()
        } catch (error) {
          patch({ error: errorMessage(error) })
          stopPolling()
        }
      })()
    }, POLL_INTERVAL_MS)
  }

  return {
    snapshot: () => state,

    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async init() {
      patch({ loading: true, error: null })
      try {
        const [runners, repositories, personas, personaGroups, activeRun] = await Promise.all([
          options.api.runner.list(),
          options.api.repository.list(),
          options.api.persona.list(),
          options.api.personaGroup.list(),
          options.api.agentRun.getActive(),
        ])
        patch({ runners, repositories, personas, personaGroups })
        // Resume watching whatever run is already active — otherwise a page
        // reload during a run leaves no path back to its approval card.
        if (activeRun && !TERMINAL_STATUSES.has(activeRun.status)) {
          const pendingApprovals = await options.api.approval.listPending({ agentRunId: activeRun.id })
          patch({ activeRun, pendingApprovals })
          pollActiveRun(activeRun.id)
        }
      } catch (error) {
        patch({ error: errorMessage(error) })
      } finally {
        patch({ loading: false })
      }
    },

    async createPairingToken(name) {
      patch({ error: null })
      try {
        const pairing = await options.api.runner.createPairingToken({ name })
        patch({ lastPairing: pairing })
        const runners = await options.api.runner.list()
        patch({ runners })
      } catch (error) {
        patch({ error: errorMessage(error) })
      }
    },

    async bindRepository(input) {
      patch({ error: null })
      try {
        await options.api.repository.bindExisting(input)
        const repositories = await options.api.repository.list()
        patch({ repositories })
      } catch (error) {
        patch({ error: errorMessage(error) })
      }
    },

    async createPersona(markdownSource) {
      patch({ error: null })
      try {
        await options.api.persona.create({ markdownSource })
        const personas = await options.api.persona.list()
        patch({ personas })
      } catch (error) {
        patch({ error: errorMessage(error) })
      }
    },

    async createPersonaGroup(input) {
      patch({ error: null })
      try {
        await options.api.personaGroup.create(input)
        const personaGroups = await options.api.personaGroup.list()
        patch({ personaGroups })
      } catch (error) {
        patch({ error: errorMessage(error) })
      }
    },

    async updatePersonaGroup(input) {
      patch({ error: null })
      try {
        await options.api.personaGroup.update(input)
        const personaGroups = await options.api.personaGroup.list()
        patch({ personaGroups })
      } catch (error) {
        patch({ error: errorMessage(error) })
      }
    },

    async deletePersonaGroup(personaGroupId) {
      patch({ error: null })
      try {
        await options.api.personaGroup.delete({ personaGroupId })
        const personaGroups = await options.api.personaGroup.list()
        patch({ personaGroups })
      } catch (error) {
        patch({ error: errorMessage(error) })
      }
    },

    async startRun(input) {
      patch({ error: null })
      try {
        const run = await options.api.agentRun.start(input)
        patch({ activeRun: run, pendingApprovals: [], diff: null })
        pollActiveRun(run.id)
      } catch (error) {
        patch({ error: errorMessage(error) })
      }
    },

    async decide(approvalRequestId, decision) {
      patch({ error: null })
      try {
        await options.api.approval.decide({ approvalRequestId, decision })
        if (state.activeRun) pollActiveRun(state.activeRun.id)
      } catch (error) {
        patch({ error: errorMessage(error) })
      }
    },

    async loadDiff(agentRunId) {
      patch({ error: null })
      try {
        const { diff } = await options.api.agentRun.getDiff({ agentRunId })
        patch({ diff })
      } catch (error) {
        patch({ error: errorMessage(error) })
      }
    },

    dispose() {
      stopPolling()
      listeners.clear()
    },
  }
}
