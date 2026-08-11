import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * The dependency cache a sandboxed run gets.
 *
 * Repository binding: "a fresh clone plus `npm install`/build is minutes and gigabytes each — a real
 * throughput ceiling for swarms", and the risk register lists it as required before swarms are
 * useful. A run's HOME is created per run, so without this every worker in a swarm
 * re-downloads the same tree from an empty cache; N workers on one repository pay it N
 * times.
 *
 * **Two modes, and the difference is a security boundary, not a performance knob.**
 *
 * - `copy` (the default when the cache is enabled) — the run gets its *own* copy of the
 * warmed cache, writable, discarded with the run. Nothing a run writes is ever seen by
 * another run, so the cache is not a channel between sandboxes. On APFS and on
 * reflink-capable Linux filesystems the copy is metadata-only, so this costs
 * milliseconds and no extra disk for the shared blocks — which is the entire reason
 * the safe mode is also the practical one.
 * - `shared` — one directory bind-mounted into every run, read-write. Faster to warm
 * (runs fill it as they go) and **unsound**: npm's cacache stores registry HTTP
 * responses keyed by URL, so a malicious run can plant a response advertising a
 * version whose integrity hash it also controls, and a later run resolving that
 * package without a lockfile pin installs it. Content hashes do not save you here —
 * the attacker chose the hash. Opt-in, and named `shared` so choosing it is explicit.
 *
 * In `copy` mode the shared root is only ever written by `warmDepCache`, which runs an
 * operator-authored install command with no agent in the loop. That is the whole safety
 * argument: **nothing a model produced ever wrote to the cache runs inherit.**
 */

export type DepCacheMode = 'copy' | 'shared'

export interface DepCacheConfig {
 /** Host directory holding the warmed cache. */
 readonly root: string
 readonly mode: DepCacheMode
}

export const depCacheFromEnv = (env: NodeJS.ProcessEnv = process.env): DepCacheConfig | null => {
 if (env.LOOM_DEP_CACHE_ENABLED !== '1') return null
 return {
 root: env.LOOM_DEP_CACHE_ROOT ?? join(tmpdir, 'loom-dep-cache'),
 // Anything other than an explicit `shared` is `copy`. A typo must fall to the safe
 // mode, never out of it.
 mode: env.LOOM_DEP_CACHE_MODE === 'shared' ? 'shared': 'copy',
 }
}

/**
 * Copy-on-write where the filesystem allows it, a plain copy where it does not.
 *
 * `cp -c` (macOS/APFS `clonefile`) and `cp --reflink=auto` (Linux) both share blocks
 * until written, so a multi-gigabyte cache clones in milliseconds. `--reflink=auto`
 * falls back to a full copy by itself; macOS `cp -c` *fails* on a filesystem without
 * clonefile, so that one needs the fallback spelled out.
 *
 * A slow copy is the correct failure here — the alternative is silently sharing the
 * directory, which is the mode this function exists to avoid.
 */
const cloneDirectory = async (source: string, destination: string): Promise<void> => {
 const attempts =
 process.platform === 'darwin'
 ? [['-Rc', `${source}/.`, destination], ['-R', `${source}/.`, destination]]
: [['-a', '--reflink=auto', `${source}/.`, destination], ['-a', `${source}/.`, destination]]

 let lastError: unknown
 for (const args of attempts) {
 try {
 await execFileAsync('cp', args)
 return
 } catch (error) {
 lastError = error
 }
 }
 throw lastError
}

/**
 * The path to mount at the sandbox's cache directory, and how to release it.
 *
 * `release` is a no-op in `shared` mode — deleting the shared root after one run would
 * throw away every other run's cache.
 */
export interface DepCacheMount {
 readonly path: string
 readonly release: => Promise<void>
}

export const prepareDepCache = async (
 config: DepCacheConfig,
 runId: string,
): Promise<DepCacheMount> => {
 // Created here rather than left to the container runtime: docker would create a
 // missing bind-mount source as root, which the non-root agent cannot write, so the
 // cache would silently stay empty while looking configured.
 await mkdir(config.root, { recursive: true })

 if (config.mode === 'shared') {
 return { path: config.root, release: async => {} }
 }

 const copyPath = await mkdtemp(
 join(process.env.LOOM_RUN_SCRATCH_ROOT ?? tmpdir, `loom-deps-${runId}-`),
)
 await cloneDirectory(config.root, copyPath)
 return {
 path: copyPath,
 release: async => {
 await rm(copyPath, { recursive: true, force: true })
 },
 }
}

/**
 * Fills the shared cache by running the repository's install command.
 *
 * Sandboxed like everything else, but with two deliberate differences from a run: the
 * command is the **operator's**, not an agent's, and it needs the network to reach
 * package registries. So it gets the egress proxy and it writes to the shared root
 * directly — which is exactly what `copy` mode then protects, since no other writer
 * ever touches that directory.
 *
 * The clone is mounted **read-write**, and the first version of this got that wrong.
 * "A warm step has no business modifying the repository" sounds right and is not what
 * this mounts: it is a throwaway clone, discarded the moment the install finishes. The
 * operator's actual repository is never mounted at all, which is the protection that
 * matters. Read-only just broke the feature — `npm install` writes `node_modules`, so
 * every warm failed with `ENOENT: mkdir '/work/node_modules'`, found by the live check.
 */
export interface WarmDepCacheInput {
 readonly runtime: string
 readonly image: string
 readonly network: string
 readonly cacheRoot: string
 readonly clonePath: string
 readonly command: string
 readonly env: Record<string, string>
 readonly timeoutMs: number
}

export const warmDepCache = async (
 input: WarmDepCacheInput,
): Promise<{ ok: true } | { ok: false; detail: string }> => {
 await mkdir(input.cacheRoot, { recursive: true })
 const args = buildWarmArgs(input)
 return new Promise((resolve) => {
 const child = spawn(input.runtime, args, { stdio: ['ignore', 'pipe', 'pipe'] })
 let output = ''
 const capture = (chunk: Buffer) => {
 // Bounded: a chatty installer must not be able to exhaust the Runner's memory
 // through its log, and only the tail is ever reported.
 if (output.length < 1_000_000) output += chunk.toString
 }
 child.stdout.on('data', capture)
 child.stderr.on('data', capture)

 const timer = setTimeout( => {
 child.kill('SIGKILL')
 resolve({ ok: false, detail: `the install command exceeded its timeout\n${tail(output)}` })
 }, input.timeoutMs)

 child.once('error', (error) => {
 clearTimeout(timer)
 resolve({ ok: false, detail: error.message })
 })
 child.once('close', (code) => {
 clearTimeout(timer)
 resolve(code === 0 ? { ok: true }: { ok: false, detail: tail(output) })
 })
 })
}

/** Last few lines only — a thread message is not the place for a full install log. */
const tail = (text: string, lines = 12): string =>
 text.trim.split('\n').slice(-lines).join('\n').slice(0, 4_000)

export const buildWarmArgs = (input: WarmDepCacheInput): string[] => [
 'run',
 '--rm',
 '--network',
 input.network,
 '--cap-drop=ALL',
 '--security-opt=no-new-privileges',
 '--user',
 '1000:1000',
 '--read-only',
 '--tmpfs',
 '/tmp:rw,noexec,nosuid,size=1g',
 // Writable, because installers write into the project. This is a throwaway clone,
 // not the bound repository — see the note above.
 '-v',
 `${input.clonePath}:/work:rw`,
 '-v',
 `${input.cacheRoot}:${DEP_CACHE_DIR}:rw`,
 '-w',
 '/work',
...Object.entries(input.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
 '--entrypoint',
 'sh',
 input.image,
 '-c',
 input.command,
]

/** Where the cache is mounted inside the sandbox. */
export const DEP_CACHE_DIR = '/deps'

/**
 * Package managers pointed at the cache. Each of these names a cache and nothing else.
 *
 * `CARGO_HOME` is deliberately absent, and the reason generalises: it holds
 * `config.toml`, not just downloaded artifacts, and `[build] rustc-wrapper` in a shared
 * one is direct code execution in whatever run reads it next. **A directory is only
 * safe to share when it *is* a cache.**
 */
export const depCacheEnv = : Record<string, string> => ({
 npm_config_cache: `${DEP_CACHE_DIR}/npm`,
 npm_config_store_dir: `${DEP_CACHE_DIR}/pnpm`,
 YARN_CACHE_FOLDER: `${DEP_CACHE_DIR}/yarn`,
 PIP_CACHE_DIR: `${DEP_CACHE_DIR}/pip`,
 GOMODCACHE: `${DEP_CACHE_DIR}/go`,
})
