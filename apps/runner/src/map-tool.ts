import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import {
 MAP_EDGE_KINDS,
 MAP_NODE_KINDS,
 MAX_EDGES_PER_FRAGMENT,
 MAX_MAP_LABEL_LENGTH,
 MAX_MAP_NODE_KEY_LENGTH,
 MAX_MAP_NODE_PATHS,
 MAX_MAP_SUMMARY_LENGTH,
 MAX_NODES_PER_FRAGMENT,
} from '@loom/domain'
import { z } from 'zod'

/**
 * The mastery tool.
 *
 * One tool, `record_map`, and it streams each fragment out the moment it is written —
 * modelled on `write_note` and deliberately *not* on `submit_plan`. The worker-notes design states
 * the contrast: a plan is only actionable whole, so it is collected and emitted after
 * the agent loop ends; a map is worth what it is worth the moment it exists, and the
 * runs whose output matters most here are exactly the ones that never reach a stop
 * handler. A mastery run is the longest-lived run in the system, so it is the likeliest
 * of all of them to be killed, reaped or capped mid-way.
 *
 * The description is doing real work and is written for the model. The failure mode
 * for this artifact is a map that is "technically a graph and practically a directory
 * listing" — a node per file and an edge per import, which the reader could have
 * produced with `grep` in less time than it takes to read. So the description spends
 * its length on what earns a node, and the schema offers `concept` kinds first.
 *
 * Note what the tool does **not** offer: a `provenance` field. Mastery makes provenance the
 * trust boundary inside the graph, and only the platform's parsers may write
 * `extracted`. The server would refuse a claim of it (`parseMapFragment`), so offering
 * the field here would only be inviting a refusal — and an argument about which claims
 * are trusted is not one a model should be able to open.
 */

export const MAP_SERVER_NAME = 'loom_map'
export const RECORD_MAP_TOOL_NAME = `mcp__${MAP_SERVER_NAME}__record_map`

export const MAP_TOOL_NAMES = [RECORD_MAP_TOOL_NAME] as const

export interface MapToolCallbacks {
 readonly recordMap: (fragment: {
 nodes: unknown[]
 edges: unknown[]
 }) => Promise<
 | { ok: true; nodesWritten: number; edgesWritten: number; superseded: number }
 | { ok: false; reason: string }
 >
}

/** Only the kinds a model should reach for first, in the order it should consider them. */
const NODE_KIND_GUIDANCE =
 'concept: a domain notion that lives in no single file (the merge queue, the approval gate). ' +
 'convention: a rule the codebase follows that a newcomer would break. ' +
 'constraint: something that must stay true. ' +
 'hazard: a place past changes went wrong. ' +
 'module / file / symbol / test / entry_point / migration / config: code entities, worth a node ' +
 'only when something else in the map points at them.'

export const createMapTool = (callbacks: MapToolCallbacks) => {
 const recordMap = tool(
 'record_map',
 'Record part of what you have learned about this subject, as nodes and typed edges. ' +
 'Call it repeatedly as you go — every call is saved immediately, and a map you ' +
 'assemble at the end is a map that is lost if this run is stopped. ' +
 'Record what a later worker could NOT get from reading the code quickly: which files ' +
 'together implement one idea, a convention that is followed but written down nowhere, ' +
 'a place changes have gone wrong before. A node per file and an edge per import is ' +
 'worth nothing — that is already derivable in a second, and it crowds out what is not.',
 {
 nodes: z
.array(
 z.object({
 key: z
.string
.min(1)
.max(MAX_MAP_NODE_KEY_LENGTH)
.describe(
 'A stable id you can point edges at, here and in later calls. Use the ' +
 'repository-relative path for a file, and a short slug for a concept.',
),
 kind: z
.enum(MAP_NODE_KINDS as unknown as [string,...string[]])
.describe(NODE_KIND_GUIDANCE),
 label: z.string.min(1).max(MAX_MAP_LABEL_LENGTH).describe('One line, human-readable.'),
 summary: z
.string
.max(MAX_MAP_SUMMARY_LENGTH)
.optional
.describe(
 'What someone needs to know, and enough of why that a later reader can tell ' +
 'whether it still applies. A map node is a pointer, not a document.',
),
 paths: z
.array(z.string.max(500))
.max(MAX_MAP_NODE_PATHS)
.optional
.describe(
 'Repository-relative paths this node is about. Naming them is what lets the ' +
 'platform retire this claim automatically when those files change — a node ' +
 'with no paths can only ever be checked by hand.',
),
 observationCount: z
.number
.int
.min(1)
.optional
.describe(
 'How many separate times you actually observed this. Required to be honest: ' +
 'for a person\'s conventions the platform refuses anything seen fewer than ' +
 'three times, because a preference seen once is a coincidence.',
),
 }),
)
.max(MAX_NODES_PER_FRAGMENT)
.optional,
 edges: z
.array(
 z.object({
 fromKey: z.string.min(1).max(MAX_MAP_NODE_KEY_LENGTH),
 toKey: z.string.min(1).max(MAX_MAP_NODE_KEY_LENGTH),
 kind: z
.enum(MAP_EDGE_KINDS as unknown as [string,...string[]])
.describe(
 'implements is the valuable one: it connects a concept to the code that ' +
 'realizes it. There is deliberately no "related to" — an edge that does not ' +
 'say how two things relate tells a reader nothing they can act on.',
),
 }),
)
.max(MAX_EDGES_PER_FRAGMENT)
.optional,
 },
 async (args) => {
 const result = await callbacks.recordMap({
 nodes: args.nodes ?? [],
 edges: args.edges ?? [],
 })

 if (!result.ok) {
 return {
 content: [{ type: 'text' as const, text: `Not recorded: ${result.reason}` }],
 isError: true,
 }
 }

 /**
 * The counts go back deliberately. `superseded` is the one a mapping agent needs
 * most: it means "this replaced something you already said", which is the signal
 * that it is re-deriving rather than extending — the flat-yield state mastery wants
 * visible, reported to the agent itself rather than only to the human watching.
 */
 const superseded =
 result.superseded > 0 ? `, replacing ${result.superseded} earlier claim(s)`: ''
 return {
 content: [
 {
 type: 'text' as const,
 text: `Recorded ${result.nodesWritten} node(s) and ${result.edgesWritten} edge(s)${superseded}.`,
 },
 ],
 }
 },
)

 return createSdkMcpServer({
 name: MAP_SERVER_NAME,
 version: '1.0.0',
 tools: [recordMap],
 })
}
