import { and, eq } from 'drizzle-orm'
import type { Database } from './client.js'
import { ensureWorkspace } from './workspace-provisioning.js'
import { workspaceMember } from './schema.js'

/**
 * Phase 1 scope cut, documented deliberately: every authenticated user
 * auto-joins one default workspace on first login. Multi-workspace
 * membership/switching is real feature work,
 * not something to half-build under this task.
 */
export const ensureWorkspaceMembership = async (
 db: Database,
 userId: string,
 defaults: { slug: string; name: string },
): Promise<{ workspaceId: string }> => {
 const { id: workspaceId } = await ensureWorkspace(db, defaults.slug, defaults.name)

 const existing = await db
.select({ id: workspaceMember.id })
.from(workspaceMember)
.where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
.limit(1)

 if (!existing[0]) {
 await db.insert(workspaceMember).values({ workspaceId, userId, role: 'member' })
 }

 return { workspaceId }
}
