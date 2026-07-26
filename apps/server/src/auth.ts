import { asUserId, asWorkspaceId, userActor, type Actor, type WorkspaceId } from '@loom/domain'
import { fromNodeHeaders } from 'better-auth/node'
import type { LoomAuth } from './better-auth.js'

/**
 * AuthPort — the seam every identity source drops into (PLAN.md §8).
 * `betterAuthPort` below is the real implementation; `devAuth` (see bottom)
 * remains only for tests that need to bypass Better Auth's HTTP session flow.
 */
export interface AuthPort {
  /** Resolves the calling principal. Returning null means unauthenticated. */
  resolve(headers: Record<string, string | string[] | undefined>): Promise<Principal | null>
}

export interface Principal {
  readonly actor: Actor
  readonly workspaceId: WorkspaceId
}

export interface WorkspaceMembership {
  ensureMembership(userId: string): Promise<{ workspaceId: string; created: boolean }>
}

/**
 * Real auth. Resolves a Better Auth session, then resolves that user to a
 * workspace via WorkspaceMembership — Better Auth owns identity, it does not
 * know about our workspace/member tables, so the join happens here.
 */
export const betterAuthPort = (auth: LoomAuth, membership: WorkspaceMembership): AuthPort => ({
  async resolve(headers) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) })
    if (!session) return null

    const { workspaceId } = await membership.ensureMembership(session.user.id)

    return {
      actor: userActor(asUserId(session.user.id)),
      workspaceId: asWorkspaceId(workspaceId),
    }
  },
})

const header = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null => {
  const raw = headers[name]
  if (Array.isArray(raw)) return raw[0] ?? null
  return raw ?? null
}

/**
 * Development/test-only stub. Trusts headers outright — never wire this into
 * anything reachable beyond localhost or a test harness.
 */
export const devAuth = (defaults: { userId: string; workspaceId: string }): AuthPort => ({
  async resolve(headers) {
    const userId = header(headers, 'x-loom-dev-user') ?? defaults.userId
    const workspaceId = header(headers, 'x-loom-dev-workspace') ?? defaults.workspaceId
    return {
      actor: userActor(asUserId(userId)),
      workspaceId: asWorkspaceId(workspaceId),
    }
  },
})
