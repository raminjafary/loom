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
 */

import type { WorkflowStepStatus } from './agents.js'
import {
  fanningOf,
  INPUT_REFERENCE,
  isRunNode,
  ITEM_REFERENCE,
  MAX_LOOP_ITERATIONS,
  templateReferences,
  type WorkflowAnswer,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from './workflow-graph.js'

/** One row of the journal, in the only terms this decision needs. */
export interface WorkflowStepState {
  readonly nodeId: string
  readonly pass: number
  readonly itemIndex: number
  readonly status: WorkflowStepStatus
  readonly answer: Readonly<Record<string, unknown>> | null
}

/** A step the executor may start now, with its prompt already rendered. */
export interface DealableStep {
  readonly nodeId: string
  readonly pass: number
  readonly itemIndex: number
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
  const sources = new Map<string, string | null>()
  for (const node of order) {
    if (node.kind === 'barrier') {
      sources.set(node.id, null)
      continue
    }
    const above = new Set<string>()
    for (const edge of graph.edges) {
      if (edge.to !== node.id || edge.loop !== null) continue
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
    if (fanningOf(node) !== null) {
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
  readonly answers: ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>
}): string =>
  input.task.replace(/\{\{\s*([a-z0-9-]+)(?:\.([a-z0-9-]+))?\s*\}\}/g, (_whole, node: string, field?: string) => {
    if (node === ITEM_REFERENCE) return input.item ?? ''
    if (node === INPUT_REFERENCE) return input.input
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
}): WorkflowPlan => {
  const lanes = laneSources(input.graph)
  if (!lanes.ok) return { deal: [], skip: [], collect: [], done: true, failure: lanes.reason }
  const laneOf = lanes.sources

  const byId = new Map(input.graph.nodes.map((node) => [node.id, node]))
  const byKey = new Map(input.steps.map((step) => [keyOf(step.nodeId, step.pass, step.itemIndex), step]))
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
    if (source === undefined || source.status !== 'answered') return null
    const list = source.answer?.[fanning.field]
    if (!Array.isArray(list)) return []
    return list.slice(0, fanning.maxWidth)
  }

  const laneCount = (nodeId: string, pass: number): number | null => {
    const list = laneList(nodeId, pass)
    if (list === undefined) return 1
    return list === null ? null : list.length
  }

  const itemFor = (nodeId: string, pass: number, itemIndex: number): string | null => {
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

  const edgeState = (edge: WorkflowEdge, pass: number, itemIndex: number): EdgeState => {
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
    const from = byId.get(edge.from)
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
    const pass = loop === null ? 0 : loopState(loop).dealing
    const width = laneCount(node.id, pass)
    if (width === null) {
      pending = true
      continue
    }

    for (let itemIndex = 0; itemIndex < width; itemIndex += 1) {
      const existing = byKey.get(keyOf(node.id, pass, itemIndex))
      if (existing !== undefined) {
        if (!SETTLED.has(existing.status)) pending = true
        continue
      }

      const inbound = input.graph.edges.filter((edge) => edge.to === node.id && edge.loop === null)
      if (inbound.length === 0) {
        // A start, and a loop's target on a later pass reaches here through its own inbound edges.
        if (node.kind === 'barrier') continue
        deal.push(dealt(node, pass, itemIndex))
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
      deal.push(dealt(node, pass, itemIndex))
    }
  }

  function dealt(node: WorkflowNode, pass: number, itemIndex: number): DealableStep {
    const answers = new Map<string, Readonly<Record<string, unknown>>[]>()
    for (const reference of isRunNode(node) ? templateReferences(node.task) : []) {
      if (reference.node === ITEM_REFERENCE || reference.node === INPUT_REFERENCE) continue
      if (answers.has(reference.node)) continue
      const { steps } = requiredInstances(reference.node, node.id, pass, itemIndex)
      answers.set(
        reference.node,
        steps
          .filter((step) => step?.status === 'answered')
          .map((step) => step?.answer ?? {}),
      )
    }
    const item = itemFor(node.id, pass, itemIndex)
    return {
      nodeId: node.id,
      pass,
      itemIndex,
      item,
      persona: isRunNode(node) ? node.persona : '',
      task: isRunNode(node)
        ? renderWorkflowTask({ task: node.task, input: input.input, item, answers })
        : '',
    }
  }

  const done = !pending && deal.length === 0 && skip.length === 0 && collect.length === 0
  return { deal, skip, collect, done, failure: done ? failureOf(input.graph, byNode) : null }
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
): string | null => {
  const terminals = graph.nodes.filter(
    (node) => !graph.edges.some((edge) => edge.from === node.id && edge.loop === null),
  )
  const answered = terminals.some((node) =>
    (byNode.get(node.id) ?? []).some((step) => step.status === 'answered'),
  )
  if (answered) return null
  return (
    'Nothing at the bottom of this workflow answered: every terminal step was refused or was ' +
    'on a path that was not taken.'
  )
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
