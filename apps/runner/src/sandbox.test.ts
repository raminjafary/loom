import { describe, expect, it } from 'vitest'
import {
 buildSandboxArgs,
 sandboxConfigFromEnv,
 sandboxEnabled,
 sandboxModelKeyFromEnv,
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

 it('passes env through without leaking a real credential name', => {
 expect(args).toContain('ANTHROPIC_BASE_URL=http://loom-egress:8080/anthropic')
 })
})

describe('sandbox configuration', => {
 it('defaults to docker but allows another runtime', => {
 expect(sandboxConfigFromEnv({} as NodeJS.ProcessEnv).runtime).toBe('docker')
 expect(
 sandboxConfigFromEnv({ LOOM_CONTAINER_RUNTIME: 'podman' } as NodeJS.ProcessEnv).runtime,
).toBe('podman')
 })

 it('requires an explicit opt-in before handing a run a real model key', => {
 // Weakening the credential broker must be a decision an operator made, not a side effect of a
 // variable being set somewhere else.
 const key = 'sk-ant-api03-whatever'
 expect(sandboxModelKeyFromEnv({} as NodeJS.ProcessEnv)).toBeNull
 expect(
 sandboxModelKeyFromEnv({ LOOM_SANDBOX_MODEL_API_KEY: key } as NodeJS.ProcessEnv),
).toBeNull
 expect(
 sandboxModelKeyFromEnv({ LOOM_SANDBOX_MODEL_KEY_PASSTHROUGH: '1' } as NodeJS.ProcessEnv),
).toBeNull
 expect(
 sandboxModelKeyFromEnv({
 LOOM_SANDBOX_MODEL_KEY_PASSTHROUGH: '1',
 LOOM_SANDBOX_MODEL_API_KEY: key,
 } as NodeJS.ProcessEnv),
).toBe(key)
 })

 it('is on unless explicitly disabled', => {
 expect(sandboxEnabled({} as NodeJS.ProcessEnv)).toBe(true)
 expect(sandboxEnabled({ LOOM_SANDBOX_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(true)
 // Only an explicit 0 opts out, so a typo cannot silently unsandbox a Runner.
 expect(sandboxEnabled({ LOOM_SANDBOX_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(true)
 expect(sandboxEnabled({ LOOM_SANDBOX_ENABLED: '0' } as NodeJS.ProcessEnv)).toBe(false)
 })
})
