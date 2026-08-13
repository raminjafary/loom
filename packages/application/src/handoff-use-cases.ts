import {
 DEFAULT_HANDOFF_CAP_PER_TREE,
 HAND_OVER_TOOL_NAME,
 NotFoundError,
 checkBrief,
 handoffDecision,
 parseBrief,
 renderHandoffBrief,
 renderHandoffNudge,
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

/**
 * The stored policy as the `limits` shape both handoff paths already accept.
 *
 * A null is *omitted* rather than passed through, because `handoffDecision` reads an
 * absent field as "use the default" and an explicit `undefined` the same way — but only
 * one of those survives an object spread into a caller that checks `in`. One converter,
 * used by both callers, is what keeps "I have not chosen" meaning the same thing in both.
 */
export const handoffLimits = (control: {
 handoff: { threshold: number | null; capPerTree: number | null }
}): { handoffThreshold?: number; handoffCapPerTree?: number } => ({
...(control.handoff.threshold === null ? {}: { handoffThreshold: control.handoff.threshold }),
...(control.handoff.capPerTree === null
 ? {}
: { handoffCapPerTree: control.handoff.capPerTree }),
})

export interface SuggestHandoffDeps {
 readonly agentRuns: {
 markHandoffSuggested(workspaceId: WorkspaceId, id: AgentRunId): Promise<boolean>
 listTree(workspaceId: WorkspaceId, treeRunId: AgentRunId): Promise<{ relation: string | null }[]>
 }
 readonly resolveTreeRunId: (workspaceId: WorkspaceId, runId: AgentRunId) => Promise<AgentRunId>
 /** Says it to the run itself, in-flight. */
 readonly deliver: (input: { runnerId: string; runId: AgentRunId; text: string }) => Promise<void>
 /** Says it where a human reads — a threshold nobody can see acting is a setting. */
 readonly announce: (input: { runId: AgentRunId; text: string }) => Promise<void>
 readonly limits?: { handoffThreshold?: number; handoffCapPerTree?: number }
}

/**
 * The nudge.
 *
 * Called from the heartbeat, which is the frame that already carries the measurement live swarm observability
 * takes and mastery acts on — so the platform notices a filling window at the moment it fills
 * rather than the next time somebody looks at the board.
 *
 * **It never hands over.** All it does is tell the run its own number and remind it the
 * tool exists, because retiring an agent mid-thought on a ratio is the thing mastery rules
 * out: the measurement is the platform's, the judgement is the agent's, and the cap is the
 * only part that refuses.
 *
 * Two guards keep it from being a cost of its own. The decision is taken **before** the
 * tree is read — a heartbeat arrives every few seconds and every run in the workspace
 * sends one, so a tree query per heartbeat would be a query per run per tick for a
 * condition almost no run is in. And the stamp is claimed conditionally, so it fires once
 * per run: a nudge repeated every heartbeat is a nudge ignored, in a window that by
 * hypothesis has no room to spare.
 */
export const suggestHandoffOnPressure = async (
 deps: SuggestHandoffDeps,
 run: {
 id: AgentRunId
 workspaceId: WorkspaceId
 runnerId: string
 status: string
 contextTokens: number | null
 contextMaxTokens: number | null
 },
): Promise<boolean> => {
 /**
 * The cheap half first, with the tree count assumed clear. Assuming zero can only make
 * this *more* likely to pass, so nothing that deserves a nudge is filtered out here —
 * the authoritative decision below re-runs with the real count.
 */
 const provisional = handoffDecision({
 status: run.status,
 contextTokens: run.contextTokens,
 contextMaxTokens: run.contextMaxTokens,
 handoffsInTree: 0,
...(deps.limits?.handoffThreshold === undefined
 ? {}
: { threshold: deps.limits.handoffThreshold }),
 })
 if (!provisional.handOff) return false

 const treeRunId = await deps.resolveTreeRunId(run.workspaceId, run.id)
 const handoffsInTree = countHandoffsInTree(await deps.agentRuns.listTree(run.workspaceId, treeRunId))
 if (!shouldSuggestHandoff(run, handoffsInTree, deps.limits)) return false

 // The claim is what makes it once-only, and it is taken before the delivery: a nudge
 // sent twice is worse than one that was stamped and then failed to send.
 if (!(await deps.agentRuns.markHandoffSuggested(run.workspaceId, run.id))) return false

 const cap = deps.limits?.handoffCapPerTree ?? DEFAULT_HANDOFF_CAP_PER_TREE
 await deps.deliver({
 runnerId: run.runnerId,
 runId: run.id,
 text: renderHandoffNudge({
 pressure: provisional.pressure,
 toolName: HAND_OVER_TOOL_NAME,
 handoffsInTree,
 cap,
 }),
 })
 await deps.announce({
 runId: run.id,
 text:
 `This run's context window is ${Math.round(provisional.pressure * 100)}% full. It has ` +
 'been told, and it may hand the work to a fresh run on the same branch and the same ' +
 'budget — that is its call, not the platform\'s.',
 })
 return true
}
