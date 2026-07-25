import { eq } from 'drizzle-orm'
import type { Database } from './client.js'
import { workspace } from './schema.js'

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
