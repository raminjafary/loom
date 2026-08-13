import {
 DEFAULT_HANDOFF_CAP_PER_TREE,
 NotFoundError,
 checkBrief,
 handoffDecision,
 parseBrief,
 renderHandoffBrief,
 type AgentRunId,
 type WorkspaceId,
} from '@loom/domain'

/**
 * Warm handoff, as use cases.
 *
 * **The only item in mastery that can lose work**, so the order of operations here is the
 * design. The successor is started *before* the predecessor is retired, and the
 * predecessor is retired only if that start succeeded: the failure this guards is a tree
 * with no live run and a branch nobody owns, which is the one outcome worse than a
 * degraded agent carrying on.
 *
 * What it does not do is decide *when*. `handoffDecision` answers that from measured
 * context pressure, and the agent asks by calling `hand_over` — a threshold nobody acts
 * on is a setting, and an agent that hands off whenever it likes is a budget with no
 * bottom. Both have to agree.
 */

export interface HandoffResult {
 readonly ok: boolean
 readonly reason: string
 readonly successorRunId: AgentRunId | null
}

/**
 * How many handoffs a tree has already made.
 *
 * Counted from the runs themselves rather than kept as a column, for the same reason
 * delegation depth is: a counter is a second fact that can disagree with the tree, and
 * the tree is the one a human reads.
 */
export const countHandoffsInTree = (
 runs: readonly { relation: string | null }[],
): number => runs.filter((run) => run.relation === 'handoff').length

/**
 * Accepts a brief and starts the successor.
 *
 * Written as one function rather than "validate, then start", because the two halves have
 * to fail together: a brief accepted whose successor never starts is a predecessor that
 * has been told to stop working with nothing taking over.
 *
 * `startSuccessor` is injected rather than imported to keep this file out of the cycle
 * `startAgentRun` would create — and, more usefully, to make the one thing this must do
 * in order visible in its signature.
 */
export const handOverToSuccessor = async (
 deps: {
 agentRuns: {
 findById(workspaceId: WorkspaceId, id: AgentRunId): Promise<
 | {
 id: AgentRunId
 status: string
 branchName: string | null
 contextTokens: number | null
 contextMaxTokens: number | null
 totalCostUsd: number | null
 task: string | null
 }
 | null
 >
 listTree(workspaceId: WorkspaceId, treeRunId: AgentRunId): Promise<{ relation: string | null }[]>
 updateStatus(
 workspaceId: WorkspaceId,
 id: AgentRunId,
 patch: { status: 'completed'; errorMessage?: string },
): Promise<unknown>
 }
 agentRunEvents: { writtenPaths(workspaceId: WorkspaceId, id: AgentRunId): Promise<string[]> }
 /** Resolves the tree this run belongs to, so the cap is counted over the right set. */
 resolveTreeRunId(workspaceId: WorkspaceId, runId: AgentRunId): Promise<AgentRunId>
 /** Starts the successor and returns its id. Throws if it could not be started. */
 startSuccessor(input: {
 predecessorRunId: AgentRunId
 brief: string
 task: string | null
 }): Promise<AgentRunId>
 /** Says it out loud, in the thread — mastery: "a handoff is a visible event". */
 announce(input: {
 predecessorRunId: AgentRunId
 successorRunId: AgentRunId
 reason: string
 }): Promise<void>
 limits?: { handoffThreshold?: number; handoffCapPerTree?: number }
 },
 input: { workspaceId: WorkspaceId; agentRunId: AgentRunId; brief: unknown },
): Promise<HandoffResult> => {
 const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
 if (!run) throw new NotFoundError('AgentRun')

 const verdict = parseBrief(input.brief)
 if (!verdict.ok) return { ok: false, reason: verdict.reason, successorRunId: null }

 const treeRunId = await deps.resolveTreeRunId(input.workspaceId, input.agentRunId)
 const tree = await deps.agentRuns.listTree(input.workspaceId, treeRunId)
 const handoffsInTree = countHandoffsInTree(tree)

 /**
 * The cap and the status are checked; the *threshold* deliberately is not.
 *
 * An agent that calls `hand_over` has told the platform it is getting worse at the task,
 * and that judgement is worth more than a ratio — the own reason for measuring
 * pressure is that a compacting window makes an agent worse, and the agent notices that
 * first. What the platform will not do is let it happen repeatedly: the cap is a bound
 * on thrash, and thrash is the failure mode this feature has.
 */
 const cap = deps.limits?.handoffCapPerTree ?? DEFAULT_HANDOFF_CAP_PER_TREE
 if (handoffsInTree >= cap) {
 return {
 ok: false,
 reason:
 `This tree has already handed off ${handoffsInTree} time(s), which is the limit. ` +
 'Finish what you can and stop — two agents handing a task back and forth spends a ' +
 'budget on continuity and never on the work.',
 successorRunId: null,
 }
 }
 if (run.status !== 'running') {
 return { ok: false, reason: 'This run is not working, so there is nothing to hand over', successorRunId: null }
 }

 const observedPaths = await deps.agentRunEvents.writtenPaths(input.workspaceId, run.id)
 const checked = checkBrief(verdict.brief, {
 branchName: run.branchName,
 observedPaths,
 // Verification belongs to the merge queue and has not run for a branch still being
 // written. Saying so plainly beats leaving the successor to assume either way.
 verification: null,
 spendUsd: run.totalCostUsd,
 })

 /**
 * The successor first. A predecessor retired before its replacement exists is a tree
 * with no live run and a branch nobody owns — the one outcome worse than a degraded
 * agent carrying on, and the reason this section is last in mastery.
 */
 const successorRunId = await deps.startSuccessor({
 predecessorRunId: run.id,
 brief: renderHandoffBrief(checked),
 task: run.task,
 })

 await deps.agentRuns.updateStatus(input.workspaceId, run.id, { status: 'completed' })
 await deps.announce({
 predecessorRunId: run.id,
 successorRunId,
 reason: 'its context was filling up',
 })

 return { ok: true, reason: 'a successor is taking over', successorRunId }
}

/**
 * Whether the platform would suggest a handoff right now.
 *
 * Separate from acting on it, because the threshold is "a setting with a sane default"
 * and what it drives is a *nudge*: the platform tells a run its window is filling, and the
 * run decides whether it is getting worse. Acting unilaterally would retire an agent
 * mid-thought on a ratio.
 */
export const shouldSuggestHandoff = (
 run: {
 status: string
 contextTokens: number | null
 contextMaxTokens: number | null
 },
 handoffsInTree: number,
 limits?: { handoffThreshold?: number; handoffCapPerTree?: number },
): boolean =>
 handoffDecision({
 status: run.status,
 contextTokens: run.contextTokens,
 contextMaxTokens: run.contextMaxTokens,
 handoffsInTree,
...(limits?.handoffThreshold === undefined ? {}: { threshold: limits.handoffThreshold }),
...(limits?.handoffCapPerTree === undefined ? {}: { cap: limits.handoffCapPerTree }),
 }).handOff
