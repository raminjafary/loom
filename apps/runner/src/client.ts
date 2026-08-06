import { classifyToolEffect, isRiskyTool } from '@loom/domain'
import {
  RunnerFrameSchema,
  ServerFrameSchema,
  type RunnerFrame,
  type WireAgentEvent,
  type WirePersonaSpec,
} from '@loom/runner-protocol'
import WebSocket from 'ws'
import { runAgent } from './claude-agent-adapter.js'
import {
  drainUsage,
  egressConfigFromEnv,
  leaseEgressToken,
  revokeEgressToken,
} from './egress-client.js'
import { checkPath, resolveWithinRoot } from './path-check.js'
import { discardRunWorkspace, getDiff, prepareRunWorkspace, pushRunBranch } from './run-workspace.js'
import { runAgentInSandbox, sandboxConfigFromEnv, sandboxEnabled } from './sandbox.js'

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
  // Per-run abort handles (PLAN.md §6 kill switch) — registered before the
  // clone starts so a cancel arriving during workspace prep is not ignored.
  const aborts = new Map<string, AbortController>()
  // SDK session ids, so a run can be resumed rather than restarted (PLAN.md §7
  // Phase 1). Only in memory here; durable persistence lands with resumption.
  const sessions = new Map<string, string>()
  const HEARTBEAT_INTERVAL_MS = Number(process.env.LOOM_HEARTBEAT_INTERVAL_MS ?? 20_000)

  // Sandbox + egress config (PLAN.md §6 A5/A6). `egress` is null when this Runner
  // has no control secret, which is the deliberate unsandboxed escape hatch —
  // see runAgentForRun below for what that costs.
  const sandbox = sandboxConfigFromEnv()
  const useSandbox = sandboxEnabled()
  const egress = egressConfigFromEnv()
  const USAGE_POLL_MS = Number(process.env.LOOM_USAGE_POLL_MS ?? 5_000)

  let socket: WebSocket | null = null
  let closed = false

  // Per-run event counter — the server's idempotency key (PLAN.md §6). Kept
  // here rather than derived from anything observable so a retransmit of an
  // already-sent event reuses its original seq and is dropped server-side.
  const eventSeqs = new Map<string, number>()

  const send = (frame: RunnerFrame) => socket?.send(JSON.stringify(frame))

  const sendAgentEvent = (runId: string, event: WireAgentEvent) => {
    const seq = (eventSeqs.get(runId) ?? 0) + 1
    eventSeqs.set(runId, seq)
    send({ type: 'agent_event', runId, seq, event })
  }

  /**
   * Forwards proxy-metered spend to the server, and enforces the budget cap's
   * "hard kill" half (PLAN.md §6). The proxy can refuse further calls but cannot
   * reach a Runner, so stopping the run has to happen here.
   *
   * Drain-on-read means a record handed over is gone from the proxy's queue, so
   * anything received is forwarded even if the run has already ended — dropping it
   * would silently lose spend that really happened.
   */
  const pumpUsage = async (): Promise<void> => {
    if (!egress) return
    const records = await drainUsage(egress)
    for (const record of records) {
      send({
        type: 'cost_report',
        runId: record.runId,
        spentUsd: record.spentUsd,
        capUsd: record.capUsd,
        exhausted: record.exhausted,
      })
      if (!record.exhausted) continue

      const abort = aborts.get(record.runId)
      if (!abort || abort.signal.aborted) continue
      log(`run ${record.runId} exceeded its budget cap — killing`)
      sendAgentEvent(record.runId, {
        kind: 'run_failed',
        message: `Run stopped: budget cap of $${record.capUsd?.toFixed(2) ?? '0'} reached (spent $${record.spentUsd.toFixed(4)}).`,
      })
      abort.abort()
    }
  }

  const usageTimer = egress
    ? setInterval(() => {
        void pumpUsage().catch((error) => log(`usage poll failed: ${error instanceof Error ? error.message : String(error)}`))
      }, USAGE_POLL_MS)
    : null

  /**
   * Chooses how a run's agent loop executes. Sandboxed is the default and the
   * only configuration §6 A5 considers acceptable; the in-process path exists
   * because it is what Phase 1 shipped before the sandbox did, and it is still
   * the fastest way to debug the adapter itself.
   *
   * The in-process path is genuinely less safe, not merely less isolated: the
   * agent runs with the Runner's own privileges, and the Runner is the component
   * that holds git credentials and push authority (§6 A2). It is logged loudly
   * for that reason.
   */
  const runAgentForRun = async (input: {
    runId: string
    persona: WirePersonaSpec
    task?: string
    clonePath: string
    abort: AbortController
    resumeSessionId?: string
  }): Promise<void> => {
    const onEvent = (event: WireAgentEvent) => sendAgentEvent(input.runId, event)
    const onSessionId = (sessionId: string) => {
      sessions.set(input.runId, sessionId)
    }
    const onPermissionRequest = (
      toolUseId: string,
      toolName: string,
      toolInput: Record<string, unknown>,
    ): Promise<'allow' | 'deny'> => {
      send({ type: 'permission_request', runId: input.runId, toolUseId, toolName, input: toolInput })
      return new Promise((resolve) => {
        pendingPermissions.set(toolUseId, resolve)
      })
    }

    if (!useSandbox || !egress) {
      log(
        `WARNING: running ${input.runId} UNSANDBOXED — the agent has this Runner's privileges (PLAN.md §6 A5)`,
      )
      await runAgent({
        persona: input.persona,
        cwd: input.clonePath,
        ...(input.task === undefined ? {} : { task: input.task }),
        ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
        abortController: input.abort,
        isRiskyTool,
        classifyEffect: (toolName, toolInput) =>
          classifyToolEffect(toolName, toolInput, input.clonePath, resolveWithinRoot),
        onEvent,
        onSessionId,
        onPermissionRequest,
      })
      return
    }

    // The lease is taken before the container starts, so the sandbox never exists
    // in a state where it could reach the model API without one (§6 A6).
    const egressToken = await leaseEgressToken(egress, {
      runId: input.runId,
      // Enforced at the proxy (PLAN.md §6/§9), snapshotted onto the run so a
      // mid-run persona edit cannot raise the ceiling of a run already in flight.
      budgetCapUsd: input.persona.budgetCapUsd,
    })

    try {
      await runAgentInSandbox(sandbox, {
        runId: input.runId,
        persona: input.persona,
        ...(input.task === undefined ? {} : { task: input.task }),
        clonePath: input.clonePath,
        egressToken,
        egressDataUrl: egress.dataUrl,
        ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
        abortController: input.abort,
        onEvent,
        onSessionId,
        onPermissionRequest,
        log,
      })
    } finally {
      // Drained before revoking: the final turn's spend is usually still queued
      // when the container exits, and revoking first would not lose it but
      // reporting late would let a run look cheaper than it was.
      await pumpUsage().catch(() => {})
      await revokeEgressToken(egress, input.runId).catch((error) =>
        log(`failed to revoke lease for ${input.runId}: ${error instanceof Error ? error.message : String(error)}`),
      )
    }
  }

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

          const abort = new AbortController()
          aborts.set(runId, abort)

          void prepareRunWorkspace(frame.cwd, runId)
            .then(({ clonePath, branchName }) => {
              // A cancel that landed while the clone was still running has no
              // agent loop to abort yet — honor it here instead of starting one.
              if (abort.signal.aborted) return

              runWorkspaces.set(runId, {
                clonePath,
                defaultBranch: frame.defaultBranch,
                sourcePath: frame.cwd,
                branchName,
              })
              send({ type: 'run_workspace_ready', runId, clonePath, branchName })
              log(`starting run ${runId} in ${clonePath}`)
              return runAgentForRun({
                runId,
                persona: frame.persona,
                ...(frame.task === undefined ? {} : { task: frame.task }),
                clonePath,
                abort,
              })
            })
            .then(() => log(`run ${runId} finished`))
            .catch((error) => {
              // A cancel during clone surfaces here as a rejected prepare; the
              // server already recorded the run as cancelled, so stay quiet.
              if (abort.signal.aborted) return
              log(`run ${runId} failed to prepare workspace: ${error instanceof Error ? error.message : String(error)}`)
              sendAgentEvent(runId, {
                kind: 'run_failed',
                message: `Failed to prepare run workspace: ${error instanceof Error ? error.message : String(error)}`,
              })
            })
            .finally(() => {
              const timer = heartbeats.get(runId)
              if (timer) {
                clearInterval(timer)
                heartbeats.delete(runId)
              }
              aborts.delete(runId)
              sessions.delete(runId)
            })
          return
        }

        case 'cancel_run': {
          const abort = aborts.get(frame.runId)
          if (!abort) return
          log(`cancelling run ${frame.runId}`)
          abort.abort()
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
      if (usageTimer) clearInterval(usageTimer)
      socket?.close()
    },
  }
}

// Re-exported so a caller can validate a raw frame if needed (e.g. tests).
export { RunnerFrameSchema }
