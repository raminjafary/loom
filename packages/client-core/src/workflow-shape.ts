/**
 * A drawn workflow, laid out for reading.
 *
 * **Layout is computed here, not authored**, exactly as the swarm graph's is: the position of a
 * step is a fact about the shape — which stage it is in, which lane it opened — so there is
 * nothing for a human to drag and nothing to persist. Two readers of one graph must not disagree
 * about where a barrier sits.
 *
 * **This reads the graph; it does not validate it.** The server parses a shape with the one
 * validator that exists, and anything that reaches this function has already been through it. So
 * what is here is a *narrow structural read* rather than a second definition of what a workflow
 * may be — the thing the contract deliberately refuses to write twice. Where a field is not the
 * shape this expects, the node is rendered as what it is and the reader is not lied to; nothing
 * here refuses anything, because a viewer that refuses to draw is a viewer that hides the shape
 * a person is trying to understand.
 *
 * **On not using a graph library**, the swarm graph's argument unchanged: Vue Flow renders a
 * layout you supply rather than computing one, so a read-only view of a staged DAG would need it
 * *and* a layout engine to draw what the stage ordering below already knows.
 */

/** What the wire carries per step, in the only terms a drawing needs. */
export interface WorkflowStepRow {
  readonly nodeId: string
  readonly pass: number
  readonly itemIndex: number
  readonly item: string | null
  readonly status: 'pending' | 'running' | 'answered' | 'refused' | 'skipped'
  readonly agentRunId: string | null
  readonly reason: string | null
  readonly costUsd: number | null
}

export type WorkflowNodeKind =
  | 'step'
  | 'fan'
  | 'router'
  | 'verifier'
  | 'bracket'
  | 'barrier'
  | 'unknown'

/** What one node's lanes add up to, which is what a reader is actually asking. */
export type WorkflowNodeState =
  /** Nothing has been dealt: it is waiting for what is above it. */
  | 'waiting'
  | 'running'
  | 'answered'
  | 'refused'
  | 'skipped'
  /** Lanes disagreed — some answered, some did not. The state a fan is usually in. */
  | 'mixed'

export interface WorkflowShapeNode {
  readonly id: string
  readonly kind: WorkflowNodeKind
  readonly title: string
  readonly persona: string | null
  /** "discover.sites, up to 3" — what makes this node open lanes, when it does. */
  readonly fans: string | null
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly state: WorkflowNodeState
  /** One entry per lane actually dealt, in lane order, so a reader can point at one. */
  readonly lanes: readonly WorkflowStepRow[]
  /** How many runs this node has cost so far, and what they came to. */
  readonly costUsd: number | null
}

export interface WorkflowShapeEdge {
  readonly from: string
  readonly to: string
  /** A router's branch label, when this edge is one. */
  readonly label: string | null
  readonly loop: boolean
  readonly path: string
}

export interface WorkflowShape {
  readonly nodes: readonly WorkflowShapeNode[]
  readonly edges: readonly WorkflowShapeEdge[]
  readonly width: number
  readonly height: number
}

const NODE_WIDTH = 168
const NODE_HEIGHT = 48
const BARRIER_HEIGHT = 14
const COLUMN = 232
const ROW = 76
const MARGIN = 16

interface RawNode {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly persona?: string
  readonly source?: string
  readonly over?: string | null
  readonly verifies?: string
  readonly maxWidth?: number | null
  readonly entrants?: string
  readonly maxEntrants?: number | null
}

interface RawEdge {
  readonly from: string
  readonly to: string
  readonly when?: string | null
  readonly loop?: { readonly until: string } | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readNodes = (graph: unknown): RawNode[] => {
  if (!isRecord(graph) || !Array.isArray(graph.nodes)) return []
  return graph.nodes.filter(isRecord).flatMap((node) => {
    const id = node.id
    if (typeof id !== 'string') return []
    return [
      {
        id,
        kind: typeof node.kind === 'string' ? node.kind : 'unknown',
        title: typeof node.title === 'string' ? node.title : id,
        ...(typeof node.persona === 'string' ? { persona: node.persona } : {}),
        ...(typeof node.source === 'string' ? { source: node.source } : {}),
        ...(typeof node.over === 'string' ? { over: node.over } : {}),
        ...(typeof node.verifies === 'string' ? { verifies: node.verifies } : {}),
        ...(typeof node.maxWidth === 'number' ? { maxWidth: node.maxWidth } : {}),
        ...(typeof node.entrants === 'string' ? { entrants: node.entrants } : {}),
        ...(typeof node.maxEntrants === 'number' ? { maxEntrants: node.maxEntrants } : {}),
      },
    ]
  })
}

const readEdges = (graph: unknown): RawEdge[] => {
  if (!isRecord(graph) || !Array.isArray(graph.edges)) return []
  return graph.edges.filter(isRecord).flatMap((edge) => {
    const { from, to } = edge
    if (typeof from !== 'string' || typeof to !== 'string') return []
    const loop = isRecord(edge.loop) && typeof edge.loop.until === 'string'
    return [
      {
        from,
        to,
        when: typeof edge.when === 'string' ? edge.when : null,
        loop: loop ? { until: String((edge.loop as Record<string, unknown>).until) } : null,
      },
    ]
  })
}

const KINDS: readonly WorkflowNodeKind[] = [
  'step',
  'fan',
  'router',
  'verifier',
  'bracket',
  'barrier',
]

const kindOf = (raw: string): WorkflowNodeKind =>
  (KINDS as readonly string[]).includes(raw) ? (raw as WorkflowNodeKind) : 'unknown'

/**
 * What makes a node open lanes, in the words a reader needs: where the list comes from and how
 * wide it may get. Null for a node that runs once.
 */
const fansOf = (node: RawNode): string | null => {
  if (node.kind === 'fan' && node.source !== undefined && node.over !== undefined) {
    return `${node.source}.${node.over}, up to ${node.maxWidth ?? '?'}`
  }
  if (node.kind === 'verifier' && node.verifies !== undefined && node.over != null) {
    return `${node.verifies}.${node.over}, up to ${node.maxWidth ?? '?'}`
  }
  /**
   * A bracket's lanes are matches rather than items, so the number a reader needs is how many
   * entrants may come forward — the matches follow from it, and the rounds from those.
   */
  if (node.kind === 'bracket' && node.entrants !== undefined && node.over !== undefined) {
    return `${node.entrants}.${node.over}, up to ${node.maxEntrants ?? '?'} entrants`
  }
  return null
}

/**
 * The waves the shape runs in, which is what the columns are. Loop edges are ignored, because a
 * column is a statement about the first pass.
 */
const stagesOf = (nodes: readonly RawNode[], edges: readonly RawEdge[]): number[] => {
  const index = new Map(nodes.map((node, at) => [node.id, at]))
  const depth = new Array<number>(nodes.length).fill(-1)
  const resolve = (at: number, seen: Set<number>): number => {
    const known = depth[at]
    if (known !== undefined && known >= 0) return known
    if (seen.has(at)) return 0
    seen.add(at)
    const parents = edges
      .filter((edge) => edge.loop === null && index.get(edge.to) === at)
      .flatMap((edge) => {
        const from = index.get(edge.from)
        return from === undefined ? [] : [from]
      })
    const value = parents.length === 0 ? 0 : Math.max(...parents.map((p) => resolve(p, seen))) + 1
    depth[at] = value
    seen.delete(at)
    return value
  }
  for (let at = 0; at < nodes.length; at += 1) resolve(at, new Set())
  return depth
}

/**
 * What one node's lanes add up to.
 *
 * `mixed` exists because a fan's ordinary end state *is* disagreement — six sites transformed and
 * one refused — and collapsing that to "refused" or to "answered" would each be a lie in a
 * different direction.
 */
export const stateOf = (lanes: readonly WorkflowStepRow[]): WorkflowNodeState => {
  if (lanes.length === 0) return 'waiting'
  if (lanes.some((lane) => lane.status === 'running' || lane.status === 'pending')) return 'running'
  const settled = new Set(lanes.map((lane) => lane.status))
  if (settled.size === 1) {
    const only = [...settled][0]
    return only === 'answered' ? 'answered' : only === 'refused' ? 'refused' : 'skipped'
  }
  return 'mixed'
}

export const layoutWorkflow = (
  graph: unknown,
  steps: readonly WorkflowStepRow[] = [],
): WorkflowShape => {
  const raw = readNodes(graph)
  const edges = readEdges(graph)
  if (raw.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  const depth = stagesOf(raw, edges)
  const rowInStage = new Map<number, number>()
  const placed: WorkflowShapeNode[] = raw.map((node, at) => {
    const stage = depth[at] ?? 0
    const row = rowInStage.get(stage) ?? 0
    rowInStage.set(stage, row + 1)
    const kind = kindOf(node.kind)
    const lanes = steps
      .filter((step) => step.nodeId === node.id)
      .slice()
      .sort((a, b) => a.pass - b.pass || a.itemIndex - b.itemIndex)
    const costs = lanes.filter((lane) => lane.costUsd !== null)
    return {
      id: node.id,
      kind,
      title: node.title,
      persona: node.persona ?? null,
      fans: fansOf(node),
      x: MARGIN + stage * COLUMN,
      y: MARGIN + row * ROW,
      width: NODE_WIDTH,
      height: kind === 'barrier' ? BARRIER_HEIGHT : NODE_HEIGHT,
      state: stateOf(lanes),
      lanes,
      costUsd: costs.length === 0 ? null : costs.reduce((sum, lane) => sum + (lane.costUsd ?? 0), 0),
    }
  })

  const byId = new Map(placed.map((node) => [node.id, node]))
  const drawn: WorkflowShapeEdge[] = edges.flatMap((edge) => {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from === undefined || to === undefined) return []
    const x1 = from.x + from.width
    const y1 = from.y + from.height / 2
    const x2 = to.x
    const y2 = to.y + to.height / 2
    /**
     * A loop edge is drawn *under* the shape rather than between the two boxes, because it goes
     * backwards: routed like a forward edge it would cross every stage between its ends and read
     * as an arrow into the wrong node.
     */
    const path =
      edge.loop !== null
        ? `M ${from.x + from.width / 2} ${from.y + from.height} ` +
          `C ${from.x} ${from.y + from.height + 48}, ${to.x + to.width} ${to.y + to.height + 48}, ` +
          `${to.x + to.width / 2} ${to.y + to.height}`
        : `M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2} ${y2}`
    return [{ from: edge.from, to: edge.to, label: edge.when ?? null, loop: edge.loop !== null, path }]
  })

  return {
    nodes: placed,
    edges: drawn,
    width: Math.max(...placed.map((node) => node.x + node.width)) + MARGIN,
    height: Math.max(...placed.map((node) => node.y + node.height)) + MARGIN + 56,
  }
}

/**
 * One line about what an execution is doing, for a list that has no room for a diagram.
 *
 * Counts lanes rather than nodes, because a fan of six is six runs and a reader deciding whether
 * to open this one is asking about runs.
 */
export const describeWorkflowProgress = (steps: readonly WorkflowStepRow[]): string => {
  if (steps.length === 0) return 'Nothing dealt yet.'
  const count = (status: WorkflowStepRow['status']) =>
    steps.filter((step) => step.status === status).length
  const running = count('running') + count('pending')
  const parts = [`${count('answered')} answered`]
  if (running > 0) parts.push(`${running} running`)
  if (count('refused') > 0) parts.push(`${count('refused')} refused`)
  if (count('skipped') > 0) parts.push(`${count('skipped')} not taken`)
  return `${steps.length} step(s): ${parts.join(', ')}.`
}
