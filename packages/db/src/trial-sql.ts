import { sql } from 'drizzle-orm'
import { agentRun, runVerification } from './schema.js'

/**
 * The SQL every trial in this platform counts with.
 *
 * Its own module because the argument for writing it once outgrew the file it started in.
 * Four aggregates now read these fragments — the prompt trial, the map trial, the variant
 * search and the experience trial — and each of them reports an arm count a human compares
 * against the others'. Two definitions of "decided" would drift, and the first time they
 * disagreed nobody would know which one the platform meant.
 */

/**
 * What every trial counts as a run that has an outcome.
 *
 * Three ways a run is decided, and the third is the one the verification harness added:
 *
 * 1. **A disposition.** Somebody merged, pushed or discarded the branch — the judgement.
 * 2. **The run failed.** An outcome, and the arm wears it.
 * 3. **The branch failed its repository's definition of done.** No human required. A branch
 *    that does not build is decided whether or not anyone has looked at it, and waiting for
 *    a reviewer to say so would mean the measurement only ever describes runs a human had
 *    time for. Only `failed` counts: `skipped`, `refused` and `error` are facts about the
 *    operator's setup or the Runner, not about the branch, and a *pass* is not an outcome on
 *    its own — passing the checks is the floor, and only a human merging says the work was
 *    wanted.
 */
export const decidedRun = sql`(${agentRun.branchDisposition} is not null or ${agentRun.status} = 'failed' or ${runVerification.status} = 'failed')`

/**
 * The check that failed most often on this arm.
 *
 * `jsonb_path_query_first` pulls the first `failed` entry out of the verification's results —
 * the first is the only one, since the harness short-circuits at the first failure — and
 * `mode()` picks the name that came up most. Extracted rather than counted in TypeScript so
 * the aggregate stays one round trip per trial.
 */
export const modalFailingCheck = sql<
  string | null
>`mode() within group (order by jsonb_path_query_first(${runVerification.checks}, '$[*] ? (@.status == "failed")') ->> 'name') filter (where ${runVerification.status} = 'failed')`

export const verificationFailedCount = sql<
  number
>`count(*) filter (where ${runVerification.status} = 'failed')::int`
