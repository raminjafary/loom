/**
 * Workflows — a harness per task, **drawn rather than scripted**.
 *
 * A Planner decides *what work exists*. A workflow fixes *the shape of work whose steps are
 * already known*: the same stages, in the same order, every time the task class comes round.
 * Where the decomposition is the hard part the Planner is still the right answer and a
 * workflow would be a guess frozen into a diagram.
 *
 * ## Why a graph and not a script
 *
 * The obvious implementation is the one the field uses: let the model write a small program
 * with `agent()`, `parallel()` and `pipeline()` primitives, and run it. That is arbitrary code
 * authored by a model and executed inside the trust boundary — the one thing the security
 * model exists to prevent, and the thing the promotion gate refuses even for this platform's
 * own source.
 *
 * A graph is **data**: a finite node-and-edge vocabulary this module validates before anything
 * runs, and an executor that is the platform's code rather than the model's. The same choice
 * buys three things a script cannot:
 *
 * - **It is measurable.** A shape with a digest is a configuration, and a configuration can be
 *   an arm. The dealer, the tallies, the held-out screen and the blinded verifier all apply to
 *   it unchanged — which is what factorial screening over structural combinations needs a unit
 *   of variation for, and what nothing else here supplies: a prompt is an arm and a tool list
 *   is an arm, but the *shape of the work* is not.
 * - **It is replayable.** No sampling, no wall-clock branching, no `Math.random`. Where a
 *   choice must be random it is hash-seeded, exactly as the verifier's blinding is. A workflow
 *   that cannot be replayed from its own rows cannot be evidence about anything.
 * - **It shows the thing authors get wrong.** The reported mistake in hand-written harnesses
 *   is defaulting to barriers — waiting for every branch when only one predecessor was
 *   actually needed — and paying for it in wall-clock. In a script that distinction hides in
 *   whether somebody typed `await parallel`. Here a barrier is a *node*, drawn as a bar across
 *   the lane, and a pipeline is the absence of one.
 *
 * ## What a node is, and what it is not
 *
 * **A step is a run.** Not a lighter-weight thing that resembles one: the tree renders it, the
 * meter meters it, the envelope attenuates it, approvals gate its tools, steering reaches it,
 * and any branch it produces goes through the merge queue in order like everybody else's. A
 * second orchestration layer whose steps the platform never sees is exactly the arrangement
 * the nesting policy forbids, so a workflow ingests instead.
 *
 * Five kinds, and the vocabulary is closed on purpose — a validator can only be trusted about a
 * vocabulary it can enumerate. The six named harness patterns are compositions of these rather
 * than entries in the list: classify-and-act is a `router`; fan-out-and-synthesize is a `fan`
 * into a `barrier`; adversarial verification is a `verifier`; generate-and-filter is a
 * `verifier` carrying a rubric; a tournament is a bracket of barriers; loop-until-done is a
 * `loop` edge back to an earlier stage.
 *
 * ## What is deliberately *not* part of the shape
 *
 * Not the workflow's name — a rename is not a new shape, and a comparison across a rename is
 * the ordinary case. Not its budget cap: the cap belongs to the *run*, the way a campaign's
 * does, because otherwise raising a ceiling would fork the configuration and every tally
 * against it would start over. Not where a box sits on the canvas.
 */

import { detectDependencyCycle, planStages } from './planning.js'

/**
 * A hard ceiling on one drawn graph. Small on purpose: this is a harness, not a program, and a
 * shape nobody can hold in their head is a shape nobody can review before it spends.
 */
export const MAX_WORKFLOW_NODES = 24

/**
 * How wide one `fan` may get. The list it fans over is model-authored, so this is the bound
 * between "run this once per file it found" and an unmetered fork — the same reason a
 * decomposition is capped at eight subtasks.
 */
export const MAX_FAN_WIDTH = 16

/** How many times one `loop` edge may be taken. The executor enforces it whatever the stop condition says. */
export const MAX_LOOP_ITERATIONS = 5

/** How many branches one `router` may declare. */
export const MAX_ROUTER_CHOICES = 8

/**
 * The shape of an answer a step must return, in the smallest vocabulary that supports the
 * checks other nodes make against it.
 *
 * Three field kinds, each earning its place by being something the *executor* reads rather
 * than something a reader finds informative: a `list` is what a `fan` fans over, a `flag` is
 * what a `loop` edge stops on, and `text` is what a downstream template interpolates. A richer
 * schema would be a JSON-Schema dialect, and every field of it that no edge consults is a field
 * the platform is pretending to validate.
 */
export type WorkflowAnswerField =
  | { readonly kind: 'text'; readonly name: string }
  | { readonly kind: 'flag'; readonly name: string }
  | { readonly kind: 'list'; readonly name: string }

export interface WorkflowAnswer {
  readonly fields: readonly WorkflowAnswerField[]
}

interface NodeShared {
  /** Author-chosen and stable: it is what a template references and what the journal keys a step by. */
  readonly id: string
  readonly title: string
}

interface RunNodeShared extends NodeShared {
  /** Which registered persona runs this step, by name — resolved at start, like a subtask's. */
  readonly persona: string
  /** What the step is told to do. `{{node}}` and `{{node.field}}` interpolate an ancestor's answer. */
  readonly task: string
}

/** One run. The ordinary node, and the only one most workflows need. */
export interface WorkflowStepNode extends RunNodeShared {
  readonly kind: 'step'
  readonly answer: WorkflowAnswer | null
}

/**
 * One run *per element* of a predecessor's list answer.
 *
 * The width is not known when the graph is drawn — that is the point of it, and the reason
 * `maxWidth` is mandatory rather than defaulted: the list is written by a model, and a bound a
 * human chose at drawing time is the only bound that was chosen by a human at all.
 */
export interface WorkflowFanNode extends RunNodeShared {
  readonly kind: 'fan'
  /** The node whose answer supplies the list. */
  readonly source: string
  /** Which `list` field of that answer. */
  readonly over: string
  readonly maxWidth: number
  readonly answer: WorkflowAnswer | null
}

/**
 * One run whose answer picks exactly one outgoing edge — classify-and-act.
 *
 * The choice is the model's, and it is *constrained*: an answer outside `choices` is a refusal
 * rather than a default, because a router that silently falls through to a branch nobody picked
 * is a workflow that took a path its own journal cannot explain.
 */
export interface WorkflowRouterNode extends RunNodeShared {
  readonly kind: 'router'
  readonly choices: readonly string[]
}

/**
 * A run that tries to *refute* another node's answer — and may not be its author.
 *
 * That rule is enforced here rather than described, for the reason the surrogate verifier is a
 * separate persona and a separate session: measured stance homogenization is worst exactly
 * where two agents share a model, so a verifier that is the author agrees with the author. The
 * executor blinds it in addition; this is the half a validator can check.
 */
export interface WorkflowVerifierNode extends RunNodeShared {
  readonly kind: 'verifier'
  /** The node under refutation. */
  readonly verifies: string
  /** A `list` field of that node's answer, verified one element at a time, or null for the whole answer. */
  readonly over: string | null
  readonly answer: WorkflowAnswer | null
}

/**
 * A join, and the only node that is not a run: it starts nothing, spends nothing, and exists to
 * say that what follows genuinely needs every inbound branch *together*.
 *
 * Drawn rather than implied because the wrong answer here is the expensive one. Two inbound
 * edges minimum — a barrier across a single lane is a bar that stops nothing and costs the
 * reader a second look.
 */
export interface WorkflowBarrierNode extends NodeShared {
  readonly kind: 'barrier'
}

export type WorkflowNode =
  | WorkflowStepNode
  | WorkflowFanNode
  | WorkflowRouterNode
  | WorkflowVerifierNode
  | WorkflowBarrierNode

export type WorkflowRunNode =
  | WorkflowStepNode
  | WorkflowFanNode
  | WorkflowRouterNode
  | WorkflowVerifierNode

/**
 * A dependency edge.
 *
 * A plain edge is a **pipeline**: the target starts the moment this predecessor finishes,
 * whatever the other lanes are doing. Waiting for everything is what a `barrier` target means,
 * and it is the only thing that means it.
 */
export interface WorkflowEdge {
  readonly from: string
  readonly to: string
  /** Which router answer takes this edge. Required out of a `router`, refused everywhere else. */
  readonly when: string | null
  /**
   * A loop edge, pointing back at an ancestor — the only backwards edge the vocabulary has.
   *
   * `until` names a `flag` field of `from`'s answer: the edge is taken while that flag is
   * false. `MAX_LOOP_ITERATIONS` bounds it regardless of what the flag says, because a stop
   * condition a model controls is a stop condition that can fail to stop.
   */
  readonly loop: { readonly until: string } | null
}

/** The drawn shape. Nodes and edges, and nothing about what it is called or what it may spend. */
export interface WorkflowGraph {
  readonly nodes: readonly WorkflowNode[]
  readonly edges: readonly WorkflowEdge[]
}

export type WorkflowGraphVerdict =
  | { readonly ok: true; readonly graph: WorkflowGraph }
  | { readonly ok: false; readonly reason: string }

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/

/** The reference a template makes to an ancestor's answer: `{{node}}` or `{{node.field}}`. */
const REFERENCE = /\{\{\s*([a-z0-9-]+)(?:\.([a-z0-9-]+))?\s*\}\}/g

/**
 * The element a `fan` or a per-item `verifier` is running against, in that node's own task.
 *
 * Required there and illegal elsewhere: a fan whose task never mentions the item deals N
 * identical runs, which is N times the cost of the one run it meant to be.
 */
export const ITEM_REFERENCE = 'item'

export interface TemplateReference {
  readonly node: string
  readonly field: string | null
}

export const templateReferences = (task: string): TemplateReference[] => {
  const out: TemplateReference[] = []
  for (const match of task.matchAll(REFERENCE)) {
    const node = match[1]
    if (node === undefined) continue
    out.push({ node, field: match[2] ?? null })
  }
  return out
}

export const isRunNode = (node: WorkflowNode): node is WorkflowRunNode => node.kind !== 'barrier'

/** What a node answers, or null when it answers nothing structured a later node could read. */
export const answerOf = (node: WorkflowNode): WorkflowAnswer | null =>
  node.kind === 'step' || node.kind === 'fan' || node.kind === 'verifier' ? node.answer : null

const fieldOf = (node: WorkflowNode, name: string): WorkflowAnswerField | null =>
  answerOf(node)?.fields.find((field) => field.name === name) ?? null

const isString = (value: unknown): value is string => typeof value === 'string'

const parseAnswer = (value: unknown, where: string): WorkflowAnswer | null | string => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return `${where}: an answer schema must be an object.`
  const fields = (value as { fields?: unknown }).fields
  if (!Array.isArray(fields)) return `${where}: an answer schema needs a \`fields\` array.`
  const seen = new Set<string>()
  const out: WorkflowAnswerField[] = []
  for (const raw of fields) {
    if (typeof raw !== 'object' || raw === null) {
      return `${where}: every answer field must be an object.`
    }
    const { kind, name } = raw as { kind?: unknown; name?: unknown }
    if (!isString(name) || !SLUG.test(name)) {
      return `${where}: an answer field needs a lower-case slug name, not ${JSON.stringify(name)}.`
    }
    if (kind !== 'text' && kind !== 'flag' && kind !== 'list') {
      return `${where}: answer field "${name}" has kind ${JSON.stringify(kind)}; the vocabulary is text, flag and list.`
    }
    if (seen.has(name)) return `${where}: answer field "${name}" is declared twice.`
    seen.add(name)
    out.push({ kind, name })
  }
  return { fields: out }
}

const parseNode = (value: unknown, index: number): WorkflowNode | string => {
  if (typeof value !== 'object' || value === null) return `Node ${index + 1} is not an object.`
  const raw = value as Record<string, unknown>
  const { id, title, kind } = raw
  if (!isString(id) || !SLUG.test(id)) {
    return `Node ${index + 1} needs a lower-case slug id, not ${JSON.stringify(id)}.`
  }
  if (!isString(title) || title.trim() === '') return `Node "${id}" needs a title.`

  if (kind === 'barrier') return { kind: 'barrier', id, title: title.trim() }

  const { persona, task } = raw
  if (!isString(persona) || persona.trim() === '') return `Node "${id}" needs a persona name.`
  if (!isString(task) || task.trim() === '') return `Node "${id}" needs a task.`
  const shared = { id, title: title.trim(), persona: persona.trim(), task: task.trim() }

  if (kind === 'step') {
    const answer = parseAnswer(raw.answer, `Node "${id}"`)
    if (isString(answer)) return answer
    return { kind: 'step', ...shared, answer }
  }

  if (kind === 'fan') {
    const { source, over, maxWidth } = raw
    if (!isString(source) || !SLUG.test(source)) return `Fan "${id}" needs a \`source\` node id.`
    if (!isString(over) || !SLUG.test(over)) return `Fan "${id}" needs an \`over\` field name.`
    if (typeof maxWidth !== 'number' || !Number.isInteger(maxWidth) || maxWidth < 1) {
      return `Fan "${id}" needs a whole \`maxWidth\` of at least 1.`
    }
    if (maxWidth > MAX_FAN_WIDTH) {
      return `Fan "${id}" asks for a width of ${maxWidth}; ${MAX_FAN_WIDTH} is the ceiling.`
    }
    const answer = parseAnswer(raw.answer, `Fan "${id}"`)
    if (isString(answer)) return answer
    return { kind: 'fan', ...shared, source, over, maxWidth, answer }
  }

  if (kind === 'router') {
    const { choices } = raw
    if (!Array.isArray(choices) || choices.length < 2) {
      return `Router "${id}" needs at least two choices; a router with one branch is a step.`
    }
    if (choices.length > MAX_ROUTER_CHOICES) {
      return `Router "${id}" declares ${choices.length} choices; ${MAX_ROUTER_CHOICES} is the ceiling.`
    }
    const parsed: string[] = []
    for (const choice of choices) {
      if (!isString(choice) || !SLUG.test(choice)) {
        return `Router "${id}" has a choice that is not a lower-case slug: ${JSON.stringify(choice)}.`
      }
      if (parsed.includes(choice)) return `Router "${id}" declares the choice "${choice}" twice.`
      parsed.push(choice)
    }
    return { kind: 'router', ...shared, choices: parsed }
  }

  if (kind === 'verifier') {
    const { verifies, over } = raw
    if (!isString(verifies) || !SLUG.test(verifies)) {
      return `Verifier "${id}" needs a \`verifies\` node id.`
    }
    if (over !== null && over !== undefined && (!isString(over) || !SLUG.test(over))) {
      return `Verifier "${id}" has an \`over\` that is not a field name: ${JSON.stringify(over)}.`
    }
    const answer = parseAnswer(raw.answer, `Verifier "${id}"`)
    if (isString(answer)) return answer
    return { kind: 'verifier', ...shared, verifies, over: isString(over) ? over : null, answer }
  }

  return `Node "${id}" has kind ${JSON.stringify(kind)}; the vocabulary is step, fan, router, verifier and barrier.`
}

const parseEdge = (value: unknown, index: number): WorkflowEdge | string => {
  const where = `Edge ${index + 1}`
  if (typeof value !== 'object' || value === null) return `${where} is not an object.`
  const raw = value as Record<string, unknown>
  const { from, to, when, loop } = raw
  if (!isString(from) || !SLUG.test(from)) return `${where} needs a \`from\` node id.`
  if (!isString(to) || !SLUG.test(to)) return `${where} needs a \`to\` node id.`
  if (from === to) return `${where} joins "${from}" to itself.`
  if (when !== null && when !== undefined && (!isString(when) || !SLUG.test(when))) {
    return `${where} has a \`when\` that is not a router choice: ${JSON.stringify(when)}.`
  }
  let parsedLoop: { readonly until: string } | null = null
  if (loop !== null && loop !== undefined) {
    if (typeof loop !== 'object') {
      return `${where}: \`loop\` must be an object with an \`until\` field.`
    }
    const until = (loop as { until?: unknown }).until
    if (!isString(until) || !SLUG.test(until)) {
      return `${where}: a loop edge needs an \`until\` flag field name.`
    }
    parsedLoop = { until }
  }
  return { from, to, when: isString(when) ? when : null, loop: parsedLoop }
}

const indexOfNodes = (graph: WorkflowGraph): Map<string, number> =>
  new Map(graph.nodes.map((node, index) => [node.id, index]))

const forwardDependencies = (graph: WorkflowGraph): number[][] => {
  const index = indexOfNodes(graph)
  return graph.nodes.map((node) =>
    graph.edges
      .filter((edge) => edge.to === node.id && edge.loop === null)
      .map((edge) => index.get(edge.from) ?? 0),
  )
}

/** Every node reachable *backwards* from each node, over forward edges only. */
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

const checkStructure = (graph: WorkflowGraph, byId: Map<string, WorkflowNode>): string | null => {
  const cycle = detectDependencyCycle(
    forwardDependencies(graph).map((dependsOn) => ({ dependsOn })),
  )
  if (cycle !== null) {
    // Reversed, because the cycle walk follows dependency edges and a drawn graph is read
    // along its arrows. Told `"c" -> "b" -> "a"` about a canvas showing a -> b -> c, an author
    // looks for an edge that is not there.
    const named = [...cycle]
      .reverse()
      .map((at) => `"${graph.nodes[at]?.id ?? at}"`)
      .join(' -> ')
    return `The graph loops without a loop edge: ${named}. A backwards edge has to be drawn as one.`
  }

  const ancestors = ancestorsOf(graph)
  const outbound = new Map<string, WorkflowEdge[]>()
  for (const node of graph.nodes) outbound.set(node.id, [])
  for (const edge of graph.edges) outbound.get(edge.from)?.push(edge)

  const starts = graph.nodes.filter(
    (node) => !graph.edges.some((edge) => edge.to === node.id && edge.loop === null),
  )
  if (starts.length === 0) {
    return 'No node starts the workflow — every one of them waits for another.'
  }

  for (const node of graph.nodes) {
    const inbound = graph.edges.filter((edge) => edge.to === node.id)
    const out = outbound.get(node.id) ?? []

    if (node.kind === 'barrier') {
      if (inbound.filter((edge) => edge.loop === null).length < 2) {
        return `Barrier "${node.id}" joins fewer than two lanes, so it waits for nothing the edge into it did not already wait for.`
      }
      if (out.length === 0) return `Barrier "${node.id}" leads nowhere.`
    }

    if (node.kind === 'router') {
      const forward = out.filter((edge) => edge.loop === null)
      for (const choice of node.choices) {
        const matching = forward.filter((edge) => edge.when === choice)
        if (matching.length === 0) {
          return `Router "${node.id}" declares the choice "${choice}" and no edge takes it.`
        }
        if (matching.length > 1) {
          return `Router "${node.id}" has ${matching.length} edges for the choice "${choice}".`
        }
      }
      for (const edge of forward) {
        if (edge.when === null) {
          return `The edge out of router "${node.id}" to "${edge.to}" carries no choice.`
        }
        if (!node.choices.includes(edge.when)) {
          return `Router "${node.id}" has an edge for "${edge.when}", which is not one of its choices.`
        }
      }
    } else {
      for (const edge of out) {
        if (edge.when !== null) {
          return `The edge "${node.id}" to "${edge.to}" carries the choice "${edge.when}", but "${node.id}" is not a router.`
        }
      }
    }

    if (node.kind === 'fan') {
      const source = byId.get(node.source)
      if (source === undefined) {
        return `Fan "${node.id}" fans over "${node.source}", which is not a node.`
      }
      if (!(ancestors.get(node.id)?.has(node.source) ?? false)) {
        return `Fan "${node.id}" fans over "${node.source}", which is not one of its ancestors.`
      }
      const field = fieldOf(source, node.over)
      if (field === null) {
        return `Fan "${node.id}" fans over "${node.source}.${node.over}", which that node does not answer.`
      }
      if (field.kind !== 'list') {
        return `Fan "${node.id}" fans over "${node.source}.${node.over}", which is a ${field.kind} and not a list.`
      }
    }

    if (node.kind === 'verifier') {
      const verified = byId.get(node.verifies)
      if (verified === undefined) {
        return `Verifier "${node.id}" verifies "${node.verifies}", which is not a node.`
      }
      if (!(ancestors.get(node.id)?.has(node.verifies) ?? false)) {
        return `Verifier "${node.id}" verifies "${node.verifies}", which is not one of its ancestors.`
      }
      if (verified.kind === 'barrier') {
        return `Verifier "${node.id}" verifies barrier "${node.verifies}", which answers nothing of its own.`
      }
      if (isRunNode(verified) && verified.persona === node.persona) {
        return `Verifier "${node.id}" runs the persona that wrote what it verifies (${node.persona}). An author does not refute itself.`
      }
      if (node.over !== null) {
        const field = fieldOf(verified, node.over)
        if (field === null) {
          return `Verifier "${node.id}" verifies "${node.verifies}.${node.over}", which that node does not answer.`
        }
        if (field.kind !== 'list') {
          return `Verifier "${node.id}" verifies "${node.verifies}.${node.over}", which is a ${field.kind} and not a list.`
        }
      }
    }

    for (const edge of out) {
      if (edge.loop === null) continue
      if (!(ancestors.get(node.id)?.has(edge.to) ?? false)) {
        return `The loop edge "${node.id}" to "${edge.to}" does not point back at an ancestor, so it is a forward edge wearing a loop's label.`
      }
      const field = fieldOf(node, edge.loop.until)
      if (field === null) {
        return `The loop edge out of "${node.id}" stops on "${edge.loop.until}", which "${node.id}" does not answer.`
      }
      if (field.kind !== 'flag') {
        return `The loop edge out of "${node.id}" stops on "${edge.loop.until}", which is a ${field.kind} and not a flag.`
      }
    }

    if (isRunNode(node)) {
      const references = templateReferences(node.task)
      const readsItem = references.some((reference) => reference.node === ITEM_REFERENCE)
      const perItem = node.kind === 'fan' || (node.kind === 'verifier' && node.over !== null)
      if (perItem && !readsItem) {
        return `"${node.id}" runs once per item and its task never mentions {{${ITEM_REFERENCE}}}, so every one of those runs would be given the same instructions.`
      }
      if (!perItem && readsItem) {
        return `"${node.id}" mentions {{${ITEM_REFERENCE}}} but does not run once per item.`
      }

      for (const reference of references) {
        if (reference.node === ITEM_REFERENCE) continue
        const target = byId.get(reference.node)
        if (target === undefined) {
          return `"${node.id}" reads {{${reference.node}}}, which is not a node.`
        }
        if (!(ancestors.get(node.id)?.has(reference.node) ?? false)) {
          return `"${node.id}" reads {{${reference.node}}}, which is not one of its ancestors — that answer does not exist yet when this step starts.`
        }
        if (reference.field !== null && fieldOf(target, reference.field) === null) {
          return `"${node.id}" reads {{${reference.node}.${reference.field}}}, which "${reference.node}" does not answer.`
        }
      }
    }
  }

  return null
}

/**
 * The gate. Everything a workflow is allowed to be is decided here, before an executor sees it
 * and therefore before it can spend anything.
 *
 * Two rules are worth naming because they catch a graph that *looks* fine:
 *
 * - **A template may only read an ancestor.** `{{sweep.claims}}` in a node that does not
 *   descend from `sweep` is a step asking for an answer that has not happened, and at runtime
 *   it would interpolate nothing and read as a bad model rather than as a bad graph.
 * - **A loop edge must point at an ancestor.** A backwards edge that goes forwards is a forward
 *   edge somebody labelled `loop`, and it would quietly opt that path out of the cycle check
 *   that keeps the rest of the graph finite.
 */
export const parseWorkflowGraph = (value: unknown): WorkflowGraphVerdict => {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: 'A workflow must be an object.' }
  }
  const rawNodes = (value as { nodes?: unknown }).nodes
  const rawEdges = (value as { edges?: unknown }).edges
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    return { ok: false, reason: 'A workflow needs at least one node.' }
  }
  if (rawNodes.length > MAX_WORKFLOW_NODES) {
    return {
      ok: false,
      reason: `A workflow may have at most ${MAX_WORKFLOW_NODES} nodes; this one draws ${rawNodes.length}.`,
    }
  }
  if (rawEdges !== undefined && rawEdges !== null && !Array.isArray(rawEdges)) {
    return { ok: false, reason: 'A workflow needs its `edges` to be an array.' }
  }

  const nodes: WorkflowNode[] = []
  const byId = new Map<string, WorkflowNode>()
  for (const [index, raw] of rawNodes.entries()) {
    const node = parseNode(raw, index)
    if (isString(node)) return { ok: false, reason: node }
    if (byId.has(node.id)) return { ok: false, reason: `Two nodes share the id "${node.id}".` }
    byId.set(node.id, node)
    nodes.push(node)
  }

  const edges: WorkflowEdge[] = []
  const drawn = new Set<string>()
  for (const [index, raw] of (Array.isArray(rawEdges) ? rawEdges : []).entries()) {
    const edge = parseEdge(raw, index)
    if (isString(edge)) return { ok: false, reason: edge }
    if (!byId.has(edge.from)) {
      return { ok: false, reason: `Edge ${index + 1} starts at "${edge.from}", which is not a node.` }
    }
    if (!byId.has(edge.to)) {
      return { ok: false, reason: `Edge ${index + 1} ends at "${edge.to}", which is not a node.` }
    }
    const key = `${edge.from} ${edge.to} ${edge.when ?? ''}`
    if (drawn.has(key)) {
      return { ok: false, reason: `The edge "${edge.from}" to "${edge.to}" is drawn twice.` }
    }
    drawn.add(key)
    edges.push(edge)
  }

  const graph: WorkflowGraph = { nodes, edges }
  const structural = checkStructure(graph, byId)
  if (structural !== null) return { ok: false, reason: structural }
  return { ok: true, graph }
}

/**
 * The waves the graph runs in, by node id — wave 0 starts immediately, wave 1 once wave 0 is
 * done, and so on. Loop edges are ignored, because a wave is a statement about the first pass.
 *
 * This is `planStages` over ids rather than a second implementation of it: the two are the same
 * question asked about two vocabularies, and a scheduler with two topological sorts is a
 * scheduler with two answers.
 */
export const workflowStages = (graph: WorkflowGraph): string[][] =>
  planStages(forwardDependencies(graph).map((dependsOn) => ({ dependsOn }))).map((stage) =>
    stage.map((at) => graph.nodes[at]?.id ?? '').filter((id) => id !== ''),
  )

/**
 * The nodes a loop edge actually re-runs: its target, its source, and everything on a path
 * between them.
 *
 * Worth computing rather than approximating by the two endpoints, because the endpoints are the
 * cheap half — a loop back over a fan is the shape that multiplies, and a ceiling that missed
 * the middle of the loop would understate exactly the graph that most needs refusing.
 */
export const loopedNodes = (graph: WorkflowGraph): Set<string> => {
  const ancestors = ancestorsOf(graph)
  const inside = new Set<string>()
  for (const edge of graph.edges) {
    if (edge.loop === null) continue
    inside.add(edge.from)
    inside.add(edge.to)
    for (const node of graph.nodes) {
      const above = ancestors.get(node.id)
      const belowSource = ancestors.get(edge.from)
      if ((above?.has(edge.to) ?? false) && (belowSource?.has(node.id) ?? false)) {
        inside.add(node.id)
      }
    }
  }
  return inside
}

/** What one node could cost, for the disclosure a human reads before approving a shape. */
export interface WorkflowNodeCost {
  readonly id: string
  /** The persona's enforced cap, and null when that persona is uncapped. */
  readonly budgetCapUsd: number | null
}

/**
 * The worst case, in the terms the plan-stage disclosure already uses, plus the two things a
 * drawn shape can overrun by and a plan cannot: a `fan`'s width and a `loop`'s iterations.
 *
 * A **ceiling from the enforced caps**, never an estimate. The number's job is to let a person
 * refuse a shape before it runs, and only the worst case can do that. An uncapped persona makes
 * the ceiling unknown, and it says so rather than quietly summing the rest.
 */
export const describeWorkflowCost = (
  graph: WorkflowGraph,
  costs: readonly WorkflowNodeCost[],
): string => {
  const capOf = new Map(costs.map((cost) => [cost.id, cost.budgetCapUsd]))
  const runNodes = graph.nodes.filter(isRunNode)
  const uncapped = runNodes.filter((node) => (capOf.get(node.id) ?? null) === null)
  const inLoop = loopedNodes(graph)

  const ceiling = runNodes.reduce((sum, node) => {
    const cap = capOf.get(node.id) ?? 0
    const width = node.kind === 'fan' ? node.maxWidth : 1
    const passes = inLoop.has(node.id) ? MAX_LOOP_ITERATIONS : 1
    return sum + cap * width * passes
  }, 0)

  const stages = workflowStages(graph)
  const barriers = graph.nodes.filter((node) => node.kind === 'barrier').length
  const lines = [
    `${runNodes.length} step(s) in ${stages.length} stage(s)` +
      (barriers === 0
        ? ', and no barrier — every step starts the moment its own predecessor finishes.'
        : `, behind ${barriers} barrier(s) that each wait for every inbound lane.`),
  ]
  for (const node of runNodes) {
    if (node.kind !== 'fan') continue
    lines.push(
      `- "${node.id}" runs once per item of ${node.source}.${node.over}, up to ${node.maxWidth} times.`,
    )
  }
  if (inLoop.size > 0) {
    lines.push(
      `- A loop may take ${MAX_LOOP_ITERATIONS} passes, and the ${inLoop.size} step(s) inside it are counted that many times below.`,
    )
  }
  lines.push(
    uncapped.length > 0
      ? `Worst case is unbounded: ${uncapped.length} of these personas is uncapped.`
      : `Worst case is $${ceiling.toFixed(2)} if every step spends its persona's whole cap.`,
  )
  return lines.join('\n')
}

/**
 * The canonical text of a shape — sorted, and covering exactly what the shape *is*.
 *
 * Domain owns what "the same workflow" means; whoever needs a digest hashes this, the way the
 * capability registry hashes a canonical tool list. That keeps `node:crypto` out of a package
 * the browser also parses, and it keeps the definition of sameness in one place rather than in
 * each caller that hashes.
 *
 * Serialized through `JSON.stringify` rather than by joining fields, because a task is free
 * text: two shapes that differ only in where a `|` falls inside a prompt must not canonicalize
 * to the same string, and a separator that can appear in the data is not a separator.
 */
export const canonicalWorkflow = (graph: WorkflowGraph): string => {
  const nodes = graph.nodes
    .map((node) => [
      node.kind,
      node.id,
      isRunNode(node) ? node.persona : '',
      isRunNode(node) ? node.task : '',
      node.kind === 'fan'
        ? [node.source, node.over, node.maxWidth]
        : node.kind === 'router'
          ? [...node.choices].sort()
          : node.kind === 'verifier'
            ? [node.verifies, node.over ?? '']
            : [],
      (answerOf(node)?.fields ?? [])
        .map((field) => [field.kind, field.name])
        .sort((a, b) => (a[1] ?? '').localeCompare(b[1] ?? '')),
    ])
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))

  const edges = graph.edges
    .map((edge) => [edge.from, edge.to, edge.when ?? '', edge.loop?.until ?? ''])
    .sort((a, b) => a.join(' ').localeCompare(b.join(' ')))

  return JSON.stringify({ nodes, edges })
}
