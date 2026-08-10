import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { MAX_SUBTASKS } from '@loom/domain'
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
