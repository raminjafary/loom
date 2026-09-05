/**
 * The designer agent — a harness arrives as a **proposal**, not as an edit.
 *
 * There is deliberately no workflow editor. A drawn shape is a configuration a measurement
 * cites: a tally against "the review harness" means nothing if the shape moved under it, so an
 * edit is a new version and never a mutation. That much the version table already enforces. What
 * this file adds is the answer to the question the missing editor leaves open — *who draws the
 * next version, and how* — and the answer is not a form.
 *
 * A designer is asked for a shape in words, reads the workspace it is drawing for, and submits a
 * graph. Nothing it submits runs. It lands as a proposal a human reads as a diagram, beside the
 * ceiling it could spend, and approves or declines. Approval is what writes the version, through
 * the same validator a hand-drawn shape goes through.
 *
 * ## Why a proposal rather than a write, given that a human could just review the diff
 *
 * Because a shape is **capability**, not text. A node names a persona, and a step of a running
 * workflow *is* a run of that persona — with that persona's tools, its approval mode, its cap. A
 * designer that could name any persona in the workspace could therefore mint a harness that runs
 * a shell it does not itself hold, and the fact that a human clicked approve on a diagram is not
 * the same as a human having chosen that grant. So two things hold at once, and the second does
 * not replace the first:
 *
 * - **Every persona a proposal names attenuates against the designer's own envelope**, by the
 *   same rule and the same function that decides whether a planner may delegate to a worker.
 *   Drawing a step that runs `swe` is delegating to `swe` a version at a time.
 * - **A human approves.** Attenuation bounds what may be proposed; the approval decides whether
 *   it happens. Either alone is the failure the other exists to prevent — configuration
 *   authored inside the trust boundary, or privilege escalation laundered through a config file.
 *
 * The designer is snapshotted from the *run*, not from the persona row: a run is what it was
 * launched as, and an envelope widened while a designer was thinking must not widen what it may
 * name. That is the same rule every child start already applies.
 */

import type { PersonaSpec } from './agents.js'
import type { AgentRunId, WorkflowDesignId, WorkflowId, WorkspaceId } from './ids.js'
import { delegationDesign, type DelegationRefusal } from './delegation-design.js'
import {
  fanningOf,
  isRunNode,
  ITEM_REFERENCE,
  INPUT_REFERENCE,
  LEFT_REFERENCE,
  MAX_BRACKET_ENTRANTS,
  MAX_FAN_WIDTH,
  MAX_LOOP_ITERATIONS,
  MAX_ROUTER_CHOICES,
  MAX_WORKFLOW_NODES,
  RIGHT_REFERENCE,
  workflowStages,
  type WorkflowGraph,
  type WorkflowNode,
} from './workflow-graph.js'

/**
 * Where a proposal stands.
 *
 * `superseded` is not here, and its absence is a decision: a second proposal for the same
 * workflow does not invalidate the first, because two shapes for one job is exactly the useful
 * case — a human reads both and takes one. What closes a proposal is a person deciding about it.
 */
export type WorkflowDesignStatus = 'proposed' | 'approved' | 'declined'

export const WORKFLOW_DESIGN_STATUSES: readonly WorkflowDesignStatus[] = [
  'proposed',
  'approved',
  'declined',
]

/**
 * How many proposals one designer run may leave open.
 *
 * Three, for the reason a proposer may send at most three candidate prompts: alternatives are
 * the point, and a fourth is a session filling a review queue rather than making a case. The
 * bound is per *run*, so a person who wants more asks again — which is a decision they make
 * rather than one a model makes for them.
 */
export const MAX_DESIGNS_PER_RUN = 3

/** How long a rationale may be. A case a human will not read is a case that was not made. */
export const MAX_DESIGN_RATIONALE_CHARS = 1_200

export const MAX_DESIGN_NAME_CHARS = 60
export const MAX_DESIGN_DESCRIPTION_CHARS = 240

/** What a designer submitted, before anything about this deployment has been checked. */
export interface WorkflowDesignSubmission {
  readonly name: string
  readonly description: string | null
  /** What this shape would do differently, and why it is worth a version. */
  readonly rationale: string
  readonly graph: unknown
}

/**
 * One proposal, as a person reads it.
 *
 * `workflowId` null means a workflow this workspace does not have yet; set means a **new version
 * of that one**, which is the only way an existing shape ever changes.
 */
export interface WorkflowDesignRecord {
  readonly id: WorkflowDesignId
  readonly workspaceId: WorkspaceId
  readonly workflowId: WorkflowId | null
  readonly name: string
  readonly description: string | null
  readonly rationale: string
  readonly graph: WorkflowGraph
  readonly digest: string
  readonly status: WorkflowDesignStatus
  /** The designer run that submitted it, so its session is readable beside its proposal. */
  readonly proposedByRunId: AgentRunId | null
  /** The persona that was designing, snapshotted — the envelope this was attenuated against. */
  readonly personaName: string | null
  readonly decidedByUserId: string | null
  readonly decidedAt: Date | null
  /** What the person said when they declined, or null. */
  readonly decisionNote: string | null
  readonly createdAt: Date
}

/** Why a proposal may not name a persona, node by node. */
export interface DesignEscalation {
  readonly nodeId: string
  readonly persona: string
  readonly refusals: readonly DelegationRefusal[]
}

/**
 * Every node whose persona is outside the designer's envelope.
 *
 * `delegationDesign` rather than a rule of its own, and that is the whole point: a step is a run
 * of that persona, so "may this shape name it" and "may this planner delegate to it" are one
 * question. A second answer to it would drift, and the first time the two disagreed nobody would
 * know which one the platform meant.
 *
 * Enumerated rather than returned on the first refusal, for the reason the composition canvas
 * enumerates: a designer told one reason at a time submits four times, and a person reading a
 * refused proposal wants to know what would have to change.
 */
export const designEscalations = (input: {
  readonly designer: PersonaSpec
  readonly graph: WorkflowGraph
  readonly personas: readonly PersonaSpec[]
  /** How many hops below this designer a named planner would still have. */
  readonly remainingDepth: number
}): DesignEscalation[] => {
  const byName = new Map(input.personas.map((persona) => [persona.name, persona]))
  const escalations: DesignEscalation[] = []
  const seen = new Set<string>()
  for (const node of input.graph.nodes) {
    if (!isRunNode(node)) continue
    if (seen.has(`${node.id}:${node.persona}`)) continue
    seen.add(`${node.id}:${node.persona}`)
    const named = byName.get(node.persona)
    if (named === undefined) continue
    const design = delegationDesign(input.designer, named, input.remainingDepth)
    if (design.ok) continue
    escalations.push({ nodeId: node.id, persona: node.persona, refusals: design.refusals })
  }
  return escalations
}

/** The refusal a designer is handed, naming the node and what would have to change. */
export const describeEscalations = (escalations: readonly DesignEscalation[]): string =>
  [
    'This shape names personas outside the envelope you are designing inside, so it is refused ' +
      'rather than proposed — a harness that runs a tool its designer may not hand out would be ' +
      'that grant made by drawing.',
    ...escalations.map(
      (escalation) =>
        `- "${escalation.nodeId}" runs ${escalation.persona}: ` +
        escalation.refusals.map((refusal) => refusal.detail).join(' '),
    ),
    'Redraw those steps with personas from the list you were given, or ask for the envelope to ' +
      'be widened by a person — which is a decision they make, not one you can make by naming it.',
  ].join('\n')

/**
 * The shape in one line: what it does, in order, with the lanes marked.
 *
 * For a list a diagram will not fit in, and for a brief where a designer needs to know what the
 * workspace already has without being handed six whole graphs. Stages rather than nodes, because
 * what a reader is asking is "what happens, then what".
 */
export const summarizeWorkflowShape = (graph: WorkflowGraph): string => {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  return workflowStages(graph)
    .map((stage) =>
      stage
        .map((id) => {
          const node = byId.get(id)
          if (node === undefined) return id
          const fanning = fanningOf(node)
          if (fanning !== null) return `${id}(×${fanning.maxWidth})`
          if (node.kind === 'bracket') return `${id}(bracket of ${node.maxEntrants})`
          if (node.kind === 'barrier') return `[${id}]`
          if (node.kind === 'router') return `${id}(${node.choices.join('|')})`
          return id
        })
        .join(' + '),
    )
    .join(' → ')
}

/**
 * The vocabulary, rendered from the vocabulary.
 *
 * A designer has to be told what a workflow may be, and the failure mode of writing that out in
 * prose is specific and silent: a node kind added to the validator and not to the paragraph is a
 * kind no designer will ever draw, and a bound changed in one place is a designer proposing
 * shapes that are refused on arrival. So the kinds come from `WORKFLOW_NODE_KINDS` — which the
 * compiler proves covers the union — and every number here is the constant itself.
 */
/**
 * One line per node kind, keyed by the kind.
 *
 * A `Record` over the union rather than a list of sentences, and that is load-bearing: a kind
 * added to the vocabulary and not to a paragraph is a kind no designer would ever draw, and this
 * makes that a compile error naming the kind that was forgotten. Every bound in the text is the
 * constant itself for the same reason.
 */
const KIND_LINES: Record<WorkflowNode['kind'], string> = {
  step:
    '`step` — one run. `answer: { fields: [{ kind, name }] }` declares what it must return, ' +
    'where kind is text, flag or list; or `answer: null` for a step nothing below it reads.',
  fan:
    "`fan` — one run per element of a predecessor's list. Needs `source` (that node's id), " +
    `\`over\` (which list field) and \`maxWidth\` (at most ${MAX_FAN_WIDTH}). Its task must ` +
    `mention {{${ITEM_REFERENCE}}}, or every lane reads the same prompt.`,
  router:
    '`router` — one run whose answer picks exactly one outgoing edge. Needs `choices` (2 to ' +
    `${MAX_ROUTER_CHOICES} slugs), and every choice needs an edge carrying \`when\`.`,
  verifier:
    "`verifier` — a run that tries to *refute* another node's answer. Needs `verifies`, and " +
    'may take `over` + `maxWidth` to refute one list element at a time. It may not run the ' +
    'persona that wrote what it verifies.',
  bracket:
    '`bracket` — judges entrants two at a time until one is left. Needs `entrants` (the node ' +
    'they come from), `over` (a text field where that node fans, a list field where it runs ' +
    `once) and \`maxEntrants\` (at most ${MAX_BRACKET_ENTRANTS}). Its task must show both ` +
    `{{${LEFT_REFERENCE}}} and {{${RIGHT_REFERENCE}}}; it answers \`winner\` (left or right) and ` +
    'whatever else you declare. It may not run the persona that wrote the entrants.',
  barrier:
    '`barrier` — starts nothing and costs nothing. It is the *only* thing that waits for every ' +
    'inbound lane, and it needs at least two of them.',
}

export const describeWorkflowVocabulary = (): string =>
  [
    'A workflow is a graph of nodes and edges, and nothing else. It is data the server validates ' +
      'before it can spend, not a program: there is no way to write a loop, a condition or a ' +
      'call that is not one of the shapes below.',
    '',
    'NODES — every node has `kind`, a slug `id`, a `title`, and (except a barrier) a `persona` ' +
      'and a `task`:',
    ...Object.values(KIND_LINES).map((line) => `- ${line}`),
    '',
    'EDGES — `{ from, to }`, plus:',
    '- A plain edge is a **pipeline**: the target starts the moment this one predecessor ' +
      'finishes, whatever the other lanes are doing. This is the default and it is usually right.',
    '- `when: "<choice>"` out of a router, and nowhere else.',
    `- \`loop: { until: "<flag field>" }\` on an edge pointing back at an ancestor, taken while ` +
      `that flag is false, at most ${MAX_LOOP_ITERATIONS} times whatever the flag says.`,
    '',
    'TEMPLATES — a task may interpolate:',
    `- {{${INPUT_REFERENCE}}} — what the execution was started on.`,
    '- {{node}} or {{node.field}} — an **ancestor**\'s answer. Not a barrier\'s, and not a node ' +
      'this one does not descend from: that answer does not exist yet when this step starts.',
    `- {{${ITEM_REFERENCE}}} in a fan or a per-item verifier; {{${LEFT_REFERENCE}}} and ` +
      `{{${RIGHT_REFERENCE}}} in a bracket.`,
    '',
    `BOUNDS — at most ${MAX_WORKFLOW_NODES} nodes. The graph may not cycle except through a ` +
      'loop edge. A node fed by two different fans, or sitting inside two loops, is refused: ' +
      'there is no honest lane or pass number for it, and a barrier between them makes both ' +
      'well-defined.',
  ].join('\n')

/**
 * What a designer is told, and it is the whole of its context beyond the repository it can read.
 *
 * Platform-authored and assembled here rather than on the Runner, for the reason every other
 * pre-rendered brief in this platform is: what is *withheld* and what is *stated* are the
 * mitigation, and a second formatter would be a second place for a rule to go missing.
 *
 * Three things it carries that a form could not, and they are the argument for the whole shape:
 *
 * - **The personas it may name, with what each holds** — and the ones it may *not*, with the
 *   reason. A designer that finds out at submission is a designer that submits four times.
 * - **What this workspace already has.** The most common right answer to "draw me a harness" is
 *   "the one you already have", and the second most common is "a new version of it".
 * - **The vocabulary, generated from the vocabulary**, so what a designer is told and what the
 *   validator enforces cannot drift apart.
 */
export const renderDesignerBrief = (input: {
  /** What the person asked for, verbatim. */
  readonly ask: string
  readonly designerName: string
  readonly available: readonly { readonly name: string; readonly description: string; readonly model: string; readonly tools: readonly string[] }[]
  readonly refused: readonly { readonly name: string; readonly why: string }[]
  readonly existing: readonly { readonly name: string; readonly version: number; readonly shape: string }[]
}): string =>
  [
    'You are drawing a **harness** — a reusable shape for a class of work — for this workspace,',
    'and a person asked for it in these words:',
    '',
    input.ask.trim(),
    '',
    'Read this repository before you draw anything. The question is not which diagram is elegant;',
    'it is what steps this work actually has here, in what order, and which of them genuinely',
    'need every earlier result before they can start. A harness that is one step per stage is a',
    'harness that costs one run per stage for nothing.',
    '',
    'Nothing you submit runs. It becomes a proposal a person reads as a drawing, beside what it',
    'could spend, and they approve it or they do not. If they approve it, it becomes a new',
    'version — an existing harness is never edited in place, because measurements cite versions.',
    '',
    '--- THE PERSONAS YOU MAY NAME ---',
    ...input.available.map(
      (persona) =>
        `- ${persona.name} (${persona.model}; ${persona.tools.length === 0 ? 'no tools' : persona.tools.join(', ')}) — ${persona.description}`,
    ),
    ...(input.refused.length === 0
      ? []
      : [
          '',
          'You may NOT name these, and naming one is refused rather than proposed:',
          ...input.refused.map((persona) => `- ${persona.name} — ${persona.why}`),
        ]),
    '',
    ...(input.existing.length === 0
      ? ['This workspace has no harnesses yet.']
      : [
          '--- WHAT THIS WORKSPACE ALREADY HAS ---',
          ...input.existing.map(
            (workflow) => `- "${workflow.name}" (v${workflow.version}): ${workflow.shape}`,
          ),
          '',
          'If one of these already does the job, say so and submit nothing — that is a useful',
          'answer and it costs nobody a version. If one nearly does it, propose it under its',
          'exact name: same name means a new version of that harness, and a different name',
          'means a new harness beside it.',
        ]),
    '',
    '--- THE VOCABULARY ---',
    describeWorkflowVocabulary(),
    '',
    '--- HOW TO SUBMIT ---',
    'Call submit_workflow_design once you have a shape, with the name, a one-line description of',
    'when to reach for it, the graph, and a rationale: what this shape would make happen that a',
    'single run of one agent would not, and what would show it worked. A rationale that says the',
    'shape is thorough is a rationale nobody can check.',
    '',
    'Two habits to avoid, both of which cost real money here:',
    '- **Barriers everywhere.** A barrier is for a stage that genuinely needs every lane. Use a',
    '  plain edge otherwise and the work flows down lane by lane.',
    '- **A step whose answer nothing reads.** Every declared field should be interpolated by',
    '  something below it, fanned over, or looped on. A field nobody consults is a field the',
    '  platform is only pretending to validate.',
    '',
    `You are ${input.designerName}. You cannot change any configuration yourself, and you should`,
    'not try: you draw, a person decides.',
  ].join('\n')
