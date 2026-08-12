import { describe, expect, it } from 'vitest'
import {
 PLANNER_READABLE_TOOLS,
 actingTools,
 canPlannerRead,
 isPlannerReadableTool,
} from './planner-tools.js'

/**
 * The planner/worker trust boundary, as amended. These tests state the boundary rather than the list:
 * a planner may read and may never act. If someone widens the allowlist, the
 * first block should still pass and the second block is what fails.
 */
describe('planner tool allowlist', => {
 it('admits exactly the three read-only tools', => {
 expect([...PLANNER_READABLE_TOOLS].sort).toEqual(['Glob', 'Grep', 'Read'])
 })

 it.each(['Read', 'Grep', 'Glob'])('%s is readable', (tool) => {
 expect(isPlannerReadableTool(tool)).toBe(true)
 })

 /**
 * The whole point of the amendment. Each of these is a way for untrusted worker
 * text to become planner *execution*, which is the threat the planner/worker trust boundary names — reading
 * is not on that list and these four are.
 */
 it.each(['Bash', 'Write', 'Edit', 'NotebookEdit'])('%s is an acting tool', (tool) => {
 expect(isPlannerReadableTool(tool)).toBe(false)
 expect(actingTools([tool])).toEqual([tool])
 })

 it('names every acting tool on a mixed list, so a refusal is fixable', => {
 expect(actingTools(['Read', 'Bash', 'Glob', 'Write'])).toEqual(['Bash', 'Write'])
 })

 it('treats an unknown tool as acting rather than as harmless', => {
 // Default-deny: a tool this module has never heard of — a new SDK builtin, an
 // MCP name, a typo — must not reach a planner because nobody listed it as
 // dangerous. The allowlist is the whole mechanism.
 expect(actingTools(['SomeFutureTool'])).toEqual(['SomeFutureTool'])
 })

 it('reports an empty-tooled planner as unable to read', => {
 // Still a legal persona to author, and the delegation roster and subtask
 // wording both branch on this — telling such a planner to go and read a file
 // is the stall that forced this change.
 expect(canPlannerRead([])).toBe(false)
 expect(canPlannerRead(['Read'])).toBe(true)
 })
})
