import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import type { Database } from './client.js'

/**
 * Whether the schema this build expects is the schema this database has.
 *
 * Written for tier 3's health check and useful well before it. A promoted revision of Loom's
 * own source can fail in a way every check in the manifest passes: `pnpm typecheck` is green,
 * the tests are green, the process starts, it binds, it answers — and the first query against a
 * table the new code expects fails, because nobody ran the migration. That is not a bug a build
 * can catch, and it is the single most likely way a self-promotion takes a platform down.
 *
 * **The newest shipped migration, not a count.** Counting rows against journal entries looks
 * equivalent and is not: this database holds 64 applied rows against 63 journalled entries,
 * because a migration that has since been removed from the tree was applied here once. A count
 * comparison would call that healthy today and unhealthy the moment somebody prunes a migration,
 * neither of which is about the schema. The journal's `when` for an entry is written verbatim
 * into `drizzle.__drizzle_migrations.created_at`, so "has the last one this build ships been
 * applied" is an exact question with an exact answer.
 *
 * The journal is read once and kept: it is a build artifact and cannot change while a process
 * runs, and a health endpoint that stats a file per request is a health endpoint under load.
 */

interface JournalEntry {
  readonly idx: number
  readonly when: number
  readonly tag: string
}

let journal: readonly JournalEntry[] | null = null

const readJournal = (): readonly JournalEntry[] => {
  if (journal !== null) return journal
  const path = new URL('../migrations/meta/_journal.json', import.meta.url)
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: JournalEntry[] }
  journal = [...(parsed.entries ?? [])].sort((a, b) => a.idx - b.idx)
  return journal
}

export interface SchemaStatus {
  /** The newest migration this build ships, by its journal tag. Null when it ships none. */
  readonly expected: string | null
  readonly applied: boolean
  /** One sentence naming what is missing, or that nothing is. */
  readonly detail: string
}

export const schemaStatus = async (db: Database): Promise<SchemaStatus> => {
  const entries = readJournal()
  const newest = entries[entries.length - 1] ?? null
  if (newest === undefined || newest === null) {
    return {
      expected: null,
      applied: true,
      /**
       * Reported as applied rather than as an error: a build that ships no migrations has
       * nothing to be behind on, and calling that unhealthy would make a fresh checkout of a
       * migration-less branch fail its own health check.
       */
      detail: 'This build ships no migrations, so there is nothing for the database to be missing.',
    }
  }
  const rows = await db.execute<{ present: number }>(
    sql`select count(*)::int as present from drizzle.__drizzle_migrations where created_at = ${newest.when}`,
  )
  const present = Number((rows as unknown as { present: number }[])[0]?.present ?? 0) > 0
  return {
    expected: newest.tag,
    applied: present,
    detail: present
      ? `The newest migration this build ships (${newest.tag}) is applied here.`
      : `The newest migration this build ships (${newest.tag}) has not been applied to this ` +
        'database. The code expects tables or columns that are not there, so the first query ' +
        'against them fails at runtime rather than at build time. Run the migrations.',
  }
}
