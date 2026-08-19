/**
 * Fleets — how *wide* a team is.
 *
 * A team is a roster of roles, and a roster cannot say "three of these". The corporation
 * buys depth and the `dependsOn` buys sequencing; nothing expressed width as a design-time
 * fact, so the only thing deciding how many `swe` workers run was a Planner's judgement at
 * plan time, one goal at a time.
 *
 * **The whole risk this module is written against is the own sentence:** "a fleet
 * size that the runtime never reads is a number a human tunes and a swarm ignores, which
 * is worse than not offering it." So the count is read in exactly the three places that
 * section names, and this module is the shared meaning behind all three:
 *
 * 1. **The Planner's roster** — `describeDelegationRoster` says "sized for up to three
 *    concurrent `swe`", which is a real instruction to a real model.
 * 2. **The concurrency limit**, per team rather than per workspace — enforced at
 *    `startAgentRun`, and **only ever narrowing**: `boundedFleet` clamps to the
 *    workspace ceiling, because a design-time field that widened an operator's limit
 *    would be a way around it.
 * 3. **Plan validation** — a decomposition naming five `swe` subtasks against a team
 *    sized for three warns, and warns rather than refuses for the reason path overlap
 *    warns: the Planner may be right and the count stale.
 *
 * What a fleet is **not**, per the fleet design: N copies of a persona on the canvas. A
 * persona is a template and a canvas node is a *role*; two nodes of one persona would be
 * two *runs*, which is a runtime fact belonging on the board. A fleet is one node carrying
 * a number.
 */

/** Nobody needs a team sized wider than this, and an unbounded number is a runaway. */
export const MAX_FLEET_SIZE = 20

/**
 * Per-persona width for one team, keyed by persona id — the same convention
 * `persona_group.layout` uses, and for the same reason: there is no per-member metadata
 * beyond this, so a join table would buy nothing.
 *
 * A persona with no entry is **unsized**, which means "the Planner decides", exactly as
 * it did before this field existed. That is deliberately different from a count of 1: an
 * absent entry makes no claim, and reading it as 1 would silently serialize every
 * existing team the first time this shipped.
 */
export type FleetSizes = Readonly<Record<string, number>>

export type FleetVerdict =
  | { readonly ok: true; readonly fleet: Record<string, number> }
  | { readonly ok: false; readonly reason: string }

/**
 * Validates a fleet map a client sent, and drops the entries that say nothing.
 *
 * Zero and one are handled differently on purpose. **Zero is refused**: "this team may
 * run none of these" is not a width, it is a removal, and the way to express it is to
 * take the persona off the team — otherwise a roster would offer a persona the
 * concurrency check then refuses every time, which is the "a listed name reads as
 * permission" failure `delegation-roster.ts` exists to prevent. **One is kept**, because
 * "exactly one of these at a time" is a real design decision and the commonest one for a
 * lead or a reviewer.
 */
export const parseFleetSizes = (
  value: unknown,
  memberIds: readonly string[],
): FleetVerdict => {
  if (value === undefined || value === null) return { ok: true, fleet: {} }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'Fleet sizes must be an object keyed by persona id' }
  }

  const members = new Set(memberIds)
  const fleet: Record<string, number> = {}
  for (const [personaId, size] of Object.entries(value as Record<string, unknown>)) {
    // Silently ignored rather than refused: removing a member should not make a stored
    // fleet map unsaveable, and the entry it leaves behind means nothing.
    if (!members.has(personaId)) continue
    if (typeof size !== 'number' || !Number.isInteger(size)) {
      return { ok: false, reason: `Fleet size for ${personaId} must be a whole number` }
    }
    if (size < 1) {
      return {
        ok: false,
        reason: `A fleet size of ${size} is not a width — remove the persona from the team instead of sizing it to none`,
      }
    }
    if (size > MAX_FLEET_SIZE) {
      return { ok: false, reason: `A fleet may be at most ${MAX_FLEET_SIZE} wide, got ${size}` }
    }
    fleet[personaId] = size
  }
  return { ok: true, fleet }
}

/**
 * The width actually in force: the team's number, never above the workspace ceiling.
 *
 * The fleet design is explicit — "bounded above by the workspace limit, never widening it,
 * which would make a design-time field a way around an operator's ceiling". Null when the
 * persona is unsized, which means the workspace limit alone applies, as before.
 */
export const boundedFleet = (
  size: number | undefined,
  maxConcurrentRunsPerWorkspace: number,
): number | null => {
  if (size === undefined) return null
  return Math.min(size, maxConcurrentRunsPerWorkspace)
}

/** One team's declared width for a persona, resolved for a run about to start. */
export interface FleetLimit {
  readonly personaName: string
  readonly limit: number
  /** How many runs of this persona the tree already has in flight. */
  readonly active: number
}

/**
 * The refusal a fleet produces, worded so the reader knows it is *their own* design
 * saying no rather than a platform ceiling.
 *
 * This is the one place a fleet count refuses rather than warns, and it refuses for the
 * same reason the workspace concurrency limit does: a limit that yields is not a limit.
 * The plan warning (`describeFleetOverruns`) is what gives a human the chance to fix the
 * count *before* any of this happens.
 */
export const describeFleetRefusal = (limit: FleetLimit): string =>
  `This team is sized for ${limit.limit} concurrent ${limit.personaName} run(s) and ${limit.active} ${
    limit.active === 1 ? 'is' : 'are'
  } already running. Widen the fleet on the team, or wait for one to finish.`

/** A persona a plan asked for more of than its team is sized for. */
export interface FleetOverrun {
  readonly personaName: string
  readonly asked: number
  readonly limit: number
}

/**
 * Which personas a decomposition over-asks for, given the team's widths.
 *
 * Counted over the **whole plan** rather than per wave, and that is the honest reading of
 * a warning: the subtasks of a plan with no dependencies all start at once, so the plan's
 * own count is what a human should be shown. A plan that happens to be staged so that no
 * wave exceeds the width is a plan whose warning was noise — accepted, because the
 * alternative is a warning that stays silent on the case the fleet design actually names.
 */
export const detectFleetOverruns = (
  personaNames: readonly string[],
  limits: Readonly<Record<string, number>>,
): FleetOverrun[] => {
  const asked = new Map<string, number>()
  for (const name of personaNames) asked.set(name, (asked.get(name) ?? 0) + 1)

  const overruns: FleetOverrun[] = []
  for (const [personaName, count] of asked) {
    const limit = limits[personaName]
    if (limit === undefined || count <= limit) continue
    overruns.push({ personaName, asked: count, limit })
  }
  return overruns.sort((a, b) => a.personaName.localeCompare(b.personaName))
}

/**
 * The plan-time warning. Null when nothing over-asks, so a caller has one
 * condition rather than a rule to remember.
 *
 * **A warning, not a refusal**, and the wording has to carry why: the count is a human's
 * design and the plan is a model's judgement about one goal, so either can be the stale
 * one. It says what will actually happen — the extra runs are refused as they start, not
 * queued — because a warning that leaves the consequence vague reads as advice.
 */
export const describeFleetOverruns = (overruns: readonly FleetOverrun[]): string | null => {
  if (overruns.length === 0) return null
  return [
    overruns.length === 1
      ? 'This plan asks for more concurrent workers than the team is sized for:'
      : `This plan asks for more concurrent workers than the team is sized for, in ${overruns.length} roles:`,
    ...overruns.map(
      (overrun) =>
        `• ${overrun.asked} × ${overrun.personaName}, and this team is sized for ${overrun.limit}`,
    ),
    'The ones past the limit are refused as they try to start, not queued behind the others. ' +
      'Widen the fleet on the team if the plan is right, or re-split the work if the size is.',
  ].join('\n')
}
