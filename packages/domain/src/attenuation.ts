import { modelTierRank } from './model-pricing.js'
import type { PersonaSpec } from './agents.js'

/**
 * PLAN.md §5's capability attenuation: "a child run can never request tools,
 * model tier, budget, or path scope exceeding its parent's."
 *
 * This is the rule that keeps Phase 2's swarm from being a privilege-escalation
 * machine. Without it, a `tools: []` Planner — deliberately given no filesystem or
 * shell (§3, §6's trust boundary) — could simply spawn a child that has them, and
 * the trust boundary would be decoration. §4f later generalizes the same idea into
 * the *envelope* a self-modifying agent may rewrite itself within; this is that
 * mechanism's first, narrower instance, so they should stay recognizably alike.
 *
 * Path scope is not checked here because it is not expressible in a `PersonaSpec`:
 * every run writes only inside its own clone, enforced inside the container
 * (§6 A3), and a child gets its own clone rather than a subset of its parent's.
 */

export type AttenuationVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

export const attenuateChildPersona = (
  parent: PersonaSpec,
  child: PersonaSpec,
): AttenuationVerdict => {
  const escalatedTools = child.tools.filter((tool) => !parent.tools.includes(tool))
  if (escalatedTools.length > 0) {
    return {
      ok: false,
      reason: `Child run may not use tools its parent lacks: ${escalatedTools.join(', ')}`,
    }
  }

  // A parent that must ask a human cannot hand down the right to skip asking.
  if (child.autoApprove && !parent.autoApprove) {
    return { ok: false, reason: 'Child run may not auto-approve when its parent does not' }
  }

  // An uncapped parent constrains nothing — but an uncapped *child* of a capped
  // parent is the escalation this exists to stop, since the cap is what bounds a
  // runaway loop's cost (§6/§9: caps are enforced, not advisory).
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

  const parentRank = modelTierRank(parent.model)
  const childRank = modelTierRank(child.model)
  // An unknown model is not silently allowed past the tier check: a typo or a
  // newly-added id would otherwise be the one way to escalate model tier. It is
  // also not a hard failure when *both* are unknown — a self-hosted open-weight
  // deployment (§8's vLLM path) has no place in this ranking at all.
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
