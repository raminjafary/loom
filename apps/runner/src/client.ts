import { classifyToolEffect, isRiskyTool } from '@loom/domain'
import { RunnerFrameSchema, ServerFrameSchema, type RunnerFrame } from '@loom/runner-protocol'
import WebSocket from 'ws'
import { runAgent } from './claude-agent-adapter.js'
import { checkPath, resolveWithinRoot } from './path-check.js'
import { discardRunWorkspace, getDiff, prepareRunWorkspace, pushRunBranch } from './run-workspace.js'

export interface RunnerClientOptions {
  readonly serverWsUrl: string
  readonly pairingToken: string
  readonly allowedRoots: readonly string[]
  readonly log?: (message: string) => void
}

export const connectRunner = (options: RunnerClientOptions): { close: () => void } => {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`))
  const pendingPermissions = new Map<string, (decision: 'allow' | 'deny') => void>()
  // Per-run clone state, needed to answer a later get_diff request — keyed by
  // runId since a Runner may have several runs in flight concurrently.
  const runWorkspaces = new Map<
    string,
    { clonePath: string; defaultBranch: string; sourcePath: string; branchName: string }
  >()
  // Per-run heartbeat timers (PLAN.md §6 runtime safety) — started as soon as
  // start_run arrives (covers a hang during workspace prep too), cleared once
  // the run reaches a terminal outcome.
  const heartbeats = new Map<string, ReturnType<typeof setInterval>>()
  const HEARTBEAT_INTERVAL_MS = Number(process.env.LOOM_HEARTBEAT_INTERVAL_MS ?? 20_000)

  let socket: WebSocket | null = null
  let closed = false

  const send = (frame: RunnerFrame) => socket?.send(JSON.stringify(frame))

  const connect = () => {
    if (closed) return
    const ws = new WebSocket(options.serverWsUrl)
    socket = ws

    ws.on('open', () => {
      log(`connected to ${options.serverWsUrl}`)
      send({ type: 'hello', token: options.pairingToken, allowedRoots: [...options.allowedRoots] })
    })

    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString())
      } catch {
        return
      }

      const result = ServerFrameSchema.safeParse(parsed)
      if (!result.success) return
      const frame = result.data

      switch (frame.type) {
        case 'hello_ack':
          log(`paired as runner ${frame.runnerId}`)
          return

        case 'error':
          log(`server error: ${frame.message}`)
          return

        case 'check_path':
          void checkPath(frame.path, options.allowedRoots).then((result) => {
            send(
              result.ok
                ? {
                    type: 'check_path_result',
                    requestId: frame.requestId,
                    ok: true,
                    defaultBranch: result.defaultBranch,
                  }
                : { type: 'check_path_result', requestId: frame.requestId, ok: false, error: result.error },
            )
          })
          return

        case 'start_run': {
          const runId = frame.runId
          log(`preparing workspace for run ${runId} from ${frame.cwd}`)

          heartbeats.set(
            runId,
            setInterval(() => send({ type: 'heartbeat', runId }), HEARTBEAT_INTERVAL_MS),
          )

          void prepareRunWorkspace(frame.cwd, runId)
            .then(({ clonePath, branchName }) => {
              runWorkspaces.set(runId, {
                clonePath,
                defaultBranch: frame.defaultBranch,
                sourcePath: frame.cwd,
                branchName,
              })
              send({ type: 'run_workspace_ready', runId, clonePath, branchName })
              log(`starting run ${runId} in ${clonePath}`)
              return runAgent({
                persona: frame.persona,
                cwd: clonePath,
                ...(frame.task === undefined ? {} : { task: frame.task }),
                isRiskyTool,
                classifyEffect: (toolName, input) =>
                  classifyToolEffect(toolName, input, clonePath, resolveWithinRoot),
                onEvent: (event) => send({ type: 'agent_event', runId, event }),
                onPermissionRequest: (toolUseId, toolName, input) => {
                  send({ type: 'permission_request', runId, toolUseId, toolName, input })
                  return new Promise((resolve) => {
                    pendingPermissions.set(toolUseId, resolve)
                  })
                },
              })
            })
            .then(() => log(`run ${runId} finished`))
            .catch((error) => {
              log(`run ${runId} failed to prepare workspace: ${error instanceof Error ? error.message : String(error)}`)
              send({
                type: 'agent_event',
                runId,
                event: {
                  kind: 'run_failed',
                  message: `Failed to prepare run workspace: ${error instanceof Error ? error.message : String(error)}`,
                },
              })
            })
            .finally(() => {
              const timer = heartbeats.get(runId)
              if (timer) {
                clearInterval(timer)
                heartbeats.delete(runId)
              }
            })
          return
        }

        case 'permission_response': {
          const resolve = pendingPermissions.get(frame.toolUseId)
          if (resolve) {
            pendingPermissions.delete(frame.toolUseId)
            resolve(frame.decision)
          }
          return
        }

        case 'get_diff': {
          const workspace = runWorkspaces.get(frame.runId)
          if (!workspace) {
            send({ type: 'diff_result', requestId: frame.requestId, ok: false, error: 'Run has no workspace' })
            return
          }
          void getDiff(workspace.clonePath, workspace.defaultBranch)
            .then((diff) => send({ type: 'diff_result', requestId: frame.requestId, ok: true, diff }))
            .catch((error) =>
              send({
                type: 'diff_result',
                requestId: frame.requestId,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            )
          return
        }

        case 'discard_run': {
          const workspace = runWorkspaces.get(frame.runId)
          if (!workspace) {
            send({ type: 'discard_result', requestId: frame.requestId, ok: false, error: 'Run has no workspace' })
            return
          }
          void discardRunWorkspace(workspace.clonePath)
            .then(() => {
              runWorkspaces.delete(frame.runId)
              send({ type: 'discard_result', requestId: frame.requestId, ok: true })
            })
            .catch((error) =>
              send({
                type: 'discard_result',
                requestId: frame.requestId,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            )
          return
        }

        case 'push_run': {
          const workspace = runWorkspaces.get(frame.runId)
          if (!workspace) {
            send({ type: 'push_result', requestId: frame.requestId, ok: false, error: 'Run has no workspace' })
            return
          }
          void pushRunBranch(
            workspace.sourcePath,
            workspace.clonePath,
            workspace.branchName,
            workspace.defaultBranch,
            frame.acknowledgeCiChange,
          )
            .then((result) =>
              send(
                result.ok
                  ? {
                      type: 'push_result',
                      requestId: frame.requestId,
                      ok: true,
                      ...(result.prUrl === undefined ? {} : { prUrl: result.prUrl }),
                      ...(result.compareUrl === undefined ? {} : { compareUrl: result.compareUrl }),
                      ...(result.warning === undefined ? {} : { warning: result.warning }),
                    }
                  : { type: 'push_result', requestId: frame.requestId, ok: false, error: result.error },
              ),
            )
            .catch((error) =>
              send({
                type: 'push_result',
                requestId: frame.requestId,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            )
          return
        }
      }
    })

    ws.on('close', () => {
      log('disconnected')
      if (!closed) {
        setTimeout(connect, 2000)
      }
    })

    ws.on('error', (error: Error) => {
      log(`connection error: ${error.message}`)
    })
  }

  connect()

  return {
    close: () => {
      closed = true
      socket?.close()
    },
  }
}

// Re-exported so a caller can validate a raw frame if needed (e.g. tests).
export { RunnerFrameSchema }
