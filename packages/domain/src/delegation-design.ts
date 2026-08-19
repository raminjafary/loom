import { isWiderApprovalMode } from './approval-modes.js'
import { attenuateChildPersona } from './attenuation.js'
import { attenuateChildCapabilities } from './capabilities.js'
import { modelTierRank } from './model-pricing.js'
import type { PersonaSpec } from './agents.js'

/**
 * Why a planner cannot delegate to a worker — **all** the reasons, at design time.
 *
 * `attenuateChildPersona` is the authority and stays exactly as it is: it answers
 * one question at the one moment that matters, and returns on the first refusal
 * because a child start only needs to be refused once. That is the wrong shape for a
 * composition canvas. A human fixing the model tier, saving, and discovering the
 * budget cap, and then the auto-approve flag, is the failure the roadmap describes — the
 * gate's laconic answer is correct and useless here.
 *
 * So this enumerates. Two rules keep the pair honest:
 *
 * - **It never decides anything.** Nothing starts a run from this; the gate does.
 * - **`delegationDesign(...).ok` must equal `attenuateChildPersona(...).ok`**, over
 *   every combination, asserted in `delegation-design.test.ts`. A second opinion that
 *   could drift would be worse than no opinion, because it would be believed.
 */

export type DelegationRule =
  | 'tools'
  | 'delegates'
  | 'autoApprove'
  | 'budget'
  | 'model'
  | 'capabilities'
  | 'depth'

export interface DelegationRefusal {
  readonly rule: DelegationRule
  /** What is wrong, in the same terms the runtime gate uses. */
  readonly detail: string
  /** What a human would change to make it right. */
  readonly fix: string
  /**
   * Tools that, added to the planner's `harness.delegates`, would satisfy this rule.
   *
   * Present only for `tools` and `delegates`, and this is the one refusal a composer
   * may offer to fix by itself: widening an envelope is a decision a human is already
   * making by drawing the edge. Everything else — a cheaper model, a budget cap, an
   * auto-approve flag — changes what a *worker* is, which is not what drawing an edge
   * between two personas asked for.
   */
  readonly widenEnvelopeWith?: string[]
}

export interface DelegationDesign {
  readonly ok: boolean
  readonly refusals: DelegationRefusal[]
}

const ceilingOf = (planner: PersonaSpec): string[] =>
  planner.planner && planner.delegates ? planner.delegates : planner.tools

export const delegationDesign = (
  planner: PersonaSpec,
  worker: PersonaSpec,
  /** How many further hops this planner's children may make; 0 means they are leaves. */
  remainingDepth = 0,
): DelegationDesign => {
  const refusals: DelegationRefusal[] = []
  const ceiling = ceilingOf(planner)

  /**
   * Checked first because it is the one the roster applies before attenuation, and a
   * human looking at a greyed-out sub-planner otherwise gets told about tools when
   * the real answer is that nothing below it could run.
   */
  if (worker.planner && remainingDepth < 1) {
    refusals.push({
      rule: 'depth',
      detail: `${worker.name} is a planner, and this planner's children may not delegate any further.`,
      fix: 'Give the area to a worker instead, or raise the delegation depth limit.',
    })
  }

  const escalatedTools = worker.tools.filter((tool) => !ceiling.includes(tool))
  if (escalatedTools.length > 0) {
    refusals.push({
      rule: 'tools',
      detail: planner.planner
        ? `${worker.name} holds ${escalatedTools.join(', ')}, which is outside ${planner.name}'s delegation envelope.`
        : `${worker.name} holds ${escalatedTools.join(', ')}, which ${planner.name} does not hold itself.`,
      fix: planner.planner
        ? `Add ${escalatedTools.join(', ')} to ${planner.name}'s harness.delegates, or remove them from ${worker.name}.`
        : `${planner.name} is not a planner, so its own tools are the ceiling. Mark it a planner and give it an envelope.`,
      ...(planner.planner ? { widenEnvelopeWith: escalatedTools } : {}),
    })
  }

  const escalatedDelegates = (worker.planner && worker.delegates ? worker.delegates : []).filter(
    (tool) => !ceiling.includes(tool),
  )
  if (escalatedDelegates.length > 0) {
    refusals.push({
      rule: 'delegates',
      detail: `${worker.name} may hand its own children ${escalatedDelegates.join(', ')}, which is outside ${planner.name}'s ceiling.`,
      fix: `Add ${escalatedDelegates.join(', ')} to ${planner.name}'s harness.delegates, or narrow ${worker.name}'s.`,
      ...(planner.planner ? { widenEnvelopeWith: escalatedDelegates } : {}),
    })
  }

  if (isWiderApprovalMode(worker.approvalMode, planner.approvalMode)) {
    refusals.push({
      rule: 'autoApprove',
      detail: `${worker.name} may skip more approvals (${worker.approvalMode}) than ${planner.name} (${planner.approvalMode}).`,
      fix: `Narrow ${worker.name} to ${planner.approvalMode} or below, or widen ${planner.name} — a parent that must ask cannot hand down the right to skip asking.`,
    })
  }

  if (planner.budgetCapUsd !== null) {
    if (worker.budgetCapUsd === null) {
      refusals.push({
        rule: 'budget',
        detail: `${worker.name} is uncapped and ${planner.name} is capped at $${planner.budgetCapUsd.toFixed(2)}.`,
        fix: `Give ${worker.name} a cap of at most $${planner.budgetCapUsd.toFixed(2)}.`,
      })
    } else if (worker.budgetCapUsd > planner.budgetCapUsd) {
      refusals.push({
        rule: 'budget',
        detail: `${worker.name}'s cap ($${worker.budgetCapUsd.toFixed(2)}) is above ${planner.name}'s ($${planner.budgetCapUsd.toFixed(2)}).`,
        fix: `Lower ${worker.name} to at most $${planner.budgetCapUsd.toFixed(2)}, or raise ${planner.name}.`,
      })
    }
  }

  const capabilities = attenuateChildCapabilities(planner.capabilities ?? [], worker.capabilities ?? [])
  if (!capabilities.ok) {
    refusals.push({
      rule: 'capabilities',
      detail: capabilities.reason,
      fix: `Attach the same capability to ${planner.name}, or detach it from ${worker.name} — an MCP server is a route to a shell.`,
    })
  }

  /**
   * The one that surprises people, and the reason the last session's handoff records
   * "a cheap planner model silently empties its roster": a Haiku planner cannot start
   * a Sonnet worker, so a whole roster can be correct and empty at once.
   */
  const plannerRank = modelTierRank(planner.model)
  const workerRank = modelTierRank(worker.model)
  if (plannerRank !== null && workerRank !== null && workerRank > plannerRank) {
    refusals.push({
      rule: 'model',
      detail: `${worker.name} runs on ${worker.model}, a higher tier than ${planner.name}'s ${planner.model}.`,
      fix: `Move ${planner.name} to ${worker.model} or higher, or move ${worker.name} down.`,
    })
  }
  if (plannerRank !== null && workerRank === null) {
    refusals.push({
      rule: 'model',
      detail: `${worker.name}'s model (${worker.model}) is unranked, so it cannot be shown to be within ${planner.name}'s tier.`,
      fix: 'Use a priced model, or move both to unranked ones — a self-hosted deployment has no place in the ranking.',
    })
  }

  return { ok: refusals.length === 0, refusals }
}

/**
 * The whole design-time picture for one workspace: every planner against every
 * candidate. Small by construction — personas are counted in tens, not thousands —
 * and computed in one place so a canvas, a launcher and a roster cannot disagree.
 */
export interface DelegationEdge {
  readonly plannerName: string
  readonly workerName: string
  readonly ok: boolean
  readonly refusals: DelegationRefusal[]
}

export const delegationMatrix = (
  personas: readonly PersonaSpec[],
  remainingDepth = 0,
): DelegationEdge[] => {
  const edges: DelegationEdge[] = []
  for (const planner of personas) {
    if (!planner.planner) continue
    for (const worker of personas) {
      const design = delegationDesign(planner, worker, remainingDepth)
      edges.push({
        plannerName: planner.name,
        workerName: worker.name,
        ok: design.ok,
        refusals: design.refusals,
      })
    }
  }
  return edges
}

/**
 * Whether the two agree. Exported so the test can assert it over generated
 * combinations rather than over a table someone remembered to extend.
 */
export const agreesWithGate = (
  planner: PersonaSpec,
  worker: PersonaSpec,
): boolean => delegationDesign(planner, worker, 1).ok === attenuateChildPersona(planner, worker).ok
