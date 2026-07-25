import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as authSchema from './auth-schema.js'
import * as domainSchema from './schema.js'

// Merged so Better Auth's drizzleAdapter can resolve `db.query.user` etc.
// alongside the domain tables on the same client.
const schema = { ...domainSchema, ...authSchema }

export type Database = ReturnType<typeof createDatabase>['db']

export const createDatabase = (connectionString: string) => {
  const sql = postgres(connectionString, { max: 10 })
  const db = drizzle(sql, { schema })
  return { db, close: async () => sql.end({ timeout: 5 }) }
}
