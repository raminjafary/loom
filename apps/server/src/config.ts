import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const EnvSchema = z.object({
 DATABASE_URL: z.string.default('postgres://loom:loom@localhost:5432/loom'),
 VALKEY_URL: z.string.default('redis://localhost:6379'),
 SERVER_PORT: z.coerce.number.int.default(3001),
 WEB_ORIGIN: z.string.default('http://localhost:5173'),
 NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
 BETTER_AUTH_SECRET: z.string.min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
 BETTER_AUTH_URL: z.string.default('http://localhost:3001'),
 /**
 * Shared with apps/ws-gateway, and the only thing standing in front of a workspace's
 * entire agent transcript. This server
 * signs subscription tokens with it; the gateway verifies them and holds nothing else.
 *
 * Deliberately not `BETTER_AUTH_SECRET`: sharing that one would put the session-signing
 * key in a stateless fan-out service that has no business holding it. Validated like
 * `LOOM_EGRESS_CONTROL_SECRET` for the same reason — a copied example value is not a
 * secret, and being merely *set* is not a check.
 */
 WS_SUBSCRIPTION_SECRET: z
.string
.min(32, 'WS_SUBSCRIPTION_SECRET must be at least 32 characters')
.refine((secret) => !/change-me|changeme|your-secret|placeholder|example/i.test(secret), {
 message:
 'WS_SUBSCRIPTION_SECRET still looks like the example value. It is the whole ' +
 'authentication of /ws/client — generate one with `openssl rand -base64 32`.',
 }),
 // Dead-run reaper — see agent-use-cases.ts's
 // reapStuckRuns for how the two timeouts are used.
 REAPER_INTERVAL_MS: z.coerce.number.int.positive.default(30_000),
 REAPER_HEARTBEAT_TIMEOUT_MS: z.coerce.number.int.positive.default(90_000),
 REAPER_NO_PROGRESS_TIMEOUT_MS: z.coerce.number.int.positive.default(600_000),
 // Approval SLA — how long a risky-tool gate may sit undecided
 // before it auto-denies and the run resumes. Swept on the reaper's interval.
 // Independent of REAPER_NO_PROGRESS_TIMEOUT_MS by design: a run waiting on a
 // human is excluded from the no-progress signal (see reapStuckRuns), so this
 // is the only clock that governs an `awaiting_approval` run.
 APPROVAL_SLA_MS: z.coerce.number.int.positive.default(900_000),
 // Web push. All three optional together:
 // with none set, the notification adapter reports itself unconfigured and the
 // UI says so, rather than offering a subscribe button that cannot work.
 // Generate a pair with `npx web-push generate-vapid-keys`.
 VAPID_PUBLIC_KEY: z.string.optional,
 VAPID_PRIVATE_KEY: z.string.optional,
 // Identifies the operator to the push service, which uses it to contact
 // whoever is sending if something goes wrong. `mailto:` or an https URL.
 VAPID_SUBJECT: z.string.default('mailto:operator@localhost'),
 // How many runs may be active in one workspace at once. Phase 1 hardcoded one.
 //
 // Was 3, on the stated grounds that it matches the own experiment — three workers
 // on one repo. That reasoning still holds and the number no longer follows from it,
 // because the corporation put *planner* runs above those workers and they are active at the
 // same time: a root plus two areas already fills a limit of 3 before a single worker
 // starts, so a corporation was silently truncated to whichever subtree got there
 // first. Observed live — one sub-planner finished having started nothing.
 //
 // 6 is three workers plus the planners above them, which is the same experiment with
 // the tree the corporation actually produces. Still deliberately small: concurrency
 // multiplies both spend and the human attention the riskiest assumption is about, so it should be raised
 // knowingly rather than defaulted high. Raise it with `MAX_DELEGATION_DEPTH`, never
 // separately — depth without width is what starves a subtree.
 MAX_CONCURRENT_RUNS_PER_WORKSPACE: z.coerce.number.int.positive.default(6),
 // How many delegation hops may separate a run from the root of its tree. 1 is the flat fan-out Phase 2 shipped: a Planner and its
 // workers, nothing below them. The default of 2 admits exactly one layer of
 // sub-planners — a root that delegates areas, sub-planners that decompose them,
 // workers that do the units — and stops there. Depth is the axis that multiplies
 // cost fastest, because each hop is a frontier-model run whose only output is more
 // runs; raising it should be a decision, like the concurrency limit beside it.
 MAX_DELEGATION_DEPTH: z.coerce.number.int.positive.default(2),
 // How long an entry may sit `merging` before the queue gives up on it. This is the merge queue's equivalent of the dead-run reaper, and
 // it exists for a specific failure: a server that dies mid-merge leaves a
 // `merging` row that the unique partial index makes unclaimable, so that
 // repository's queue would stall permanently with nothing to notice it.
 //
 // Longer than the gateway's own merge timeout, so a Runner that is merely slow
 // is failed by the request that is actually watching it rather than by a sweep
 // that cannot tell slow from dead.
 // Where the raw transcript tier's blobs live. A directory
 // rather than a database because these are append-once chunks nobody queries —
 // putting them in Postgres is exactly what the event-tiering design says does not survive ten
 // concurrent swarm runs.
 BLOB_STORAGE_ROOT: z.string.default('.loom-blobs'),
 MERGE_STUCK_TIMEOUT_MS: z.coerce.number.int.positive.default(1_800_000),
})

export type Config = z.infer<typeof EnvSchema>

const DEFAULT_TEST_DATABASE_URL = 'postgres://loom:loom@localhost:5432/loom_test'

/**
 * Integration tests run against real Postgres, not a mock — but never
 * against the same database a developer might be using the app against by
 * hand. Under `NODE_ENV=test`, `DATABASE_URL` is always overridden to a
 * separate test database (`TEST_DATABASE_URL`, defaulted like `DATABASE_URL`
 * itself is) so `pnpm -r test` can never truncate a live dev workspace.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
 const config = EnvSchema.parse(env)
 if (config.NODE_ENV === 'test') {
 return {
...config,
 DATABASE_URL: env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
 // Same reasoning as the database override directly above: a test run must
 // never write transcript blobs into a directory a developer is using, and
 // must never be able to delete one.
 BLOB_STORAGE_ROOT: env.TEST_BLOB_STORAGE_ROOT ?? join(tmpdir, 'loom-test-blobs'),
 }
 }
 return config
}
