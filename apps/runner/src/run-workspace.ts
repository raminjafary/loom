import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RunWorkspace {
 readonly clonePath: string
 readonly branchName: string
}

const scratchRoot = : string => process.env.LOOM_RUN_SCRATCH_ROOT ?? tmpdir

/**
 * Clone-per-run isolation: concurrent runs against the same
 * bound repository must not collide in one working tree. A worktree was
 * considered and rejected — worktrees share the parent's `.git`, so a run
 * could write `.git/hooks`/`.git/config` and affect every sibling and the
 * host repo. `core.hooksPath=/dev/null` and `core.fsmonitor=false` are set on
 * the clone itself, per the exact requirement.
 */
export const prepareRunWorkspace = async (
 sourcePath: string,
 runId: string,
): Promise<RunWorkspace> => {
 const branchName = `loom/run-${runId}`
 const clonePath = await mkdtemp(join(scratchRoot, `loom-run-${runId}-`))

 await execFileAsync('git', ['clone', '--quiet', sourcePath, clonePath])
 await execFileAsync('git', ['-C', clonePath, 'checkout', '-b', branchName])
 await execFileAsync('git', ['-C', clonePath, 'config', 'core.hooksPath', '/dev/null'])
 await execFileAsync('git', ['-C', clonePath, 'config', 'core.fsmonitor', 'false'])

 return { clonePath, branchName }
}

/** The run's branch diff against the point it was cloned from, for end-of-run review. */
export const getDiff = async (clonePath: string, defaultBranch: string): Promise<string> => {
 const { stdout } = await execFileAsync('git', [
 '-C',
 clonePath,
 'diff',
 `${defaultBranch}...HEAD`,
 ])
 return stdout
}
