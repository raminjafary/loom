import { asUserId, asWorkspaceId, userActor, type Actor, type WorkspaceId } from '@loom/domain'

/**
 * AuthPort — the seam Better Auth drops into.
 *
 * IMPORTANT: `devAuth` below is a development stub, NOT an auth implementation.
 * It trusts headers, which means anyone who can reach the port is any user they
 * claim to be. It exists so the contract, realtime path, and actor plumbing can
 * be exercised end to end while Better Auth is wired in behind this same
 * interface. It must be deleted before this is exposed beyond localhost.
 */
export interface AuthPort {
 /** Resolves the calling principal. Returning null means unauthenticated. */
 resolve(headers: Record<string, string | string[] | undefined>): Promise<Principal | null>
}

export interface Principal {
 readonly actor: Actor
 readonly workspaceId: WorkspaceId
}

const header = (
 headers: Record<string, string | string[] | undefined>,
 name: string,
): string | null => {
 const raw = headers[name]
 if (Array.isArray(raw)) return raw[0] ?? null
 return raw ?? null
}

export const devAuth = (defaults: {
 userId: string
 workspaceId: string
}): AuthPort => ({
 async resolve(headers) {
 const userId = header(headers, 'x-loom-dev-user') ?? defaults.userId
 const workspaceId = header(headers, 'x-loom-dev-workspace') ?? defaults.workspaceId
 return {
 actor: userActor(asUserId(userId)),
 workspaceId: asWorkspaceId(workspaceId),
 }
 },
})
