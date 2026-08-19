import { describe, expect, it } from 'vitest'
import {
  PLANNER_ALLOWED_TOOLS,
  PLANNER_READABLE_TOOLS,
  PLANNER_RESEARCH_TOOLS,
  actingTools,
  canPlannerRead,
  isPlannerReadableTool,
  isPlannerResearchTool,
} from './planner-tools.js'

/**
 * The planner's boundary, as amended twice. These tests state it rather than the list:
 * **a planner may read and may never act.** If someone widens the allowlist, the first
 * blocks should still pass and the acting block is what fails.
 */
describe('planner tool allowlist', () => {
  it('admits the three repository-reading tools', () => {
    expect([...PLANNER_READABLE_TOOLS].sort()).toEqual(['Glob', 'Grep', 'Read'])
  })

  /**
   * The second amendment: reading *outside* the repository is still reading, which is what
   * the planner/worker trust boundary's own line ("reading is not acting") already said.
   * See `planner-tools.ts` for why these were excluded anyway, and what the operator
   * changed.
   */
  it('admits the two research tools', () => {
    expect([...PLANNER_RESEARCH_TOOLS].sort()).toEqual(['WebFetch', 'WebSearch'])
  })

  it.each(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])('%s is allowed', (tool) => {
    expect(isPlannerReadableTool(tool)).toBe(true)
    expect(actingTools([tool])).toEqual([])
  })

  it('is the two lists and nothing else', () => {
    expect([...PLANNER_ALLOWED_TOOLS].sort()).toEqual([
      'Glob',
      'Grep',
      'Read',
      'WebFetch',
      'WebSearch',
    ])
  })

  /**
   * Unchanged, and the part worth guarding. Each of these is a way for untrusted worker
   * text to become planner *execution*, which is the threat the planner/worker trust
   * boundary actually names.
   */
  it.each(['Bash', 'Write', 'Edit', 'NotebookEdit'])('%s is an acting tool', (tool) => {
    expect(isPlannerReadableTool(tool)).toBe(false)
    expect(actingTools([tool])).toEqual([tool])
  })

  it('names every acting tool on a mixed list, so a refusal is fixable', () => {
    expect(actingTools(['Read', 'Bash', 'WebFetch', 'Write'])).toEqual(['Bash', 'Write'])
  })

  it('treats an unknown tool as acting rather than as harmless', () => {
    // Default-deny: a tool this module has never heard of — a new SDK builtin, an
    // MCP name, a typo — must not reach a planner because nobody listed it as
    // dangerous. The allowlist is the whole mechanism.
    expect(actingTools(['SomeFutureTool'])).toEqual(['SomeFutureTool'])
  })

  /**
   * Research and repository-reading are told apart, because the roster's wording depends on
   * the second and not the first: a planner with `WebSearch` and no `Read` still cannot
   * open the area it was handed, and telling it to go and look would be the stall that
   * forced the first amendment.
   */
  it('does not mistake reaching the web for being able to read the repository', () => {
    expect(isPlannerResearchTool('WebSearch')).toBe(true)
    expect(isPlannerResearchTool('Read')).toBe(false)
    expect(canPlannerRead(['WebSearch'])).toBe(false)
    expect(canPlannerRead(['WebSearch', 'Read'])).toBe(true)
  })

  it('reports an empty-tooled planner as unable to read', () => {
    // Still a legal persona to author, and the delegation roster and subtask
    // wording both branch on this — telling such a planner to go and read a file
    // is the stall that forced the first amendment.
    expect(canPlannerRead([])).toBe(false)
    expect(canPlannerRead(['Read'])).toBe(true)
  })
})
