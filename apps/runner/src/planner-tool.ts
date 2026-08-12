import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { MAX_DELTA_OPS, MAX_DELTA_RATIONALE_LENGTH, MAX_SUBTASKS } from '@loom/domain'
import type { WirePlanSubtask } from '@loom/runner-protocol'
import { z } from 'zod'

/**
 * The Planner's delegation channel.
 *
 * A Planner declares `tools: []` — no filesystem, no shell — and this is the one
 * thing it can call. Giving it a tool at all deserves justification: the point of
 * `tools: []` is the trust boundary, and this does not weaken it, because
 * submitting a plan has no effect the platform does not then decide for itself.
 * The tool records a decomposition; the *server* validates it, attenuates each
 * child against the Planner, and starts runs under the same concurrency limit and
 * kill switch as anything else. A Planner that submits a plan asking for tools it
 * does not have gets children that are refused.
 *
 * An in-process SDK MCP server rather than parsing the model's prose: the schema
 * is then enforced by the tool call itself, so a malformed plan is a retry the
 * model can see and fix rather than a parse failure after the run has ended.
 */

export const PLANNER_SERVER_NAME = 'loom_plan'
export const PLANNER_TOOL_NAME = `mcp__${PLANNER_SERVER_NAME}__submit_plan`

export interface PlannerToolHandle {
 readonly server: ReturnType<typeof createSdkMcpServer>
 /** The last plan submitted, or null if the Planner never called the tool. */
 readonly taken: => WirePlanSubtask[] | null
}

export const createPlannerTool = : PlannerToolHandle => {
 let submitted: WirePlanSubtask[] | null = null

 const submitPlan = tool(
 'submit_plan',
 'Submit a decomposition of the goal into subtasks. Each subtask becomes one agent ' +
 'run on its own branch. Submit exactly one plan, then stop.',
 {
 subtasks: z
.array(
 z.object({
 title: z.string.min(1).max(200).describe('A short name for this subtask'),
 task: z
.string
.min(1)
.max(4_000)
.describe('Exactly what the worker should do, written as an instruction to them'),
 personaName: z
.string
.min(1)
.max(100)
.describe('The name of the registered persona that should do this subtask'),
 /**
 * **This field was missing, and its absence explains a feature that never
 * fired.** Path ownership, the overlap warning, the cross-plan collision
 * check and the board's per-card claim are all built on it — and all of
 * them were reading a field the model was never asked for. The wire
 * protocol carried it, the domain validated it, the server acted on it,
 * and every live planner submitted plans without it, which read as
 * "planners choose not to claim paths" rather than as a missing input.
 *
 * The description says *why* to claim rather than only what to write: the
 * point of the field is the warning it makes possible before tokens are
 * spent, and a model that does not know that treats it as bookkeeping.
 */
 paths: z
.array(z.string)
.optional
.describe(
 'Repository-relative paths (files or directories) this subtask will ' +
 'work in — for example ["src/api", "docs/api.md"]. Claim them: the ' +
 'platform uses these to warn about two workers heading for the same ' +
 'file before either of them starts, which is the main cause of merge ' +
 'conflicts. Best effort is useful — name the paths you are confident ' +
 'about and leave the list short rather than guessing at the whole tree.',
),
 /**
 * The DAG. The description leads with *when to use it* rather than what
 * it holds, because the failure mode is not a malformed edge — it is a
 * planner that never makes one and fans out work that had an order.
 *
 * It also states the cost, for the reason the collaboration topology gives: "a DAG of agents is a
 * machine for turning one bad early decision into eight expensive later
 * ones". A model that thinks sequencing is free will sequence everything,
 * and a fully serial plan throws away the 2.1× the parallel-branch measurement measured.
 */
 dependsOn: z
.array(z.number.int)
.optional
.describe(
 'Indices of other subtasks in this same array (0-based) that must ' +
 'finish before this one starts. Use it when a subtask genuinely ' +
 'needs another\'s output — "QA tests what the engineer built", ' +
 '"the architect decides the approach before anyone implements it". ' +
 'Leave it out otherwise: subtasks with no dependencies all start at ' +
 'once, which is faster and fails more cheaply, and a subtask whose ' +
 'dependency fails is skipped rather than run. Dependencies must not ' +
 'form a cycle — a plan containing one is refused whole.',
),
 }),
)
.min(1)
.max(MAX_SUBTASKS),
 },
 async (args) => {
 submitted = args.subtasks
 // The count is echoed back rather than a bare "ok": a Planner that meant to
 // submit five and sees three has been told something useful.
 return {
 content: [
 {
 type: 'text' as const,
 text:
 `Plan accepted: ${args.subtasks.length} subtask(s) recorded. ` +
 'They will be started once you stop. Do not submit another plan.',
 },
 ],
 }
 },
)

 return {
 server: createSdkMcpServer({ name: PLANNER_SERVER_NAME, version: '1.0.0', tools: [submitPlan] }),
 taken: => submitted,
 }
}

export const PLAN_DELTA_TOOL_NAME = `mcp__${PLANNER_SERVER_NAME}__submit_plan_delta`

/** What the model submitted, before the server validates it. */
export interface WirePlanDelta {
 readonly rationale: string
 readonly ops: Record<string, unknown>[]
}

export interface PlanDeltaToolHandle {
 readonly server: ReturnType<typeof createSdkMcpServer>
 readonly taken: => WirePlanDelta | null
}

/**
 * The re-planning turn's one channel.
 *
 * Given *instead of* `submit_plan`, never alongside it: a run re-entered to adjust a
 * plan must not be able to answer by submitting a second decomposition, which would
 * start a fresh fan-out beside the work already running. That substitution is the
 * whole reason this is a separate factory rather than a second tool on the same
 * server.
 *
 * **The descriptions are the design.** mid-flight steering point 2 is a research finding, not a
 * preference — agents repair disrupted plans badly and make bounded local edits well —
 * so every field here pushes toward the smallest change that answers the human, and
 * says outright that no change is a valid answer. A model told only "emit a delta"
 * will produce the whole plan again with edits folded in, which is the one outcome
 * this must not have.
 */
export const createPlanDeltaTool = : PlanDeltaToolHandle => {
 let submitted: WirePlanDelta | null = null

 const submitDelta = tool(
 'submit_plan_delta',
 'Submit the change that should be made to the plan you already made, in response ' +
 'to the message from the human. Change as little as possible: the subtasks you ' +
 'do not mention keep running untouched, which is the point. Do not re-describe ' +
 'the plan, do not re-create subtasks that are already running, and do not ' +
 'decompose the goal again. If nothing should change, submit no changes at all ' +
 'and explain why in the rationale — that is a complete and often correct ' +
 'answer. Submit exactly one delta, then stop.',
 {
 rationale: z
.string
.min(1)
.max(MAX_DELTA_RATIONALE_LENGTH)
.describe(
 'One or two sentences on how you read the message and why these changes ' +
 '(or no changes) follow from it. A human reads this to know they were understood.',
),
 ops: z
.array(
 z.union([
 z.object({
 op: z.literal('cancel'),
 runId: z
.string
.describe('The runId of the subtask to stop, exactly as listed in your brief'),
 reason: z
.string
.min(1)
.max(2_000)
.describe('Why this subtask should stop. It is recorded and a human will read it.'),
 }),
 z.object({
 op: z.literal('revise'),
 runId: z.string.describe('The runId of the subtask whose scope changes'),
 guidance: z
.string
.min(1)
.max(2_000)
.describe(
 'What that worker should do differently, written as an instruction to ' +
 'them. This reaches the worker through the shared notes, so it takes ' +
 'effect when they next read them rather than interrupting them — say ' +
 'what should change from here, not what they should have done.',
),
 }),
 z.object({
 op: z.literal('add'),
 subtask: z.object({
 title: z.string.min(1).max(200).describe('A short name for this subtask'),
 task: z
.string
.min(1)
.max(4_000)
.describe('Exactly what the worker should do, written as an instruction to them'),
 personaName: z
.string
.min(1)
.max(100)
.describe('The name of the registered persona that should do this subtask'),
 paths: z
.array(z.string)
.optional
.describe(
 'Repository-relative paths this subtask owns, so the platform can warn ' +
 'about overlap with work already running',
),
 }),
 }),
 ]),
)
.max(MAX_DELTA_OPS)
.describe(
 `At most ${MAX_DELTA_OPS} changes, each naming one subtask. An empty list means the plan is right as it stands.`,
),
 },
 async (args) => {
 submitted = { rationale: args.rationale, ops: args.ops as Record<string, unknown>[] }
 return {
 content: [
 {
 type: 'text' as const,
 text:
 `Delta recorded: ${args.ops.length} change(s). They will be applied once you ` +
 'stop, and each one that cannot be applied will be reported. Do not submit another delta.',
 },
 ],
 }
 },
)

 return {
 server: createSdkMcpServer({ name: PLANNER_SERVER_NAME, version: '1.0.0', tools: [submitDelta] }),
 taken: => submitted,
 }
}
