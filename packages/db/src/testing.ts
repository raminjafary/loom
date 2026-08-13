import { sql, type SQL } from 'drizzle-orm'
import type { Database } from './client.js'
import {
 agentPersona,
 agentRun,
 agentRunEvent,
 approvalRequest,
 colosseumClaim,
 colosseumParticipant,
 colosseumSession,
 colosseumTurn,
 expertiseUse,
 masteryCheckpoint,
 noteReadEdge,
 subjectMap,
 subjectMapEdge,
 subjectMapNode,
 auditEvent,
 channel,
 message,
 notificationTarget,
 repository,
 runner,
 thread,
 workspace,
} from './schema.js'

/**
 * Test-support helpers. These live here rather than in consumers so that
 * `drizzle-orm` stays confined to this package — the boundary rule from
 * The replaceability contract applies to test code too.
 *
 * `workspace` is deliberately never in this list: several test files build
 * their app/workspace once in `beforeAll` and truncate in `beforeEach` — if
 * `workspace` were included, the first truncate would delete the row every
 * later request's principal still points at, turning every subsequent insert
 * into a dangling-FK failure. `truncateAll` below is the explicit opt-in for
 * tests that really do rebuild the workspace every time.
 */

/**
 * Retries a truncate that deadlocked, and only that.
 *
 * **A deadlock here is a property of the test harness, not of the product.** `truncate`
 * takes `ACCESS EXCLUSIVE` on every table it names, while a run's own writes are still
 * landing — an integration test asserts on the last thing it cares about and returns,
 * and the events, notes and trial rows behind that assertion are still being written when
 * the next test's `beforeEach` starts clearing. The two acquire the same tables in
 * different orders, and Postgres resolves that by killing one of them.
 *
 * The alternative was making every test wait for silence, which is both impossible to
 * state precisely ("silence" is not observable from outside) and the wrong trade: it
 * would slow every test in the suite to fix a failure whose only symptom is a retryable
 * error. Every *other* error is rethrown immediately, so a real failure is never
 * swallowed — the retry is keyed to `40P01`, which is the deadlock and nothing else.
 */
const RETRYABLE = new Set(['40P01', '40001'])

const truncateWithRetry = async (db: Database, statement: SQL): Promise<void> => {
 for (let attempt = 0;; attempt += 1) {
 try {
 await db.execute(statement)
 return
 } catch (error) {
 const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ??
 (error as { code?: string }).code
 if (attempt >= 4 || !code || !RETRYABLE.has(code)) throw error
 // Short and increasing: the write it collided with is milliseconds from finishing.
 await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
 }
 }
}

export const truncateDomainTables = async (db: Database): Promise<void> => {
 await truncateWithRetry(
 db,
 sql`truncate table ${auditEvent}, ${approvalRequest}, ${agentRunEvent}, ${masteryCheckpoint}, ${colosseumTurn}, ${colosseumClaim}, ${colosseumParticipant}, ${colosseumSession}, ${expertiseUse}, ${subjectMapEdge}, ${subjectMapNode}, ${subjectMap}, ${noteReadEdge}, ${agentRun}, ${agentPersona}, ${repository}, ${runner}, ${message}, ${notificationTarget}, ${thread}, ${channel} restart identity cascade`,
)
}

export const truncateAll = async (db: Database): Promise<void> => {
 await truncateWithRetry(
 db,
 sql`truncate table ${auditEvent}, ${approvalRequest}, ${agentRunEvent}, ${masteryCheckpoint}, ${colosseumTurn}, ${colosseumClaim}, ${colosseumParticipant}, ${colosseumSession}, ${expertiseUse}, ${subjectMapEdge}, ${subjectMapNode}, ${subjectMap}, ${noteReadEdge}, ${agentRun}, ${agentPersona}, ${repository}, ${runner}, ${message}, ${notificationTarget}, ${thread}, ${channel}, ${workspace} restart identity cascade`,
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
