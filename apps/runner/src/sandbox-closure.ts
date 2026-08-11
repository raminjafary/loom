/**
 * What the agent host's source closure *is*, and what it hashes to.
 *
 * Two problems, one walk, and both were paid for rather than anticipated.
 *
 * **1. The closure must be complete.** Dockerfile.sandbox copies agent-side sources one
 * file at a time, deliberately: the Runner's client, workspace prep and push policy stay
 * out of the image because the push policy depends on the agent being unable to reach them. A
 * blanket `COPY src/ src/` would be shorter and would hand the agent the host-side half
 * of the system. The price of the explicit list is that a new import breaks the image,
 * silently — tsx fails to resolve it inside a container whose logs nobody reads.
 *
 * **2. The image must not be stale.** This is the one that actually cost a session. The
 * worker-notes tools and the Planner's `submit_plan` were absent from every
 * sandboxed run for days, because the image predated them and rebuilding it is a manual
 * step. Nothing failed. Runs completed, work was committed, cost was metered, and the
 * model — told to call `write_note` and offered no such tool — invented a substitute by
 * writing a markdown file into the clone, which is the one place the worker-notes design says notes
 * must never go. A green suite proved nothing, because the suite exercises host-side
 * code and the container was running a different, older copy of it.
 *
 * So the same walk answers both: it defines the file set the image needs, and hashes it
 * into a digest the Runner can compare against the digest baked into the image. Drift
 * between the source tree and the image becomes a refused run with a reason, instead of
 * a run that quietly lacks half its tools.
 *
 * Run directly (`tsx sandbox-closure.ts <entry> [--emit <path>]`) it is the build-time
 * check; imported, it is the host side of the runtime comparison.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

/**
 * Matches `from './x.js'` in import and re-export positions. Only relative specifiers:
 * a bare specifier is a dependency npm already installed, and the image's install step
 * would have failed if it were missing.
 */
const RELATIVE_IMPORT = /from\s+['"](\.[^'"]*)['"]/g

export interface ClosureResult {
 /** Absolute paths, sorted, entry included. */
 readonly files: string[]
 /** `<importer> imports <specifier>` for each unresolved relative import. */
 readonly missing: string[]
}

export const walkClosure = (entry: string): ClosureResult => {
 const seen = new Set<string>
 const missing: string[] = []

 const visit = (file: string): void => {
 if (seen.has(file)) return
 seen.add(file)
 for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) {
 const specifier = match[1] as string
 // Sources are TypeScript but import each other with the `.js` extension ESM
 // requires at runtime, so a specifier never names the file on disk.
 const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'))
 if (existsSync(target)) visit(target)
 else missing.push(`${basename(file)} imports ${specifier}`)
 }
 }

 visit(entry)
 return { files: [...seen].sort, missing }
}

/**
 * A digest of the closure's *contents*, stable across the host tree and the image.
 *
 * Keyed by basename rather than full path — the same file is `apps/runner/src/x.ts` on
 * the host and `/app/src/x.ts` in the image, and a digest that disagreed about that
 * would report drift on every single run and train an operator to ignore it.
 */
export const closureDigest = (entry: string): string => {
 const { files } = walkClosure(entry)
 const hash = createHash('sha256')
 for (const file of files) {
 hash.update(basename(file))
 hash.update('\0')
 hash.update(readFileSync(file))
 hash.update('\0')
 }
 return hash.digest('hex')
}

/** Where the build writes the image's own digest, and where the Runner reads it back. */
export const IMAGE_DIGEST_PATH = '/app/closure-digest'

const main = : void => {
 const args = process.argv.slice(2)
 const entry = args.find((arg) => !arg.startsWith('--'))
 if (entry === undefined) {
 console.error('usage: sandbox-closure.ts <entry.ts> [--emit <path>]')
 process.exit(1)
 }

 const { files, missing } = walkClosure(resolve(entry))
 if (missing.length > 0) {
 console.error("sandbox image: the agent host's import closure is incomplete.")
 console.error('Add the missing file(s) to the COPY list in apps/runner/Dockerfile.sandbox,')
 console.error('after checking each is genuinely agent-side and not host-side.\n')
 for (const line of missing) console.error(` ${line}`)
 process.exit(1)
 }

 const digest = closureDigest(resolve(entry))
 const emitIndex = args.indexOf('--emit')
 if (emitIndex !== -1) {
 const target = args[emitIndex + 1]
 if (target === undefined) {
 console.error('--emit needs a path')
 process.exit(1)
 }
 writeFileSync(target, digest)
 }
 console.log(`agent host import closure complete (${files.length} files), digest ${digest.slice(0, 12)}`)
}

// `tsx a.ts` leaves argv[1] as the resolved script path; only run as a CLI.
if (process.argv[1] !== undefined && basename(process.argv[1]) === 'sandbox-closure.ts') main
