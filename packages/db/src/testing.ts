import { sql } from 'drizzle-orm'
import type { Database } from './client.js'
import { auditEvent, channel, message, thread, workspace } from './schema.js'

/**
 * Test-support helpers. These live here rather than in consumers so that
 * `drizzle-orm` stays confined to this package — the boundary rule from
 * The replaceability contract applies to test code too.
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

export { ensureWorkspace } from './workspace-provisioning.js'
