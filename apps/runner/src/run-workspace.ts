import { classifyPushEffect } from '@loom/domain'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RunWorkspace {
  readonly clonePath: string
  readonly branchName: string
  /**
   * Host-backed HOME for the run's sandbox. Exists so the SDK's session transcript
   * (`$HOME/.claude/projects`) outlives the container — without it the session id in
   * the Runner's state file names a transcript that was destroyed, and resumption after
   * a restart is impossible (PLAN.md §7 Phase 1).
   */
  readonly homePath: string
}

const scratchRoot = (): string => process.env.LOOM_RUN_SCRATCH_ROOT ?? tmpdir()

/**
 * Clone-per-run isolation (PLAN.md §5a): concurrent runs against the same
 * bound repository must not collide in one working tree. A worktree was
 * considered and rejected — worktrees share the parent's `.git`, so a run
 * could write `.git/hooks`/`.git/config` and affect every sibling and the
 * host repo. `core.hooksPath=/dev/null` and `core.fsmonitor=false` are set on
 * the clone itself, per §5a's exact requirement.
 */
export const prepareRunWorkspace = async (
  sourcePath: string,
  runId: string,
): Promise<RunWorkspace> => {
  const branchName = `loom/run-${runId}`
  const clonePath = await mkdtemp(join(scratchRoot(), `loom-run-${runId}-`))
  const homePath = await mkdtemp(join(scratchRoot(), `loom-home-${runId}-`))
  // The sandbox runs as uid 1000, which is not the Runner's uid on Linux. Docker
  // Desktop maps ownership on bind mounts, but a plain Linux host does not, so the
  // directory is made group/other-writable rather than silently unwritable there.
  await chmod(homePath, 0o777)

  await execFileAsync('git', ['clone', '--quiet', sourcePath, clonePath])
  await execFileAsync('git', ['-C', clonePath, 'checkout', '-b', branchName])
  await execFileAsync('git', ['-C', clonePath, 'config', 'core.hooksPath', '/dev/null'])
  await execFileAsync('git', ['-C', clonePath, 'config', 'core.fsmonitor', 'false'])

  return { clonePath, branchName, homePath }
}

/** The run's branch diff against the point it was cloned from, for end-of-run review (PLAN.md §5a). */
export const getDiff = async (clonePath: string, defaultBranch: string): Promise<string> => {
  const { stdout } = await execFileAsync('git', [
    '-C',
    clonePath,
    'diff',
    `${defaultBranch}...HEAD`,
  ])
  return stdout
}

/**
 * Removes a run's scratch clone after a human discards the branch on DiffView, and its
 * host-backed HOME with it — that directory holds the SDK session transcript, which is
 * a record of the run and should not outlive the branch a human just discarded.
 */
export const discardRunWorkspace = async (clonePath: string, homePath?: string): Promise<void> => {
  await rm(clonePath, { recursive: true, force: true })
  if (homePath) await rm(homePath, { recursive: true, force: true })
}

interface ParsedRemote {
  readonly host: string
  readonly owner: string
  readonly repo: string
}

/** Handles both `git@host:owner/repo.git` and `https://host/owner/repo.git` forms. */
const parseGitRemoteUrl = (url: string): ParsedRemote | null => {
  const ssh = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
  if (ssh?.[1] && ssh[2] && ssh[3]) return { host: ssh[1], owner: ssh[2], repo: ssh[3] }

  try {
    const parsed = new URL(url)
    const [owner, repo] = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/')
    if (!owner || !repo) return null
    return { host: parsed.hostname, owner, repo }
  } catch {
    return null
  }
}

export type PushResult =
  | { readonly ok: true; readonly prUrl?: string; readonly compareUrl?: string; readonly warning?: string }
  | { readonly ok: false; readonly error: string }

/**
 * Host-side push + best-effort PR/MR open (PLAN.md §6 A2). The agent never
 * holds git credentials or pushes — this runs on the Runner host, outside
 * any sandbox, using whatever git/`gh`/`glab` auth already exists there. The
 * push target is always exactly `refs/heads/<branchName>` (the run's own
 * trusted branch, never agent- or client-supplied) as a plain push, never
 * force, never a tag — there is no code path here that could do otherwise.
 */
export const pushRunBranch = async (
  sourcePath: string,
  clonePath: string,
  branchName: string,
  defaultBranch: string,
  acknowledgeCiChange: boolean,
): Promise<PushResult> => {
  let remoteUrl: string
  try {
    remoteUrl = (await execFileAsync('git', ['-C', sourcePath, 'remote', 'get-url', 'origin'])).stdout.trim()
  } catch {
    return { ok: false, error: 'Repository has no configured remote — nothing to push to' }
  }

  const { stdout: changedRaw } = await execFileAsync('git', [
    '-C',
    clonePath,
    'diff',
    '--name-only',
    `${defaultBranch}...HEAD`,
  ])
  const changedPaths = changedRaw.split('\n').filter((line) => line.length > 0)
  const verdict = classifyPushEffect(changedPaths, acknowledgeCiChange)
  if (!verdict.ok) return { ok: false, error: verdict.reason }

  await execFileAsync('git', ['-C', clonePath, 'push', remoteUrl, `HEAD:refs/heads/${branchName}`])

  const parsed = parseGitRemoteUrl(remoteUrl)
  if (!parsed) return { ok: true, warning: 'Pushed, but the remote URL could not be parsed for a PR link' }

  const { host, owner, repo } = parsed

  if (host === 'github.com') {
    try {
      const { stdout } = await execFileAsync('gh', [
        'pr',
        'create',
        '--repo',
        `${owner}/${repo}`,
        '--head',
        branchName,
        '--base',
        defaultBranch,
        '--title',
        `Loom: ${branchName}`,
        '--body',
        `Opened by Loom for branch \`${branchName}\`.`,
      ])
      return { ok: true, prUrl: stdout.trim() }
    } catch (error) {
      return {
        ok: true,
        compareUrl: `https://github.com/${owner}/${repo}/compare/${defaultBranch}...${branchName}`,
        warning: `Pushed, but PR creation failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  if (host === 'gitlab.com') {
    try {
      const { stdout } = await execFileAsync('glab', [
        'mr',
        'create',
        '--repo',
        `${owner}/${repo}`,
        '--source-branch',
        branchName,
        '--target-branch',
        defaultBranch,
        '--title',
        `Loom: ${branchName}`,
        '--description',
        `Opened by Loom for branch \`${branchName}\`.`,
        '--yes',
      ])
      return { ok: true, prUrl: stdout.trim() }
    } catch (error) {
      return {
        ok: true,
        compareUrl: `https://gitlab.com/${owner}/${repo}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${branchName}&merge_request%5Btarget_branch%5D=${defaultBranch}`,
        warning: `Pushed, but MR creation failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  return { ok: true, warning: `Pushed. No PR/MR was opened — unrecognized git host: ${host}` }
}
