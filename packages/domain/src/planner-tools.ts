/**
 * What a Planner may hold itself.
 *
 * The roadmap wrote this as `tools: []` and the planner/worker trust boundary gave the
 * reason: worker output is untrusted text that a planner acts on with more authority, so
 * "decomposition emits structured output only" is what stops poisoned input becoming
 * planner *execution*. Both sections have been amended to draw the line where that reason
 * actually falls — between acting and reading, not between some tools and none.
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
 *   no MCP capability (`attenuateChildCapabilities` — an MCP server is a route
 *   to a shell). The only effect a planner can have on the world is the
 *   decomposition it submits, which the server then decides about itself.
 * - The envelope is untouched. `harness.delegates` is what bounds a planner's
 *   children, and it is a separate list from this one, so widening what a
 *   planner may read has no effect on what its workers may do.
 *
 * The cost, stated rather than buried: repository content is now an instruction source for
 * a planner, which is a wider injection surface than the task text and the ledger alone.
 * The planner/worker trust boundary already calls untrusted-data framing a mitigation
 * rather than a boundary; that judgement is unchanged and now covers one more input.
 */
export const PLANNER_READABLE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob']

/**
 * What a Planner may hold to **research** — reading outside the repository.
 *
 * **[AMENDED — the operator asked for planners that can do R&D, and the rule as coded was
 * coarser than its own justification.]**
 *
 * These were excluded before, and not by the planner/worker trust boundary's argument: the
 * planner/worker trust boundary's amendment draws its line at *"reading is not acting"*,
 * and fetching a URL changes nothing. They were excluded by being absent from an allowlist,
 * and the persona form then told an operator they were "acting" tools — which is not the
 * reason and taught the wrong model of the boundary.
 *
 * The reason the exclusion was nevertheless defensible is one planner/worker trust boundary
 * does not spell out. the planner/worker trust boundary's stated cost of letting a planner
 * read is that "repository content is now an instruction source" — but a bound repository
 * is a perimeter *the operator chose*. An arbitrary URL is not: a worker note saying "the
 * spec is at https://…" turns a planner's read into an attacker-selected fetch, and a
 * planner's output is authority — subtasks carrying tool grants up to its `delegates`
 * ceiling.
 *
 * **What changed is that the operator moved the gate, deliberately.** Their position: teams
 * run autonomously and a human only merges. That is a real bound and the strongest one
 * available here — the push policy keeps git credentials out of the sandbox, so a merge is
 * already the one thing no agent can do for itself. Injected planning therefore surfaces as
 * a branch a human declined to merge rather than as silent action.
 *
 * **The two are not equally safe, and the asymmetry is the whole content of this list:**
 *
 * - `WebFetch` runs in the sandbox behind the egress proxy, so it reaches **only** hosts a
 *   capability an operator attached names. Allowing it on a planner therefore adds no reach
 *   at all until an operator grants a host — the perimeter stays operator-chosen, which is
 *   exactly the property the planner/worker trust boundary's own reasoning turns on.
 * - `WebSearch` is executed by the *model API*, so no allowlist ever sees it and nothing
 *   can scope it to hosts. Ticking it **is** the grant. It is the widest instruction source
 *   in the system and it is here because the operator asked for it with the merge gate as
 *   the accepted backstop — recorded rather than implied, because the next person to read
 *   this should know it was a decision and not an oversight.
 *
 * Still no MCP capability on a planner: the capability registry treats an MCP server as a
 * route to a shell, and `attenuateChildCapabilities` is unchanged.
 */
export const PLANNER_RESEARCH_TOOLS: readonly string[] = ['WebFetch', 'WebSearch']

/**
 * Everything a Planner may hold: the read-only three plus the two research tools.
 *
 * One list rather than two call sites, because the invariant that matters is "a planner
 * cannot act", and every check should be against that single answer.
 */
export const PLANNER_ALLOWED_TOOLS: readonly string[] = [
  ...PLANNER_READABLE_TOOLS,
  ...PLANNER_RESEARCH_TOOLS,
]

export const isPlannerReadableTool = (tool: string): boolean =>
  PLANNER_ALLOWED_TOOLS.includes(tool)

/** Whether this tool reaches outside the repository — true of the research two only. */
export const isPlannerResearchTool = (tool: string): boolean =>
  PLANNER_RESEARCH_TOOLS.includes(tool)

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
  tools.some((tool) => PLANNER_READABLE_TOOLS.includes(tool))
