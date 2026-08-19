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
 *   done; "planner + swe + qa" is a list they would have to interpret. The names are the
 *   documentation of what a swarm is *for*.
 * - **A root is always chosen.** the depth is only answerable from somewhere, and a
 *   team with no root leaves the canvas picking by reach and saying so — true, and a worse
 *   first impression than a chain that reads.
 * - **`reviews` is set wherever it makes sense**, because the reviewing relation is the
 *   one worker-to-worker collaboration the runtime executes, and a team that does not use
 *   it teaches an operator that work is only ever handed on, never checked.
 * - **Every team includes the `reconciler`**, and it is not a member like the others. The
 *   merge queue starts it — `PLATFORM_STARTED_PERSONAS` keeps it off every delegation roster,
 *   so no planner can assign it work and no plan can name it. It is on the roster because it
 *   is a real participant in what happens to *this team's* branches, and a canvas that drew
 *   the team without it would be drawing a team whose conflicts are resolved by nobody. The
 *   composer gives it its own role rather than calling it unreachable, which it would
 *   otherwise be on every single team.
 * - **No repository and no layout.** The repository is the operator's choice and
 *   the canvas arranges an unplaced team by tier on first open, which is exactly right for
 *   one nobody has arranged. Seeding coordinates would be the platform pretending to a
 *   human intent the roadmap says positions record.
 *
 * **Members are named, not id'd**, and a member whose persona is missing is dropped rather
 * than failing the team: an operator who deleted `qa` should still get the rest.
 */

export interface BuiltinTeam {
  readonly name: string
  /**
   * When to reach for this team, in one line.
   *
   * The name says what the team does; this says when it is the right one, which is the
   * question an operator actually has when the composer lists six. Required rather than
   * optional on a *shipped* team: a preset nobody can tell apart from the next one is a
   * preset nobody picks, and that is the whole failure this field exists for.
   */
  readonly description: string
  /** Persona names, in the order they are worth reading. */
  readonly members: readonly string[]
  /** Which member the work starts from — the root orchestrator. */
  readonly orchestrator: string
  /** Who reviews whom, keyed by *reviewer* name, as the relation is drawn. */
  readonly reviewers?: Readonly<Record<string, readonly string[]>>
  /** How many of each member this team is sized to run at once — the fleet. */
  readonly fleet?: Readonly<Record<string, number>>
  /**
   * Whether this team is meant to work across repositories.
   *
   * **A flag rather than a list of names, and that is the only honest shape for a preset.**
   * Which repositories a workspace has bound is unknowable at build time — a shipped team
   * naming `payments-api` would name nothing in every workspace but one. So the preset ships
   * the *arrangement*, and the seeder fills in whatever is actually bound; a workspace with
   * one repository gets a team that is simply a normal team, which is the truthful outcome
   * rather than a broken one.
   */
  readonly crossRepository?: boolean
  /**
   * Who reports to whom, keyed by the **worker** — the opposite key from
   * `reviewers`, because a worker reports to at most one planner.
   *
   * Only `two-areas` ships one, and that is the point of it: a chain of command is the
   * thing a two-planner team exists to demonstrate, and until the platform held the fact
   * there was nothing to demonstrate it with.
   */
  readonly reportsTo?: Readonly<Record<string, string>>
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
    description: 'One scoped change, fanned out and checked. Reach for this by default.',
    members: ['planner', 'swe', 'qa', 'reconciler'],
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
    description: 'A change that spans UI and API, split by boundary so the branches merge.',
    members: ['planner', 'frontend-engineer', 'backend-engineer', 'qa', 'reconciler'],
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
    description: 'A goal too vague to hand out yet — scoped into a spec first, then built.',
    members: ['planner', 'product-manager', 'swe', 'qa', 'reconciler'],
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
   * reach `swe` is necessarily wide enough to start `swe` itself. Reporting lines and
   * reachability are different questions, and the *tiers* answer the second one.
   *
   * **[AMENDED — the first question is now answerable, and this team answers it.]** The
   * platform holds `reportsTo`, so this ships one: `swe` reports to `area-planner`. That
   * makes the preset a real corporation rather than a flat team with an extra planner in
   * it — the root's roster is `area-planner` and `qa`, and `swe` is the sub-planner's to
   * assign. It is also the only place the feature is discoverable without an operator
   * drawing it themselves, which is the difference between a mechanism and a demo.
   *
   * `qa` is deliberately left unassigned: reviewing is a team-wide expectation rather than
   * one planner's staff, and an unassigned member stays on every planner's roster.
   */
  {
    name: 'two-areas',
    description:
      'A goal with two areas — a root planner, a sub-planner owning one of them, and staff.',
    members: ['planner', 'area-planner', 'swe', 'qa', 'reconciler'],
    orchestrator: 'planner',
    reviewers: { qa: ['swe'] },
    fleet: { swe: 2 },
    reportsTo: { swe: 'area-planner' },
  },

  /**
   * **the cross-repository fleet, shipped as an arrangement.** One goal, more
   * than one repository, split by repository before anything else.
   *
   * Why this is a different team rather than a flag on `two-areas`: the split is not a
   * decomposition choice, it is a fact about the work. Two subtasks in different
   * repositories *cannot* conflict and one subtask cannot span two, so a planner told it
   * works across repositories has a stronger and simpler rule to plan by than any area
   * boundary — which is The own argument for parallel agents, arriving from the cheapest
   * possible direction.
   *
   * What makes it affordable rather than merely appealing: the merge queue is already
   * serialized *per repository*, so N repositories is N queues and no new concurrency story.
   * The human gate stays exactly where item 4 put it — one merge per repository.
   *
   * `crossRepository` rather than a list of names: see the field's own comment. A workspace
   * with one repository bound gets an ordinary team, which is the truthful outcome.
   */
  {
    name: 'across-repositories',
    description: 'One goal spanning several repositories — split by repository first.',
    members: ['planner', 'swe', 'qa', 'reconciler'],
    orchestrator: 'planner',
    reviewers: { qa: ['swe'] },
    fleet: { swe: 2 },
    crossRepository: true,
  },
]
