import { classifyToolEffect, isRiskyTool, maySelfModify } from '@loom/domain'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { runAgentOnBackend } from './agent-backend.js'
import { createHandoffTool } from './handoff-tool.js'
import { createMapTool } from './map-tool.js'
import { createExperienceTool } from './experience-tool.js'
import { createAtlasTool } from './atlas-tool.js'
import { createNotesTool } from './notes-tool.js'
import { createQuestionTool } from './question-tool.js'
import { createSelfTool } from './self-tool.js'
import { createProposalTool } from './proposal-tool.js'
import { createVerdictTool } from './verdict-tool.js'
import {
  PLANNER_TOOL_NAME,
  PLAN_DELTA_TOOL_NAME,
  createPlanDeltaTool,
  createPlannerTool,
} from './planner-tool.js'
import { resolveWithinRoot } from './path-check.js'
import {
  SandboxCommandSchema,
  decodeFrameLine,
  encodeFrame,
  type SandboxCommand,
  type SandboxEvent,
} from './sandbox-protocol.js'

/**
 * The in-container entrypoint. This is the *only* Loom code that
 * runs inside a sandbox, and it is deliberately thin: read a `start` command,
 * drive the Agent SDK, relay events and permission requests out over stdio.
 *
 * It holds no credentials. The model key never enters here — the container is
 * handed an opaque per-run lease token and points at the egress proxy, which
 * attaches the real key. Nothing in this file needs to know that.
 *
 * It also decides nothing about permissions. Every risky call round-trips to the
 * host; a compromised agent that subverted this process could at most refuse to
 * ask, and refusing to ask cannot manufacture an approval.
 */

const emit = (event: SandboxEvent): void => {
  process.stdout.write(encodeFrame(event))
}

/**
 * Same as `emit`, but waits for stdout to drain.
 * Awaited from `onEvent` only: while the Runner has the pipe paused, this is what
 * makes the agent loop inside the container wait rather than pile turns into this
 * process's write buffer. Node never *loses* a buffered write, so the control
 * frames keep using the plain `emit` — the difference here is pressure, not safety.
 */
const emitEvent = async (event: SandboxEvent): Promise<void> => {
  if (process.stdout.write(encodeFrame(event))) return
  await once(process.stdout, 'drain')
}

const pendingPermissions = new Map<string, (decision: 'allow' | 'deny') => void>()

/**
 * Note writes and note reads awaiting the host's answer.
 *
 * Keyed by a request id this process mints, exactly like `pendingPermissions`: both
 * are an in-process SDK callback that has to round-trip out of the container and
 * back. The two maps are separate because their payloads are, and because a note
 * failing must never be able to resolve a permission gate.
 */
const pendingNotes = new Map<
  string,
  (result: { ok: boolean; reason?: string | undefined }) => void
>()
/** `look_across_projects` round-trips. */
const pendingAtlasReads = new Map<
  string,
  (result: { ok: boolean; leads?: string | undefined; error?: string | undefined }) => void
>()
/** `propose_cross_project_link` round-trips. */
const pendingAtlasLinks = new Map<
  string,
  (result: { ok: boolean; outcome?: string | undefined; error?: string | undefined }) => void
>()
const pendingNoteReads = new Map<
  string,
  (result: { ok: boolean; ledger?: string | undefined; error?: string | undefined }) => void
>()
/** `record_map` round-trips, same shape as a note write. */
const pendingHandoffs = new Map<
  string,
  (result: { ok: boolean; reason?: string | undefined }) => void
>()
const pendingMapWrites = new Map<
  string,
  (result: {
    ok: boolean
    reason?: string | undefined
    nodesWritten?: number | undefined
    edgesWritten?: number | undefined
    superseded?: number | undefined
  }) => void
>()
/** `record_experience` round-trips. */
const pendingExperienceWrites = new Map<
  string,
  (result: {
    ok: boolean
    reason?: string | undefined
    written?: number | undefined
    superseded?: number | undefined
    remaining?: number | undefined
  }) => void
>()
/** `revise_own_prompt` round-trips. */
const pendingSelfEdits = new Map<
  string,
  (result: { ok: boolean; outcome?: string | undefined; error?: string | undefined }) => void
>()
/** `ask_human` round-trips, same shape as a notes read. */
const pendingQuestions = new Map<string, (result: { answer: string | null }) => void>()

/** The running agent's delivery channel, once its loop has started. */
let deliverToAgent: ((text: string) => void) | null = null

let requestCounter = 0
const nextRequestId = (): string => {
  requestCounter += 1
  return `${process.pid}-${requestCounter}`
}

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

        if (parsed.data.t === 'deliver') {
          // Dropped rather than queued if the agent loop has not started yet: the
          // ledger the run opens with is assembled after this frame could arrive, so
          // anything delivered that early is already in the opening prompt.
          deliverToAgent?.(parsed.data.text)
          return
        }

        if (parsed.data.t === 'note_result') {
          const resolveNote = pendingNotes.get(parsed.data.requestId)
          if (resolveNote) {
            pendingNotes.delete(parsed.data.requestId)
            resolveNote({ ok: parsed.data.ok, ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }) })
          }
          return
        }

        if (parsed.data.t === 'handoff_result') {
          const resolveHandoff = pendingHandoffs.get(parsed.data.requestId)
          if (resolveHandoff) {
            pendingHandoffs.delete(parsed.data.requestId)
            resolveHandoff(parsed.data)
          }
          return
        }
        if (parsed.data.t === 'map_result') {
          const resolveMap = pendingMapWrites.get(parsed.data.requestId)
          if (resolveMap) {
            pendingMapWrites.delete(parsed.data.requestId)
            resolveMap(parsed.data)
          }
          return
        }

        if (parsed.data.t === 'experience_result') {
          const resolveExperience = pendingExperienceWrites.get(parsed.data.requestId)
          if (resolveExperience) {
            pendingExperienceWrites.delete(parsed.data.requestId)
            resolveExperience(parsed.data)
          }
          return
        }

        if (parsed.data.t === 'notes_result') {
          const resolveRead = pendingNoteReads.get(parsed.data.requestId)
          if (resolveRead) {
            pendingNoteReads.delete(parsed.data.requestId)
            resolveRead(parsed.data)
          }
          return
        }

        if (parsed.data.t === 'atlas_result') {
          const resolveAtlas = pendingAtlasReads.get(parsed.data.requestId)
          if (resolveAtlas) {
            pendingAtlasReads.delete(parsed.data.requestId)
            resolveAtlas(parsed.data)
          }
          return
        }

        if (parsed.data.t === 'atlas_link_result') {
          const resolveLink = pendingAtlasLinks.get(parsed.data.requestId)
          if (resolveLink) {
            pendingAtlasLinks.delete(parsed.data.requestId)
            resolveLink(parsed.data)
          }
          return
        }

        if (parsed.data.t === 'self_edit_result') {
          const resolveSelfEdit = pendingSelfEdits.get(parsed.data.requestId)
          if (resolveSelfEdit) {
            pendingSelfEdits.delete(parsed.data.requestId)
            resolveSelfEdit(parsed.data)
          }
          return
        }

        if (parsed.data.t === 'question_result') {
          const resolveQuestion = pendingQuestions.get(parsed.data.requestId)
          if (resolveQuestion) {
            pendingQuestions.delete(parsed.data.requestId)
            resolveQuestion({ answer: parsed.data.answer ?? null })
          }
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

  // Only now: the host holds its `start` frame until it sees this, because stdin
  // written before the container attaches is discarded (see SandboxEventSchema).
  emit({ t: 'ready' })
  note('waiting for start frame')

  const command = await started
  const persona = command.persona as Parameters<typeof runAgentOnBackend>[0]['persona']
  // A Planner's delegation tool is an in-process MCP server, so inside a sandbox
  // it lives here and its result crosses the stdio boundary like everything else.
  // A re-planning turn gets the delta tool *instead* — a run re-entered
  // to adjust a plan must not be able to submit a whole new one.
  const plannerTool = persona.planner && !command.steering ? createPlannerTool() : null
  const deltaTool = persona.planner && command.steering ? createPlanDeltaTool() : null

  /**
   * The notes channel. Both halves round-trip to the host,
   * because the ledger is workspace-side state and this process is inside a sandbox
   * with no network and no database — which is also the reason the notes a worker
   * reads cannot be tampered with from in here.
   */
  /**
   * The atlas channel, round-tripping to the host for the same reason the
   * ledger does: it is workspace-side state and this process is inside a sandbox with no
   * network and no database — which is also why the leads a worker reads cannot be
   * tampered with from in here.
   */
  const atlasTool = createAtlasTool({
    lookAcross: (topic) => {
      const requestId = nextRequestId()
      emit({ t: 'atlas_request', requestId, topic })
      return new Promise((resolve) => {
        pendingAtlasReads.set(requestId, (result) =>
          resolve(
            result.ok
              ? { ok: true, leads: result.leads ?? '' }
              : { ok: false, error: result.error ?? 'the platform could not read it' },
          ),
        )
      })
    },
    proposeLink: (proposal) => {
      const requestId = nextRequestId()
      emit({ t: 'atlas_link_request', requestId, ...proposal })
      return new Promise((resolve) => {
        pendingAtlasLinks.set(requestId, (result) =>
          resolve(
            result.ok
              ? { ok: true, outcome: result.outcome ?? '' }
              : { ok: false, error: result.error ?? 'the platform could not record it' },
          ),
        )
      })
    },
  })

  const notesTool = createNotesTool({
    writeNote: (note) => {
      const requestId = nextRequestId()
      // Emitted immediately, not queued for the end of the run: see the `note`
      // frame's comment in sandbox-protocol.ts.
      emit({ t: 'note', requestId, note })
      return new Promise((resolve) => {
        pendingNotes.set(requestId, (result) =>
          resolve(result.ok ? { ok: true } : { ok: false, reason: result.reason ?? 'the platform refused it' }),
        )
      })
    },
    readNotes: () => {
      const requestId = nextRequestId()
      emit({ t: 'notes_request', requestId })
      return new Promise((resolve) => {
        pendingNoteReads.set(requestId, (result) =>
          resolve(
            result.ok
              ? { ok: true, ledger: result.ledger ?? '' }
              : { ok: false, error: result.error ?? 'the platform could not read them' },
          ),
        )
      })
    },
  })

  /**
   * The mapping channel, present only on a mastery run and
   * round-tripping to the host for the same reason the notes channel does: the map is
   * workspace-side state, and this process has no network and no database.
   */
  const mapTool = command.mastery
    ? createMapTool({
        recordMap: (fragment) => {
          const requestId = nextRequestId()
          emit({ t: 'map', requestId, fragment })
          return new Promise((resolve) => {
            pendingMapWrites.set(requestId, (result) =>
              resolve(
                result.ok
                  ? {
                      ok: true,
                      nodesWritten: result.nodesWritten ?? 0,
                      edgesWritten: result.edgesWritten ?? 0,
                      superseded: result.superseded ?? 0,
                    }
                  : { ok: false, reason: result.reason ?? 'the platform refused it' },
              ),
            )
          })
        },
      })
    : null

  /**
   * The handover channel, round-tripping to the host for the same reason
   * the notes channel does: starting a successor is workspace-side work, and this process
   * has no network and no database.
   */
  const handoffTool = createHandoffTool({
    handOver: (brief) => {
      const requestId = nextRequestId()
      emit({ t: 'handoff', requestId, brief })
      return new Promise((resolve) => {
        pendingHandoffs.set(requestId, (result) =>
          resolve(
            result.ok
              ? { ok: true }
              : { ok: false, reason: result.reason ?? 'the platform refused it' },
          ),
        )
      })
    },
  })

  /**
   * The channel, present only when the persona carries an envelope — the same
   * condition the unsandboxed path applies, and it has to be applied in both places
   * because these are two different processes building two different tool lists.
   */
  const selfTool = maySelfModify(persona.envelope ?? null)
    ? createSelfTool({
        revisePrompt: (edit) => {
          const requestId = nextRequestId()
          emit({ t: 'self_edit', requestId, ...edit })
          return new Promise((resolve) => {
            pendingSelfEdits.set(requestId, (result) =>
              resolve(
                result.ok
                  ? { ok: true, outcome: result.outcome ?? '' }
                  : { ok: false, error: result.error ?? 'the platform refused it' },
              ),
            )
          })
        },
        reviseTools: (edit) => {
          const requestId = nextRequestId()
          emit({ t: 'tools_edit', requestId, ...edit })
          return new Promise((resolve) => {
            pendingSelfEdits.set(requestId, (result) =>
              resolve(
                result.ok
                  ? { ok: true, outcome: result.outcome ?? '' }
                  : { ok: false, error: result.error ?? 'the platform refused it' },
              ),
            )
          })
        },
        proposeVariants: (edit) => {
          const requestId = nextRequestId()
          emit({ t: 'variants_propose', requestId, ...edit })
          return new Promise((resolve) => {
            pendingSelfEdits.set(requestId, (result) =>
              resolve(
                result.ok
                  ? { ok: true, outcome: result.outcome ?? '' }
                  : { ok: false, error: result.error ?? 'the platform refused it' },
              ),
            )
          })
        },
      })
    : null

  /**
   * The memory channel inside the container, on the same condition as `selfTool` just
   * above and applied here for the same reason: two processes, two tool lists, and a
   * check in one of them is a check the other does not have.
   */
  const experienceTool = maySelfModify(persona.envelope ?? null)
    ? createExperienceTool({
        recordExperience: (distillation) => {
          const requestId = nextRequestId()
          emit({ t: 'experience', requestId, distillation })
          return new Promise((resolve) => {
            pendingExperienceWrites.set(requestId, (result) =>
              resolve(
                result.ok
                  ? {
                      ok: true,
                      written: result.written ?? 0,
                      superseded: result.superseded ?? 0,
                      remaining: result.remaining ?? 0,
                    }
                  : { ok: false, reason: result.reason ?? 'the platform refused it' },
              ),
            )
          })
        },
      })
    : null

  /**
   * The verdict channel inside the container, present only when the host said this is
   * a verifier — the same gating `mapTool` has three lines up.
   */
  const verdictTool = command.verifyVariants
    ? createVerdictTool(command.verifyVariants.optionKeys, {
        submit: (verdict) => {
          const requestId = nextRequestId()
          emit({ t: 'variant_verdict', requestId, ...verdict })
          return new Promise((resolve) => {
            pendingSelfEdits.set(requestId, (result) =>
              resolve(
                result.ok
                  ? { ok: true, outcome: result.outcome ?? '' }
                  : { ok: false, error: result.error ?? 'the platform refused it' },
              ),
            )
          })
        },
      })
    : null

  /**
   * The proposal channel inside the container, present only when the host said this is a
   * proposer — the same gating `verdictTool` has just above, and the same `variants_propose`
   * message the self tool uses, because it is the same request arriving from a different
   * authority.
   */
  const proposalTool = command.proposeVariants
    ? createProposalTool(command.proposeVariants.personaName, {
        submit: (edit) => {
          const requestId = nextRequestId()
          emit({ t: 'variants_propose', requestId, ...edit })
          return new Promise((resolve) => {
            pendingSelfEdits.set(requestId, (result) =>
              resolve(
                result.ok
                  ? { ok: true, outcome: result.outcome ?? '' }
                  : { ok: false, error: result.error ?? 'the platform refused it' },
              ),
            )
          })
        },
      })
    : null

  const questionTool = createQuestionTool({
    askHuman: (question) => {
      const requestId = nextRequestId()
      emit({ t: 'question_request', requestId, question })
      return new Promise((resolve) => {
        pendingQuestions.set(requestId, resolve)
      })
    },
  })

  await runAgentOnBackend({
    persona,
    cwd: command.cwd,
    ...(command.task === undefined ? {} : { task: command.task }),
    ...(command.contextLedger === undefined ? {} : { contextLedger: command.contextLedger }),
    notesTool,
    atlasTool,
    ...(mapTool ? { mapTool } : {}),
    ...(verdictTool ? { verdictTool } : {}),
    ...(proposalTool ? { proposalTool } : {}),
    handoffTool,
    ...(selfTool ? { selfTool } : {}),
    ...(experienceTool ? { experienceTool } : {}),
    ...(command.mapContext === undefined ? {} : { mapContext: command.mapContext }),
    ...(command.experienceContext === undefined
      ? {}
      : { experienceContext: command.experienceContext }),
    ...(command.mastery === undefined ? {} : { mastery: command.mastery }),
    questionTool: questionTool.server,
    ...(command.resumeSessionId === undefined ? {} : { resumeSessionId: command.resumeSessionId }),
    isRiskyTool,
    // Resolved inside the container, against the mount point — which is where
    // the paths actually are. A host-side check would be resolving a path that
    // does not exist in the namespace the tool will run in.
    classifyEffect: (toolName, input) =>
      classifyToolEffect(toolName, input, command.cwd, resolveWithinRoot),
    onEvent: (event) => emitEvent({ t: 'event', event }),
    // Same backpressure path as onEvent (see emitEvent): the raw tier is chattier
    // than the structured one, so it is the more likely of the two to outrun the
    // host's ability to drain.
    onRawMessage: (line) => emitEvent({ t: 'raw', line }),
    ...(plannerTool
      ? { plannerTool: { server: plannerTool.server, toolName: PLANNER_TOOL_NAME } }
      : {}),
    ...(deltaTool
      ? { plannerTool: { server: deltaTool.server, toolName: PLAN_DELTA_TOOL_NAME } }
      : {}),
    onInputChannel: (channel) => {
      deliverToAgent = channel.deliver
    },
    onSessionId: (sessionId) => emit({ t: 'session', sessionId }),
    onContextUsage: (usage) =>
      emit({ t: 'context_usage', totalTokens: usage.totalTokens, maxTokens: usage.maxTokens }),
    onPermissionRequest: (toolUseId, toolName, input) => {
      emit({ t: 'permission_request', toolUseId, toolName, input })
      return new Promise((resolve) => {
        pendingPermissions.set(toolUseId, resolve)
      })
    },
  })

  const subtasks = plannerTool?.taken()
  if (subtasks && subtasks.length > 0) emit({ t: 'plan', subtasks })

  // Emitted even with no ops: "nothing should change" is an answer the human is
  // waiting on, and swallowing it would leave a steering turn that ran, cost money
  // and said nothing.
  const delta = deltaTool?.taken()
  if (delta) emit({ t: 'plan_delta', rationale: delta.rationale, ops: delta.ops })

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
