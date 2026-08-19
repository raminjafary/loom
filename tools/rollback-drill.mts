/**
 * Phase 3b's rollback drill — the last unbuilt item in that phase's list
 * and the only thing still holding self-modification tiers 3 and 4.
 *
 * npx tsx tools/rollback-drill.mts
 * npx tsx tools/rollback-drill.mts --defect deletes-a-check
 *
 * The plan's four steps, and where each one is:
 *
 * 1. **A previously-passing manifest** — `recordManifest` below, validated by
 * `validateManifest` so an empty one (which could not fail, and would make the drill pass by
 * construction) is refused rather than recorded.
 * 2. **Promote a knowingly-broken self-modification** — `DEFECTS`, each a tier-3-shaped write
 * into Loom's own source whose defect is *chosen*. Each asserts it applied: a no-match
 * replace is a silent no-op, and a drill that patched nothing would report a clean recovery
 * from a modification it never made.
 * 3. **The manifest catches it, naming the check** — `compareToManifest`.
 * 4. **Recover with a Runner whose code is not the modified code** — `tools/rollback-recover.mjs`,
 * executed from a git worktree pinned at the manifest's commit. This script asserts the
 * recovering file's resolved path is inside that worktree and not inside the tree being
 * repaired, so the property is checked rather than claimed.
 *
 * ## Why it runs in place, and what makes that safe
 *
 * The checks need `node_modules`, and a scratch clone does not have one — installing per drill
 * would make it a thing nobody runs, and a drill nobody runs guards nothing. So it modifies this
 * repository and puts it back. Three things make that acceptable:
 *
 * - **It refuses to start on a dirty tree.** `git checkout <sha> --. && git clean -fd` is then a
 * total restore rather than a partial one, and there is no uncommitted work to lose.
 * - **Recovery runs in a `finally`.** A crash mid-drill still restores, and the exact recovery
 * command is printed at the moment the defect is applied so a human can run it by hand if this
 * process is killed outright.
 * - **`node_modules` is never touched.** `clean` without `-x` leaves ignored paths alone.
 *
 * ## Turbo's cache is disabled, and that is not incidental
 *
 * `pnpm typecheck` and `pnpm lint` go through turbo, which caches by input hash. After recovery
 * the inputs match the pre-defect run exactly, so a cached "pass" would be reported for a check
 * that never ran — a check that passes without running, which is the failure this whole drill
 * exists to be able to detect. `TURBO_FORCE=1` on every check.
 *
 * Not a test: it asserts loudly but is run by hand, and it prints what happened.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
 compareToManifest,
 validateManifest,
 type ManifestCheck,
 type RollbackManifest,
} from '../packages/domain/src/index.js'

const execFileAsync = promisify(execFile)
const REPO = resolve(new URL('..', import.meta.url).pathname)

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
 console.log(`${ok ? ' ok ': ' FAIL '} ${label}${detail ? ` — ${detail}`: ''}`)
 if (!ok) failures += 1
}

const git = async (args: string[], cwd = REPO): Promise<string> =>
 (await execFileAsync('git', ['-C', cwd,...args], { maxBuffer: 32 * 1024 * 1024 })).stdout.trim

/**
 * One entry of the manifest.
 *
 * `requires` is what makes "the modification deleted the check" a *different* outcome from "the
 * check failed". Without it, running a vitest file that no longer exists exits non-zero and reads
 * as a failure — which is nearly right and loses the distinction the comparison is built on:
 * `missing` is a check that cannot answer, and it is how a self-modification hides.
 */
interface DrillCheck {
 readonly name: string
 readonly command: string
 /** Repo-relative path the check needs. Absent means the check is reported as absent, not failed. */
 readonly requires?: string
}

/**
 * The default manifest: everything that runs with no infrastructure.
 *
 * names the 21 live drivers as the drill's material, and they are not here — every one
 * needs a live server, a Runner process and model access, and a drill that needs all three is one
 * that gets run once. They can be added with `--check`, and the honest position is written down
 * rather than implied: this manifest covers the platform's static guarantees and its
 * infrastructure-free suites, and says so.
 */
const CHECKS: readonly DrillCheck[] = [
 { name: 'typecheck', command: 'pnpm typecheck' },
 { name: 'lint', command: 'pnpm lint' },
 {
 name: 'boundary',
 command: 'npx vitest run tools/architecture.test.ts',
 requires: 'tools/architecture.test.ts',
 },
 {
 name: 'domain-suite',
 command: 'npx vitest run packages/domain',
 requires: 'packages/domain/src/index.ts',
 },
]

interface Defect {
 readonly name: string
 readonly what: string
 /** Which manifest check this is chosen to break, asserted rather than discovered. */
 readonly expects: { readonly name: string; readonly kind: 'regressed' | 'missing' }
 apply: Promise<void>
}

/** Asserts a patch applied. A no-match replace is a silent no-op — see the habit. */
const patch = async (relativePath: string, from: string, to: string): Promise<void> => {
 const path = join(REPO, relativePath)
 const before = await readFile(path, 'utf8')
 if (!before.includes(from)) {
 throw new Error(`the defect could not be applied: ${relativePath} does not contain the anchor`)
 }
 await writeFile(path, before.replace(from, to))
 const after = await readFile(path, 'utf8')
 if (after === before) throw new Error(`the defect changed nothing in ${relativePath}`)
}

const DEFECTS: readonly Defect[] = [
 {
 name: 'weakens-a-check',
 what:
 'removes the expiry check from the realtime gateway\'s token verdict — a tier-3 ' +
 'write that quietly widens a security boundary, which is the shape the security model worries about most',
 expects: { name: 'domain-suite', kind: 'regressed' },
 apply: =>
 patch(
 'packages/domain/src/subscription-token.ts',
 ' if (input.token.claims.expiresAtMs <= input.nowMs) return refused',
 ' // rollback drill: the expiry check, deliberately removed',
),
 },
 {
 name: 'deletes-a-check',
 what:
 'deletes the architectural boundary guard — the modification that removes the check which ' +
 'would have caught it, which is how a self-modification hides rather than fails',
 expects: { name: 'boundary', kind: 'missing' },
 apply: => rm(join(REPO, 'tools/architecture.test.ts')),
 },
]

const runCheck = async (entry: DrillCheck): Promise<ManifestCheck | null> => {
 if (entry.requires !== undefined && !existsSync(join(REPO, entry.requires))) return null
 try {
 const { stdout, stderr } = await execFileAsync('sh', ['-c', entry.command], {
 cwd: REPO,
 // See the header: a cached pass is a check that did not run.
 env: {...process.env, TURBO_FORCE: '1', CI: '1' },
 maxBuffer: 64 * 1024 * 1024,
 })
 return { name: entry.name, status: 'passed', detail: tail(stdout + stderr) }
 } catch (error) {
 const output = error as { stdout?: string; stderr?: string; message?: string }
 return {
 name: entry.name,
 status: 'failed',
 detail: tail(`${output.stdout ?? ''}${output.stderr ?? ''}` || (output.message ?? '')),
 }
 }
}

const tail = (text: string, lines = 4): string | null => {
 const kept = text.trimEnd.split('\n').slice(-lines).join('\n')
 return kept.length === 0 ? null: kept
}

const observe = async (selected: readonly DrillCheck[]): Promise<ManifestCheck[]> => {
 const results: ManifestCheck[] = []
 for (const entry of selected) {
 const result = await runCheck(entry)
 console.log(
 ` ${entry.name}: ${result === null ? 'absent': result.status}`,
)
 if (result !== null) results.push(result)
 }
 return results
}

const main = async => {
 const argOf = (name: string) => {
 const index = process.argv.indexOf(`--${name}`)
 return index === -1 ? null: (process.argv[index + 1] ?? null)
 }
 const only = argOf('defect')
 const selectedNames = argOf('check')?.split(',').map((name) => name.trim)
 const selected = selectedNames
 ? CHECKS.filter((entry) => selectedNames.includes(entry.name))
: CHECKS
 if (selected.length === 0) {
 console.error(`no such check. Available: ${CHECKS.map((c) => c.name).join(', ')}`)
 process.exit(2)
 }

 /**
 * Refused on a dirty tree, and this is the safety property the whole in-place design rests on:
 * `checkout --. && clean -fd` is only a *total* restore when there was nothing uncommitted to
 * begin with.
 */
 const dirty = await git(['status', '--porcelain'])
 if (dirty !== '') {
 console.error(
 'This drill modifies this repository and puts it back, so it refuses to start with\n' +
 'uncommitted changes — recovery would take yours with it. Commit or stash first.\n\n' +
 dirty,
)
 process.exit(2)
 }

 const baseCommit = await git(['rev-parse', 'HEAD'])
 console.log(`\n— step 1: the previously-passing manifest, at ${baseCommit.slice(0, 12)} —`)
 const recorded = await observe(selected)
 const valid = validateManifest({ commit: baseCommit, checks: recorded })
 if (!valid.ok) {
 console.error(`\nrefusing to record this manifest (${valid.rule}): ${valid.reason}`)
 process.exit(1)
 }
 const manifest: RollbackManifest = {
 commit: baseCommit,
 recordedAt: new Date,
 checks: recorded,
 }
 check(
 'the manifest holds something that can fail',
 manifest.checks.some((entry) => entry.status === 'passed'),
 `${manifest.checks.filter((c) => c.status === 'passed').length} passing`,
)

 /**
 * The pinned worktree — the known-good code, taken *before* anything is broken. A worktree
 * rather than a clone because it shares the object store and costs nothing, and because the
 * file that performs the recovery has to be a checkout of the manifest's commit rather than a
 * copy somebody made.
 */
 const pinned = await mkdtemp(join(tmpdir, 'loom-rollback-pinned-'))
 await rm(pinned, { recursive: true, force: true })
 await git(['worktree', 'add', '--detach', pinned, baseCommit])
 const recoverScript = join(pinned, 'tools/rollback-recover.mjs')

 try {
 check(
 'the recovery script is a checkout of the manifest\'s commit',
 existsSync(recoverScript),
 recoverScript,
)
 /**
 * The clause the plan says needed designing, asserted rather than promised: the bytes that
 * perform the recovery are not inside the tree being repaired.
 */
 check(
 'and it is not inside the tree being repaired',
 !resolve(recoverScript).startsWith(`${REPO}/`),
)

 for (const defect of DEFECTS) {
 if (only !== null && defect.name !== only) continue
 console.log(`\n— step 2: promote a knowingly-broken modification: ${defect.name} —`)
 console.log(` ${defect.what}`)
 console.log(
 ` if this process is killed, recover by hand with:\n` +
 ` node ${recoverScript} --target ${REPO} --commit ${baseCommit}`,
)
 await defect.apply
 check(
 'the defect actually changed the tree',
 (await git(['status', '--porcelain'])) !== '',
)

 console.log(`\n— step 3: the manifest catches it, by name —`)
 const broken = compareToManifest(manifest, await observe(selected))
 check('the manifest is not satisfied', broken.recovered === false, broken.detail)
 const caught = broken.regressions.find((entry) => entry.name === defect.expects.name)
 check(
 `it names ${defect.expects.name} as ${defect.expects.kind}`,
 caught?.kind === defect.expects.kind,
 caught === undefined ? `regressions: ${broken.regressions.map((r) => r.name).join(', ') || 'none'}`: caught.kind,
)

 console.log(`\n— step 4: recover, without the modified code participating —`)
 const { stdout } = await execFileAsync(
 'node',
 [recoverScript, '--target', REPO, '--commit', baseCommit],
 { maxBuffer: 8 * 1024 * 1024 },
)
 const report = JSON.parse(stdout) as { restoredTo: string; recoveredBy: string }
 check('the recovery reports the commit it restored', report.restoredTo === baseCommit)
 check(
 'and names itself as code from the pinned worktree',
 report.recoveredBy.includes(pinned),
 report.recoveredBy,
)
 check('the tree is clean again', (await git(['status', '--porcelain'])) === '')

 const after = compareToManifest(manifest, await observe(selected))
 check('every check that passed before passes again', after.recovered, after.detail)
 check(
 'and the check the defect broke is back',
 after.entries.find((entry) => entry.name === defect.expects.name)?.kind === 'held',
)
 }
 } finally {
 /**
 * Always, even on a throw. The drill's own failure must not be the thing that leaves this
 * repository broken — and `checkout`/`clean` are idempotent, so running it after a
 * successful recovery costs nothing.
 */
 try {
 await execFileAsync('node', [recoverScript, '--target', REPO, '--commit', baseCommit])
 } catch (error) {
 console.error(
 `\nRECOVERY FAILED. Restore by hand:\n git -C ${REPO} checkout ${baseCommit} --. && git -C ${REPO} clean -fd\n`,
 error,
)
 failures += 1
 }
 await git(['worktree', 'remove', '--force', pinned]).catch( => {})
 }

 console.log(failures === 0 ? '\nall checks passed': `\n${failures} check(s) failed`)
 process.exit(failures === 0 ? 0: 1)
}

await main
