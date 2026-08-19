import { isWiderApprovalMode } from './approval-modes.js'
import { attenuateChildCapabilities } from './capabilities.js'
import { attenuateEnvelope, envelopeRefusalSummary } from './envelope.js'
import { modelTierRank } from './model-pricing.js'
import type { PersonaSpec } from './agents.js'

/**
 * Capability attenuation: a child run can never request tools, model tier, budget, or
 * path scope exceeding its parent's.
 *
 * This is the rule that keeps Phase 2's swarm from being a privilege-escalation machine.
 * Without it, a `tools: []` Planner — deliberately given no filesystem or shell (the
 * product shape, the trust boundary) — could simply spawn a child that has them, and the
 * trust boundary would be decoration. Continuity mode later generalizes the same idea into
 * the *envelope* a self-modifying agent may rewrite itself within; this is that mechanism's
 * first, narrower instance, so they should stay recognizably alike.
 *
 * Path scope is not checked here because it is not expressible in a `PersonaSpec`: every
 * run writes only inside its own clone, enforced inside the container, and a child gets its
 * own clone rather than a subset of its parent's.
 */

export type AttenuationVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

export const attenuateChildPersona = (
  parent: PersonaSpec,
  child: PersonaSpec,
): AttenuationVerdict => {
  /**
   * A Planner is measured against its declared envelope rather than its own tools — see
   * `PersonaSpec.delegates` for why the `tools: []` and the * "never exceeding its
   * parent's" cannot both apply to the same list.
   *
   * Only a planner may carry one, which is checked where personas are authored;
   * for every other parent this is just its own tool list, unchanged.
   */
  const ceiling = parent.planner && parent.delegates ? parent.delegates : parent.tools
  const escalatedTools = child.tools.filter((tool) => !ceiling.includes(tool))
  if (escalatedTools.length > 0) {
    return {
      ok: false,
      reason: parent.planner
        ? `Child run may not use tools outside its planner's delegation envelope: ${escalatedTools.join(', ')}`
        : `Child run may not use tools its parent lacks: ${escalatedTools.join(', ')}`,
    }
  }

  /**
   * A child Planner's *envelope* attenuates too, and for the same reason its tools
   * do. Checking only `tools` reads a Planner as harmless — it holds nothing — so a
   * Planner whose envelope excludes `Bash` could parent one whose envelope includes
   * it, and that inner Planner could then start a `Bash` worker. Nothing is refused
   * at any hop, and the outer envelope has been widened by delegating through it.
   *
   * That is the escalation this file exists to stop, moved one level down: what a
   * parent may hand down bounds what its children may hand down.
   */
  const escalatedDelegates = (child.planner && child.delegates ? child.delegates : []).filter(
    (tool) => !ceiling.includes(tool),
  )
  if (escalatedDelegates.length > 0) {
    return {
      ok: false,
      reason: `Child planner may not delegate tools outside its parent's own ceiling: ${escalatedDelegates.join(', ')}`,
    }
  }

  /**
   * A parent that must ask a human cannot hand down the right to skip asking — now
   * over an ordered mode rather than a boolean, so `accept-edits` under `ask` is
   * refused for the same reason `auto` under `ask` always was (`approval-modes.ts`).
   */
  if (isWiderApprovalMode(child.approvalMode, parent.approvalMode)) {
    return {
      ok: false,
      reason: `Child run's approval mode (${child.approvalMode}) is wider than its parent's (${parent.approvalMode})`,
    }
  }

  // An uncapped parent constrains nothing — but an uncapped *child* of a capped parent is
  // the escalation this exists to stop, since the cap is what bounds a runaway loop's cost
  // (the security model/the cost model: caps are enforced, not advisory).
  if (parent.budgetCapUsd !== null) {
    if (child.budgetCapUsd === null) {
      return {
        ok: false,
        reason: `Child run must carry a budget cap: its parent is capped at $${parent.budgetCapUsd.toFixed(2)}`,
      }
    }
    if (child.budgetCapUsd > parent.budgetCapUsd) {
      return {
        ok: false,
        reason: `Child run's budget cap ($${child.budgetCapUsd.toFixed(2)}) exceeds its parent's ($${parent.budgetCapUsd.toFixed(2)})`,
      }
    }
  }

  // Capabilities are the sharpest case of this rule: a `tools: []` Planner has no
  // shell of its own, but an MCP server is a route to one.
  const capabilities = attenuateChildCapabilities(parent.capabilities ?? [], child.capabilities ?? [])
  if (!capabilities.ok) return capabilities

  /**
   * The **envelope** attenuates too.
   *
   * This is `delegates`' own amendment arriving one level up, and the escalation is the
   * same shape: checking a child's *current* configuration reads a modest worker as
   * harmless, while the thing actually being handed down is what that worker may later
   * become. A child whose envelope reaches past its parent's is a privilege escalation one
   * delegation hop long and one self-edit deep — nothing is refused at either moment, and
   * the ceiling has been raised by going through it.
   */
  const envelope = attenuateEnvelope(parent.envelope ?? null, child.envelope ?? null)
  if (!envelope.ok) {
    return { ok: false, reason: `Child run's envelope exceeds its parent's: ${envelopeRefusalSummary(envelope)}` }
  }

  const parentRank = modelTierRank(parent.model)
  const childRank = modelTierRank(child.model)
  // An unknown model is not silently allowed past the tier check: a typo or a
  // newly-added id would otherwise be the one way to escalate model tier. It is
  // also not a hard failure when *both* are unknown — a self-hosted open-weight
  // deployment (the vLLM path) has no place in this ranking at all.
  if (parentRank !== null && childRank !== null && childRank > parentRank) {
    return {
      ok: false,
      reason: `Child run's model (${child.model}) is a higher tier than its parent's (${parent.model})`,
    }
  }
  if (parentRank !== null && childRank === null) {
    return {
      ok: false,
      reason: `Child run's model (${child.model}) is unranked, so it cannot be shown to be within its parent's tier (${parent.model})`,
    }
  }

  return { ok: true }
}
