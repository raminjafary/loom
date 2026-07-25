import { createDatabase, ensureWorkspace } from '@loom/db'
import { loadConfig } from './config.js'

/**
 * Creates the development workspace the dev auth stub points at, and prints its
 * id. Idempotent, so it is safe to run repeatedly.
 */

const config = loadConfig()
const { db, close } = createDatabase(config.DATABASE_URL)

const { id, created } = await ensureWorkspace(db, 'dev', 'Dev Workspace')

process.stdout.write(`${created ? 'created' : 'found'} dev workspace\n`)
process.stdout.write(`LOOM_DEV_WORKSPACE_ID=${id}\n`)

await close()
