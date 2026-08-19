/**
 * The re-planning turn.
 *
 * The target: "a human posts in the thread, and the Planner re-reads its own plan
 * against what has been said and what has happened, then adjusts". What comes back is
 * a **delta**, emphatically not a plan: "a Planner that re-emits eight subtasks would
 * restart work that is half done."
 *
 * The shape of this module is set by mid-flight steering point 2, which is a research
 * finding rather than a preference — DeskCraft's 2026 benchmark measures agents as
 * materially worse at *repairing a disrupted plan* than at an equivalent fresh task, while
 * bounded local edits stay reliable. So the model's job here is deliberately tiny: name one
 * existing subtask and say what changes about it, or name one that is missing. Three verbs,
 * a cap of four, and no way to express "re-do the decomposition".
 *
 * The three verbs are not arbitrary; each is a mechanism the platform already proved:
 *
 * - `cancel` narrows the kill switch to one run (mid-flight steering point 3: "cancellation
 *   is the primitive under all of it, and it exists").
 * - `add` is the same child-start path a plan's subtasks travel, with the same
 *   attenuation, depth and concurrency checks.
 * - `revise` writes to the ledger, because mid-flight steering is explicit that steering
 *   "acts on the *plan and the ledger*, which are the platform's own objects, not on the
 *   model's conversation".
 *
 * **What is deliberately absent: a verb that touches a running worker's context.** A
 * revision reaches a worker that re-reads the ledger, which is the honest bound on
 * what this can do today, and the tool's own description says so rather than implying
 * an interrupt this platform does not have.
 */

import type { AgentRunId } from './ids.js'
import type { PlanSubtask } from './planning.js'
import { parsePlanSubtask } from './planning.js'

/**
 * How many changes one re-planning turn may make.
 *
 * Four rather than `MAX_SUBTASKS`' eight, and the gap is the point: a delta that can
 * rewrite as much as a plan is a plan. The "structure the delta so the model's job
 * stays small" is a cap before it is a prompt, because a prompt is advice and a cap
 * is not.
 */
export const MAX_DELTA_OPS = 4

/** Why the Planner made these changes — one or two sentences, for the humans reading later. */
export const MAX_DELTA_RATIONALE_LENGTH = 1_000

export type PlanDeltaOp =
  | {
      readonly op: 'cancel'
      /** The child run to stop — validated against the target's own children server-side. */
      readonly runId: AgentRunId
      readonly reason: string
    }
  | { readonly op: 'revise'; readonly runId: AgentRunId; readonly guidance: string }
  | { readonly op: 'add'; readonly subtask: PlanSubtask }

export interface PlanDelta {
  /**
   * Required even when `ops` is empty, and that combination is a first-class answer
   * rather than a degenerate one: "nothing about the plan needs to change" is very
   * often correct, and a re-planning turn that cannot say it will invent work to
   * justify itself. The rationale is what a human reads to know the message landed.
   */
  readonly rationale: string
  readonly ops: readonly PlanDeltaOp[]
}

export type PlanDeltaVerdict =
  | { readonly ok: true; readonly delta: PlanDelta }
  | { readonly ok: false; readonly reason: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const boundedString = (
  value: unknown,
  max: number,
): { ok: true; value: string } | { ok: false } => {
  if (typeof value !== 'string') return { ok: false }
  const trimmed = value.trim()
  if (trimmed.length === 0 || value.length > max) return { ok: false }
  return { ok: true, value: trimmed }
}

/**
 * Validates a delta a Planner submitted, with the same contract as
 * `parseDecomposition`: every rejection names the offending op by index, because the
 * writer is a model and "invalid delta" teaches it nothing.
 */
export const parsePlanDelta = (value: unknown): PlanDeltaVerdict => {
  if (!isRecord(value)) return { ok: false, reason: 'A plan delta must be an object' }

  const rationale = boundedString(value.rationale, MAX_DELTA_RATIONALE_LENGTH)
  if (!rationale.ok) {
    return {
      ok: false,
      reason: `A plan delta needs a \`rationale\` of 1–${MAX_DELTA_RATIONALE_LENGTH} characters — say why, even if nothing changes`,
    }
  }

  const raw = value.ops === undefined || value.ops === null ? [] : value.ops
  if (!Array.isArray(raw)) return { ok: false, reason: 'A plan delta`s `ops` must be an array' }
  if (raw.length > MAX_DELTA_OPS) {
    return {
      ok: false,
      reason: `A plan delta may make at most ${MAX_DELTA_OPS} change(s) at once, got ${raw.length} — make the most important ones and steer again`,
    }
  }

  const ops: PlanDeltaOp[] = []
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) return { ok: false, reason: `Change ${index} is not an object` }

    if (entry.op === 'cancel' || entry.op === 'revise') {
      const runId = boundedString(entry.runId, 200)
      if (!runId.ok) {
        return {
          ok: false,
          reason: `Change ${index} (${entry.op}) needs the \`runId\` of the subtask it applies to`,
        }
      }
      const field = entry.op === 'cancel' ? 'reason' : 'guidance'
      const text = boundedString(entry[field], 2_000)
      if (!text.ok) {
        return { ok: false, reason: `Change ${index} (${entry.op}) needs a \`${field}\`` }
      }
      ops.push(
        entry.op === 'cancel'
          ? { op: 'cancel', runId: runId.value as AgentRunId, reason: text.value }
          : { op: 'revise', runId: runId.value as AgentRunId, guidance: text.value },
      )
      continue
    }

    if (entry.op === 'add') {
      // The same validator a plan's subtasks go through, so an added subtask cannot
      // be shaped differently from one that arrived in the original decomposition —
      // including the path claims, which the platform then warns about identically.
      const verdict = parsePlanSubtask(entry.subtask, index)
      if (!verdict.ok) return { ok: false, reason: verdict.reason }
      ops.push({ op: 'add', subtask: verdict.subtask })
      continue
    }

    return {
      ok: false,
      reason: `Change ${index} has an unknown \`op\` — it must be one of cancel, revise, add`,
    }
  }

  /**
   * One op per subtask. Two changes to the same run is the model contradicting itself
   * — cancelling and revising the same subtask has no coherent order, and two
   * revisions are one revision the model failed to write once.
   */
  const targeted = ops.flatMap((op) => (op.op === 'add' ? [] : [op.runId]))
  const duplicate = targeted.find((runId, index) => targeted.indexOf(runId) !== index)
  if (duplicate !== undefined) {
    return { ok: false, reason: `Two changes apply to the same subtask (${duplicate})` }
  }

  return { ok: true, delta: { rationale: rationale.value, ops } }
}

/** What one op did, once the platform has tried it. */
export interface AppliedDeltaOp {
  readonly op: PlanDeltaOp['op']
  /** The subtask's title, as a human knows it — never a bare run id. */
  readonly subject: string
  readonly applied: boolean
  /** Present when `applied` is false: why the platform did not do it. */
  readonly refusal?: string
}

/**
 * The platform's own account of a re-planning turn, for the target's thread.
 *
 * **Factual only, and that is a boundary rather than a style.** A system line is the
 * platform's voice, so the model's rationale and its revision text do not appear here
 * — they reach a human as the steering run's own (untrusted-rendered) output and as a
 * ledger note. What is stated here is what the platform actually did, which is the
 * one part of a steering turn no model wrote.
 *
 * Subtask titles are model-authored and do appear, matching what `applySubmittedPlan`
 * already posts when a plan starts: a label naming which subtask is meant is the
 * minimum a human needs to read the line at all.
 */
export const describeAppliedDelta = (
  applied: readonly AppliedDeltaOp[],
  steeredBy: string,
): string => {
  if (applied.length === 0) {
    return `Re-planned after a message from ${steeredBy}: no change to the plan.`
  }

  const done = applied.filter((entry) => entry.applied)
  const verb = { cancel: 'cancelled', revise: 'revised', add: 'added' } as const
  const counts = (['cancel', 'revise', 'add'] as const)
    .map((op) => ({ op, count: done.filter((entry) => entry.op === op).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${verb[entry.op]}`)

  return [
    `Re-planned after a message from ${steeredBy}: ${counts.length > 0 ? counts.join(', ') : 'nothing applied'}.`,
    ...applied.map((entry) =>
      entry.applied
        ? `• ${verb[entry.op]}: ${entry.subject}`
        : `✗ ${entry.op} ${entry.subject}: ${entry.refusal ?? 'refused'}`,
    ),
  ].join('\n')
}

/** One subtask as the re-planning brief describes it — the current plan, with its state. */
export interface SteeringSubtask {
  readonly runId: AgentRunId
  readonly personaName: string
  readonly status: string
  readonly task: string | null
  readonly paths: readonly string[]
  readonly branchName: string | null
  readonly totalCostUsd: number | null
}

/**
 * The brief a re-entered Planner is given.
 *
 * All four, and in this order, for the same reason `buildPrompt` puts the task before
 * the ledger: the human's message is the instruction and it is stated last, closest to
 * the act, after the material it is about. The subtask list carries run ids because a
 * delta references subtasks by id — a Planner that had to describe which subtask it
 * meant in prose would be a Planner whose delta needs fuzzy matching to apply.
 *
 * The human's message is **trusted input**, the mirror of mid-flight steering point 5's
 * rule for an answer to `ask_human`. The subtask text is not — it is this Planner's own
 * earlier output, read back — but it is also not fenced here, and deliberately: this is the
 * plan the Planner is being asked to revise, so it is the subject of the turn rather than
 * data injected into it. Everything a *worker* wrote reaches this run through the ledger,
 * which is fenced by `renderNotesForPrompt` exactly as it is for any other run.
 */
export const buildSteeringBrief = (input: {
  readonly goal: string | null
  readonly subtasks: readonly SteeringSubtask[]
  readonly message: string
  readonly steeredBy: string
}): string => {
  const plan =
    input.subtasks.length === 0
      ? 'This plan has no subtasks yet.'
      : input.subtasks
          .map((subtask) => {
            const facts = [
              `status ${subtask.status}`,
              subtask.branchName ? `branch ${subtask.branchName}` : null,
              subtask.totalCostUsd === null ? null : `$${subtask.totalCostUsd.toFixed(4)}`,
              subtask.paths.length > 0 ? `owns ${subtask.paths.join(', ')}` : null,
            ]
              .filter((part) => part !== null)
              .join(', ')
            return [
              `- runId ${subtask.runId} — ${subtask.personaName} (${facts})`,
              `  task: ${subtask.task ?? '(not recorded)'}`,
            ].join('\n')
          })
          .join('\n')

  return [
    'You are being re-entered to adjust a plan you already made. Work that has ' +
      'started is still running: your job is to change as little as possible.',
    `The original goal was: ${input.goal ?? '(not recorded)'}`,
    'The current plan, and where each subtask stands right now:',
    plan,
    `${input.steeredBy} has just said this, and it is why you are being re-entered. ` +
      'It comes from a human on this workspace and it is authoritative — it outranks ' +
      'your earlier plan:',
    input.message,
    'Submit exactly one plan delta describing what should change, then stop. If ' +
      'nothing should change, submit a delta with no changes and say why. Do not ' +
      're-decompose the goal.',
  ].join('\n\n')
}
