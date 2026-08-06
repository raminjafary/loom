import { classifyToolEffect, isRiskyTool } from '@loom/domain'
import { createInterface } from 'node:readline'
import { runAgent } from './claude-agent-adapter.js'
import { startLeaseShim } from './lease-shim.js'
import { resolveWithinRoot } from './path-check.js'
import {
  SandboxCommandSchema,
  decodeFrameLine,
  encodeFrame,
  type SandboxCommand,
  type SandboxEvent,
} from './sandbox-protocol.js'

/**
 * The in-container entrypoint (PLAN.md §6 A5). This is the *only* Loom code that
 * runs inside a sandbox, and it is deliberately thin: read a `start` command,
 * drive the Agent SDK, relay events and permission requests out over stdio.
 *
 * It holds no credentials. The model key never enters here — the container is
 * handed an opaque per-run lease token and points at the egress proxy, which
 * attaches the real key (§6 A6). Nothing in this file needs to know that.
 *
 * It also decides nothing about permissions. Every risky call round-trips to the
 * host; a compromised agent that subverted this process could at most refuse to
 * ask, and refusing to ask cannot manufacture an approval.
 */

const emit = (event: SandboxEvent): void => {
  process.stdout.write(encodeFrame(event))
}

const pendingPermissions = new Map<string, (decision: 'allow' | 'deny') => void>()

const main = async (): Promise<void> => {
  // Logged, not silent. An agent host that produces no output at all is
  // indistinguishable from one that never started, which cost real debugging time.
  // stderr, so it can never be mistaken for a protocol frame.
  const note = (message: string) => process.stderr.write(`agent-host: ${message}\n`)
  note('started')

  const lines = createInterface({ input: process.stdin })

  const started = new Promise<Extract<SandboxCommand, { t: 'start' }>>(
    (resolve) => {
      lines.on('line', (line) => {
        const decoded = decodeFrameLine(line)
        if (decoded === null) return
        const parsed = SandboxCommandSchema.safeParse(decoded)
        if (!parsed.success) {
          // Reported, not swallowed. A dropped `start` frame leaves the run hanging
          // until its wall clock with no indication why — which is exactly what a
          // silent `return` here produced when PersonaSpec gained a required field
          // and a caller had not been updated.
          note(`ignoring malformed command frame: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
          return
        }

        if (parsed.data.t === 'start') {
          resolve(parsed.data)
          return
        }

        const resolvePermission = pendingPermissions.get(parsed.data.toolUseId)
        if (resolvePermission) {
          pendingPermissions.delete(parsed.data.toolUseId)
          resolvePermission(parsed.data.decision)
        }
      })
    },
  )

  // Started before the agent, so the SDK's very first request already has somewhere
  // to go. Absent config means this container is not using the proxy at all, which is
  // only the unsandboxed/debug path.
  const leaseToken = process.env.LOOM_LEASE_TOKEN
  const egressUrl = process.env.LOOM_EGRESS_URL
  const shimPort = Number(process.env.LOOM_LEASE_SHIM_PORT ?? 8787)

  if (leaseToken && egressUrl) {
    await startLeaseShim({
      port: shimPort,
      leaseToken,
      egressUrl,
      leaseHeader: process.env.LOOM_LEASE_HEADER ?? 'x-loom-lease',
      log: note,
    })
    note(`lease shim listening on 127.0.0.1:${shimPort} -> ${egressUrl}`)
  } else {
    note('no lease configured — model calls will not be proxied')
  }

  // Only now: the host holds its `start` frame until it sees this, because stdin
  // written before the container attaches is discarded (see SandboxEventSchema).
  emit({ t: 'ready' })
  note('waiting for start frame')

  const command = await started
  const persona = command.persona as Parameters<typeof runAgent>[0]['persona']

  await runAgent({
    persona,
    cwd: command.cwd,
    ...(command.task === undefined ? {} : { task: command.task }),
    ...(command.resumeSessionId === undefined ? {} : { resumeSessionId: command.resumeSessionId }),
    isRiskyTool,
    // Resolved inside the container, against the mount point — which is where
    // the paths actually are. A host-side check would be resolving a path that
    // does not exist in the namespace the tool will run in.
    classifyEffect: (toolName, input) =>
      classifyToolEffect(toolName, input, command.cwd, resolveWithinRoot),
    onEvent: (event) => emit({ t: 'event', event }),
    onSessionId: (sessionId) => emit({ t: 'session', sessionId }),
    onPermissionRequest: (toolUseId, toolName, input) => {
      emit({ t: 'permission_request', toolUseId, toolName, input })
      return new Promise((resolve) => {
        pendingPermissions.set(toolUseId, resolve)
      })
    },
  })

  emit({ t: 'done' })
  lines.close()
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    // Reported as a run event rather than a bare crash so the failure reaches the
    // thread instead of only the container's exit code.
    emit({
      t: 'event',
      event: {
        kind: 'run_failed',
        message: `agent host failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    })
    emit({ t: 'done' })
    process.exit(1)
  },
)
