import { describe, expect, it } from 'vitest'
import {
 describeVerification,
 isVerificationTerminal,
 MAX_VERIFICATION_CHECKS,
 parseVerificationChecks,
 planVerification,
 summarizeVerification,
 verificationChecksFor,
 type VerificationCheckResult,
} from './verification.js'
import { ValidationError } from './errors.js'

const result = (
 name: string,
 status: VerificationCheckResult['status'],
 detail: string | null = null,
): VerificationCheckResult => ({ name, status, detail, durationMs: null })

describe('planVerification', => {
 it('runs the checks in the sandbox when one is available', => {
 expect(
 planVerification({
 checks: [{ name: 'tests', command: 'pnpm -r test' }],
 sandboxAvailable: true,
 unsandboxedAcknowledged: false,
 }),
).toEqual({ kind: 'run', checks: [{ name: 'tests', command: 'pnpm -r test' }], sandboxed: true })
 })

 /**
 * The clause worth guarding by name, and it is the merge queue's own, generalized.
 * The commands are operator-configured but the code they execute is on the agent's
 * branch, so running them on the host is agent code with the Runner's privileges
 * — and at run end it happens with nobody watching at all.
 */
 it('refuses to verify on the host without an explicit acknowledgement', => {
 expect(
 planVerification({
 checks: [{ name: 'tests', command: 'pnpm -r test' }],
 sandboxAvailable: false,
 unsandboxedAcknowledged: false,
 }).kind,
).toBe('refuse')
 })

 it('verifies unsandboxed only when the operator acknowledged the exposure', => {
 const plan = planVerification({
 checks: [{ name: 'tests', command: 'pnpm -r test' }],
 sandboxAvailable: false,
 unsandboxedAcknowledged: true,
 })
 expect(plan).toEqual({
 kind: 'run',
 checks: [{ name: 'tests', command: 'pnpm -r test' }],
 sandboxed: false,
 })
 })

 // Proceeding unverified is allowed — the queue's ordering and conflict handling are
 // worth having alone — but the record has to say so rather than claim a pass.
 it('skips when nothing is configured, rather than refusing', => {
 expect(
 planVerification({ checks: [], sandboxAvailable: true, unsandboxedAcknowledged: false }).kind,
).toBe('skip')
 })

 it('treats a whitespace-only command as no check at all', => {
 expect(
 planVerification({
 checks: [{ name: 'tests', command: ' ' }],
 sandboxAvailable: true,
 unsandboxedAcknowledged: false,
 }).kind,
).toBe('skip')
 })

 it('keeps the operator\'s order, because it is a dependency order', => {
 const plan = planVerification({
 checks: [
 { name: 'build', command: 'pnpm build' },
 { name: 'tests', command: 'pnpm test' },
 { name: 'smoke', command: 'node dist/main.js --version' },
 ],
 sandboxAvailable: true,
 unsandboxedAcknowledged: false,
 })
 expect(plan.kind === 'run' && plan.checks.map((c) => c.name)).toEqual(['build', 'tests', 'smoke'])
 })
})

describe('verificationChecksFor', => {
 /**
 * Every repository that existed before the harness has its whole definition of done
 * in `verifyCommand`. Reading it as a check rather than migrating it away is what
 * keeps the harness from being a feature only new repositories have.
 */
 it('reads a lone verifyCommand as a check named tests', => {
 expect(verificationChecksFor({ verificationChecks: [], verifyCommand: 'pnpm -r test' })).toEqual([
 { name: 'tests', command: 'pnpm -r test' },
 ])
 })

 it('prefers the explicit list when both are set', => {
 expect(
 verificationChecksFor({
 verificationChecks: [{ name: 'build', command: 'pnpm build' }],
 verifyCommand: 'pnpm -r test',
 }),
).toEqual([{ name: 'build', command: 'pnpm build' }])
 })

 it('is empty for a repository with no definition of done', => {
 expect(verificationChecksFor({ verificationChecks: [], verifyCommand: null })).toEqual([])
 expect(verificationChecksFor({ verificationChecks: [], verifyCommand: ' ' })).toEqual([])
 })
})

describe('parseVerificationChecks', => {
 it('trims and keeps order', => {
 expect(
 parseVerificationChecks([
 { name: ' build ', command: ' pnpm build ' },
 { name: 'tests', command: 'pnpm test' },
 ]),
).toEqual([
 { name: 'build', command: 'pnpm build' },
 { name: 'tests', command: 'pnpm test' },
 ])
 })

 // A duplicate name makes both results unreadable — and the self-improvement loop compares runs by
 // check name, so it would make two different measurements the same measurement.
 it('refuses two checks with the same name, case-insensitively', => {
 expect( =>
 parseVerificationChecks([
 { name: 'Tests', command: 'a' },
 { name: 'tests', command: 'b' },
 ]),
).toThrow(ValidationError)
 })

 it('refuses a check with no command, rather than dropping it', => {
 expect( => parseVerificationChecks([{ name: 'tests', command: ' ' }])).toThrow(ValidationError)
 })

 it('refuses a check with no name', => {
 expect( => parseVerificationChecks([{ name: ' ', command: 'pnpm test' }])).toThrow(ValidationError)
 })

 it('caps the list', => {
 const many = Array.from({ length: MAX_VERIFICATION_CHECKS + 1 }, (_, i) => ({
 name: `check-${i}`,
 command: 'true',
 }))
 expect( => parseVerificationChecks(many)).toThrow(ValidationError)
 })
})

describe('summarizeVerification', => {
 it('passes only when every check that ran passed', => {
 expect(summarizeVerification([result('build', 'passed'), result('tests', 'passed')])).toEqual({
 status: 'passed',
 failed: null,
 })
 })

 /**
 * Derived here rather than reported by the Runner, for the reason the merge queue
 * computes `verified` itself: a frame carrying `ok: true` beside a failing check is
 * a version skew, and the verdict must come from the results a human can read.
 */
 it('fails on a failing check even if later checks were never reached', => {
 const summary = summarizeVerification([
 result('build', 'failed', 'error TS2345'),
 result('tests', 'not_run'),
 ])
 expect(summary.status).toBe('failed')
 expect(summary.failed?.name).toBe('build')
 })

 it('does not treat a not_run check as a failure on its own', => {
 expect(summarizeVerification([result('tests', 'not_run')]).status).toBe('passed')
 })
})

describe('describeVerification', => {
 // "Verification failed" sends a human to open a log. Naming the check sends them
 // to the thing that broke.
 it('names the failing check and what was never reached', => {
 const text = describeVerification({
 status: 'failed',
 checks: [result('build', 'failed'), result('tests', 'not_run'), result('smoke', 'not_run')],
 reason: null,
 })
 expect(text).toContain('build')
 expect(text).toContain('tests, smoke')
 expect(text).toContain('not reached')
 })

 it('keeps skipped and refused distinguishable from failed', => {
 expect(
 describeVerification({ status: 'skipped', checks: [], reason: 'no checks configured' }),
).toContain('no checks configured')
 expect(
 describeVerification({ status: 'refused', checks: [], reason: 'no sandbox' }),
).toContain('refused')
 })
})

describe('isVerificationTerminal', => {
 it('treats every outcome but pending as terminal', => {
 expect(isVerificationTerminal('pending')).toBe(false)
 for (const status of ['passed', 'failed', 'skipped', 'refused', 'error'] as const) {
 expect(isVerificationTerminal(status)).toBe(true)
 }
 })
})
