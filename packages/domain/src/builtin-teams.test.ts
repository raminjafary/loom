import { describe, expect, it } from 'vitest'
import { BUILTIN_PERSONAS } from './builtin-personas.js'
import { BUILTIN_TEAMS } from './builtin-teams.js'
import { MAX_FLEET_SIZE } from './fleets.js'

/**
 * The shipped teams.
 *
 * These exist because seeding writes them through the port rather than through
 * `updatePersonaGroup`, which is human-only by design — so the validation a human's edit
 * gets is not applied to ours. Every rule that use case enforces is asserted here instead,
 * where a bad shipped team fails a build rather than a workspace's first login.
 */

const persona = (name: string) => BUILTIN_PERSONAS.find((entry) => entry.name === name)

describe('BUILTIN_TEAMS', => {
 it('ships a few, each named for a job rather than a roster', => {
 expect(BUILTIN_TEAMS.length).toBeGreaterThanOrEqual(3)
 expect(new Set(BUILTIN_TEAMS.map((team) => team.name)).size).toBe(BUILTIN_TEAMS.length)
 })

 it('names only personas the platform actually ships', => {
 for (const team of BUILTIN_TEAMS) {
 for (const member of team.members) {
 expect(persona(member), `${team.name} names ${member}`).toBeDefined
 }
 }
 })

 /** A team of one is a run, not a swarm — the same floor `conveneRoster` holds. */
 it('gives every team something to arrange', => {
 for (const team of BUILTIN_TEAMS) {
 expect(team.members.length, team.name).toBeGreaterThanOrEqual(2)
 expect(new Set(team.members).size, team.name).toBe(team.members.length)
 }
 })

 /**
 * The corporation: the chain of command starts with a decomposition, so a root that is not a
 * planner would make every tier the canvas draws below it a drawing of a tree no run can
 * have — which is exactly the refusal `updatePersonaGroup` makes for a human.
 */
 it('roots every team at a planner that is on it', => {
 for (const team of BUILTIN_TEAMS) {
 expect(team.members, team.name).toContain(team.orchestrator)
 expect(persona(team.orchestrator)?.harnessPlanner, team.name).toBe(true)
 }
 })

 /**
 * The two refusals `parseReviewPolicy` makes, checked against the shipped data: a persona
 * reviewing itself (which plan validation refuses) and a *planner* as the reviewed party,
 * whose output is a plan rather than a branch.
 */
 it('ships no review policy the runtime would refuse', => {
 for (const team of BUILTIN_TEAMS) {
 for (const [reviewer, reviewed] of Object.entries(team.reviewers ?? {})) {
 expect(team.members, `${team.name}: ${reviewer} reviews`).toContain(reviewer)
 for (const name of reviewed) {
 expect(team.members, `${team.name}: ${name} is reviewed`).toContain(name)
 expect(name, `${team.name}: ${reviewer} would review itself`).not.toBe(reviewer)
 expect(
 persona(name)?.harnessPlanner,
 `${team.name}: ${name} is a planner, so it produces a plan and not a branch`,
).toBe(false)
 }
 }
 }
 })

 /** A width of 0 is a removal and one past the ceiling refuses every run of that member. */
 it('ships no width the runtime would refuse', => {
 for (const team of BUILTIN_TEAMS) {
 for (const [name, size] of Object.entries(team.fleet ?? {})) {
 expect(team.members, `${team.name}: ${name} is sized`).toContain(name)
 expect(size, `${team.name}: ${name}`).toBeGreaterThan(0)
 expect(size, `${team.name}: ${name}`).toBeLessThanOrEqual(MAX_FLEET_SIZE)
 }
 }
 })

 /**
 * The corporation has to be visible out of the box, which is what the second
 * planner persona is for — a workspace that ships one planner ships no depth at all.
 */
 it('ships one team with a sub-planner on it', => {
 const withTwoPlanners = BUILTIN_TEAMS.filter(
 (team) => team.members.filter((name) => persona(name)?.harnessPlanner).length >= 2,
)
 expect(withTwoPlanners.length).toBeGreaterThanOrEqual(1)
 })
})
