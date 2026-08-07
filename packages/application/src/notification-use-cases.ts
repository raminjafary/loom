import {
 ForbiddenError,
 ValidationError,
 isHuman,
 type Actor,
 type NotificationTarget,
 type NotificationTransport,
 type WorkspaceId,
} from '@loom/domain'
import type { NotificationPort, NotificationTargetRepositoryPort } from './ports.js'

export interface NotificationDeps {
 readonly notifications: NotificationPort
 readonly notificationTargets: NotificationTargetRepositoryPort
}

/**
 * A target is a place a specific person granted permission to be reached, so
 * only that person may register one — an agent run registering a destination
 * would be a way to send mail as the platform, which is the same class of
 * forgery identity-bound approval closes for approvals.
 */
export const registerNotificationTarget = async (
 deps: NotificationDeps,
 input: {
 workspaceId: WorkspaceId
 actor: Actor
 transport: NotificationTransport
 endpoint: string
 credentials: Record<string, string>
 },
): Promise<NotificationTarget> => {
 if (!isHuman(input.actor) || input.actor.kind !== 'user') {
 throw new ForbiddenError('Only a human may register a notification target')
 }

 const configured = deps.notifications.clientConfig
 if (configured.transport === null) {
 throw new ValidationError('Notifications are not configured on this deployment')
 }
 if (configured.transport !== input.transport) {
 throw new ValidationError(`Unsupported notification transport: ${input.transport}`)
 }

 return deps.notificationTargets.register({
 workspaceId: input.workspaceId,
 userId: input.actor.userId,
 transport: input.transport,
 endpoint: input.endpoint,
 credentials: input.credentials,
 })
}

/**
 * Idempotent, and deliberately not scoped to the registering user: a browser
 * that revoked permission must be able to clear its own endpoint, and the only
 * thing that identifies it is the endpoint itself. The endpoint is an opaque
 * high-entropy URL only its own browser holds, so knowing one is not a way to
 * enumerate anyone else's.
 */
export const unregisterNotificationTarget = async (
 deps: NotificationDeps,
 input: { workspaceId: WorkspaceId; actor: Actor; endpoint: string },
): Promise<void> => {
 if (!isHuman(input.actor)) {
 throw new ForbiddenError('Only a human may unregister a notification target')
 }
 await deps.notificationTargets.unregister(input.workspaceId, input.endpoint)
}

/** What a client needs before it can subscribe; see NotificationPort.clientConfig. */
export const getNotificationConfig = (
 deps: NotificationDeps,
): { transport: NotificationTransport | null; publicKey: string | null } =>
 deps.notifications.clientConfig
