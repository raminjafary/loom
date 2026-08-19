import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PersonaSpecSchema } from '@loom/runner-protocol'

/**
 * Durable per-run state on the Runner's disk.
 *
 * Without this, a Runner crash mid-run loses everything needed to continue: which
 * clone the run owns, which branch, which SDK session to resume, and how far its event
 * sequence had got. The server would eventually reap the run as dead, which is correct
 * but wasteful — the work is still sitting on disk.
 *
 * Deliberately on the Runner, not the server. The clone, the container, and the SDK
 * session are all Runner-local facts; putting them in the database would make the
 * server responsible for state it cannot see or verify.
 */

export const RunStateSchema = z.object({
  runId: z.string(),
  persona: PersonaSpecSchema,
  task: z.string().optional(),
  clonePath: z.string(),
  homePath: z.string(),
  branchName: z.string(),
  defaultBranch: z.string(),
  /** Source repo the clone came from, needed for a later push. */
  sourcePath: z.string(),
  /** SDK session to resume. Absent until the session announces itself. */
  sessionId: z.string().optional(),
  /**
   * Highest event `seq` this Runner has sent for the run. On resume the counter
   * continues from here — restarting at 1 would make every new event collide with an
   * old one on the server's `(run, seq)` index and be silently dropped.
   */
  lastEventSeq: z.number().int().nonnegative(),
})

export type RunState = z.infer<typeof RunStateSchema>

const stateRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  env.LOOM_RUNNER_STATE_DIR ?? join(env.HOME ?? '/tmp', '.loom', 'runner-state')

const stateFile = (root: string, runId: string): string => join(root, `${runId}.json`)

export const saveRunState = async (state: RunState): Promise<void> => {
  const root = stateRoot()
  await mkdir(root, { recursive: true })
  // Written whole on every change rather than appended: the file is small, and a
  // partially-applied update is worse than a slightly stale one.
  await writeFile(stateFile(root, state.runId), JSON.stringify(state), 'utf8')
}

export const clearRunState = async (runId: string): Promise<void> => {
  await rm(stateFile(stateRoot(), runId), { force: true })
}

/**
 * Every run this Runner still has state for. Malformed or unreadable entries are
 * skipped rather than fatal — one corrupt file must not stop a Runner from booting and
 * recovering the others.
 */
export const listRunStates = async (): Promise<RunState[]> => {
  const root = stateRoot()
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }

  const states: RunState[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = RunStateSchema.safeParse(JSON.parse(await readFile(join(root, name), 'utf8')))
      if (parsed.success) states.push(parsed.data)
    } catch {
      // Skipped deliberately — see above.
    }
  }
  return states
}
