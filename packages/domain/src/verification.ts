/**
 * The verification harness.
 *
 * Principle 6 says "every agent action needs a verifiable check — test, build, diff,
 * or second-agent review. 'Looks done' is not a stop condition." Until now the platform
 * had exactly one automated check, and it ran in the wrong place: the merge queue's
 * `verifyCommand`, executed *after* a human approved a merge. That is late (the human
 * reviewed an unverified branch, and reviewing is the expensive step), coarse (one
 * command, one boolean, so "the build broke" and "one test failed" are the same fact),
 * and unavailable to anything but a merge — while the tiers 3 and 4 need to verify a
 * *candidate* before promoting it, and the self-improvement loop needs a fitness that is not the run's own
 * report of itself.
 *
 * So the definition of done becomes a **named, ordered list of checks** belonging to the
 * repository, and it is one list: the merge queue runs it against the rebased branch, and
 * a finished run runs it against its own. Two lists would drift and nobody would know
 * which one the platform meant — the same argument the self-improvement loop makes for importing the * thresholds rather than restating them.
 *
 * Only the decisions live here. Running the commands is the Runner's
 * (apps/runner/src/verify.ts), because the filesystem and the sandbox are the Runner's.
 */

import { ValidationError } from './errors.js'
import type { AgentRunId, RepositoryId, RunVerificationId, WorkspaceId } from './ids.js'

/**
 * One step of a repository's definition of done.
 *
 * The name is not decoration. A verdict of "failed" is unactionable; "the build failed"
 * and "the tests failed" are different next actions for the human, and different signals
 * for the self-improvement loop — a candidate persona that breaks the build is worse than one whose tests
 * are flaky, and a single boolean cannot say so.
 */
export interface VerificationCheck {
 readonly name: string
 readonly command: string
}

/**
 * `not_run` is a real outcome rather than a missing one. The list short-circuits at the
 * first failure (see `VerificationPlan`), so the checks after it were not skipped by
 * policy — they were never reached, and a reader who cannot tell those apart will read
 * a passing-looking blank where nothing was measured.
 */
export type VerificationCheckStatus = 'passed' | 'failed' | 'not_run'

export interface VerificationCheckResult {
 readonly name: string
 readonly status: VerificationCheckStatus
 /** Tail of the command's output, and only ever the tail. Null when it was not run. */
 readonly detail: string | null
 readonly durationMs: number | null
}

/**
 * What the harness concluded about one branch.
 *
 * `skipped` and `refused` are deliberately not `failed`. A repository with no checks
 * configured has no definition of done, which is a fact about the operator's setup; a
 * refusal is the platform declining to execute agent-authored code unsandboxed.
 * Neither says anything about the branch, and collapsing them into `failed` would make
 * every unconfigured repository look like it was producing broken work.
 */
export type VerificationStatus = 'pending' | 'passed' | 'failed' | 'skipped' | 'refused' | 'error'

export const VERIFICATION_TERMINAL_STATUSES: readonly VerificationStatus[] = [
 'passed',
 'failed',
 'skipped',
 'refused',
 'error',
]

export const isVerificationTerminal = (status: VerificationStatus): boolean =>
 VERIFICATION_TERMINAL_STATUSES.includes(status)

/**
 * The platform's record of what a repository's definition of done said about one run's
 * branch — the artifact continuity mode–4 gate promotion on and the self-improvement loop scores against.
 *
 * One per run: a finished run's branch does not move, so a second verification of the
 * same head can only produce the same verdict plus a flake.
 */
export interface RunVerification {
 readonly id: RunVerificationId
 readonly workspaceId: WorkspaceId
 readonly agentRunId: AgentRunId
 readonly repositoryId: RepositoryId
 readonly branchName: string
 readonly status: VerificationStatus
 readonly commitSha: string | null
 readonly checks: readonly VerificationCheckResult[]
 readonly reason: string | null
 readonly createdAt: Date
 readonly startedAt: Date | null
 readonly finishedAt: Date | null
}

/**
 * A ceiling on how many checks a repository may define, and a short one.
 *
 * Every check is a process the platform runs per finished run and per merge, so the list
 * is a multiplier on the machine's whole workload. Eight is far above the build/test/smoke
 * Continuity mode names and far below the number at which a definition of done stops being one.
 */
export const MAX_VERIFICATION_CHECKS = 8
const MAX_CHECK_NAME_LENGTH = 40
const MAX_CHECK_COMMAND_LENGTH = 2_000

/**
 * Validates an operator's list. Refuses rather than repairs, for the reason continuity mode gives
 * about self-edits: a silently dropped check is a definition of done that quietly got
 * weaker, and the row would still read as configured.
 */
export const parseVerificationChecks = (input: readonly VerificationCheck[]): VerificationCheck[] => {
 if (input.length > MAX_VERIFICATION_CHECKS) {
 throw new ValidationError(
 `a repository may define at most ${MAX_VERIFICATION_CHECKS} verification checks (given ${input.length})`,
)
 }
 const seen = new Set<string>
 return input.map((check) => {
 const name = check.name.trim
 const command = check.command.trim
 if (name.length === 0) throw new ValidationError('a verification check needs a name')
 if (name.length > MAX_CHECK_NAME_LENGTH) {
 throw new ValidationError(`a verification check name is at most ${MAX_CHECK_NAME_LENGTH} characters`)
 }
 if (command.length === 0) throw new ValidationError(`the "${name}" check has no command`)
 if (command.length > MAX_CHECK_COMMAND_LENGTH) {
 throw new ValidationError(`the "${name}" check's command is too long`)
 }
 // Names are how a result is read and how the self-improvement loop compares one run's outcome to
 // another's. Two checks called "tests" make both meaningless.
 const key = name.toLowerCase
 if (seen.has(key)) throw new ValidationError(`two verification checks are both called "${name}"`)
 seen.add(key)
 return { name, command }
 })
}

/**
 * A repository's definition of done, from the two columns that can hold one.
 *
 * `verifyCommand` predates the harness and is every existing repository's whole
 * definition of done. It is read as a single check named `tests` rather than migrated
 * away, because an operator who set it meant it and a migration that rewrote it into a
 * list would be the platform editing a human's configuration. The explicit list wins
 * when both are set — it is the more specific statement, and it is the one an operator
 * had to open the harness to write.
 */
export const verificationChecksFor = (repository: {
 readonly verificationChecks: readonly VerificationCheck[]
 readonly verifyCommand: string | null
}): VerificationCheck[] => {
 if (repository.verificationChecks.length > 0) return repository.verificationChecks.map((c) => ({...c }))
 const command = repository.verifyCommand?.trim
 return command ? [{ name: 'tests', command }]: []
}

export type VerificationPlan =
 | {
 readonly kind: 'run'
 /**
 * Run in order, and **stop at the first failure**.
 *
 * The order is a dependency order — build, then test, then smoke — so a failed
 * build does not make the later results redundant, it makes them meaningless: a
 * test suite run against a tree that would not compile reports the compiler's
 * error again in a worse shape, and a smoke check of a binary that was never
 * built reports nothing at all. Short-circuiting also keeps the cost of the
 * harness proportional to how broken the branch is, which is the right way round.
 */
 readonly checks: readonly VerificationCheck[]
 readonly sandboxed: boolean
 }
 | { readonly kind: 'skip'; readonly reason: string }
 | { readonly kind: 'refuse'; readonly reason: string }

/**
 * Whether, and how, to run a repository's definition of done — the "run tests" step,
 * generalized from the one command the merge queue used to take.
 *
 * The non-obvious clause is `refuse`, and it is unchanged from the merge queue's own:
 * the commands are the operator's, but the *code they run* is agent-authored — a test
 * file, a `package.json` script, a `Makefile` target on the branch under verification.
 * Executing that on the Runner host is arbitrary agent code with the Runner's
 * privileges, the precise exposure the sandbox spec exists to remove. So verification runs in the
 * sandbox, and without one it needs the same explicit acknowledgement an unsandboxed
 * run needs. It is never silently downgraded to host execution.
 *
 * A repository with no checks is `skip`, not `refuse`: the queue's serialization and its
 * conflict handling are worth having on their own, and the record says which.
 */
export const planVerification = (input: {
 readonly checks: readonly VerificationCheck[]
 readonly sandboxAvailable: boolean
 readonly unsandboxedAcknowledged: boolean
}): VerificationPlan => {
 const checks = input.checks.filter((check) => check.command.trim.length > 0)
 if (checks.length === 0) {
 return { kind: 'skip', reason: 'no verification checks are configured for this repository' }
 }
 if (input.sandboxAvailable) return { kind: 'run', checks, sandboxed: true }
 if (input.unsandboxedAcknowledged) return { kind: 'run', checks, sandboxed: false }

 return {
 kind: 'refuse',
 reason:
 'Refusing to verify this branch. The verification checks would execute code from the ' +
 "agent's own branch with this Runner's privileges, and no sandbox is available. Start " +
 "the sandbox, clear the repository's verification checks to proceed unverified, or set " +
 'LOOM_ALLOW_UNSANDBOXED=i-understand-the-agent-gets-my-privileges.',
 }
}

/**
 * The verdict, from the results.
 *
 * Derived rather than reported so that the Runner cannot hand back "passed" with a
 * failing check in the list — the same reason the merge queue computes `verified`
 * itself instead of trusting a flag on the frame.
 */
export const summarizeVerification = (
 results: readonly VerificationCheckResult[],
): { readonly status: 'passed' | 'failed'; readonly failed: VerificationCheckResult | null } => {
 const failed = results.find((result) => result.status === 'failed') ?? null
 return failed ? { status: 'failed', failed }: { status: 'passed', failed: null }
}

/**
 * One line a human reads in a lane, a thread, or a notification.
 *
 * Names the *check* on failure and never only the branch. "Verification failed" sends a
 * human to open a log; "the build check failed" sends them to the build.
 */
export const describeVerification = (input: {
 readonly status: VerificationStatus
 readonly checks: readonly VerificationCheckResult[]
 readonly reason: string | null
}): string => {
 switch (input.status) {
 case 'pending':
 return 'verification has not finished'
 case 'passed': {
 const names = input.checks.filter((c) => c.status === 'passed').map((c) => c.name)
 return names.length === 0
 ? 'verification passed'
: `verification passed — ${names.join(', ')}`
 }
 case 'failed': {
 const failed = input.checks.find((c) => c.status === 'failed')
 const notRun = input.checks.filter((c) => c.status === 'not_run')
 const trailing = notRun.length === 0 ? '': ` (${notRun.map((c) => c.name).join(', ')} not reached)`
 return `the ${failed?.name ?? 'verification'} check failed${trailing}`
 }
 case 'skipped':
 return `not verified — ${input.reason ?? 'nothing to verify'}`
 case 'refused':
 return `verification refused — ${input.reason ?? 'no sandbox available'}`
 case 'error':
 return `verification could not run — ${input.reason ?? 'the Runner did not answer'}`
 }
}
