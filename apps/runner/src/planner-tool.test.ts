import { describe, expect, it } from 'vitest'
import { PLAN_SUBTASKS_SCHEMA } from './planner-tool.js'

/**
 * The pre-flight on `submit_plan`'s input.
 *
 * Why it is worth its own file: a plan is validated *server-side, after the run has
 * ended*, because `submit_plan` only records what the model submitted. So a semantically
 * invalid plan used to be a refusal nobody could act on — the planner had already
 * stopped, and a human got a thread saying "Plan refused" and nothing else. Running the
 * domain's validator inside the tool turns that into a retry in the same turn.
 *
 * Observed live: a Haiku planner sent `reviews: [0]`, saw the *type* error the schema
 * already produced, fixed it inside one turn, and then sent `reviews: 1` for subtask 1 —
 * a 1-based reading of a 0-based field. The type error was caught here; the semantic one
 * was not, and it cost the whole run.
 *
 * The tests validate against the exported schema itself, not a copy of it, because a
 * copy would keep passing after the tool stopped using it.
 */
describe('submit_plan pre-flight', => {
 const sub = (title: string, extra: Record<string, unknown> = {}) => ({
 title,
 task: 'do the thing',
 personaName: 'swe',
...extra,
 })

 it('accepts an ordinary fan-out unchanged', => {
 expect(PLAN_SUBTASKS_SCHEMA.safeParse([sub('a'), sub('b')]).success).toBe(true)
 })

 it('rejects a self-review in the tool call, and names the 0-based convention', => {
 // The exact mistake a live planner made. The message has to be actionable, because
 // its only reader is a model deciding what to send next.
 const result = PLAN_SUBTASKS_SCHEMA.safeParse([sub('build'), sub('check', { reviews: 1 })])
 expect(result.success).toBe(false)
 if (result.success) return
 const message = result.error.issues.map((issue) => issue.message).join(' ')
 expect(message).toContain('0-based')
 expect(message).toContain('did you mean 0?')
 })

 it('rejects a reviews as an array — the shape a live planner tried first', => {
 expect(PLAN_SUBTASKS_SCHEMA.safeParse([sub('a'), sub('b', { reviews: [0] })]).success).toBe(
 false,
)
 })

 it('rejects a cycle before the run ends rather than after', => {
 const result = PLAN_SUBTASKS_SCHEMA.safeParse([
 sub('a', { dependsOn: [1] }),
 sub('b', { dependsOn: [0] }),
 ])
 expect(result.success).toBe(false)
 if (result.success) return
 expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain('cycle')
 })

 it('rejects a reviewer that claims paths', => {
 const result = PLAN_SUBTASKS_SCHEMA.safeParse([
 sub('build'),
 sub('check', { reviews: 0, paths: ['src/api'] }),
 ])
 expect(result.success).toBe(false)
 if (result.success) return
 expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain(
 'A reviewer owns no paths',
)
 })

 it('still enforces the subtask ceiling', => {
 // The pre-flight is added to the existing constraints, not in place of them.
 const many = Array.from({ length: 20 }, (_, index) => sub(`s${index}`))
 expect(PLAN_SUBTASKS_SCHEMA.safeParse(many).success).toBe(false)
 expect(PLAN_SUBTASKS_SCHEMA.safeParse([]).success).toBe(false)
 })
})
