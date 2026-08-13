import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { WireAgentEvent, WirePersonaSpec } from '@loom/runner-protocol'
import {
 DEP_CACHE_DIR,
 depCacheEnv,
 depCacheFromEnv,
 prepareDepCache,
 type DepCacheConfig,
} from './dep-cache.js'
import { sandboxCredentialsFile } from './host-claude-auth.js'
import { IMAGE_DIGEST_PATH, closureDigest } from './sandbox-closure.js'
import { SandboxEventSchema, decodeFrameLine, encodeFrame } from './sandbox-protocol.js'

const execFileAsync = promisify(execFile)

/**
 * Per-run container isolation to the spec. The agent's process no
 * longer runs with the Runner's privileges — which matters because the Runner is
 * the component that holds git credentials and push authority, and model
 * output is attacker-controllable input.
 *
 * Where this deviates from the sandbox spec, and why — stated rather than buried:
 *
 * - **`--network` is an internal Docker network, not `none`.** A literal
 * `--network=none` would also cut the egress proxy, and the sandbox spec's own sentence is
 * "`--network=none` by default with all egress through the authenticating
 * proxy" — those cannot both be literally true. The internal network has no
 * gateway, so it is `none` as far as the internet, the host, postgres and
 * valkey are concerned, while leaving exactly one reachable peer.
 * - **Containers, not microVMs.** the sandbox spec is explicit that a shared kernel is not a
 * sufficient boundary for LLM-generated code. Kata/microsandbox is Phase 3
 *; this is the Phase 1 boundary, and it is a real one compared to running
 * unsandboxed, not a claim to have solved kernel escape.
 * - **Runtime defaults to docker, not podman.** the tech stack prefers podman for being
 * daemonless; the flags used here are common to both, so this is a one-variable
 * swap rather than a design choice.
 */

export interface SandboxOptions {
 readonly runId: string
 readonly persona: WirePersonaSpec
 readonly task?: string
 /** Host path of the run's clone, mounted at WORK_DIR. */
 readonly clonePath: string
 /** Host path backing the sandbox's HOME, so the SDK session survives a restart. */
 readonly homePath: string
 /** Opaque per-run lease token. Never the real model key. */
 readonly egressToken: string
 /** Where the sandbox reaches the proxy, e.g. http://loom-egress:8080. */
 readonly egressDataUrl: string
 readonly resumeSessionId?: string
 /** May return a promise; awaited before the next event is forwarded (see forwardEvent). */
 readonly onEvent: (event: WireAgentEvent) => void | Promise<void>
 /** Verbatim provider-stream line, forwarded under the same backpressure. */
 readonly onRawMessage?: (line: string) => void | Promise<void>
 /** A Planner's decomposition, submitted inside the container. */
 readonly onPlan?: (
 subtasks: { title: string; task: string; personaName: string; paths?: string[] | undefined }[],
) => void
 /**
 * This run is a re-planning turn: the Planner
 * inside the container gets `submit_plan_delta` instead of `submit_plan`.
 */
 readonly steering?: boolean
 /** The delta that turn submitted, relayed out the same way a plan is. */
 readonly onPlanDelta?: (delta: {
 rationale: string
 ops: Record<string, unknown>[]
 }) => void
 /**
 * Hands back a function that delivers pre-rendered context into the running
 * container. Called once, as soon as the
 * container is accepting commands.
 */
 readonly onDeliveryChannel?: (deliver: (text: string) => void) => void
 /**
 * One note the agent wrote, relayed as it is written. The
 * verdict travels back into the tool result, so a refused note is something the
 * model can see and correct.
 */
 readonly onNote?: (note: {
 kind: string
 title: string
 body: string
 paths?: string[] | undefined
 }) => Promise<{ ok: true } | { ok: false; reason: string }>
 /** The agent asking for its tree's ledger mid-run. */
 readonly onNotesRequest?: => Promise<
 { ok: true; ledger: string } | { ok: false; error: string }
 >
 /**
 * The agent asking a human a question and blocking on the answer.
 * Resolves with `answer: null` when nobody answered — the run must continue either
 * way, or it blocks until the reaper takes it.
 */
 readonly onQuestion?: (question: string) => Promise<{ answer: string | null }>
 /**
 * One map fragment the agent wrote, relayed as it is written.
 * Absent on an ordinary run, which is what makes `record_map` a mastery-run-only tool
 * rather than something any worker could write to the persona's shared memory with.
 */
 readonly onMapWrite?: (fragment: Record<string, unknown>) => Promise<
 | { ok: true; nodesWritten: number; edgesWritten: number; superseded: number }
 | { ok: false; reason: string }
 >
 /**
 * The agent handing its work to a successor.
 *
 * Present on every run, unlike `onMapWrite`: a brief is read by one successor in one
 * tree and is fenced when it gets there, so withholding the channel would only mean an
 * agent that knows it is running out of room and cannot say what it knows.
 */
 readonly onHandOver?: (
 brief: Record<string, unknown>,
) => Promise<{ ok: true } | { ok: false; reason: string }>
 /** The tree's ledger at start, rendered and fenced server-side. */
 readonly contextLedger?: string
 /** What the persona already knows about this subject, rendered server-side. */
 readonly mapContext?: string
 /** Present when the deliverable is a map rather than a diff. */
 readonly mastery?: {
 subjectKind: 'repository' | 'author' | 'corpus'
 subjectRef: string
 revision: string
 }
 readonly onSessionId?: (sessionId: string) => void
 /** How full the model's context window is, sampled inside the container. */
 readonly onContextUsage?: (usage: { totalTokens: number; maxTokens: number }) => void
 readonly onPermissionRequest: (
 toolUseId: string,
 toolName: string,
 input: Record<string, unknown>,
) => Promise<'allow' | 'deny'>
 readonly abortController?: AbortController
 readonly log?: (message: string) => void
}

export interface SandboxConfig {
 readonly runtime: string
 readonly image: string
 readonly network: string
 readonly memory: string
 readonly cpus: string
 readonly pidsLimit: string
 readonly wallClockMs: number
 /**
 * The package-manager cache runs inherit, or null for none.
 * **Null is the default.** See dep-cache.ts — `copy` vs `shared` is a security
 * boundary, not a tuning knob.
 */
 readonly depCache: DepCacheConfig | null
}

export const sandboxConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): SandboxConfig => ({
 // Docker by default; podman is drop-in (see the note above).
 runtime: env.LOOM_CONTAINER_RUNTIME ?? 'docker',
 image: env.LOOM_SANDBOX_IMAGE ?? 'loom-agent-sandbox:latest',
 network: env.LOOM_SANDBOX_NETWORK ?? 'loom-sandbox',
 memory: env.LOOM_SANDBOX_MEMORY ?? '4g',
 cpus: env.LOOM_SANDBOX_CPUS ?? '2',
 pidsLimit: env.LOOM_SANDBOX_PIDS ?? '512',
 wallClockMs: Number(env.LOOM_SANDBOX_WALL_CLOCK_MS ?? 3_600_000),
 // Opt-in, and only then does a cache exist at all. See dep-cache.ts.
 depCache: depCacheFromEnv(env),
})

export const sandboxEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
 (env.LOOM_SANDBOX_ENABLED ?? '1') !== '0'

/**
 * Turning the sandbox off needs a second, separate acknowledgement.
 *
 * Unsandboxed, model output executes with the Runner's own user privileges — which on a
 * developer machine means it can read the login keychain, `~/.ssh`, `~/.aws`, and every
 * repository on disk. `security find-generic-password` is one Bash call away, and the
 * risky-tool gate is a name-based heuristic, not a boundary (effect-based classification says so itself).
 *
 * That is a categorically different exposure from "less isolated", so one variable
 * should not be enough to reach it. A typo, a copied `.env`, or a stale shell export
 * must not silently put an operator's whole machine inside the blast radius.
 */
export const unsandboxedAcknowledged = (env: NodeJS.ProcessEnv = process.env): boolean =>
 env.LOOM_ALLOW_UNSANDBOXED === 'i-understand-the-agent-gets-my-privileges'

/**
 * Refuse to start a run whose image was built from different sources than the Runner
 * is running.
 *
 * The image is built by hand and is easy to forget, and forgetting is not a loud
 * failure: the container starts, the run completes, work is committed, cost is metered
 * — and the agent silently lacks whatever the newer sources added. That is not a
 * hypothetical. `notes-tool.ts`, `planner-tool.ts` and `capabilities.ts` were missing
 * from every sandboxed run for four days; a model told to call `write_note` and offered
 * no such tool wrote a markdown file into the clone instead, which is precisely where
 * The worker-notes design says notes must never go. The whole test suite was green throughout,
 * because the suite exercises the host's copy of code the container did not have.
 *
 * Refusing rather than warning, for the same reason `unsandboxedAcknowledged` exists: a
 * warning in a Runner log is indistinguishable from the silence it replaces. The escape
 * hatch is an env var, so an operator deliberately pinning an image can still do so and
 * has said out loud that they meant to.
 */
export const staleSandboxImageAcknowledged = (
 env: NodeJS.ProcessEnv = process.env,
): boolean => env.LOOM_ALLOW_STALE_SANDBOX_IMAGE === '1'

export type ImageFreshness =
 | { readonly ok: true; readonly digest: string }
 | { readonly ok: false; readonly reason: string }

/**
 * Compares the digest baked into the image against the host's agent-side sources.
 *
 * `hostEntry` is the path to `agent-host.ts` in the Runner's own tree; both sides run
 * the identical walk in sandbox-closure.ts, so a mismatch means the file *contents*
 * differ, not merely their location.
 *
 * An image with no digest file is treated as stale rather than as fine: it was built
 * before this check existed, which is exactly the population the check is about.
 */
export const checkImageFreshness = async (
 config: SandboxConfig,
 hostEntry: string,
): Promise<ImageFreshness> => {
 let imageDigest: string
 try {
 const { stdout } = await execFileAsync(config.runtime, [
 'run', '--rm', '--entrypoint', 'cat', config.image, IMAGE_DIGEST_PATH,
 ])
 imageDigest = stdout.trim
 } catch {
 return {
 ok: false,
 reason:
 `the image ${config.image} carries no source digest, so it predates this check. ` +
 'Rebuild it: docker build -f apps/runner/Dockerfile.sandbox -t loom-agent-sandbox:latest.',
 }
 }

 const hostDigest = closureDigest(hostEntry)
 if (imageDigest !== hostDigest) {
 return {
 ok: false,
 reason:
 `the image ${config.image} was built from different agent sources than this Runner ` +
 `is running (image ${imageDigest.slice(0, 12)}, sources ${hostDigest.slice(0, 12)}). ` +
 'Rebuild it: docker build -f apps/runner/Dockerfile.sandbox -t loom-agent-sandbox:latest.',
 }
 }
 return { ok: true, digest: hostDigest }
}

/**
 * Container name, which doubles as its DNS name on the sandbox network — that is how
 * the agent addresses its own shim (see ANTHROPIC_BASE_URL below).
 */
const containerName = (runId: string): string => `loom-run-${runId}`

/** The run's clone. */
const WORK_DIR = '/work'
/**
 * The SDK keeps resumable session transcripts under `$HOME/.claude/projects`. That has
 * to outlive the container or resumption after a Runner restart is impossible — the
 * session id survives in the Runner's state file but the transcript it names would be
 * gone. So HOME is a host-backed, run-scoped directory rather than a tmpfs.
 *
 * This is a second bind mount, which the sandbox spec's "mount only the run's clone" does not
 * literally allow. The risk is the same shape as the clone's, and deliberately so: the
 * directory is created per run, owned by that run, and destroyed with it. What the sandbox spec is
 * actually guarding against — `$HOME`, `~/.ssh`, `~/.aws`, `~/.claude` on the *host* —
 * is still never mounted.
 */
const HOME_DIR = '/home/agent'


/**
 * Every flag the sandbox spec asks for, in one place so the spec is auditable against the code
 * rather than scattered through a spawn call.
 */
export const buildSandboxArgs = (
 config: SandboxConfig,
 options: {
 runId: string
 clonePath: string
 homePath: string
 env: Record<string, string>
 /** Host path to mount as the dependency cache — per-run in `copy` mode. */
 depCachePath?: string
 },
): string[] => [
 'run',
 '--rm',
 // Interactive stdio: the approval round-trip and event stream ride these pipes.
 '-i',
 '--name',
 containerName(options.runId),

 // No route off the host except the egress proxy.
 '--network',
 config.network,

 // Drop every capability, and forbid regaining any via setuid binaries.
 '--cap-drop=ALL',
 '--security-opt=no-new-privileges',
 // The default seccomp profile applies because no seccomp flag is passed. Said
 // out loud because the failure mode is someone "fixing" a syscall error by
 // adding `--security-opt seccomp=unconfined`, which the sandbox spec forbids outright.

 // Non-root, matching the uid the image creates. On Docker Desktop the bind
 // mount below is ownership-mapped so this uid can still write the clone; on
 // native Linux the clone's owner has to line up, which is why the uid is fixed
 // rather than inherited.
 '--user',
 '1000:1000',

 // Immutable rootfs. The only other writable space is a noexec tmpfs.
 '--read-only',
 '--tmpfs',
 '/tmp:rw,noexec,nosuid,size=1g',

 // Exactly two bind mounts, both run-scoped: the clone, and a host-backed HOME so
 // the SDK's session transcript survives a Runner restart (see HOME_DIR). Never the
 // host's $HOME, ~/.ssh, ~/.aws, ~/.config/gh, ~/.claude or ~/.gitconfig — and never
 // the container socket, which would hand the agent the host (the sandbox spec).
 '-v',
 `${options.clonePath}:${WORK_DIR}:rw`,
 '-v',
 `${options.homePath}:${HOME_DIR}:rw`,
 // A third mount only when an operator opted in. In the default `copy` mode this is
 // a per-run clone of the warmed cache, so it stays run-scoped like the other two;
 // in `shared` mode it is the one mount that is not. See dep-cache.ts.
...(options.depCachePath ? ['-v', `${options.depCachePath}:${DEP_CACHE_DIR}:rw`]: []),
 '-w',
 WORK_DIR,

 '--memory',
 config.memory,
 '--memory-swap',
 config.memory,
 '--cpus',
 config.cpus,
 '--pids-limit',
 config.pidsLimit,

...Object.entries(options.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),

 config.image,
]

/** Hostname of the egress proxy, for NO_PROXY. Falls back to the raw value if it is not a URL. */
const proxyHost = (dataUrl: string): string => {
 try {
 return new URL(dataUrl).hostname
 } catch {
 return dataUrl
 }
}

/**
 * Embeds the lease token as the password in the proxy URL's userinfo. Still not a
 * secret leaving the host — the token is opaque and per-run, and the real
 * credential stays in the proxy.
 */
/**
 * The proxy URL with a lease in its userinfo. `HTTP_PROXY`-aware tools (npm, curl, git)
 * have no other channel for a proxy credential — they turn this into
 * `Proxy-Authorization: Basic`. Exported because the dependency-cache warm step needs
 * exactly the same shape: without the lease the proxy answers 407 and the install
 * fails, which is how the live check found it.
 */
export const proxyUrlWithToken = (dataUrl: string, token: string): string => {
 try {
 const parsed = new URL(dataUrl)
 parsed.username = 'loom'
 parsed.password = token
 return parsed.toString
 } catch {
 return dataUrl
 }
}

export const runAgentInSandbox = async (
 config: SandboxConfig,
 options: SandboxOptions,
): Promise<void> => {
 const log = options.log ?? ( => {})

 // The lease, in the only place the CLI will carry it intact. Written into the run's
 // own HOME, which is a host-backed directory destroyed with the run — so the file
 // never outlives the run and never contains anything real.
 // Per-run copy of the warmed cache by default, so nothing this run writes is ever
 // seen by another (dep-cache.ts). Released in the same `finally` as the container.
 const depCache = config.depCache ? await prepareDepCache(config.depCache, options.runId): null
 if (depCache) await chmod(depCache.path, 0o777)

 await mkdir(join(options.homePath, '.claude'), { recursive: true })
 await writeFile(
 join(options.homePath, '.claude', '.credentials.json'),
 sandboxCredentialsFile(options.egressToken),
 { mode: 0o600 },
)

 const args = buildSandboxArgs(config, {
 runId: options.runId,
 clonePath: options.clonePath,
 homePath: options.homePath,
 env: {
 // Straight to the proxy. The lease travels in the sandbox's credentials file
 // (see writeSandboxCredentials), which the CLI forwards byte-exact as a bearer
 // token — unlike ANTHROPIC_API_KEY, which it validates offline and rewrites.
 ANTHROPIC_BASE_URL: options.egressDataUrl,
 // Everything that is not the model API goes through the same proxy, where it
 // meets the host allowlist. The lease token rides in the URL's userinfo
 // because that is the only channel `HTTP_PROXY`-aware tools (npm, curl, git)
 // have for a proxy credential — they turn it into Proxy-Authorization: Basic.
 HTTP_PROXY: proxyUrlWithToken(options.egressDataUrl, options.egressToken),
 HTTPS_PROXY: proxyUrlWithToken(options.egressDataUrl, options.egressToken),
 // The proxy host itself must be exempt. ANTHROPIC_BASE_URL already points
 // *at* the proxy, so without this the SDK proxies its model call to the
 // proxy — arriving in absolute form on the forward-proxy path instead of the
 // credential-injecting one, which fails as "must use CONNECT". Found by
 // running it, not by reading it.
 // Both the proxy host and the container's own name. Without the latter the CLI
 // would route its shim call through the egress proxy, arriving on the
 // forward-proxy path instead of the shim.
 NO_PROXY: `localhost,127.0.0.1,${proxyHost(options.egressDataUrl)}`,
 HOME: HOME_DIR,
 // Only when the mount exists. Pointing a package manager at a path that is not
 // mounted would make it fail to write its cache rather than fall back.
...(depCache ? depCacheEnv: {}),
 },
...(depCache ? { depCachePath: depCache.path }: {}),
 })

 const child: ChildProcessWithoutNullStreams = spawn(config.runtime, args, {
 stdio: ['pipe', 'pipe', 'pipe'],
 })

 const kill = async (reason: string): Promise<void> => {
 log(`killing sandbox for run ${options.runId}: ${reason}`)
 // `kill` the container, not just the client process: killing `docker run`
 // leaves the container itself alive, which is exactly the orphan the sandbox spec's
 // resource limits are meant to bound.
 try {
 await execFileAsync(config.runtime, ['kill', containerName(options.runId)])
 } catch {
 // Already gone, or never started — nothing to do either way.
 }
 child.kill('SIGKILL')
 }

 // Wall-clock kill. The dead-run reaper catches a
 // stalled run server-side, but only this stops the container burning budget.
 const wallClock = setTimeout( => {
 void kill(`exceeded the ${Math.round(config.wallClockMs / 60_000)} min wall clock`)
 options.onEvent({
 kind: 'run_failed',
 message: `Run killed after exceeding its ${Math.round(config.wallClockMs / 60_000)} minute wall clock.`,
 })
 }, config.wallClockMs)

 const onAbort = => {
 void kill('cancelled')
 }
 options.abortController?.signal.addEventListener('abort', onAbort, { once: true })

 const send = (frame: Parameters<typeof encodeFrame>[0]) => {
 if (child.stdin.writable) child.stdin.write(encodeFrame(frame))
 }

 /**
 * Offered as soon as the container exists rather than after `ready`, because the
 * caller registers it once and a delivery arriving before the agent loop starts is
 * already in the opening ledger — see the `deliver` case in agent-host.ts.
 */
 options.onDeliveryChannel?.((text) => send({ t: 'deliver', text }))

 // Held until the container reports `ready`. Writing it now would lose it —
 // `docker run -i` discards stdin written before the container's process attaches,
 // and the symptom is a run that hangs to its wall clock with no error anywhere.
 const sendStart = => {
 send({
 t: 'start',
 persona: options.persona,
...(options.task === undefined ? {}: { task: options.task }),
...(options.contextLedger === undefined ? {}: { contextLedger: options.contextLedger }),
...(options.mapContext === undefined ? {}: { mapContext: options.mapContext }),
...(options.mastery === undefined ? {}: { mastery: options.mastery }),
 cwd: WORK_DIR,
...(options.resumeSessionId === undefined ? {}: { resumeSessionId: options.resumeSessionId }),
...(options.steering ? { steering: true }: {}),
 })
 }

 /**
 * Forwards container events to the host one at a time, pausing the container's
 * stdout while the host is behind. Two
 * properties this protects, both of which a bare `options.onEvent(...)` call
 * broke:
 *
 * - **Order.** `onEvent` may be async, and readline emits several lines within
 * one chunk — concurrent calls would assign event sequence numbers in
 * whatever order their awaits happened to resolve.
 * - **Pressure.** Pausing the pipe is what reaches the agent inside the
 * container: its stdout stops draining, `process.stdout.write` starts
 * returning false, and agent-host waits (see its `emitEvent`).
 */
 let queueDepth = 0
 let forwarding: Promise<void> = Promise.resolve
 const forwardEvent = (event: WireAgentEvent): void => {
 queueDepth += 1
 stdout.pause
 forwarding = forwarding
.then( => options.onEvent(event))
.catch((error: unknown) =>
 log(
 `failed to forward an event for run ${options.runId}: ${error instanceof Error ? error.message: String(error)}`,
),
)
.then( => {
 queueDepth -= 1
 if (queueDepth === 0) stdout.resume
 })
 }

 const forwardRaw = (line: string): void => {
 if (!options.onRawMessage) return
 queueDepth += 1
 stdout.pause
 forwarding = forwarding
.then( => options.onRawMessage?.(line))
.catch( => {
 // A transcript is an artifact, not a control path: failing to persist one
 // line must never take down the run that produced it.
 })
.then( => {
 queueDepth -= 1
 if (queueDepth === 0) stdout.resume
 })
 }

 const stdout = createInterface({ input: child.stdout })
 stdout.on('line', (line) => {
 if (process.env.LOOM_SANDBOX_TRACE === '1') log(`[run ${options.runId}:raw] ${line}`)
 const decoded = decodeFrameLine(line)
 if (decoded === null) {
 // Ordinary container output — build logs, npm noise. Logged, not parsed.
 if (line.trim.length > 0) log(`[run ${options.runId}] ${line}`)
 return
 }
 const parsed = SandboxEventSchema.safeParse(decoded)
 if (!parsed.success) return
 const frame = parsed.data

 switch (frame.t) {
 case 'ready':
 sendStart
 return
 case 'event':
 forwardEvent(frame.event)
 return
 case 'raw':
 // Through the same serialized queue as events, so a raw line and the
 // structured events derived from it cannot be reordered relative to
 // each other, and so the pipe pauses for both.
 forwardRaw(frame.line)
 return
 case 'session':
 options.onSessionId?.(frame.sessionId)
 return
 case 'context_usage':
 // Not through `forwardEvent`'s queue: this is an observation about the run, and
 // holding it behind a backlog of events would make it stale precisely when the
 // backlog says the run is busy.
 options.onContextUsage?.({ totalTokens: frame.totalTokens, maxTokens: frame.maxTokens })
 return
 case 'plan':
 options.onPlan?.(frame.subtasks)
 return
 case 'plan_delta':
 options.onPlanDelta?.({ rationale: frame.rationale, ops: frame.ops })
 return
 case 'note':
 // Not through `forwardEvent`'s queue: a note is not part of the event
 // sequence, so serializing it behind the transcript would make a worker's
 // note wait on a backlog it has nothing to do with — and the whole point of
 // The incremental write is that a note lands promptly.
 void (async => {
 const result = (await options.onNote?.(frame.note)) ?? {
 ok: false,
 reason: 'this run has no notes channel',
 }
 send({
 t: 'note_result',
 requestId: frame.requestId,
 ok: result.ok,
...(result.ok ? {}: { reason: result.reason }),
 })
 })
 return
 case 'handoff':
 void (async => {
 const result = (await options.onHandOver?.(frame.brief)) ?? {
 ok: false,
 reason: 'this Runner cannot hand over — carry on',
 }
 send({
 t: 'handoff_result',
 requestId: frame.requestId,
 ok: result.ok,
...(result.ok ? {}: { reason: result.reason }),
 })
 })
 return
 case 'map':
 // Same reasoning as `note` above: off the event queue, because a map fragment
 // is not part of the transcript sequence and making it wait on a backlog would
 // defeat the incremental write mastery requires.
 void (async => {
 const result = (await options.onMapWrite?.(frame.fragment)) ?? {
 ok: false,
 reason: 'this run is not a mastery run, so it has no map to write to',
 }
 send({
 t: 'map_result',
 requestId: frame.requestId,
 ok: result.ok,
...(result.ok
 ? {
 nodesWritten: result.nodesWritten,
 edgesWritten: result.edgesWritten,
 superseded: result.superseded,
 }
: { reason: result.reason }),
 })
 })
 return
 case 'notes_request':
 void (async => {
 const result = (await options.onNotesRequest?.) ?? {
 ok: false,
 error: 'this run has no notes channel',
 }
 send({
 t: 'notes_result',
 requestId: frame.requestId,
 ok: result.ok,
...(result.ok ? { ledger: result.ledger }: { error: result.error }),
 })
 })
 return
 case 'question_request':
 void (async => {
 const result = (await options.onQuestion?.(frame.question)) ?? { answer: null }
 send({
 t: 'question_result',
 requestId: frame.requestId,
...(result.answer === null ? {}: { answer: result.answer }),
 })
 })
 return
 case 'permission_request':
 void options
.onPermissionRequest(frame.toolUseId, frame.toolName, frame.input)
.then((decision) => send({ t: 'permission', toolUseId: frame.toolUseId, decision }))
 return
 case 'done':
 return
 }
 })

 createInterface({ input: child.stderr }).on('line', (line) => {
 if (line.trim.length > 0) log(`[run ${options.runId}:stderr] ${line}`)
 })

 const exitCode = await new Promise<number | null>((resolve) => {
 child.once('close', (code) => resolve(code))
 child.once('error', (error) => {
 // A missing runtime binary is a configuration error, not a run failure —
 // reported as a run failure anyway, because that is where a human will look.
 options.onEvent({
 kind: 'run_failed',
 message: `Could not start the sandbox (${config.runtime}): ${error.message}`,
 })
 resolve(null)
 })
 })

 clearTimeout(wallClock)
 options.abortController?.signal.removeEventListener('abort', onAbort)

 // The run's copy of the cache goes with the run. A no-op in `shared` mode — deleting
 // the shared root after one run would throw away every other run's cache.
 await depCache?.release.catch((error: unknown) => {
 log(`failed to release the dependency cache for run ${options.runId}: ${String(error)}`)
 })

 // A non-zero exit with no prior run_failed means the container died without the
 // agent host reporting why — OOM kill being the common case. Left unreported it
 // would look like a run that simply stopped.
 if (exitCode !== null && exitCode !== 0 && !options.abortController?.signal.aborted) {
 log(`sandbox for run ${options.runId} exited ${exitCode}`)
 }
}
