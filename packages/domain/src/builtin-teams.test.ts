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

/**
 * The two fields the operator asks added, asserted here for the reason every other rule in this
 * file is: seeding writes through the port, so a shipped team never meets the validation a
 * human's edit does. A bad one has to fail a build.
 */
describe('BUILTIN_TEAMS descriptions and reporting lines', => {
 it('describes every team, because a preset nobody can tell apart is one nobody picks', => {
 for (const team of BUILTIN_TEAMS) {
 expect(team.description.trim, team.name).not.toBe('')
 // One line, not a paragraph — it sits beside a name in a list.
 expect(team.description.length, team.name).toBeLessThanOrEqual(120)
 expect(team.description, team.name).not.toContain('\n')
 }
 })

 /**
 * Every rule `reportingLineProblems` enforces, applied to what we ship: both ends on the
 * team, the target a planner, nobody reporting to themselves.
 */
 it('draws every reporting line between members, into a planner', => {
 for (const team of BUILTIN_TEAMS) {
 for (const [worker, planner] of Object.entries(team.reportsTo ?? {})) {
 expect(team.members, `${team.name} assigns ${worker}`).toContain(worker)
 expect(team.members, `${team.name} reports into ${planner}`).toContain(planner)
 expect(worker, `${team.name}: ${worker} reports to itself`).not.toBe(planner)
 expect(
 persona(planner)?.harnessPlanner,
 `${team.name}: ${planner} is reported to but is not a planner`,
).toBe(true)
 }
 }
 })

 /**
 * The corporation is the one arrangement a chain of command is *for*, so the team
 * that exists to demonstrate it has to actually demonstrate it — otherwise the feature is
 * a mechanism with no shipped example, which is how it stays undiscovered.
 */
 it('ships a chain of command on the two-planner team', => {
 const twoAreas = BUILTIN_TEAMS.find((team) => team.name === 'two-areas')
 expect(twoAreas).toBeDefined
 expect(twoAreas?.reportsTo).toEqual({ swe: 'area-planner' })
 // And the reviewer stays unassigned: reviewing is team-wide, not one planner's staff.
 expect(Object.keys(twoAreas?.reportsTo ?? {})).not.toContain('qa')
 })
})

/**
 * The cross-repository preset.
 *
 * Asserted as an *arrangement* rather than as a repository list, because that is the only
 * honest shape for a preset: which repositories a workspace has bound is unknowable at build
 * time, so the team ships the shape and the seeder fills in what is actually there.
 */
describe('BUILTIN_TEAMS across repositories', => {
 const acrossRepositories = BUILTIN_TEAMS.find((team) => team.name === 'across-repositories')

 it('ships one team that works across repositories', => {
 expect(acrossRepositories?.crossRepository).toBe(true)
 // Exactly one, so the seeder's "fill in whatever is bound" has one owner.
 expect(BUILTIN_TEAMS.filter((team) => team.crossRepository === true)).toHaveLength(1)
 })

 /**
 * It must not name repositories. A shipped name would name nothing in every workspace but
 * one, and a team pointing at a repository that does not exist is worse than a team that
 * points at none.
 */
 it('names no repository, because a preset cannot know one', => {
 expect(JSON.stringify(acrossRepositories)).not.toContain('repositoryId')
 expect(JSON.stringify(acrossRepositories)).not.toContain('extraRepositoryIds')
 })

 /** Every other preset stays single-repository, which is what every team did before. */
 it('leaves every other preset working in one repository', => {
 for (const team of BUILTIN_TEAMS.filter((entry) => entry.name !== 'across-repositories')) {
 expect(team.crossRepository, team.name).toBeUndefined
 }
 })
})

/**
 * The reconciler on every team, which is a different kind of membership
 * from the rest and has to stay that way.
 */
describe('BUILTIN_TEAMS and the reconciler', => {
 it('puts the reconciler on every team', => {
 for (const team of BUILTIN_TEAMS) {
 expect(team.members, team.name).toContain('reconciler')
 }
 })

 /**
 * Nothing may point at it. `PLATFORM_STARTED_PERSONAS` keeps it off every delegation roster,
 * so a reporting line or a review edge naming it would be a control the runtime ignores —
 * and it is the merge queue, not a planner, that starts it.
 */
 it('never makes the reconciler somebody’s staff or somebody’s reviewer', => {
 for (const team of BUILTIN_TEAMS) {
 expect(Object.keys(team.reportsTo ?? {}), team.name).not.toContain('reconciler')
 expect(Object.values(team.reportsTo ?? {}), team.name).not.toContain('reconciler')
 expect(Object.keys(team.reviewers ?? {}), team.name).not.toContain('reconciler')
 for (const reviewed of Object.values(team.reviewers ?? {})) {
 expect([...reviewed], team.name).not.toContain('reconciler')
 }
 expect(team.orchestrator, team.name).not.toBe('reconciler')
 expect(Object.keys(team.fleet ?? {}), team.name).not.toContain('reconciler')
 }
 })
})
