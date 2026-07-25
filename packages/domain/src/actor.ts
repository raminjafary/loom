import type { AgentRunId, UserId } from './ids.js'

/**
 * Anti-forgery primitive. Always resolved server-side from the
 * authenticated principal — never accepted from a client or agent payload.
 * Approval resolution requires `kind: 'user'`; nothing else may open a gate.
 */
export type Actor =
 | { readonly kind: 'user'; readonly userId: UserId }
 | { readonly kind: 'agent_run'; readonly agentRunId: AgentRunId }
 | { readonly kind: 'system' }

export const userActor = (userId: UserId): Actor => ({ kind: 'user', userId })
export const agentRunActor = (agentRunId: AgentRunId): Actor => ({ kind: 'agent_run', agentRunId })
export const systemActor = : Actor => ({ kind: 'system' })

export const isHuman = (actor: Actor): boolean => actor.kind === 'user'

export const actorRef = (actor: Actor): string => {
 switch (actor.kind) {
 case 'user':
 return `user:${actor.userId}`
 case 'agent_run':
 return `agent_run:${actor.agentRunId}`
 case 'system':
 return 'system'
 }
}
