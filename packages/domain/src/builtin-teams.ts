/**
 * The teams a workspace ships with.
 *
 * A workspace shipped ten personas and no arrangement of them, which left the
 * highest-value surface in the product — the composition canvas — opening onto an empty
 * roster and a "New team" field. Every question that canvas answers ("who reviews whom",
 * "how wide does this run", "where does the work land", "who is the root") needs a team to
 * be asked about, so the first thing an operator met was authoring one from nothing.
 *
 * Four rules these teams follow, each one a decision rather than a default:
 *
 * - **Named for the job, not the roster.** "ship-a-change" is a thing an operator wants
 * done; "planner + swe + qa" is a list they would have to interpret. The names are the
 * documentation of what a swarm is *for*.
 * - **A root is always chosen.** the depth is only answerable from somewhere, and a
 * team with no root leaves the canvas picking by reach and saying so — true, and a worse
 * first impression than a chain that reads.
 * - **`reviews` is set wherever it makes sense**, because the reviewing relation is the
 * one worker-to-worker collaboration the runtime executes, and a team that does not use
 * it teaches an operator that work is only ever handed on, never checked.
 * - **No repository and no layout.** The repository is the operator's choice and
 * the canvas arranges an unplaced team by tier on first open, which is exactly right for
 * one nobody has arranged. Seeding coordinates would be the platform pretending to a
 * human intent the roadmap says positions record.
 *
 * **Members are named, not id'd**, and a member whose persona is missing is dropped rather
 * than failing the team: an operator who deleted `qa` should still get the rest.
 */

export interface BuiltinTeam {
 readonly name: string
 /** Persona names, in the order they are worth reading. */
 readonly members: readonly string[]
 /** Which member the work starts from — the root orchestrator. */
 readonly orchestrator: string
 /** Who reviews whom, keyed by *reviewer* name, as the relation is drawn. */
 readonly reviewers?: Readonly<Record<string, readonly string[]>>
 /** How many of each member this team is sized to run at once — the fleet. */
 readonly fleet?: Readonly<Record<string, number>>
}

export const BUILTIN_TEAMS: readonly BuiltinTeam[] = [
 /**
 * The common case, and deliberately the smallest thing that is still a swarm: one
 * planner, work that fans out, and somebody checking it. The fleet of two is what makes
 * it a swarm rather than a queue — the width, on the one member where parallel
 * work is the point.
 */
 {
 name: 'ship-a-change',
 members: ['planner', 'swe', 'qa'],
 orchestrator: 'planner',
 reviewers: { qa: ['swe'] },
 fleet: { swe: 2 },
 },

 /**
 * Two areas that genuinely do not overlap, which is the whole argument for parallel
 * agents: the reason the branches merge cleanly is that they were split by boundary
 * rather than by phase.
 */
 {
 name: 'front-and-back',
 members: ['planner', 'frontend-engineer', 'backend-engineer', 'qa'],
 orchestrator: 'planner',
 reviewers: { qa: ['frontend-engineer', 'backend-engineer'] },
 },

 /**
 * The spec first, because the failure this arrangement exists for is a swarm that
 * implemented four readings of one ambiguous sentence. `product-manager` is read-only,
 * so it can only produce the spec — it cannot start writing the thing it scoped.
 */
 {
 name: 'spec-then-build',
 members: ['planner', 'product-manager', 'swe', 'qa'],
 orchestrator: 'planner',
 reviewers: { qa: ['swe'] },
 },

 /**
 * **the corporation, shipped as an arrangement.** A root planner, a sub-planner
 * that owns one area and decomposes it itself, and workers under the pair.
 *
 * Worth knowing before the canvas surprises anyone: both planners draw on the same tier,
 * and so do the workers. That is not the canvas being wrong. Depth there is measured by
 * what the runtime would allow from the root, and attenuation intersects a child
 * planner's envelope with its parent's — so a root wide enough for `area-planner` to
 * reach `swe` is necessarily wide enough to start `swe` itself. Reporting-lines and
 * reachability are different questions, and this canvas answers the second one.
 */
 {
 name: 'two-areas',
 members: ['planner', 'area-planner', 'swe', 'qa'],
 orchestrator: 'planner',
 reviewers: { qa: ['swe'] },
 fleet: { swe: 2 },
 },
]
