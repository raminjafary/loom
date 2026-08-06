import { sql } from 'drizzle-orm'
import type { Database } from './client.js'
import {
  agentPersona,
  agentRun,
  agentRunEvent,
  approvalRequest,
  auditEvent,
  channel,
  message,
  repository,
  runner,
  thread,
  workspace,
} from './schema.js'

/**
 * Test-support helpers. These live here rather than in consumers so that
 * `drizzle-orm` stays confined to this package — the boundary rule from
 * PLAN.md §4a applies to test code too.
 *
 * `workspace` is deliberately never in this list: several test files build
 * their app/workspace once in `beforeAll` and truncate in `beforeEach` — if
 * `workspace` were included, the first truncate would delete the row every
 * later request's principal still points at, turning every subsequent insert
 * into a dangling-FK failure. `truncateAll` below is the explicit opt-in for
 * tests that really do rebuild the workspace every time.
 */

export const truncateDomainTables = async (db: Database): Promise<void> => {
  await db.execute(
    sql`truncate table ${auditEvent}, ${approvalRequest}, ${agentRunEvent}, ${agentRun}, ${agentPersona}, ${repository}, ${runner}, ${message}, ${thread}, ${channel} restart identity cascade`,
  )
}

export const truncateAll = async (db: Database): Promise<void> => {
  await db.execute(
    sql`truncate table ${auditEvent}, ${approvalRequest}, ${agentRunEvent}, ${agentRun}, ${agentPersona}, ${repository}, ${runner}, ${message}, ${thread}, ${channel}, ${workspace} restart identity cascade`,
  )
}

export const seedWorkspace = async (
  db: Database,
  slug: string,
): Promise<{ id: string }> => {
  const [row] = await db
    .insert(workspace)
    .values({ name: slug, slug })
    .returning({ id: workspace.id })
  if (!row) throw new Error('workspace seed failed')
  return row
}

export { ensureWorkspace } from './workspace-provisioning.js'
