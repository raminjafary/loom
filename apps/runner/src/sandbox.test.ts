import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { closureDigest, walkClosure } from './sandbox-closure.js'
import {
 buildSandboxArgs,
 sandboxConfigFromEnv,
 sandboxEnabled,
 staleSandboxImageAcknowledged,
 unsandboxedAcknowledged,
} from './sandbox.js'

/**
 * These assert the sandbox spec spec itself, not plumbing. Every clause in
 * that section is a line here, so weakening the sandbox fails a test that names
 * the requirement rather than silently shipping.
 */

const config = sandboxConfigFromEnv({} as NodeJS.ProcessEnv)
const args = buildSandboxArgs(config, {
 runId: 'run-1',
 clonePath: '/scratch/loom-run-1',
 homePath: '/scratch/loom-home-1',
 env: { ANTHROPIC_BASE_URL: 'http://loom-egress:8080/anthropic' },
})
const joined = args.join(' ')

describe('sandbox args meet the sandbox spec spec', => {
 it('drops all capabilities and forbids regaining privileges', => {
 expect(args).toContain('--cap-drop=ALL')
 expect(args).toContain('--security-opt=no-new-privileges')
 })

 it('never disables seccomp', => {
 // the sandbox spec is explicit: default seccomp, never `unconfined`. Passing no seccomp flag
 // is what keeps the default, so the assertion is on the absence.
 expect(joined).not.toContain('seccomp')
 })

 it('runs as a non-root user', => {
 expect(args).toContain('--user')
 expect(args[args.indexOf('--user') + 1]).toBe('1000:1000')
 })

 it('uses a read-only rootfs with writable space only on noexec tmpfs', => {
 expect(args).toContain('--read-only')
 const tmpfsMounts = args.filter((_, i) => args[i - 1] === '--tmpfs')
 expect(tmpfsMounts.length).toBeGreaterThan(0)
 for (const mount of tmpfsMounts) {
 expect(mount).toContain('noexec')
 expect(mount).toContain('nosuid')
 }
 })

 it('mounts only run-scoped paths, and nothing from the host home', => {
 const binds = args.filter((_, i) => args[i - 1] === '-v')
 // Exactly two, both created per run: the clone, and a host-backed HOME so the SDK
 // session transcript survives a Runner restart (see HOME_DIR in sandbox.ts).
 expect(binds).toEqual(['/scratch/loom-run-1:/work:rw', '/scratch/loom-home-1:/home/agent:rw'])
 // The explicit the sandbox spec denylist. A regression here is the difference between a
 // contained injection and a stolen credential.
 for (const forbidden of ['.ssh', '.aws', '.config/gh', '.claude', '.gitconfig', 'docker.sock']) {
 expect(joined).not.toContain(forbidden)
 }
 })

 it('never mounts the container socket', => {
 // Called out separately from the denylist above because it is the one that
 // converts sandbox escape into full host control.
 expect(joined).not.toContain('/var/run/docker.sock')
 expect(joined).not.toContain('/run/podman')
 })

 it('caps memory, cpu and pids', => {
 expect(args).toContain('--memory')
 expect(args).toContain('--cpus')
 expect(args).toContain('--pids-limit')
 // Swap pinned to the memory limit, so the memory cap cannot be evaded by
 // swapping — an unpinned --memory-swap defaults to twice the limit.
 expect(args[args.indexOf('--memory-swap') + 1]).toBe(args[args.indexOf('--memory') + 1])
 })

 it('attaches only to the isolated sandbox network', => {
 expect(args[args.indexOf('--network') + 1]).toBe('loom-sandbox')
 })

 it('removes the container when it exits', => {
 // Otherwise every run leaks a stopped container holding its clone's contents.
 expect(args).toContain('--rm')
 })

 it('passes env through', => {
 expect(args).toContain('ANTHROPIC_BASE_URL=http://loom-egress:8080/anthropic')
 })

 it('never puts a credential-shaped variable in the sandbox environment', => {
 // The core property, guarded rather than assumed. The run carries only its
 // opaque lease token, in a credentials file; the real credential is attached by the
 // proxy. An ANTHROPIC_API_KEY here would silently undo that — which is exactly what
 // an earlier iteration did, before the OAuth path made it unnecessary.
 const envArgs = args.filter((_, i) => args[i - 1] === '-e')
 for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'LOOM_EGRESS_CONTROL_SECRET']) {
 expect(envArgs.some((entry) => entry.startsWith(`${name}=`))).toBe(false)
 }
 })
})

describe('sandbox configuration', => {
 it('defaults to docker but allows another runtime', => {
 expect(sandboxConfigFromEnv({} as NodeJS.ProcessEnv).runtime).toBe('docker')
 expect(
 sandboxConfigFromEnv({ LOOM_CONTAINER_RUNTIME: 'podman' } as NodeJS.ProcessEnv).runtime,
).toBe('podman')
 })

 it('requires a deliberate acknowledgement to run unsandboxed', => {
 // Unsandboxed means the agent gets the operator's privileges — keychain, SSH keys,
 // every repo on disk. One variable must not be enough to reach that.
 expect(unsandboxedAcknowledged({} as NodeJS.ProcessEnv)).toBe(false)
 expect(unsandboxedAcknowledged({ LOOM_ALLOW_UNSANDBOXED: '1' } as NodeJS.ProcessEnv)).toBe(false)
 expect(unsandboxedAcknowledged({ LOOM_ALLOW_UNSANDBOXED: 'true' } as NodeJS.ProcessEnv)).toBe(false)
 expect(
 unsandboxedAcknowledged({
 LOOM_ALLOW_UNSANDBOXED: 'i-understand-the-agent-gets-my-privileges',
 } as NodeJS.ProcessEnv),
).toBe(true)
 })

 it('is on unless explicitly disabled', => {
 expect(sandboxEnabled({} as NodeJS.ProcessEnv)).toBe(true)
 expect(sandboxEnabled({ LOOM_SANDBOX_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(true)
 // Only an explicit 0 opts out, so a typo cannot silently unsandbox a Runner.
 expect(sandboxEnabled({ LOOM_SANDBOX_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(true)
 expect(sandboxEnabled({ LOOM_SANDBOX_ENABLED: '0' } as NodeJS.ProcessEnv)).toBe(false)
 })

 it('requires a deliberate acknowledgement to run a stale image', => {
 // A stale image is a *silent* failure: the run completes and the agent is simply
 // never offered whatever the newer sources added. Four days of sandboxed runs had
 // no worker-notes tools this way. Default must be refuse, not warn.
 expect(staleSandboxImageAcknowledged({} as NodeJS.ProcessEnv)).toBe(false)
 expect(
 staleSandboxImageAcknowledged({ LOOM_ALLOW_STALE_SANDBOX_IMAGE: 'true' } as NodeJS.ProcessEnv),
).toBe(false)
 expect(
 staleSandboxImageAcknowledged({ LOOM_ALLOW_STALE_SANDBOX_IMAGE: '1' } as NodeJS.ProcessEnv),
).toBe(true)
 })
})

/**
 * The image must contain the code the Runner thinks it is running.
 *
 * Both halves of this were live-found, not designed: the COPY list in
 * Dockerfile.sandbox silently omitted three agent-side modules, and the image itself
 * silently predated them. Neither failed anything.
 */
describe("the agent host's source closure", => {
 const entry = fileURLToPath(new URL('./agent-host.ts', import.meta.url))

 it('is fully present in the source tree', => {
 expect(walkClosure(entry).missing).toEqual([])
 })

 it('names every file Dockerfile.sandbox must copy into the image', => {
 // The point of asserting the set rather than just "no missing imports": adding an
 // import to an agent-side module is exactly the change that must not pass review
 // without the Dockerfile changing too.
 const dockerfile = readFileSync(
 fileURLToPath(new URL('../Dockerfile.sandbox', import.meta.url)),
 'utf8',
)
 for (const file of walkClosure(entry).files) {
 expect(dockerfile).toContain(`apps/runner/src/${basename(file)}`)
 }
 })

 it('hashes to something stable and content-dependent', => {
 // The digest is compared across a host tree and a container filesystem, so it must
 // depend on contents and not on where the files live.
 expect(closureDigest(entry)).toMatch(/^[0-9a-f]{64}$/)
 expect(closureDigest(entry)).toBe(closureDigest(entry))
 })
})
