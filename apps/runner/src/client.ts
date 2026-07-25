import { isRiskyTool } from '@loom/domain'
import { RunnerFrameSchema, ServerFrameSchema, type RunnerFrame } from '@loom/runner-protocol'
import WebSocket from 'ws'
import { runAgent } from './claude-agent-adapter.js'
import { checkPath } from './path-check.js'

export interface RunnerClientOptions {
  readonly serverWsUrl: string
  readonly pairingToken: string
  readonly allowedRoots: readonly string[]
  readonly log?: (message: string) => void
}

export const connectRunner = (options: RunnerClientOptions): { close: () => void } => {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`))
  const pendingPermissions = new Map<string, (decision: 'allow' | 'deny') => void>()

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
          log(`starting run ${runId} in ${frame.cwd}`)
          void runAgent({
            persona: frame.persona,
            cwd: frame.cwd,
            isRiskyTool,
            onEvent: (event) => send({ type: 'agent_event', runId, event }),
            onPermissionRequest: (toolUseId, toolName, input) => {
              send({ type: 'permission_request', runId, toolUseId, toolName, input })
              return new Promise((resolve) => {
                pendingPermissions.set(toolUseId, resolve)
              })
            },
          }).then(() => log(`run ${runId} finished`))
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
