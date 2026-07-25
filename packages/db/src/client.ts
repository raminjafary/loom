import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Database = ReturnType<typeof createDatabase>['db']

export const createDatabase = (connectionString: string) => {
  const sql = postgres(connectionString, { max: 10 })
  const db = drizzle(sql, { schema })
  return { db, close: async () => sql.end({ timeout: 5 }) }
}
