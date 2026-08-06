import { classifyToolEffect, isRiskyTool } from '@loom/domain'
import { createInterface } from 'node:readline'
import { runAgent } from './claude-agent-adapter.js'
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
  const lines = createInterface({ input: process.stdin })

  const started = new Promise<Extract<SandboxCommand, { t: 'start' }>>(
    (resolve) => {
      lines.on('line', (line) => {
        const decoded = decodeFrameLine(line)
        if (decoded === null) return
        const parsed = SandboxCommandSchema.safeParse(decoded)
        if (!parsed.success) return

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
