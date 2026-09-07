/**
 * The executor's decision, as a pure function of the graph and the journal.
 *
 * Nothing here starts anything. It is asked "given this shape and these rows, what may be
 * dealt now" and it answers; the application layer does the dealing. That split is what makes
 * a workflow **replayable**: the same rows produce the same next move, forever, with no clock
 * and no sampling in the decision. A resumed execution is not a special path — it is this
 * function called against a journal that happens to be longer.
 *
 * ## Pipelines and barriers, which is the whole point of drawing it
 *
 * The mistake hand-written harnesses are reported to make is waiting for every branch when only
 * one predecessor was needed. Here that distinction is about **items**, not about steps: when a
 * `fan` splits work into eight, each of the eight flows down its own lane and reaches the next
 * step the moment *its own* predecessor finished. Item 3 does not wait for item 5. A `barrier`
 * is the only thing that collects them, and past it there is one lane again.
 *
 * So every step instance is `(node, pass, item)`:
 *
 * - **item** is which lane it is in. A node inherits its lane count from the nearest `fan`
 *   above it, and a barrier resets it to one.
 * - **pass** is which turn of a loop it is on, and it is 0 for a graph with no loop.
 *
 * Both are in the journal's unique index, which is what lets a loop's second turn and a fan's
 * second lane be rows rather than collisions.
 *
 * ## What a refusal does, and what it does not do
 *
 * A step that answers something its declared schema does not admit is **refused**, and the
 * refusal stops *its lane* rather than the execution: seven sites transformed and one did not
 * is seven results, and killing the run would throw away work already paid for. The steps
 * downstream of that lane are `skipped` with the refusal named, a barrier below still collects
 * what the other lanes produced, and the run reports itself failed only when nothing at the
 * bottom of the graph answered at all.
 *
 * One refusal is dealt again before any of that happens: a run that completed and never called
 * its answer tool decided nothing, so the step is worth one more try — `WORKFLOW_STEP_ATTEMPTS`
 * below, and `attempt` is the third dimension of a step instance for exactly that. A step at the
 * top of a shape is a single point of failure for everything under it, which is the one place
 * `plan and delegate` is structurally sturdier than a drawing.
 */

import type { WorkflowStepStatus } from './agents.js'
import { seededOrder, seededPair } from './seeded-choice.js'
import {
  BRACKET_CHAMPION_FIELD,
  BRACKET_WINNER_FIELD,
  BRACKET_WINNER_SIDES,
  fanningOf,
  INPUT_REFERENCE,
  isRunNode,
  ITEM_REFERENCE,
  LEFT_REFERENCE,
  MAX_LOOP_ITERATIONS,
  opensLanes,
  RIGHT_REFERENCE,
  templateReferences,
  type WorkflowAnswer,
  type WorkflowBracketNode,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from './workflow-graph.js'

/** One row of the journal, in the only terms this decision needs. */
export interface WorkflowStepState {
  readonly nodeId: string
  readonly pass: number
  readonly itemIndex: number
  /** Which try this row is. 0 for every step of an execution where nothing was refused. */
  readonly attempt: number
  readonly status: WorkflowStepStatus
  readonly answer: Readonly<Record<string, unknown>> | null
  /** Why it was refused — which is what decides whether asking again could say anything new. */
  readonly reason: string | null
}

/** A step the executor may start now, with its prompt already rendered. */
export interface DealableStep {
  readonly nodeId: string
  readonly pass: number
  readonly itemIndex: number
  /** Which try this is. Above 0 only after a refusal this shape is still owed a try at. */
  readonly attempt: number
  /** The element this lane is working on, for a node below a fan. Null in a one-lane graph. */
  readonly item: string | null
  readonly persona: string
  readonly task: string
}

/** A step that will never run, because the path to it was not taken. */
export interface SkippableStep {
  readonly nodeId: string
  readonly pass: number
  readonly itemIndex: number
  readonly reason: string
}

export interface WorkflowPlan {
  readonly deal: readonly DealableStep[]
  readonly skip: readonly SkippableStep[]
  /**
   * Barriers whose lanes have arrived — recorded as answered without a run, because a barrier
   * starts nothing and spends nothing.
   *
   * A separate list rather than a `deal` the caller has to notice is a barrier: a barrier in the
   * dealing list would be one `if` away from becoming a run with an empty persona, and the whole
   * claim about metering is that everything the platform starts is a run it meters.
   */
  readonly collect: readonly SkippableStep[]
  /** True when nothing is running and nothing more can be dealt. */
  readonly done: boolean
  /**
   * Set only when the run should end as failed rather than finished: nothing at the bottom of
   * the graph produced an answer. A partly-refused graph that still answered somewhere is a
   * finish with refusals in it, which is what the journal already says.
   */
  readonly failure: string | null
}

const keyOf = (nodeId: string, pass: number, itemIndex: number): string =>
  `${nodeId}|${pass}|${itemIndex}`

const SETTLED: ReadonlySet<WorkflowStepStatus> = new Set<WorkflowStepStatus>([
  'answered',
  'refused',
  'skipped',
])

/**
 * The one refusal another attempt could answer, in the words settlement writes on the row.
 *
 * A run that *completed* and never called its answer tool decided nothing: the work happened and
 * was dropped on the floor, so the same prompt asked again is a different roll rather than the
 * same one. No other refusal is dealt again — a failed or cancelled run says something happened
 * to the run rather than to the answer, a timeout would double the wait to learn the same thing,
 * and a persona that no longer exists will still not exist.
 *
 * The wording lives here, beside the decision it drives, for `BARRIER_PASSED`'s reason: the
 * alternative is the application deciding which refusals are worth repeating, which would put
 * the scheduling policy in the layer that only writes rows.
 */
export const STEP_UNANSWERED = 'the run ended without submitting an answer'

/**
 * How many times one step may be dealt, refusals included.
 *
 * Two, and the second is the whole point of the number existing. The trial's first verdict turned
 * on one `scope` step that ended without an answer: the fan below it opened no lanes, the task
 * produced no branch at all, and the shape lost a task it had not actually done badly at. One
 * more try costs one step, where losing the top of a shape costs everything under it.
 *
 * Not higher than two, because a step that goes silent twice is evidence about the step.
 */
export const WORKFLOW_STEP_ATTEMPTS = 2

/** Whether this row is a refusal the shape is still owed another attempt at. */
export const owedAnotherAttempt = (step: WorkflowStepState): boolean =>
  step.status === 'refused' &&
  step.reason === STEP_UNANSWERED &&
  step.attempt + 1 < WORKFLOW_STEP_ATTEMPTS

/**
 * What a retried step is told, and the only thing that differs from its first attempt.
 *
 * The question has to be the same question — a retry asked something else would be a different
 * step wearing the same node's name — but a model that finished without answering is told so,
 * because the words that produced silence once are the likeliest to produce it again.
 */
export const RETRY_NOTE =
  'An earlier attempt at this exact step ended without submitting an answer, so nothing below it ' +
  'could run. Submit the answer tool call before this run finishes — including when what you have ' +
  'to report is that the work could not be done.'

/**
 * Which `fan` each node inherits its lane count from, or null for a node that runs once.
 *
 * Derived rather than declared, because it is not a fact about a node: it is a fact about the
 * path to it, and a path that crosses a barrier has already been collected.
 *
 * Two shapes are refused rather than resolved, and both are refused because there is no honest
 * answer rather than because they are hard: a node fed by two different fans has two lane
 * counts and no way to pair them, and a fan below another fan would need a lane index with two
 * dimensions. Put a barrier between them and both become well-defined.
 */
export const laneSources = (
  graph: WorkflowGraph,
): { readonly ok: true; readonly sources: Map<string, string | null> } | { readonly ok: false; readonly reason: string } => {
  const order = topological(graph)
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const sources = new Map<string, string | null>()
  for (const node of order) {
    if (node.kind === 'barrier') {
      sources.set(node.id, null)
      continue
    }
    const above = new Set<string>()
    for (const edge of graph.edges) {
      if (edge.to !== node.id || edge.loop !== null) continue
      /**
       * A bracket's lanes stop at the bracket. It is the second node that collapses lanes and
       * the only one that also opens them: a tournament of six runs six-ish matches and hands
       * *one* champion down, so what follows it runs once — the shape of a barrier from below
       * and of a fan from above.
       */
      if (byId.get(edge.from)?.kind === 'bracket') continue
      const inherited = sources.get(edge.from) ?? null
      if (inherited !== null) above.add(inherited)
    }
    if (above.size > 1) {
      return {
        ok: false,
        reason: `"${node.id}" is fed by ${above.size} different fans (${[...above].sort().join(', ')}), which have no common lane. A barrier between them collects both.`,
      }
    }
    const inherited = [...above][0] ?? null
    if (opensLanes(node)) {
      if (inherited !== null) {
        return {
          ok: false,
          reason: `"${node.id}" opens its own lanes inside "${inherited}"'s, which would need a lane index with two dimensions. A barrier above it collects the outer one first.`,
        }
      }
      sources.set(node.id, node.id)
      continue
    }
    sources.set(node.id, inherited)
  }
  return { ok: true, sources }
}

const topological = (graph: WorkflowGraph): WorkflowNode[] => {
  const remaining = new Map(graph.nodes.map((node) => [node.id, node]))
  const placed = new Set<string>()
  const order: WorkflowNode[] = []
  while (remaining.size > 0) {
    let progressed = false
    for (const [id, node] of remaining) {
      const ready = graph.edges
        .filter((edge) => edge.to === id && edge.loop === null)
        .every((edge) => placed.has(edge.from))
      if (!ready) continue
      order.push(node)
      placed.add(id)
      remaining.delete(id)
      progressed = true
    }
    // Defensive only: `parseWorkflowGraph` refuses a graph that cycles without a loop edge.
    if (!progressed) break
  }
  return order
}

/** One loop: the edge that closes it, and every node that re-runs when it is taken. */
export interface WorkflowLoop {
  readonly edge: WorkflowEdge
  readonly body: ReadonlySet<string>
}

export const loopsOf = (graph: WorkflowGraph): WorkflowLoop[] => {
  const ancestors = ancestorsOf(graph)
  const loops: WorkflowLoop[] = []
  for (const edge of graph.edges) {
    if (edge.loop === null) continue
    const body = new Set<string>([edge.from, edge.to])
    for (const node of graph.nodes) {
      const above = ancestors.get(node.id)
      const belowSource = ancestors.get(edge.from)
      if ((above?.has(edge.to) ?? false) && (belowSource?.has(node.id) ?? false)) {
        body.add(node.id)
      }
    }
    loops.push({ edge, body })
  }
  return loops
}

const ancestorsOf = (graph: WorkflowGraph): Map<string, Set<string>> => {
  const inbound = new Map<string, string[]>()
  for (const node of graph.nodes) inbound.set(node.id, [])
  for (const edge of graph.edges) {
    if (edge.loop !== null) continue
    inbound.get(edge.to)?.push(edge.from)
  }
  const ancestors = new Map<string, Set<string>>()
  const walk = (id: string): Set<string> => {
    const known = ancestors.get(id)
    if (known !== undefined) return known
    const set = new Set<string>()
    ancestors.set(id, set)
    for (const parent of inbound.get(id) ?? []) {
      set.add(parent)
      for (const older of walk(parent)) set.add(older)
    }
    return set
  }
  for (const node of graph.nodes) walk(node.id)
  return ancestors
}

/**
 * What a node answered, as a value a template can interpolate and a rule can read.
 *
 * The strings are what a *model* returns, so nothing here trusts a shape: a `list` that came
 * back as a string is a refusal rather than a one-element list, because the difference between
 * "it found one site" and "it wrote a sentence where a list belonged" is the difference between
 * a fan of one and a fan of nothing.
 */
export type AnswerVerdict =
  | { readonly ok: true; readonly answer: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string }

export const parseWorkflowAnswer = (schema: WorkflowAnswer | null, raw: unknown): AnswerVerdict => {
  if (schema === null || schema.fields.length === 0) return { ok: true, answer: {} }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'The answer was not an object, so none of its declared fields are there.' }
  }
  const source = raw as Record<string, unknown>
  const answer: Record<string, unknown> = {}
  for (const field of schema.fields) {
    const value = source[field.name]
    if (value === undefined || value === null) {
      return { ok: false, reason: `The answer has no "${field.name}".` }
    }
    if (field.kind === 'text') {
      if (typeof value !== 'string') {
        return { ok: false, reason: `"${field.name}" came back as ${typeof value} rather than text.` }
      }
      answer[field.name] = value
      continue
    }
    if (field.kind === 'flag') {
      if (typeof value !== 'boolean') {
        return { ok: false, reason: `"${field.name}" came back as ${typeof value} rather than true or false.` }
      }
      answer[field.name] = value
      continue
    }
    if (!Array.isArray(value)) {
      return { ok: false, reason: `"${field.name}" came back as ${typeof value} rather than a list.` }
    }
    if (value.some((entry) => typeof entry !== 'string')) {
      return { ok: false, reason: `"${field.name}" is a list with something other than text in it.` }
    }
    answer[field.name] = value
  }
  return { ok: true, answer }
}

/** Which branch a router took, or why its answer cannot be one. */
export const resolveRouterChoice = (
  choices: readonly string[],
  answer: Readonly<Record<string, unknown>> | null,
): { readonly ok: true; readonly choice: string } | { readonly ok: false; readonly reason: string } => {
  const raw = answer?.[ROUTER_FIELD]
  if (typeof raw !== 'string') {
    return { ok: false, reason: `The router answered no "${ROUTER_FIELD}", so no edge out of it was chosen.` }
  }
  if (!choices.includes(raw)) {
    return {
      ok: false,
      reason: `The router answered "${raw}", which is not one of its choices (${choices.join(', ')}). A branch nobody drew is not a default.`,
    }
  }
  return { ok: true, choice: raw }
}

/** The one field a router's answer must carry. Fixed, so a drawn router needs no schema. */
export const ROUTER_FIELD = 'choice'

/** One match of a bracket: which two entrants, in the order the judge is shown them. */
export interface BracketMatch {
  readonly index: number
  readonly left: string
  readonly right: string
}

/**
 * Which entrants come forward, and in what order they are seated.
 *
 * Truncated first and seeded second, and that order is the honest one: the bound is a human's, so
 * *which* entrants are admitted stays the same however the hash falls — a bracket that dropped a
 * random three of six would be a measurement of five sixths of the work, differently each time.
 * What the seed decides is only the seating, which is what pairing bias lives in.
 */
export const bracketSeeding = (
  seed: string,
  nodeId: string,
  entrants: readonly string[],
  maxEntrants: number,
): string[] =>
  seededOrder(`${seed}:${nodeId}`, entrants.slice(0, maxEntrants), (entrant) => entrant)

/**
 * One round's pairs, plus the entrant that sits it out.
 *
 * A bye rather than a phantom opponent: an odd round is the ordinary case for anything but a
 * power of two, and a match against nothing would be a paid run whose answer is already known.
 * Which entrant gets it is the last seat in the seeded order — "last" being a fact about the
 * hash rather than about who wrote the list first, which is the whole reason for seeding.
 */
export const bracketMatches = (
  seed: string,
  nodeId: string,
  round: number,
  entrants: readonly string[],
): { readonly matches: readonly BracketMatch[]; readonly bye: string | null } => {
  const matches: BracketMatch[] = []
  for (let at = 0; at + 1 < entrants.length; at += 2) {
    const index = at / 2
    const [left, right] = seededPair(
      `${seed}:${nodeId}:${round}:${index}`,
      entrants[at] as string,
      entrants[at + 1] as string,
    )
    matches.push({ index, left, right })
  }
  return {
    matches,
    bye: entrants.length % 2 === 1 ? (entrants[entrants.length - 1] as string) : null,
  }
}

/**
 * Which entrant a judged match advanced, or null when it advanced nobody.
 *
 * Null covers two cases that are one fact: a match whose run was refused, and a match that
 * answered a side the vocabulary does not have. Both mean *nothing was judged here*, and the
 * alternative — advancing a side by default — would let a refusal produce a champion.
 */
export const bracketWinner = (
  match: BracketMatch,
  answer: Readonly<Record<string, unknown>> | null,
): string | null => {
  const side = answer?.[BRACKET_WINNER_FIELD]
  if (side === LEFT_REFERENCE) return match.left
  if (side === RIGHT_REFERENCE) return match.right
  return null
}

/** How a bracket stands: which round is being judged, and who has come out of it. */
export interface BracketState {
  /**
   * False while what it judges has not settled. The distinction the executor turns on: an
   * unknown bracket is pending, and a known one with no entrants is finished and lost.
   */
  readonly known: boolean
  /** The round whose matches may be dealt now. */
  readonly dealing: number
  /** That round's pairs, already seated. Empty once the tournament is over. */
  readonly matches: readonly BracketMatch[]
  readonly settled: boolean
  /** The entrant that survived, or null when nothing did. */
  readonly champion: string | null
  /** What the match that produced the champion answered, for the step below to read. */
  readonly answer: Readonly<Record<string, unknown>> | null
}

/** A pair, in the words a person scanning the journal can tell two matches apart by. */
const briefly = (entrant: string): string => {
  const line = entrant.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

export const describeMatch = (match: BracketMatch): string =>
  `${briefly(match.left)} ⟂ ${briefly(match.right)}`

const renderValue = (value: unknown): string => {
  if (Array.isArray(value)) return value.map((entry, at) => `${at + 1}. ${String(entry)}`).join('\n')
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([name, entry]) => `${name}: ${renderValue(entry)}`)
      .join('\n')
  }
  return String(value)
}

/**
 * The prompt one step is actually given.
 *
 * A reference to a node that ran in several lanes renders as all of them, numbered — which is
 * what a step below a barrier is asking for when it names the fan above it. A reference that
 * resolves to nothing renders as an empty string rather than leaving the braces in the prompt:
 * a model handed a literal `{{transform.diff}}` will try to interpret it, and the resulting run
 * is a bad answer that looks like a bad model.
 */
export const renderWorkflowTask = (input: {
  readonly task: string
  readonly input: string
  readonly item: string | null
  /** The two entrants of a bracket's match, and null for every other node. */
  readonly sides?: { readonly left: string; readonly right: string } | null
  readonly answers: ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>
}): string =>
  input.task.replace(/\{\{\s*([a-z0-9-]+)(?:\.([a-z0-9-]+))?\s*\}\}/g, (_whole, node: string, field?: string) => {
    if (node === ITEM_REFERENCE) return input.item ?? ''
    if (node === INPUT_REFERENCE) return input.input
    if (node === LEFT_REFERENCE) return input.sides?.left ?? ''
    if (node === RIGHT_REFERENCE) return input.sides?.right ?? ''
    const answers = input.answers.get(node) ?? []
    const values = answers.map((answer) => (field === undefined ? answer : answer[field]))
    if (values.length === 1) return renderValue(values[0])
    return values.map((value, at) => `${at + 1}. ${renderValue(value)}`).join('\n')
  })

interface EdgeState {
  readonly resolved: boolean
  readonly taken: boolean
  /** Why this edge was not taken, for the skip a reader will see. */
  readonly reason: string | null
}

/**
 * The next move, from the shape and the journal alone.
 *
 * Deliberately re-derived from scratch on every tick rather than advanced incrementally. The
 * incremental version is faster and cannot be resumed: a workflow whose position lives in the
 * executor's memory is a workflow that loses its place when a server restarts, and the whole
 * argument for a journal was that the place is in the rows.
 */
export const nextWorkflowActions = (input: {
  readonly graph: WorkflowGraph
  readonly steps: readonly WorkflowStepState[]
  readonly input: string
  /**
   * What every hash-seeded choice in this execution is seeded from — the execution's own id.
   *
   * Per *execution* rather than per platform, so two executions of one shape seat their brackets
   * independently; and from a row rather than a clock, so the same execution re-derives the same
   * seating on every tick and after any restart.
   *
   * Optional because most shapes hold no choice at all, and the fallback is the empty string
   * rather than anything generated: a seating that is a pure function of the entrants' own text
   * is still decorrelated from the order they were written in, which is the property that
   * matters, and it is still the same on every tick. What it loses is independence *between*
   * executions, which is why the application passes the execution's id and the live driver
   * asserts that it does.
   */
  readonly seed?: string
}): WorkflowPlan => {
  const lanes = laneSources(input.graph)
  if (!lanes.ok) return { deal: [], skip: [], collect: [], done: true, failure: lanes.reason }
  const laneOf = lanes.sources

  const byId = new Map(input.graph.nodes.map((node) => [node.id, node]))
  /**
   * The journal, latest attempt per step. A retried step has two rows and only the newer one is
   * that step's state; the older one stays in the journal because it is what the try cost.
   */
  const byKey = new Map<string, WorkflowStepState>()
  for (const step of input.steps) {
    const key = keyOf(step.nodeId, step.pass, step.itemIndex)
    const known = byKey.get(key)
    if (known === undefined || step.attempt >= known.attempt) byKey.set(key, step)
  }
  /**
   * A step owed another attempt reads as **pending** everywhere below here rather than as the
   * refusal it currently is.
   *
   * Anything else deals the retry and skips the graph beneath it on the same tick: `edgeState`
   * would see a settled refusal at this pass and resolve every edge out of it as not taken,
   * which is precisely the outcome another attempt exists to prevent.
   */
  const retrying = new Map<string, number>()
  for (const [key, step] of byKey) {
    if (!owedAnotherAttempt(step)) continue
    retrying.set(key, step.attempt + 1)
    byKey.set(key, { ...step, status: 'pending', answer: null })
  }
  const byNode = new Map<string, WorkflowStepState[]>()
  for (const step of input.steps) {
    const list = byNode.get(step.nodeId) ?? []
    list.push(step)
    byNode.set(step.nodeId, list)
  }

  const loops = loopsOf(input.graph)
  const loopFor = (nodeId: string): WorkflowLoop | null =>
    loops.find((loop) => loop.body.has(nodeId)) ?? null

  /** The turn a loop is on, and whether it has stopped. */
  const loopState = (loop: WorkflowLoop) => {
    const passes = [...loop.body].flatMap((id) => (byNode.get(id) ?? []).map((step) => step.pass))
    const current = passes.length === 0 ? 0 : Math.max(...passes)
    const source = byKey.get(keyOf(loop.edge.from, current, 0)) ?? null
    const until = loop.edge.loop?.until ?? ''
    const stop = source?.status === 'answered' && source.answer?.[until] === true
    const exhausted = current + 1 >= MAX_LOOP_ITERATIONS
    const advancing = source?.status === 'answered' && !stop && !exhausted
    return {
      current,
      /** The pass whose instances may be dealt now. */
      dealing: advancing ? current + 1 : current,
      settled: source !== null && SETTLED.has(source.status) && !advancing,
      finalPass: current,
    }
  }

  /** Which pass of `nodeId` a step at `pass` should be reading, and whether it is available. */
  const passFor = (nodeId: string, pass: number, from: WorkflowLoop | null): number | null => {
    const loop = loopFor(nodeId)
    if (loop === null) return 0
    if (from !== null && from.edge === loop.edge) return pass
    const state = loopState(loop)
    return state.settled ? state.finalPass : null
  }

  /** How many lanes a node runs in at this pass, or null while the fan above it has not answered. */
  /** The list a lane's opener fans over, at this pass, or null while it has not answered. */
  const laneList = (nodeId: string, pass: number): readonly unknown[] | null | undefined => {
    const fanId = laneOf.get(nodeId) ?? null
    if (fanId === null) return undefined
    const opener = byId.get(fanId)
    const fanning = opener === undefined ? null : fanningOf(opener)
    if (fanning === null) return undefined
    const sourcePass = passFor(fanning.source, pass, loopFor(fanId))
    if (sourcePass === null) return null
    const source = byKey.get(keyOf(fanning.source, sourcePass, 0))
    if (source === undefined || !SETTLED.has(source.status)) return null
    /**
     * A source that settled without answering opens **no lanes**, rather than leaving them
     * unknown forever.
     *
     * The difference is the difference between "still coming" and "will never come", and
     * conflating them is how an execution whose first step was refused ran until somebody
     * noticed: nothing was ready, nothing could be skipped, and the run stayed `running` with
     * an empty graph beneath it. Zero lanes lets the edges below resolve as not-taken, which
     * is what closes the execution and reports it failed.
     */
    if (source.status !== 'answered') return []
    const list = source.answer?.[fanning.field]
    if (!Array.isArray(list)) return []
    return list.slice(0, fanning.maxWidth)
  }

  const laneCount = (nodeId: string, pass: number): number | null => {
    /**
     * A bracket's lanes are the matches of one round, so its width is arithmetic on the entrants
     * that survived rather than the length of a list. Every round but the one being dealt is
     * zero wide: the rows of a finished round are in the journal and are not dealt again.
     */
    const node = byId.get(nodeId)
    if (node?.kind === 'bracket') {
      const state = bracketState(node)
      if (!state.known) return null
      return state.dealing === pass ? state.matches.length : 0
    }
    const list = laneList(nodeId, pass)
    if (list === undefined) return 1
    return list === null ? null : list.length
  }

  const itemFor = (nodeId: string, pass: number, itemIndex: number): string | null => {
    const node = byId.get(nodeId)
    if (node?.kind === 'bracket') {
      const match = bracketState(node).matches.find((entry) => entry.index === itemIndex)
      return match === undefined ? null : describeMatch(match)
    }
    const list = laneList(nodeId, pass)
    if (list === undefined || list === null) return null
    const entry = list[itemIndex]
    return typeof entry === 'string' ? entry : null
  }

  /** Every settled instance of `from` that `to`'s instance in lane `itemIndex` depends on. */
  const requiredInstances = (
    from: string,
    to: string,
    pass: number,
    itemIndex: number,
  ): { readonly steps: readonly (WorkflowStepState | undefined)[]; readonly missing: boolean } => {
    const sourcePass = passFor(from, pass, loopFor(to))
    if (sourcePass === null) return { steps: [], missing: true }
    if ((laneOf.get(from) ?? null) === (laneOf.get(to) ?? null)) {
      return { steps: [byKey.get(keyOf(from, sourcePass, itemIndex))], missing: false }
    }
    // The lane changed, which only a barrier does: this edge waits for every lane of `from`.
    const width = laneCount(from, sourcePass)
    if (width === null) return { steps: [], missing: true }
    return {
      steps: Array.from({ length: width }, (_unused, at) => byKey.get(keyOf(from, sourcePass, at))),
      missing: false,
    }
  }

  /**
   * A bracket, round by round, from the rows and the seed alone.
   *
   * Re-derived on every tick like everything else here, and memoized only within one tick: the
   * champion is a *function* of the seeding and the matches, so nothing has to be stored and
   * nothing can drift from what the rows say. A stored champion would be a summary of the
   * journal that could disagree with it.
   */
  const brackets = new Map<string, BracketState>()
  const bracketState = (node: WorkflowBracketNode): BracketState => {
    const known = brackets.get(node.id)
    if (known !== undefined) return known
    const state = deriveBracket(node)
    brackets.set(node.id, state)
    return state
  }

  const UNKNOWN_BRACKET: BracketState = {
    known: false,
    dealing: 0,
    matches: [],
    settled: false,
    champion: null,
    answer: null,
  }

  const deriveBracket = (node: WorkflowBracketNode): BracketState => {
    const entered = entrantsOf(node)
    if (entered === null) return UNKNOWN_BRACKET

    let entrants = bracketSeeding(input.seed ?? '', node.id, entered, node.maxEntrants)
    let round = 0
    let answer: Readonly<Record<string, unknown>> | null = null
    /**
     * Bounded by the arithmetic rather than by trust: each round at least halves the field, so a
     * bracket of `maxEntrants` cannot need more rounds than that many. The guard is here because
     * a loop whose exit depends on rows is a loop a bad row could make infinite.
     */
    for (let guard = 0; guard <= node.maxEntrants; guard += 1) {
      if (entrants.length <= 1) {
        return {
          known: true,
          dealing: round,
          matches: [],
          settled: true,
          champion: entrants[0] ?? null,
          answer,
        }
      }
      const { matches, bye } = bracketMatches(input.seed ?? '', node.id, round, entrants)
      const rows = matches.map((match) => byKey.get(keyOf(node.id, round, match.index)))
      if (rows.some((row) => row === undefined || !SETTLED.has(row.status))) {
        return {
          known: true,
          dealing: round,
          matches,
          settled: false,
          champion: null,
          answer: null,
        }
      }
      const survivors: string[] = []
      const wonBy = new Map<string, Readonly<Record<string, unknown>>>()
      for (const match of matches) {
        const row = rows[match.index]
        if (row?.status !== 'answered') continue
        const winner = bracketWinner(match, row.answer)
        if (winner === null) continue
        survivors.push(winner)
        wonBy.set(winner, row.answer ?? {})
      }
      if (bye !== null) survivors.push(bye)
      entrants = survivors
      answer = entrants.length === 1 ? (wonBy.get(entrants[0] as string) ?? null) : null
      round += 1
    }
    return { known: true, dealing: round, matches: [], settled: true, champion: null, answer: null }
  }

  /**
   * The entrants, before any seeding: one per answered lane of the node this bracket judges, or
   * the elements of its list where that node runs once.
   *
   * Both read the same way — whatever that field holds, flattened — because the difference
   * between them is a fact about the *source*, and asking here would be asking the same question
   * the validator already answered when it checked the field's kind.
   */
  const entrantsOf = (node: WorkflowBracketNode): string[] | null => {
    const { steps, missing } = requiredInstances(node.entrants, node.id, 0, 0)
    if (missing) return null
    if (steps.some((step) => step === undefined || !SETTLED.has(step.status))) return null
    const entrants: string[] = []
    for (const step of steps) {
      if (step?.status !== 'answered') continue
      const value = step.answer?.[node.over]
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (typeof entry === 'string' && entry.trim() !== '') entrants.push(entry)
      }
    }
    return entrants
  }

  const edgeState = (edge: WorkflowEdge, pass: number, itemIndex: number): EdgeState => {
    /**
     * An edge out of a bracket is resolved from the *tournament* rather than from a row, because
     * the two answers a reader wants — "who won" and "nobody did" — are both facts about the
     * whole bracket. Reading the final match's row instead would also make a walkover
     * unrepresentable: one entrant is a champion with no match to point at.
     */
    const from = byId.get(edge.from)
    if (from?.kind === 'bracket') {
      const state = bracketState(from)
      if (!state.known || !state.settled) return { resolved: false, taken: false, reason: null }
      if (state.champion === null) {
        return {
          resolved: true,
          taken: false,
          reason: `"${edge.from}" judged nothing to a winner, so it has no champion to hand on.`,
        }
      }
      return { resolved: true, taken: true, reason: null }
    }

    const { steps, missing } = requiredInstances(edge.from, edge.to, pass, itemIndex)
    if (missing) return { resolved: false, taken: false, reason: null }
    if (steps.length === 0) {
      return { resolved: true, taken: false, reason: `"${edge.from}" produced no lanes to follow.` }
    }
    if (steps.some((step) => step === undefined || !SETTLED.has(step.status))) {
      return { resolved: false, taken: false, reason: null }
    }
    const answered = steps.filter((step) => step?.status === 'answered')
    if (answered.length === 0) {
      const refused = steps.find((step) => step?.status === 'refused')
      return {
        resolved: true,
        taken: false,
        reason:
          refused === undefined
            ? `"${edge.from}" was itself skipped.`
            : `"${edge.from}" did not answer in this lane.`,
      }
    }
    if (from?.kind === 'router') {
      const choice = resolveRouterChoice(from.choices, answered[0]?.answer ?? null)
      if (!choice.ok) return { resolved: true, taken: false, reason: choice.reason }
      if (choice.choice !== edge.when) {
        return { resolved: true, taken: false, reason: `"${edge.from}" chose "${choice.choice}".` }
      }
    }
    return { resolved: true, taken: true, reason: null }
  }

  const deal: DealableStep[] = []
  const skip: SkippableStep[] = []
  const collect: SkippableStep[] = []
  let pending = false

  for (const node of input.graph.nodes) {
    const loop = loopFor(node.id)
    /**
     * A bracket's pass is its round, which is why the validator refuses a bracket inside a loop:
     * the number would have to mean two things at once.
     */
    const pass =
      node.kind === 'bracket'
        ? bracketState(node).dealing
        : loop === null
          ? 0
          : loopState(loop).dealing
    const width = laneCount(node.id, pass)
    if (width === null) {
      pending = true
      continue
    }

    for (let itemIndex = 0; itemIndex < width; itemIndex += 1) {
      const key = keyOf(node.id, pass, itemIndex)
      const retry = retrying.get(key)
      if (retry !== undefined) {
        // Its inbound edges are not asked again: the path into this step was taken once already,
        // and what is being decided a second time is only the run.
        deal.push(dealt(node, pass, itemIndex, retry))
        continue
      }
      const existing = byKey.get(key)
      if (existing !== undefined) {
        if (!SETTLED.has(existing.status)) pending = true
        continue
      }

      const inbound = input.graph.edges.filter((edge) => edge.to === node.id && edge.loop === null)
      if (inbound.length === 0) {
        // A start, and a loop's target on a later pass reaches here through its own inbound edges.
        if (node.kind === 'barrier') continue
        deal.push(dealt(node, pass, itemIndex, 0))
        continue
      }

      const states = inbound.map((edge) => edgeState(edge, pass, itemIndex))
      if (states.some((state) => !state.resolved)) {
        pending = true
        continue
      }
      if (states.every((state) => !state.taken)) {
        const reason = states.map((state) => state.reason).find((text) => text !== null)
        skip.push({
          nodeId: node.id,
          pass,
          itemIndex,
          reason: reason ?? 'No path into this step was taken.',
        })
        continue
      }
      /**
       * A barrier needs *every* lane above it, and a lane that refused is settled rather than
       * coming. So it collects what answered rather than waiting for what never will — which is
       * the only behaviour that makes a partly-failed fan worth having run at all.
       */
      if (node.kind === 'barrier') {
        collect.push({ nodeId: node.id, pass, itemIndex, reason: BARRIER_PASSED })
        continue
      }
      deal.push(dealt(node, pass, itemIndex, 0))
    }
  }

  function dealt(node: WorkflowNode, pass: number, itemIndex: number, attempt: number): DealableStep {
    const answers = new Map<string, Readonly<Record<string, unknown>>[]>()
    for (const reference of isRunNode(node) ? templateReferences(node.task) : []) {
      if (reference.node === ITEM_REFERENCE || reference.node === INPUT_REFERENCE) continue
      if (reference.node === LEFT_REFERENCE || reference.node === RIGHT_REFERENCE) continue
      if (answers.has(reference.node)) continue
      const referenced = byId.get(reference.node)
      /**
       * A bracket hands down one answer with `champion` in it, synthesized here rather than
       * stored: the rows below a bracket are its matches, and a step reading `{{final.champion}}`
       * is asking about the tournament rather than about whichever match happened to be last.
       */
      if (referenced?.kind === 'bracket') {
        const state = bracketState(referenced)
        answers.set(
          reference.node,
          state.champion === null
            ? []
            : [{ ...(state.answer ?? {}), [BRACKET_CHAMPION_FIELD]: state.champion }],
        )
        continue
      }
      const { steps } = requiredInstances(reference.node, node.id, pass, itemIndex)
      answers.set(
        reference.node,
        steps
          .filter((step) => step?.status === 'answered')
          .map((step) => step?.answer ?? {}),
      )
    }
    const item = itemFor(node.id, pass, itemIndex)
    const match =
      node.kind === 'bracket'
        ? (bracketState(node).matches.find((entry) => entry.index === itemIndex) ?? null)
        : null
    const task = isRunNode(node)
      ? renderWorkflowTask({
          task: node.task,
          input: input.input,
          item,
          sides: match === null ? null : { left: match.left, right: match.right },
          answers,
        })
      : ''
    return {
      nodeId: node.id,
      pass,
      itemIndex,
      attempt,
      item,
      persona: isRunNode(node) ? node.persona : '',
      task: attempt === 0 || task === '' ? task : `${task}\n\n${RETRY_NOTE}`,
    }
  }

  const done = !pending && deal.length === 0 && skip.length === 0 && collect.length === 0
  /**
   * A bracket that ended in a walkover produced an answer and no row: one entrant is a champion
   * with nothing to judge it against. Named here so a terminal bracket in that state is not
   * reported as a workflow that answered nothing.
   */
  const championed = new Set(
    input.graph.nodes
      .filter((node) => node.kind === 'bracket' && bracketState(node).champion !== null)
      .map((node) => node.id),
  )
  return {
    deal,
    skip,
    collect,
    done,
    failure: done ? failureOf(input.graph, byNode, championed) : null,
  }
}

/**
 * A barrier's row is written `answered` with an empty answer, so the edges out of it are taken.
 * Recording it as skipped would be tidier and wrong: every step below the barrier would then
 * read its one predecessor as a path not taken, and the half of the graph past the join would
 * be skipped in silence.
 */
export const BARRIER_PASSED = 'The lanes above this barrier were collected.'

const failureOf = (
  graph: WorkflowGraph,
  byNode: ReadonlyMap<string, readonly WorkflowStepState[]>,
  championed: ReadonlySet<string> = new Set(),
): string | null => {
  const terminals = graph.nodes.filter(
    (node) => !graph.edges.some((edge) => edge.from === node.id && edge.loop === null),
  )
  const answered = terminals.some(
    (node) =>
      championed.has(node.id) ||
      (byNode.get(node.id) ?? []).some((step) => step.status === 'answered'),
  )
  if (answered) return null
  const blamed = blameOf(graph, byNode)
  return (
    'Nothing at the bottom of this workflow answered: every terminal step was refused or was ' +
    `on a path that was not taken.${blamed === null ? '' : ` ${blamed}`}`
  )
}

/**
 * The step a reader should look at first, named in the closing reason.
 *
 * The **highest** refusal in the shape rather than the lowest, because everything below a
 * refusal was skipped *for* it: "report was skipped" is not something a person can act on, and
 * "scope was refused twice without answering" says both what happened and that the platform
 * already tried again.
 *
 * Without this, a shape whose first step said nothing closes with exactly the words of a shape
 * that ran everything and did it badly — which is how the trial lost a task with nobody able to
 * say why from the rows.
 */
const blameOf = (
  graph: WorkflowGraph,
  byNode: ReadonlyMap<string, readonly WorkflowStepState[]>,
): string | null => {
  for (const node of topological(graph)) {
    const refused = (byNode.get(node.id) ?? []).filter((row) => row.status === 'refused')
    const worst = refused.reduce<WorkflowStepState | null>(
      (found, row) => (found === null || row.attempt >= found.attempt ? row : found),
      null,
    )
    if (worst === null) continue
    const lanes = new Set(refused.map((row) => row.itemIndex)).size
    const tries = worst.attempt + 1
    return (
      `The first step that failed is "${node.id}"` +
      (lanes > 1 ? `, in ${lanes} of its lanes` : '') +
      (tries > 1 ? `, refused on all ${tries} attempts` : ', refused') +
      (worst.reason === null ? '' : `: ${worst.reason}`) +
      '. Everything below it was skipped for it.'
    )
  }
  return null
}

/**
 * Whether an execution may start another step.
 *
 * Checked before *each* step rather than once, because the answer changes as it spends. The
 * campaign's honesty applies unchanged and is worth repeating rather than referring to: a step's
 * cost is only known after it finishes, so **at most one step is started after the cap is
 * reached in aggregate**, never a second. The overshoot is one step's cost. The alternative
 * reading — "the cap is never exceeded" — is a promise this shape cannot keep, and refusing to
 * start until the remaining budget covers the worst case would make a cap that is merely tight
 * behave like one that is zero.
 */
export const workflowMayStart = (input: {
  readonly capUsd: number | null
  readonly spentUsd: number
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  if (input.capUsd === null) return { ok: true }
  if (input.spentUsd < input.capUsd) return { ok: true }
  return {
    ok: false,
    reason:
      `This workflow's cap of $${input.capUsd.toFixed(2)} is reached — $${input.spentUsd.toFixed(2)} ` +
      'spent. It is halted with the steps it finished, and what it produced is partial.',
  }
}
