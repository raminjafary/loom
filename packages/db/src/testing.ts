import { eq, sql } from 'drizzle-orm'
import type { Database } from './client.js'
import { auditEvent, channel, message, thread, workspace } from './schema.js'

/**
 * Test-support helpers. These live here rather than in consumers so that
 * `drizzle-orm` stays confined to this package — the boundary rule from
 * PLAN.md §4a applies to test code too.
 */

export const truncateDomainTables = async (db: Database): Promise<void> => {
  await db.execute(
    sql`truncate table ${auditEvent}, ${message}, ${thread}, ${channel} restart identity cascade`,
  )
}

export const truncateAll = async (db: Database): Promise<void> => {
  await db.execute(
    sql`truncate table ${auditEvent}, ${message}, ${thread}, ${channel}, ${workspace} restart identity cascade`,
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

/** Idempotent: returns the existing workspace for `slug`, creating it if absent. */
export const ensureWorkspace = async (
  db: Database,
  slug: string,
  name: string,
): Promise<{ id: string; created: boolean }> => {
  const existing = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.slug, slug))
    .limit(1)

  const found = existing[0]
  if (found) return { id: found.id, created: false }

  const [created] = await db
    .insert(workspace)
    .values({ name, slug })
    .returning({ id: workspace.id })
  if (!created) throw new Error(`failed to create workspace ${slug}`)
  return { id: created.id, created: true }
}
