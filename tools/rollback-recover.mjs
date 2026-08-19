/**
 * Restores a working tree to a commit.
 *
 * node <pinned-worktree>/tools/rollback-recover.mjs --target <dir> --commit <sha>
 *
 * This file is the answer to the drill's one clause that needed designing rather than
 * assembling: *recover with a Runner whose code is not the modified code.* The property is
 * structural rather than promised, and it rests on three things:
 *
 * 1. **It is executed from a git worktree pinned at the manifest's commit**, so the bytes that
 * run are the bytes that were known good. `rollback-drill.mts` asserts the resolved path of
 * this script is inside that worktree and not inside the tree being repaired.
 * 2. **Plain `.mjs` on Node's standard library** — no `tsx`, no `@loom/*`, no `node_modules` at
 * all. A recovery that imported the platform would be the modified code participating in its
 * own rollback, one layer down, and a recovery that needed a dependency install would be
 * unusable in exactly the situation where a dependency change is what broke things (tier 4).
 * 3. **It restores from git and computes nothing.** The commit is supplied; the content comes
 * from the object store. There is no logic here for a modification to have corrupted.
 *
 * Deliberately not a Loom capability, and not reachable from the contract. A rollback the
 * platform can perform on itself is a rollback a self-modification can suppress.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const argOf = (name) => {
 const index = process.argv.indexOf(`--${name}`)
 return index === -1 ? null: (process.argv[index + 1] ?? null)
}

const target = argOf('target')
const commit = argOf('commit')

if (target === null || commit === null) {
 process.stderr.write('usage: node rollback-recover.mjs --target <dir> --commit <sha>\n')
 process.exit(2)
}

const dir = resolve(target)
if (!existsSync(dir)) {
 process.stderr.write(`no such directory: ${dir}\n`)
 process.exit(2)
}

const git = (args) =>
 execFileSync('git', ['-C', dir,...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * The commit is verified to exist before anything is touched. A restore from a sha the target's
 * object store does not hold would fail halfway, and halfway is the one state a rollback must
 * never leave behind.
 */
try {
 git(['cat-file', '-e', `${commit}^{commit}`])
} catch {
 process.stderr.write(`${dir} does not contain commit ${commit}\n`)
 process.exit(1)
}

/**
 * Both halves, and both are needed. `checkout --.` restores every tracked path the modification
 * changed or deleted; `clean -fd` removes files it *added*, which a checkout leaves in place —
 * and a file the modification added is exactly how a broken module keeps being imported after
 * everything tracked has been put back.
 *
 * `node_modules` and other ignored paths are left alone: `clean` without `-x` does not touch
 * them, which is deliberate. Reinstalling dependencies is not part of restoring source, and a
 * drill that deleted them would take twenty minutes to recover from a one-line defect.
 */
git(['checkout', commit, '--', '.'])
git(['clean', '-fd'])

const head = git(['rev-parse', 'HEAD']).trim
const dirty = git(['status', '--porcelain']).trim

process.stdout.write(
 JSON.stringify({
 restoredTo: commit,
 head,
 // Non-empty when the tree still differs from HEAD, which it will whenever the manifest's
 // commit is not HEAD. Reported rather than judged: the drill knows which it expected.
 dirty,
 recoveredBy: import.meta.url,
 }) + '\n',
)
