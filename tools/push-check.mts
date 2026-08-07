/**
 * Sends one real web push to every notification target registered in a
 * workspace. A hand-run check, like e2e-run.mts, not a test.
 *
 * Exists because the automated suite cannot cover the last leg: the adapter's
 * RFC 8291 encryption, the VAPID signature a push service actually validates,
 * and whether apps/web's service worker renders what arrives. Everything before
 * that — the fan-out, the pruning, the contract — is tested; this is the part
 * that only a browser can confirm.
 *
 * Prerequisites: `docker compose up -d`, VAPID keys in .env, and a browser that
 * has clicked "Enable notifications" at least once.
 *
 *   set -a && . ./.env && set +a
 *   npx tsx tools/push-check.mts [workspace-slug]
 */
import { asAgentRunId, asWorkspaceId, buildNotification } from '../packages/domain/src/index.js'
import {
  createDatabase,
  ensureWorkspace,
  notificationTargetRepository,
} from '../packages/db/src/index.js'
import { webPushNotificationPort } from '../apps/server/src/notifications.js'

const slug = process.argv[2] ?? 'dev'
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://loom:loom@localhost:5432/loom'

const { publicKey, privateKey, subject } = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT ?? 'mailto:operator@localhost',
}

if (!publicKey || !privateKey) {
  console.error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set — see .env.example')
  process.exit(1)
}

const { db, close } = createDatabase(databaseUrl)

// `created: true` means the slug was a typo — bail rather than pushing into an
// empty workspace this script just invented.
const workspaceRow = await ensureWorkspace(db, slug, slug)
if (workspaceRow.created) {
  console.error(`no workspace with slug "${slug}" existed (one was just created — check the slug)`)
  await close()
  process.exit(1)
}
const workspaceId = asWorkspaceId(workspaceRow.id)

const targets = notificationTargetRepository(db)
const before = await targets.listByWorkspace(workspaceId)
console.log(`workspace ${slug} (${workspaceId}) has ${before.length} target(s):`)
for (const target of before) console.log(`  ${target.transport} ${target.endpoint.slice(0, 60)}…`)

const port = webPushNotificationPort({
  targets,
  keys: { publicKey, privateKey, subject },
  log: (event) => console.log('  ', event),
})

await port.deliver(
  buildNotification({
    workspaceId,
    runId: asAgentRunId(process.env.RUN_ID ?? 'push-check'),
    kind: 'approval_needed',
    personaName: 'Push check',
    toolName: 'Bash',
  }),
)

const after = await targets.listByWorkspace(workspaceId)
console.log(
  `delivered. ${after.length} target(s) remain` +
    (after.length < before.length ? ' — a dead subscription was pruned' : ''),
)

await close()
