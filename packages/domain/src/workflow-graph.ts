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
 * How many entrants one `bracket` may judge.
 *
 * Eight, which is three rounds and seven matches — the point past which a tournament is paying
 * for comparisons nobody reads. It is deliberately half a fan's ceiling: a fan of sixteen is
 * sixteen runs, and a bracket of sixteen is fifteen *judgements* on top of the sixteen runs that
 * produced the entrants.
 */
export const MAX_BRACKET_ENTRANTS = 8

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
  /**
   * How many elements it may refute, when it refutes them one at a time. Null when `over` is.
   *
   * Required for the reason a fan's is, and it bites harder here: the list a verifier fans over
   * was written by the very step it is checking, so a bound the *graph* did not set would be a
   * bound the audited step chose for its own audit.
   */
  readonly maxWidth: number | null
  readonly answer: WorkflowAnswer | null
}

/**
 * A single-elimination tournament: N answers, judged **two at a time**, until one is left.
 *
 * The shape exists because the alternative does not work. Asked to pick the best of six answers
 * in one call, a model reads six long texts in one context and returns a preference; the reported
 * failure modes of exactly that construction are self-preferential bias and a verdict that
 * correlates with position rather than with quality. A bracket replaces one wide judgement with
 * a series of narrow ones, each between two answers and each in its own context — the same remedy
 * a verifier applies to a claim, applied to a comparison.
 *
 * Three things make it a measurement rather than a knockout with a rosette:
 *
 * - **A round is a `pass` and a match is an `item`**, so the journal already keys it: round 2's
 *   match 1 is a row, not a collision. Nothing new was needed to record a bracket.
 * - **The seeding is hash-seeded, not authored.** Who meets whom, and which of a pair is shown
 *   first, come from a hash of the execution and the node — so the entrant a model happened to
 *   write first has no shorter path to the final and no reliable side of the page. That is the
 *   one place this vocabulary admits a random choice, and it is random in distribution and
 *   byte-reproducible from the rows.
 * - **The judge is never an author.** The same rule a verifier keeps, and here it is load-bearing
 *   twice over: a persona judging a pair it half-wrote is the self-preference the shape exists
 *   to route around.
 *
 * A match that answers nothing advances nobody — deliberately, over the alternative of advancing
 * a side by default. A default side would be the hash deciding the tournament rather than
 * deciding the seating, and a bracket whose winner can be produced by a refusal is not evidence
 * about the entrants.
 */
export interface WorkflowBracketNode extends RunNodeShared {
  readonly kind: 'bracket'
  /** The node whose answers are the entrants. */
  readonly entrants: string
  /**
   * Which field of that node's answer an entrant comes from — one entrant per lane where that
   * node fans, and one per list element where it runs once.
   */
  readonly over: string
  /**
   * How many entrants may come forward, and the ceiling on the whole tournament: a bracket of
   * `n` costs `n - 1` matches.
   *
   * Mandatory for the reason a fan's width is: the list of entrants is model-authored, so a bound
   * chosen when the shape was drawn is the only bound a human chose at all.
   */
  readonly maxEntrants: number
  /** What a match answers **beside** `winner`, which is fixed. Usually one text field: why. */
  readonly answer: WorkflowAnswer | null
}

/**
 * The two entrants of one match, as a judge's task refers to them.
 *
 * Named sides rather than `{{item}}` because a match has two items and the whole question is
 * which of them is better. They are legal only in a bracket's task and required there: a judge
 * whose prompt names neither side has been handed a comparison with nothing in it.
 */
export const LEFT_REFERENCE = 'left'
export const RIGHT_REFERENCE = 'right'

/**
 * The one field a match's answer must carry, and its whole vocabulary is `left` and `right`.
 *
 * A side rather than an entrant, so a judge cannot answer with a paraphrase of the text it
 * preferred and leave the executor guessing which entrant that was.
 */
export const BRACKET_WINNER_FIELD = 'winner'
export const BRACKET_WINNER_SIDES: readonly string[] = [LEFT_REFERENCE, RIGHT_REFERENCE]

/**
 * What a bracket answers to everything below it: the entrant that survived, verbatim.
 *
 * Derived from the rows rather than stored, and that is what makes a bracket replayable — the
 * champion is a function of the seeding and the matches, so re-reading the journal re-derives it
 * rather than trusting a summary somebody wrote at the time.
 */
export const BRACKET_CHAMPION_FIELD = 'champion'

/**
 * What makes a node run once per element, whichever kind it is: where the list comes from, which
 * field of that answer it is, and how wide a human said it may get.
 *
 * Two node kinds fan — a `fan` over a predecessor's list, and a `verifier` refuting one claim at
 * a time — and every rule about lanes applies to both. Derived through one function so a rule
 * cannot apply to one and quietly skip the other, which is exactly how a per-item verifier ran
 * once, against an empty item, before this existed.
 */
export const fanningOf = (
  node: WorkflowNode,
): { readonly source: string; readonly field: string; readonly maxWidth: number } | null => {
  if (node.kind === 'fan') {
    return { source: node.source, field: node.over, maxWidth: node.maxWidth }
  }
  if (node.kind === 'verifier' && node.over !== null && node.maxWidth !== null) {
    return { source: node.verifies, field: node.over, maxWidth: node.maxWidth }
  }
  return null
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
  | WorkflowBracketNode
  | WorkflowBarrierNode

export type WorkflowRunNode =
  | WorkflowStepNode
  | WorkflowFanNode
  | WorkflowRouterNode
  | WorkflowVerifierNode
  | WorkflowBracketNode

/**
 * Whether this node runs in lanes of its own — a fan's items, a per-item verifier's claims, or a
 * bracket's matches.
 *
 * One question with three answers rather than three checks, because the rules about lanes are
 * rules about *having* them: a lane-opener inside another's lanes needs a two-dimensional index
 * whichever kind it is, and the executor derives that from here so a new opener cannot be added
 * to one rule and forgotten in the other. What it does *not* say is how wide, because a bracket's
 * width is a round of matches rather than the length of a list — that is `fanningOf`'s question
 * and a bracket deliberately answers it with null.
 */
export const opensLanes = (node: WorkflowNode): boolean =>
  node.kind === 'bracket' || fanningOf(node) !== null

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

/**
 * What this execution was opened on, readable from every node's task.
 *
 * Reserved alongside the item because the alternative is worse: without it a graph's first node
 * would have to be a step whose whole job is to restate the request, and every later node would
 * read the request through that node's paraphrase of it.
 */
export const INPUT_REFERENCE = 'input'

/** Every name a task template resolves itself, and therefore every name no node may take. */
export const RESERVED_REFERENCES: readonly string[] = [
  ITEM_REFERENCE,
  INPUT_REFERENCE,
  LEFT_REFERENCE,
  RIGHT_REFERENCE,
]

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

/**
 * What a node answers, or null when it answers nothing structured a later node could read.
 *
 * A bracket's `champion` is in the list without having been declared, because it is what a
 * bracket *is* for: `{{final.champion}}` in the step below has to validate at drawing time, and
 * asking an author to declare a field the platform always writes would be a second place for the
 * same fact to be wrong.
 */
export const answerOf = (node: WorkflowNode): WorkflowAnswer | null => {
  if (node.kind === 'bracket') {
    return {
      fields: [
        { kind: 'text', name: BRACKET_CHAMPION_FIELD },
        ...(node.answer?.fields ?? []),
      ],
    }
  }
  return node.kind === 'step' || node.kind === 'fan' || node.kind === 'verifier' ? node.answer : null
}

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
  /**
   * A node may not take a name a template already means. `{{input}}` on a node called `input`
   * renders the execution's own text and not that node's answer — which is not a validation
   * nicety: it is a step being handed something other than what its author wrote, silently.
   */
  if (RESERVED_REFERENCES.includes(id)) {
    return `Node ${index + 1} is called "${id}", which is what a task template already means. Reserved: ${RESERVED_REFERENCES.join(', ')}.`
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
    const { verifies, over, maxWidth } = raw
    if (!isString(verifies) || !SLUG.test(verifies)) {
      return `Verifier "${id}" needs a \`verifies\` node id.`
    }
    if (over !== null && over !== undefined && (!isString(over) || !SLUG.test(over))) {
      return `Verifier "${id}" has an \`over\` that is not a field name: ${JSON.stringify(over)}.`
    }
    const perItem = isString(over)
    if (perItem) {
      if (typeof maxWidth !== 'number' || !Number.isInteger(maxWidth) || maxWidth < 1) {
        return `Verifier "${id}" refutes one item at a time and needs a whole \`maxWidth\` of at least 1.`
      }
      if (maxWidth > MAX_FAN_WIDTH) {
        return `Verifier "${id}" asks for a width of ${maxWidth}; ${MAX_FAN_WIDTH} is the ceiling.`
      }
    } else if (maxWidth !== null && maxWidth !== undefined) {
      return `Verifier "${id}" has a \`maxWidth\` but refutes the whole answer at once.`
    }
    const answer = parseAnswer(raw.answer, `Verifier "${id}"`)
    if (isString(answer)) return answer
    return {
      kind: 'verifier',
      ...shared,
      verifies,
      over: perItem ? over : null,
      maxWidth: perItem ? (maxWidth as number) : null,
      answer,
    }
  }

  if (kind === 'bracket') {
    const { entrants, over, maxEntrants } = raw
    if (!isString(entrants) || !SLUG.test(entrants)) {
      return `Bracket "${id}" needs an \`entrants\` node id.`
    }
    if (!isString(over) || !SLUG.test(over)) return `Bracket "${id}" needs an \`over\` field name.`
    if (typeof maxEntrants !== 'number' || !Number.isInteger(maxEntrants) || maxEntrants < 2) {
      return `Bracket "${id}" needs a whole \`maxEntrants\` of at least 2; a tournament of one has nothing to compare.`
    }
    if (maxEntrants > MAX_BRACKET_ENTRANTS) {
      return `Bracket "${id}" admits ${maxEntrants} entrants; ${MAX_BRACKET_ENTRANTS} is the ceiling.`
    }
    const answer = parseAnswer(raw.answer, `Bracket "${id}"`)
    if (isString(answer)) return answer
    for (const field of answer?.fields ?? []) {
      if (field.name === BRACKET_WINNER_FIELD || field.name === BRACKET_CHAMPION_FIELD) {
        return (
          `Bracket "${id}" declares an answer field called "${field.name}", which is the ` +
          'platform\'s own: a match always answers `winner` and a bracket always answers ' +
          '`champion`, so declaring one would be two definitions of which entrant won.'
        )
      }
    }
    return { kind: 'bracket', ...shared, entrants, over, maxEntrants, answer }
  }

  return `Node "${id}" has kind ${JSON.stringify(kind)}; the vocabulary is step, fan, router, verifier, bracket and barrier.`
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

/**
 * How many loops one node re-runs inside.
 *
 * More than one has no honest `pass` number — the executor keys a step by which turn of *the*
 * loop it is on, and a node inside two would need two — so it is refused here rather than
 * resolved there.
 */
const loopsContaining = (graph: WorkflowGraph, nodeId: string): number => {
  const ancestors = ancestorsOf(graph)
  let count = 0
  for (const edge of graph.edges) {
    if (edge.loop === null) continue
    const inside =
      nodeId === edge.from ||
      nodeId === edge.to ||
      ((ancestors.get(nodeId)?.has(edge.to) ?? false) &&
        (ancestors.get(edge.from)?.has(nodeId) ?? false))
    if (inside) count += 1
  }
  return count
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

    if (node.kind === 'bracket') {
      const source = byId.get(node.entrants)
      if (source === undefined) {
        return `Bracket "${node.id}" judges "${node.entrants}", which is not a node.`
      }
      if (!(ancestors.get(node.id)?.has(node.entrants) ?? false)) {
        return `Bracket "${node.id}" judges "${node.entrants}", which is not one of its ancestors.`
      }
      if (source.kind === 'barrier') {
        return `Bracket "${node.id}" judges barrier "${node.entrants}", which answers nothing of its own. Name the step above it.`
      }
      if (isRunNode(source) && source.persona === node.persona) {
        return `Bracket "${node.id}" runs the persona that wrote what it judges (${node.persona}). A judge that half-wrote the field does not hold a tournament.`
      }
      const field = fieldOf(source, node.over)
      if (field === null) {
        return `Bracket "${node.id}" judges "${node.entrants}.${node.over}", which that node does not answer.`
      }
      /**
       * Where the entrants come from decides which field kind is the honest one, and both are
       * legal because both are real shapes: several attempts made in parallel are one lane each
       * and one text each, and several ideas from one step are one list.
       */
      if (opensLanes(source)) {
        if (field.kind !== 'text') {
          return `Bracket "${node.id}" takes one entrant per lane of "${node.entrants}", so "${node.over}" has to be a text field and it is a ${field.kind}.`
        }
      } else if (field.kind !== 'list') {
        return `Bracket "${node.id}" takes its entrants from "${node.entrants}", which runs once, so "${node.over}" has to be a list and it is a ${field.kind}.`
      }
      if (loopsContaining(graph, node.id) > 0) {
        return `Bracket "${node.id}" sits inside a loop, and its rounds already use the pass number. Put the bracket behind a barrier outside the loop.`
      }
    }

    if (loopsContaining(graph, node.id) > 1) {
      return `"${node.id}" sits inside more than one loop, so there is no single count of how many times it has run. Nest loops behind a barrier instead.`
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

      /**
       * A match's two sides, checked the way a fan's item is and for the same failure: a judge
       * whose prompt names one side is being asked to rate one answer, which is not a comparison
       * and would come back as a preference for the only text it was shown.
       */
      const sides = [LEFT_REFERENCE, RIGHT_REFERENCE].filter((side) =>
        references.some((reference) => reference.node === side),
      )
      if (node.kind === 'bracket' && sides.length < 2) {
        return `Bracket "${node.id}" judges two entrants at a time and its task names ${sides.length === 0 ? 'neither' : `only {{${sides[0]}}}`}. A judge has to be shown both {{${LEFT_REFERENCE}}} and {{${RIGHT_REFERENCE}}}.`
      }
      if (node.kind !== 'bracket' && sides.length > 0) {
        return `"${node.id}" mentions {{${sides[0]}}}, which only a bracket's match has — nothing else in a workflow runs against a pair.`
      }

      for (const reference of references) {
        if (reference.node === ITEM_REFERENCE || reference.node === INPUT_REFERENCE) continue
        if (reference.node === LEFT_REFERENCE || reference.node === RIGHT_REFERENCE) continue
        const target = byId.get(reference.node)
        if (target === undefined) {
          return `"${node.id}" reads {{${reference.node}}}, which is not a node.`
        }
        if (!(ancestors.get(node.id)?.has(reference.node) ?? false)) {
          return `"${node.id}" reads {{${reference.node}}}, which is not one of its ancestors — that answer does not exist yet when this step starts.`
        }
        if (target.kind === 'barrier') {
          return `"${node.id}" reads {{${reference.node}}}, which is a barrier and answers nothing of its own. Name the step above it.`
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

/**
 * How many runs one node is worth at worst, on a single pass.
 *
 * A fan's is its width. A bracket's is `maxEntrants - 1`, which is the arithmetic of single
 * elimination rather than a bound somebody chose: every match removes exactly one entrant, so
 * eight entrants are seven matches however the seeding falls, byes included.
 */
export const worstCaseRuns = (node: WorkflowNode): number => {
  if (node.kind === 'bracket') return node.maxEntrants - 1
  return fanningOf(node)?.maxWidth ?? 1
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
    const passes = inLoop.has(node.id) ? MAX_LOOP_ITERATIONS : 1
    return sum + cap * worstCaseRuns(node) * passes
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
    if (node.kind === 'bracket') {
      lines.push(
        `- "${node.id}" judges the entrants from ${node.entrants}.${node.over} two at a time, ` +
          `up to ${node.maxEntrants} of them — ${node.maxEntrants - 1} match(es), since every ` +
          'one of them removes an entrant.',
      )
      continue
    }
    const fanning = fanningOf(node)
    if (fanning === null) continue
    lines.push(
      `- "${node.id}" runs once per item of ${fanning.source}.${fanning.field}, up to ${fanning.maxWidth} times.`,
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
      node.kind === 'router'
        ? [...node.choices].sort()
        : node.kind === 'verifier'
          ? [node.verifies, node.over ?? '', node.maxWidth ?? 0]
          : node.kind === 'fan'
            ? [node.source, node.over, node.maxWidth]
            : node.kind === 'bracket'
              ? [node.entrants, node.over, node.maxEntrants]
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
