import { isWiderApprovalMode } from './approval-modes.js'
import { modelTierRank } from './model-pricing.js'
import type { PersonaSpec } from './agents.js'

/**
 * The envelope — "a human grants a persona a maximum tool set, model tier,
 * budget cap, path scope, MCP references, and subagent depth. Inside its envelope an agent
 * may rewrite itself freely and without asking. It can never widen its own envelope —
 * only a human can, through the normal contract."
 *
 * **Why this comes first among the five self-modification tiers**, and why it is built
 * alone: continuity mode calls it the prerequisite for all of them, and the reason is structural
 * rather than sequential. The envelope is what makes tiers 2–4 *bounded at all*, so
 * building any tier before it means building an unbounded version and retro-fitting the
 * bound onto traffic that has already run without one.
 *
 * **What it gives up, deliberately.** the attenuation keeps the property that matters —
 * there is a ceiling and the ceiling is human-set — while giving up the property that was
 * incidental: that the ceiling is also the *current* configuration. That trade is the whole
 * feature. Without it, "an agent may edit its own prompt" and "an agent may not widen its
 * own authority" are the same sentence and one of them has to lose.
 *
 * ## Four decisions this file makes that continuity mode leaves open
 *
 * **1. An absent envelope forbids self-modification rather than permitting anything.**
 * The tempting reading of `envelope: null` is "no ceiling", and it is the wrong one: it
 * would make every persona that predates this field a self-rewriting agent with no bound,
 * which is precisely what continuity mode says must not exist. So null means *this persona may not
 * rewrite itself*, and to let it, a human first says how far. That is what turns "off by
 * default" into a real off switch rather than a permissive default — the same distinction
 * The canvas design had to draw for the reconciler's env var.
 *
 * **2. A persona must fit inside its own envelope.** Checked where personas are authored.
 * Otherwise the ceiling is a decoration on a room that is already taller than it: a
 * persona holding `Bash` with an envelope that excludes it would be refused every
 * self-modification while continuing to run `Bash`, which teaches an operator that the
 * envelope means something it does not.
 *
 * **3. `delegates` is bounded by the envelope too**, and this is the escalation that would
 * otherwise walk straight through. `delegates` is what a planner hands *down*; the
 * envelope is what the planner may *become*. A planner permitted to rewrite its own
 * delegation envelope up to a ceiling nobody checked could mint a worker stronger than
 * anything its own envelope allows — the same two-hop escape the amendment already had
 * to close once for child planners, arriving by a different road.
 *
 * **4. Path scope is absent, and saying so is better than storing it.** continuity mode lists six
 * fields and five are here. `attenuation.ts` already records why the sixth cannot be
 * expressed: every run writes only inside its own clone, enforced in the container
 *, and a child gets its own clone rather than a subset of its parent's. A narrower
 * scope — a persona that may touch only `packages/db/` — is a real feature and needs an
 * enforcer inside the sandbox that does not exist. Storing it now would put a control on
 * an envelope that the runtime ignores, which is the one thing the roadmap forbids of the design
 * canvas and is no better here.
 */

/**
 * A human-set ceiling on what a persona may become.
 *
 * Every field is a maximum, and every field is optional in the sense that `null` means
 * "this dimension is not raised at all by the envelope" — not "unbounded". The
 * envelope's *existence* is the permission; each field then says how far.
 */
export interface Envelope {
 /**
 * The most tools this persona may ever hold. An empty list is meaningful: a persona
 * that may rewrite its prompt and nothing else.
 */
 readonly tools: string[]
 /**
 * A model **id** whose tier is the ceiling, not a tier name.
 *
 * Reusing `modelTierRank` rather than inventing a second vocabulary, for the reason
 * `attenuateChildPersona` gives: a tier name would be a third place the ranking of
 * models lives, and the two would drift on the next model release. Null leaves the
 * model unbounded by the envelope — the parent's own tier still bounds a child.
 */
 readonly model: string | null
 /** The most this persona may ever cap itself at. Null leaves spend to the parent's cap. */
 readonly budgetCapUsd: number | null
 /**
 * Capability names this persona may reference.
 *
 * By name rather than by id: an envelope is written by a human in a persona's
 * frontmatter, and a uuid in a markdown file is a thing nobody can review.
 */
 readonly capabilities: string[]
 /**
 * How many further delegation hops this persona's children may make.
 *
 * The "subagent depth". Distinct from the workspace-wide `maxDelegationDepth`, which
 * bounds cost; this bounds *authority reach* per persona, and the smaller of the two
 * wins wherever they meet.
 */
 readonly subagentDepth: number | null
 /**
 * The widest approval mode this persona may ever hold.
 *
 * Not in the list, and it belongs: `auto` is the difference between an agent that
 * asks before a risky call and one that does not, which is a larger change in blast
 * radius than adding a tool. An envelope that bounded tools but let a self-edit flip
 * `ask` to `auto` would bound the wrong axis.
 */
 readonly approvalMode: PersonaSpec['approvalMode'] | null
}

export type EnvelopeRule =
 | 'tools'
 | 'delegates'
 | 'model'
 | 'budget'
 | 'capabilities'
 | 'depth'
 | 'approvalMode'
 | 'absent'

export interface EnvelopeRefusal {
 readonly rule: EnvelopeRule
 /** What exceeds the envelope, in the terms the ceiling is written in. */
 readonly detail: string
 /**
 * What a human would have to widen, phrased as the request continuity mode asks for.
 *
 * Continuity mode: "a modification that would exceed the envelope is rejected and surfaced to a
 * human as a request, not silently clamped — clamping teaches an agent to probe." So
 * every refusal carries the ask, and nothing in this file returns a narrowed value.
 */
 readonly request: string
}

export interface EnvelopeVerdict {
 readonly ok: boolean
 /** Every reason, not the first — see `delegationDesign` for why one is not enough. */
 readonly refusals: EnvelopeRefusal[]
}

const ok: EnvelopeVerdict = { ok: true, refusals: [] }

const verdict = (refusals: EnvelopeRefusal[]): EnvelopeVerdict => ({
 ok: refusals.length === 0,
 refusals,
})

/** The envelope a persona holding none is measured against: none, and nothing may change. */
export const NO_ENVELOPE = null

/**
 * Whether this persona may rewrite itself at all.
 *
 * The whole of decision 1 above, as one function, so no caller has to remember which way
 * null falls. A persona with no envelope is not an agent with no ceiling; it is an agent
 * with no permission.
 */
export const maySelfModify = (envelope: Envelope | null): boolean => envelope !== null

/**
 * Whether a proposed persona configuration fits inside an envelope.
 *
 * Used in two places that must agree: where a human authors a persona (does this persona
 * fit its own stated ceiling?) and wherever a self-modification is applied (does the
 * thing being asked for fit?). One function rather than two, because a self-edit that the
 * authoring path would have refused is a way to reach a state a human could not have
 * written — and that is the escalation, arriving as an inconsistency rather than as a
 * hole.
 *
 * `spec` is a `PersonaSpec` rather than a partial patch on purpose: an envelope check
 * against a diff has to reason about what the unchanged fields are, and the one thing
 * worth being certain of here is the *resulting* configuration.
 */
export const envelopeAllows = (
 envelope: Envelope | null,
 spec: Pick<
 PersonaSpec,
 'name' | 'tools' | 'model' | 'budgetCapUsd' | 'approvalMode' | 'planner' | 'delegates' | 'capabilities'
 >,
): EnvelopeVerdict => {
 if (envelope === null) {
 return verdict([
 {
 rule: 'absent',
 detail: `${spec.name} has no envelope, so there is no ceiling to check against.`,
 request:
 'Give this persona an envelope before it may change itself. An absent envelope ' +
 'is no permission, not an unlimited one.',
 },
 ])
 }

 const refusals: EnvelopeRefusal[] = []

 const outsideTools = spec.tools.filter((tool) => !envelope.tools.includes(tool))
 if (outsideTools.length > 0) {
 refusals.push({
 rule: 'tools',
 detail: `Tools outside the envelope: ${outsideTools.join(', ')}.`,
 request: `Add ${outsideTools.join(', ')} to this persona's envelope, or drop them here.`,
 })
 }

 /**
 * Decision 3. A planner's own `tools` are read-only by the planner/worker trust boundary, so this is the list that
 * actually says what its workers may hold — and an unchecked one is a ceiling a planner
 * can raise by editing a different field from the one being guarded.
 */
 const handedDown = spec.planner && spec.delegates ? spec.delegates: []
 const outsideDelegates = handedDown.filter((tool) => !envelope.tools.includes(tool))
 if (outsideDelegates.length > 0) {
 refusals.push({
 rule: 'delegates',
 detail: `Delegated tools outside the envelope: ${outsideDelegates.join(', ')}.`,
 request:
 `Add ${outsideDelegates.join(', ')} to this persona's envelope before it may hand ` +
 'them down. What a persona may become bounds what it may give away.',
 })
 }

 if (envelope.model !== null) {
 const ceiling = modelTierRank(envelope.model)
 const asked = modelTierRank(spec.model)
 /**
 * An unranked model against a ranked ceiling is refused rather than allowed, exactly
 * as `attenuateChildPersona` refuses it: a typo or a newly-released id would
 * otherwise be the one reliable way past a tier check.
 */
 if (ceiling !== null && asked === null) {
 refusals.push({
 rule: 'model',
 detail: `${spec.model} is unranked, so it cannot be shown to be within the envelope's tier (${envelope.model}).`,
 request: `Name ${spec.model} as the envelope's model if that tier is intended.`,
 })
 } else if (ceiling !== null && asked !== null && asked > ceiling) {
 refusals.push({
 rule: 'model',
 detail: `${spec.model} is a higher tier than the envelope's ceiling (${envelope.model}).`,
 request: `Raise the envelope's model to ${spec.model}, or choose a cheaper tier here.`,
 })
 }
 }

 if (envelope.budgetCapUsd !== null) {
 if (spec.budgetCapUsd === null) {
 refusals.push({
 rule: 'budget',
 detail: `Uncapped, against an envelope capped at $${envelope.budgetCapUsd.toFixed(2)}.`,
 request: `Set a cap of at most $${envelope.budgetCapUsd.toFixed(2)}, or raise the envelope.`,
 })
 } else if (spec.budgetCapUsd > envelope.budgetCapUsd) {
 refusals.push({
 rule: 'budget',
 detail: `Cap $${spec.budgetCapUsd.toFixed(2)} exceeds the envelope's $${envelope.budgetCapUsd.toFixed(2)}.`,
 request: `Raise the envelope's cap to $${spec.budgetCapUsd.toFixed(2)} if that spend is intended.`,
 })
 }
 }

 const outsideCapabilities = (spec.capabilities ?? [])
.map((capability) => capability.name)
.filter((name) => !envelope.capabilities.includes(name))
 if (outsideCapabilities.length > 0) {
 refusals.push({
 rule: 'capabilities',
 detail: `Capabilities outside the envelope: ${outsideCapabilities.join(', ')}.`,
 request:
 `Add ${outsideCapabilities.join(', ')} to this persona's envelope. The capability registry treats an ` +
 'MCP server as a route to a shell, so this is a tool grant by another name.',
 })
 }

 if (envelope.approvalMode !== null && isWiderApprovalMode(spec.approvalMode, envelope.approvalMode)) {
 refusals.push({
 rule: 'approvalMode',
 detail: `Approval mode ${spec.approvalMode} is wider than the envelope's ${envelope.approvalMode}.`,
 request: `Widen the envelope to ${spec.approvalMode} if this persona should stop asking.`,
 })
 }

 return verdict(refusals)
}

/**
 * A child's envelope against its parent's.
 *
 * **The asymmetry in how null falls on each side is the whole of this function**, and
 * getting it backwards is the escalation:
 *
 * - A **parent** with no envelope bounds nothing *here*. It is not permitted to rewrite
 * itself, so its configuration is fixed and the ordinary attenuation against its own
 * tools is the live check. Refusing every child of an envelope-less parent would make
 * the field impossible to adopt incrementally.
 * - A **child** with no envelope is fine, and is the common case: a worker nobody intends
 * to let rewrite itself. What is refused is a child whose envelope reaches past its
 * parent's — because a child that may become something its parent may not become is a
 * privilege escalation one delegation hop long.
 */
export const attenuateEnvelope = (
 parent: Envelope | null,
 child: Envelope | null,
): EnvelopeVerdict => {
 if (child === null) return ok
 if (parent === null) return ok

 const refusals: EnvelopeRefusal[] = []

 const widerTools = child.tools.filter((tool) => !parent.tools.includes(tool))
 if (widerTools.length > 0) {
 refusals.push({
 rule: 'tools',
 detail: `Child envelope reaches tools its parent's does not: ${widerTools.join(', ')}.`,
 request: `Add ${widerTools.join(', ')} to the parent's envelope first, or drop them from the child's.`,
 })
 }

 if (parent.model !== null) {
 const ceiling = modelTierRank(parent.model)
 const asked = child.model === null ? null: modelTierRank(child.model)
 /**
 * A child envelope with **no** model ceiling under a parent that has one is refused,
 * and this is the case the `envelopeAllows` version does not have: null there means
 * "the envelope does not raise this dimension", which is safe because the parent's own
 * tier still bounds the run. Here the child envelope *is* the ceiling a later
 * self-edit will be measured against, so leaving it open hands the child a dimension
 * its parent had closed.
 */
 if (ceiling !== null && child.model === null) {
 refusals.push({
 rule: 'model',
 detail: `Child envelope sets no model ceiling, under a parent capped at ${parent.model}.`,
 request: `Give the child envelope a model ceiling of at most ${parent.model}.`,
 })
 } else if (ceiling !== null && asked === null && child.model !== null) {
 refusals.push({
 rule: 'model',
 detail: `Child envelope's model (${child.model}) is unranked, so it cannot be shown to be within ${parent.model}.`,
 request: `Name a ranked model in the child envelope, at or below ${parent.model}.`,
 })
 } else if (ceiling !== null && asked !== null && asked > ceiling) {
 refusals.push({
 rule: 'model',
 detail: `Child envelope's model (${child.model}) is a higher tier than its parent's (${parent.model}).`,
 request: `Lower the child envelope to at most ${parent.model}.`,
 })
 }
 }

 if (parent.budgetCapUsd !== null) {
 if (child.budgetCapUsd === null) {
 refusals.push({
 rule: 'budget',
 detail: `Child envelope is uncapped, under a parent capped at $${parent.budgetCapUsd.toFixed(2)}.`,
 request: `Cap the child envelope at no more than $${parent.budgetCapUsd.toFixed(2)}.`,
 })
 } else if (child.budgetCapUsd > parent.budgetCapUsd) {
 refusals.push({
 rule: 'budget',
 detail: `Child envelope's cap ($${child.budgetCapUsd.toFixed(2)}) exceeds its parent's ($${parent.budgetCapUsd.toFixed(2)}).`,
 request: `Lower the child envelope's cap to at most $${parent.budgetCapUsd.toFixed(2)}.`,
 })
 }
 }

 const widerCapabilities = child.capabilities.filter(
 (name) => !parent.capabilities.includes(name),
)
 if (widerCapabilities.length > 0) {
 refusals.push({
 rule: 'capabilities',
 detail: `Child envelope reaches capabilities its parent's does not: ${widerCapabilities.join(', ')}.`,
 request: `Add ${widerCapabilities.join(', ')} to the parent's envelope first.`,
 })
 }

 if (parent.subagentDepth !== null) {
 if (child.subagentDepth === null) {
 refusals.push({
 rule: 'depth',
 detail: `Child envelope sets no depth bound, under a parent bounded at ${parent.subagentDepth}.`,
 request: `Bound the child envelope's depth at no more than ${parent.subagentDepth - 1}.`,
 })
 } else if (child.subagentDepth >= parent.subagentDepth) {
 /**
 * Strictly less, not less-or-equal, and that is the difference between a bound and
 * a decoration: a chain of planners each allowed its parent's own depth reaches as
 * far as the chain is long. Each hop spends one.
 */
 refusals.push({
 rule: 'depth',
 detail: `Child envelope's depth (${child.subagentDepth}) does not shrink under its parent's (${parent.subagentDepth}).`,
 request: `Lower the child envelope's depth to ${parent.subagentDepth - 1} or less — each hop spends one.`,
 })
 }
 }

 if (
 parent.approvalMode !== null &&
 (child.approvalMode === null || isWiderApprovalMode(child.approvalMode, parent.approvalMode))
) {
 refusals.push({
 rule: 'approvalMode',
 detail:
 child.approvalMode === null
 ? `Child envelope sets no approval ceiling, under a parent capped at ${parent.approvalMode}.`
: `Child envelope's approval ceiling (${child.approvalMode}) is wider than its parent's (${parent.approvalMode}).`,
 request: `Set the child envelope's approval ceiling to ${parent.approvalMode} or narrower.`,
 })
 }

 return verdict(refusals)
}

/** One line per refusal, for an error message a human reads rather than parses. */
export const envelopeRefusalSummary = (found: EnvelopeVerdict): string =>
 found.refusals.map((refusal) => `${refusal.detail} ${refusal.request}`).join(' ')
