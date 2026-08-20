/**
 * Tiers 3 and 4: build a revision of Loom's own source, prove it, and make it the one that
 * serves.
 *
 *   npx tsx tools/self-promote.mts --commit <sha>
 *   LOOM_SELF_PROMOTION=1 npx tsx tools/self-promote.mts          # HEAD
 *   npx tsx tools/self-promote.mts --rollback
 *
 * **This is a separate process on purpose, and it is the same reason the rollback drill is.** The
 * thing being replaced is the platform, so a platform that promoted itself would be deciding its
 * own fate with the code under test — and swapping the pointer from inside a request handler
 * means the process that has to survive the swap is the one performing it. So the server never
 * promotes: it reads the pointer, and this script moves it.
 *
 * The gate is `promoteSelfRevision`, which lives in the domain and is unit-tested there. What
 * this file adds is the evidence that gate needs, and every piece of it is a real operation
 * rather than an assumption:
 *
 * - **Build** — a git worktree at the candidate commit plus a frozen install. Tier 4's whole
 *   content is that second step: a dependency change is only a change you can promote if the
 *   lockfile resolves the same way twice, which `--frozen-lockfile` is exactly the check for.
 * - **Health** — the built revision is *started*, on a port of its own, and asked `/healthz`
 *   until it answers. That endpoint reports whether the schema this build expects is the schema
 *   the database has, which is the failure no build can catch: a revision that typechecks,
 *   starts, binds and then fails its first query because nobody ran the migration.
 * - **Checks** — `MANIFEST_CHECKS` against the candidate's tree, compared to the same list
 *   recorded at the revision that is serving. Absent counts as failed, because a modification
 *   that deleted the check which would have caught it is how one hides.
 *
 * The swap is two writes and nothing else: the state file, by rename, and a `current` symlink.
 * A restart is somebody else's job — a supervisor, `docker compose up -d`, systemd — and this
 * script prints the command rather than guessing at one, because a promoter that killed the
 * running server would be a promoter whose failure mode is downtime it cannot report.
 *
 * Nothing here is destructive without the gate agreeing: a refused promotion leaves the built
 * revision on disk (it is the next attempt's starting point) and the pointer untouched.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  parseDeployment,
  promoteSelfRevision,
  rollbackSelfRevision,
  serializeDeployment,
  validateManifest,
  type ManifestCheck,
  type RollbackManifest,
  type SelfDeployment,
  type SelfRevision,
} from '../packages/domain/src/index.js'
import { MANIFEST_CHECKS, observeChecks, selectChecks } from './manifest-checks.mjs'

const execFileAsync = promisify(execFile)
const REPO = resolve(new URL('..', import.meta.url).pathname)

/**
 * Where revisions and the pointer live.
 *
 * Outside the repository by default, and that is not tidiness: a revision store inside the tree
 * being replaced would be deleted by the recovery it exists to serve — `git clean -fd` at a
 * pinned commit takes untracked directories with it.
 */
const ROOT = resolve(process.env.LOOM_REVISIONS_ROOT ?? join(homedir(), '.loom', 'revisions'))
const STATE_PATH = resolve(process.env.LOOM_DEPLOYMENT_STATE ?? join(ROOT, 'deployment.json'))
const CURRENT_LINK = join(ROOT, 'current')
/** A port of its own, so a health check never talks to the server that is already serving. */
const HEALTH_PORT = Number(process.env.LOOM_PROMOTE_HEALTH_PORT ?? 3199)

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const git = async (args: string[], cwd = REPO): Promise<string> =>
  (await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024 })).stdout.trim()

const argOf = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

const readState = async (): Promise<SelfDeployment> => {
  const text = await readFile(STATE_PATH, 'utf8').catch(() => null)
  if (text === null) return { running: null, previous: null }
  const parsed = parseDeployment(text)
  if (!parsed.ok) {
    console.error(`\nthe deployment state file is unusable (${parsed.rule}): ${parsed.reason}`)
    process.exit(2)
  }
  return parsed.deployment
}

/**
 * Writes the pointer by rename, the same property `fileSelfDeploymentStore` promises and for the
 * same reason: the reader that would meet a truncated file is a recovery trying to find out
 * which revision to put back.
 */
const writeState = async (next: SelfDeployment): Promise<void> => {
  await mkdir(dirname(STATE_PATH), { recursive: true })
  const staging = join(dirname(STATE_PATH), `.${process.pid}.deployment.tmp`)
  await writeFile(staging, serializeDeployment(next), 'utf8')
  await rename(staging, STATE_PATH)
}

const pathFor = (commit: string): string => join(ROOT, commit)

/** A revision is retained when its worktree and its installed dependencies are both still there. */
const retainedOnDisk = (commit: string): boolean =>
  existsSync(join(pathFor(commit), 'package.json')) && existsSync(join(pathFor(commit), 'node_modules'))

const build = async (commit: string): Promise<boolean> => {
  const target = pathFor(commit)
  if (existsSync(join(target, 'package.json'))) {
    console.log(`       worktree already at ${target}`)
  } else {
    await mkdir(ROOT, { recursive: true })
    await git(['worktree', 'add', '--detach', target, commit])
  }
  try {
    /**
     * Frozen, which is tier 4 in one flag. An install that is allowed to resolve differently from
     * the lockfile is an install whose result nobody promoted — the tree that passed the checks
     * and the tree that serves would be two different dependency graphs.
     */
    await execFileAsync('pnpm', ['install', '--frozen-lockfile'], {
      cwd: target,
      maxBuffer: 64 * 1024 * 1024,
    })
    return true
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string; message?: string }
    console.log(`       install failed: ${(output.stderr ?? output.message ?? '').slice(-400)}`)
    return false
  }
}

/**
 * Starts the built revision and asks it whether it is well.
 *
 * The server is started from the candidate's own tree, so what answers is the code being
 * promoted rather than the code doing the promoting. Killed either way: this is a rehearsal of
 * serving, not the swap.
 */
const healthOf = async (commit: string): Promise<SelfRevision['health']> => {
  const target = pathFor(commit)
  const server = spawn('npx', ['tsx', 'apps/server/src/main.ts'], {
    cwd: target,
    env: { ...process.env, SERVER_PORT: String(HEALTH_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  server.stdout.on('data', (d) => (log += String(d)))
  server.stderr.on('data', (d) => (log += String(d)))
  try {
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 1000))
      if (server.exitCode !== null) {
        console.log(`       it exited before answering: ${log.trim().split('\n').slice(-3).join(' | ')}`)
        return 'unhealthy'
      }
      const response = await fetch(`http://127.0.0.1:${HEALTH_PORT}/healthz`).catch(() => null)
      if (response === null) continue
      const body = (await response.json().catch(() => ({}))) as { status?: string; reason?: string }
      if (response.status === 200 && body.status === 'ok') return 'healthy'
      /**
       * A 503 is an answer, not a timeout, so it ends the wait rather than being retried: the
       * endpoint reports a schema this build expects and this database does not have, and waiting
       * longer will not apply a migration.
       */
      console.log(`       it answered ${response.status}: ${body.reason ?? 'no reason given'}`)
      return 'unhealthy'
    }
    console.log('       it never answered within 60s')
    return 'unhealthy'
  } finally {
    server.kill('SIGTERM')
  }
}

const swap = async (
  /** Narrowed like the gate's own result: after either gesture, something is always serving. */
  next: { running: SelfRevision; previous: SelfRevision | null },
  releasable: readonly string[],
): Promise<void> => {
  await writeState(next)
  /**
   * The symlink is for whatever restarts the platform — a supervisor's working directory rather
   * than a thing this script reads back. Replaced by rename for the pointer's reason.
   */
  const staging = `${CURRENT_LINK}.tmp`
  await rm(staging, { force: true })
  await symlink(pathFor(next.running.commit), staging)
  await rename(staging, CURRENT_LINK)
  for (const commit of releasable) {
    /**
     * Released with `git worktree remove`, not `rm -rf`: a worktree deleted behind git's back
     * leaves an administrative entry that makes the next `worktree add` at that path fail, which
     * would be a promotion refused for a reason nobody could see.
     */
    await execFileAsync('git', ['-C', REPO, 'worktree', 'remove', '--force', pathFor(commit)]).catch(
      () => rm(pathFor(commit), { recursive: true, force: true }),
    )
    console.log(`       released ${commit.slice(0, 12)}`)
  }
}

const restartHint = () =>
  console.log(
    `\nnothing has been restarted. What serves next is whatever your supervisor starts from\n` +
      `${CURRENT_LINK} — for the dev stack that is:\n\n  cd ${CURRENT_LINK} && make up\n`,
  )

const main = async () => {
  const enabled = process.env.LOOM_SELF_PROMOTION === '1'
  const deployment = await readState()
  console.log(
    `revisions at ${ROOT}\n` +
      `running  ${deployment.running?.commit.slice(0, 12) ?? '(never promoted)'}\n` +
      `previous ${deployment.previous?.commit.slice(0, 12) ?? '(none)'}`,
  )

  if (process.argv.includes('--rollback')) {
    console.log('\n— rolling back —')
    const verdict = rollbackSelfRevision({
      deployment: {
        running:
          deployment.running === null
            ? null
            : { ...deployment.running, retained: retainedOnDisk(deployment.running.commit) },
        previous:
          deployment.previous === null
            ? null
            : { ...deployment.previous, retained: retainedOnDisk(deployment.previous.commit) },
      },
    })
    if (!verdict.ok) {
      console.error(`\nrefused (${verdict.rule}): ${verdict.reason}`)
      process.exit(1)
    }
    await swap(verdict.next, verdict.releasable)
    console.log(`\n${verdict.detail}`)
    restartHint()
    return
  }

  /**
   * The permission, before any of the work.
   *
   * The gate below is still the authority — this is the same arrangement `startVariantProposer`
   * makes for a measurement already open, and for the same reason: without it a deployment with
   * promotion switched off spends an install, a server start and two full check runs to be told
   * something that was knowable at the first line.
   */
  if (!enabled) {
    console.error(
      '\nSelf-promotion is switched off here, so nothing was built and nothing was moved.\n' +
        'It is off by default and that is a real off switch rather than an unset value: set\n' +
        'LOOM_SELF_PROMOTION=1 when you have decided that a platform which can replace itself\n' +
        'is what you want.',
    )
    process.exit(1)
  }

  const candidateCommit = await git(['rev-parse', argOf('commit') ?? 'HEAD'])
  console.log(`\n— the candidate: ${candidateCommit.slice(0, 12)} —`)

  /**
   * The other refusal worth reaching early, for the reason the switch is: re-promoting what is
   * already serving is the commonest mistake (a promote run twice), and it would otherwise cost
   * an install, a server start and two full check runs before the gate says so.
   */
  if (deployment.running?.commit === candidateCommit) {
    console.error(
      `\n${candidateCommit.slice(0, 12)} is already the revision serving. Promoting it would ` +
        'change nothing and cost the way back — the revision it replaced would become the\n' +
        'rollback target of a rollback nobody could want. Nothing was built.',
    )
    process.exit(1)
  }

  /**
   * The manifest, recorded at the revision that is *serving* rather than at HEAD.
   *
   * This is the whole reason a promotion is not just "the checks pass": what a candidate has to
   * beat is what the thing it would replace could do, and on a deployment that has never
   * promoted that is this checkout — the code an operator installed by hand.
   */
  const selected = selectChecks(argOf('check'))
  if (selected.length === 0) {
    console.error(`no such check. Available: ${MANIFEST_CHECKS.map((c) => c.name).join(', ')}`)
    process.exit(2)
  }
  const baselineTree = deployment.running === null ? REPO : pathFor(deployment.running.commit)
  const baselineCommit = deployment.running?.commit ?? (await git(['rev-parse', 'HEAD']))
  console.log(`\n— what the running revision can do, at ${baselineCommit.slice(0, 12)} —`)
  const recorded = await observeChecks(selected, baselineTree)
  const valid = validateManifest({ commit: baselineCommit, checks: recorded })
  if (!valid.ok) {
    console.error(`\nrefusing to record this manifest (${valid.rule}): ${valid.reason}`)
    process.exit(1)
  }
  const manifest: RollbackManifest = {
    commit: baselineCommit,
    recordedAt: new Date(),
    checks: recorded,
  }
  check(
    'the manifest holds something a candidate could lose',
    manifest.checks.some((entry) => entry.status === 'passed'),
    `${manifest.checks.filter((entry) => entry.status === 'passed').length} passing`,
  )

  console.log(`\n— building ${candidateCommit.slice(0, 12)} —`)
  const built = await build(candidateCommit)
  check('the candidate builds with a frozen lockfile', built)

  console.log('\n— starting it, and asking whether it is well —')
  const health = built ? await healthOf(candidateCommit) : 'unhealthy'
  check('the candidate answers /healthz as a running process', health === 'healthy', health)

  console.log('\n— what the candidate can do —')
  const observed: ManifestCheck[] = built ? await observeChecks(selected, pathFor(candidateCommit)) : []

  const candidate: SelfRevision = {
    commit: candidateCommit,
    builtAt: new Date(),
    retained: retainedOnDisk(candidateCommit),
    health,
  }
  const ancestors =
    deployment.running === null
      ? []
      : (await git(['rev-list', candidateCommit])).split('\n').filter((line) => line !== '')

  const verdict = promoteSelfRevision({
    enabled,
    deployment: {
      running:
        deployment.running === null
          ? null
          : { ...deployment.running, retained: retainedOnDisk(deployment.running.commit) },
      previous: deployment.previous,
    },
    candidate,
    ancestors,
    manifest,
    observed,
  })

  console.log('\n— the gate —')
  if (!verdict.ok) {
    console.log(` FAIL  refused (${verdict.rule}): ${verdict.reason}`)
    console.log(
      `\nThe build is left at ${pathFor(candidateCommit)} and the pointer is untouched. ` +
        'Nothing was restarted.',
    )
    process.exit(1)
  }
  check('promoted', true, verdict.detail)
  await swap(verdict.next, verdict.releasable)
  restartHint()
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((error) => {
  console.error('SELF-PROMOTE FAILED', error)
  process.exit(1)
})
