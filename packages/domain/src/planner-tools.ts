/**
 * What a Planner may hold itself.
 *
 * The roadmap wrote this as `tools: []` and the planner/worker trust boundary gave the reason: worker output is
 * untrusted text that a planner acts on with more authority, so "decomposition
 * emits structured output only" is what stops poisoned input becoming planner
 * *execution*. Both sections have been amended to draw the line where that
 * reason actually falls — between acting and reading, not between some tools
 * and none.
 *
 * The empty list was measured and found to break the own premise. A
 * sub-planner is handed "a whole area, and it will decompose that area itself";
 * an area is a region of a repository, and a planner that cannot open a single
 * file in it has nothing to decompose from but the sentence it was given. What
 * happened live, three times: the sub-planner asked a human what was in the
 * file, planned nothing, and sat on the gate until the approval SLA denied it.
 * Two prompt-level mitigations shipped before this one and neither held.
 *
 * What does *not* change, and is the part worth guarding:
 *
 * - A planner still cannot act. No `Bash`, `Write`, `Edit`, `NotebookEdit`, and
 * no MCP capability (`attenuateChildCapabilities` — an MCP server is a route
 * to a shell). The only effect a planner can have on the world is the
 * decomposition it submits, which the server then decides about itself.
 * - The envelope is untouched. `harness.delegates` is what bounds a planner's
 * children, and it is a separate list from this one, so widening what a
 * planner may read has no effect on what its workers may do.
 *
 * The cost, stated rather than buried: repository content is now an instruction
 * source for a planner, which is a wider injection surface than the task text
 * and the ledger alone. The planner/worker trust boundary already calls untrusted-data framing a mitigation
 * rather than a boundary; that judgement is unchanged and now covers one more
 * input.
 */
export const PLANNER_READABLE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob']

export const isPlannerReadableTool = (tool: string): boolean =>
 PLANNER_READABLE_TOOLS.includes(tool)

/**
 * The tools on a list that a planner may not hold — everything that is not
 * read-only. Returned rather than a boolean so a refusal can name them, which
 * is the difference between a persona a human can fix and one they must guess at.
 */
export const actingTools = (tools: readonly string[]): string[] =>
 tools.filter((tool) => !isPlannerReadableTool(tool))

/**
 * Whether a planner can scope its own area. False for a planner authored with
 * `tools: []`, which is still a legal thing to write — the rule below is an
 * allowlist, not a requirement — and which the delegation roster and the
 * subtask wording both have to keep telling the truth about.
 */
export const canPlannerRead = (tools: readonly string[]): boolean =>
 tools.some(isPlannerReadableTool)
