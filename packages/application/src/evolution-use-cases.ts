import {
  NotFoundError,
  buildLineage,
  evolutionTriggerVerdict,
  maySelfModify,
  parsePersonaMarkdown,
  systemActor,
  type Actor,
  type AgentPersonaId,
  type AgentRun,
  type BriefSource,
  type EvolutionArm,
  type PersonaLineage,
  type RepositoryId,
  type SearchEntry,
  type ThreadId,
  type TriggerThresholds,
  type WorkspaceId,
} from '@loom/domain'
import type { AuditPort } from './ports.js'
import type {
  AgentRunRepositoryPort,
  PersonaRepositoryPort,
  PersonaVariantRepositoryPort,
  ScreenRepositoryPort,
} from './agent-ports.js'

/**
 * What the trigger needs, and nothing else.
 *
 * `startProposer` is injected rather than imported, and that is the seam that keeps this module
 * out of a cycle: `startVariantProposer` lives beside the run lifecycle it uses, which already
 * imports this file's lineage walk.
 */
export interface EvolutionTriggerDeps {
  readonly agentRuns: AgentRunRepositoryPort
  readonly personaVariants: PersonaVariantRepositoryPort
  readonly audit: AuditPort
  readonly startProposer: (input: {
    workspaceId: WorkspaceId
    actor: Actor
    threadId: ThreadId
    repositoryId: RepositoryId
    personaId: AgentPersonaId
    source?: BriefSource
  }) => Promise<{ ok: true; run: AgentRun } | { ok: false; reason: string }>
}

/**
 * The lineage walk, assembled — revision → trial → verdict, and search → screen → arms →
 * promotion, with the refusals attached to the searches that rejected them.
 *
 * Every row this reads has existed since its own feature shipped and nothing has ever joined
 * them. That is the whole of this file: it decides nothing, writes nothing, and re-derives no
 * score. What it produces is what a human gets asked for after a month of an agent editing
 * itself — "how has this changed, and what actually measured any of it" — which until now
 * could only be answered by reading four panels and holding the dates in your head.
 *
 * **Read on demand, never polled**, and the query count is why it is worth saying: a walk is
 * one read of the persona, one of its revisions, one tally per revision that was *actually*
 * on trial, one of its searches, and two per search. On a persona with two searches that is
 * eight round trips, which is fine for a panel somebody opened and would be indefensible on
 * the board's timer.
 */

export interface EvolutionDeps {
  readonly personas: PersonaRepositoryPort
  readonly personaVariants: PersonaVariantRepositoryPort
  readonly screens: ScreenRepositoryPort
}

/**
 * How far back one walk goes.
 *
 * Twenty revisions and ten searches. A bound rather than everything, for the reason the
 * proposer's brief has one: the history grows for the life of the persona, and a page that
 * grows with it is a page whose first screen is the same either way. Newest first, so what a
 * bound drops is the part a reader scrolls to least.
 */
export const MAX_LINEAGE_REVISIONS = 20
export const MAX_LINEAGE_SEARCHES = 10

export const personaEvolution = async (
  deps: EvolutionDeps,
  input: { workspaceId: WorkspaceId; personaId: AgentPersonaId },
): Promise<PersonaLineage> => {
  const persona = await deps.personas.findById(input.workspaceId, input.personaId)
  if (!persona) throw new NotFoundError('AgentPersona')

  const [revisionRows, sets, onTrial] = await Promise.all([
    deps.personas.listRevisions(input.workspaceId, input.personaId),
    deps.personaVariants.listSetsForPersona(
      input.workspaceId,
      input.personaId,
      MAX_LINEAGE_SEARCHES,
    ),
    deps.personas.findRevisionOnTrial(input.workspaceId, input.personaId),
  ])

  const bounded = revisionRows.slice(0, MAX_LINEAGE_REVISIONS)

  /**
   * A tally is fetched only for a revision something actually put on trial — one a human has
   * settled, or the one running now. Every other revision is a human's edit or a tier-2
   * change, and a query per revision would be twenty round trips to be told nineteen times
   * that nothing measured it.
   */
  const trialled = bounded.filter(
    (revision) => revision.trialDecidedAt !== null || revision.id === onTrial?.id,
  )
  const tallies = new Map<string, EvolutionArm[]>()
  for (const revision of trialled) {
    const arms = await deps.personas.tallyTrialOutcomes(input.workspaceId, revision.id)
    tallies.set(
      revision.id as string,
      arms.map((arm) => ({
        label: arm.arm === 'revised' ? 'the revised prompt' : 'the prompt it replaced',
        decided: arm.decided,
        /**
         * "Kept" is merged-or-pushed, which is the fitness's first term and not a second
         * definition of it: a walk that counted anything else here would report a different
         * number from the panel that settled the trial.
         */
        kept: arm.merged,
      })),
    )
  }

  const searches: Omit<SearchEntry, 'kind'>[] = []
  for (const { set, variants } of sets) {
    const [screens, arms] = await Promise.all([
      deps.screens.screensForSet(input.workspaceId, set.id),
      deps.personaVariants.tallyVariantOutcomes(input.workspaceId, set.id),
    ])
    const screenFor = (variantId: string) =>
      screens.find((entry) => entry.screen.variantId === variantId)?.screen ?? null
    const armFor = (variantId: string) => arms.find((arm) => arm.variantId === variantId) ?? null

    searches.push({
      at: set.createdAt,
      setId: set.id,
      status: set.status,
      variedComponent: set.variedComponent,
      proposedByRunId: set.proposedByRunId,
      candidates: variants.map((variant) => {
        const screen = screenFor(variant.id as string)
        const arm = armFor(variant.id as string)
        /**
         * The four outcomes are ordered by what a reader needs first, and `refused` leads
         * because it is the only one that means *no live run was ever spent*. A candidate
         * refused an arm and a candidate that lost one look identical in a list of names.
         */
        const outcome =
          screen?.decision === 'rejected'
            ? ('refused' as const)
            : set.promotedVariantId === variant.id
              ? ('promoted' as const)
              : set.status === 'settled'
                ? ('not-kept' as const)
                : ('measured' as const)
        return {
          variantId: variant.id as string,
          rationale: variant.rationale,
          outcome,
          reason: screen?.decision === 'rejected' ? screen.reason : null,
          decided: arm?.decided ?? 0,
          kept: arm?.merged ?? 0,
        }
      }),
      verifierPickedVariantId:
        set.verifierDecidedAt === null ? null : (set.verifierPickedVariantId as string | null),
      settledAt: set.settledAt,
    })
  }

  return buildLineage({
    personaId: persona.id,
    personaName: persona.name,
    liveMarkdown: persona.markdownSource,
    revisions: bounded.map((revision) => ({
      id: revision.id,
      markdownSource: revision.markdownSource,
      replacedByKind: revision.replacedByKind,
      replacedByRunId: revision.replacedByRunId,
      rationale: revision.rationale,
      createdAt: revision.createdAt,
      trialDecidedAt: revision.trialDecidedAt,
      arms: tallies.get(revision.id as string) ?? [],
    })),
    searches,
  })
}

/**
 * One tick of the trigger: fire a proposer session for every persona whose own recent history
 * says one is due.
 *
 * **This is the moment the loop closes.** Every other path into a search needs somebody to
 * decide that a persona is worth improving; this decides it from the persona's dispositions.
 * Nothing downstream changes — the candidates are validated by the same rules, the arms are
 * dealt by the same dealer, the screen gates the same way, and promotion stays a human's.
 *
 * Swept rather than event-driven, deliberately. The signal is a *count* over a window, so the
 * moment it crosses is not the moment anything happens: the last discarded branch of three
 * arrives as a human clicks Discard, and a use case that fired from there would put an agent
 * session inside the request that dispositioned a branch.
 *
 * **Idempotent by the state it reads, not by a lock** — and the state is two things rather than
 * one, which was learned the hard way. An open measurement is the obvious guard, and it is not
 * enough: a proposer *session* is a run, and the search it opens does not exist until the session
 * submits candidates, so between firing and submission nothing looked open and a sweep every
 * thirty seconds started a session per tick. So a persona with a **running proposer session** is
 * skipped too. There is still no "already triggered" flag, because both of these are states the
 * platform already keeps and a third one could disagree with them.
 *
 * **Best-effort per persona.** One candidate whose brief cannot be assembled must not stop the
 * rest of the sweep, so a refusal is counted and the loop continues. A refusal here is the
 * ordinary case rather than an error: most ticks find nothing due.
 */
export const advanceEvolutionTriggers = async (
  deps: EvolutionTriggerDeps,
  options: {
    /**
     * Off unless an operator turns it on.
     *
     * The trigger spends model budget with nobody watching, which is a different thing from
     * every other sweep in this platform — the reapers and the queues move work a human already
     * asked for. So it is opt-in, and the flag is the operator's consent rather than a feature
     * gate. The rest of the loop works without it; what it loses is autonomy.
     */
    enabled: boolean
    /**
     * How many sessions one tick may start. One, by default.
     *
     * A tick that fired for every due persona at once would turn a quiet afternoon into a
     * workspace's whole concurrency limit spent on proposals, and nothing a person is waiting
     * for should queue behind an experiment.
     */
    maxStartsPerTick: number
    /** How many personas to consider per tick. Bounds the read, not the starts. */
    maxCandidates: number
    thresholds?: TriggerThresholds
  },
): Promise<{ considered: number; fired: number; held: number; refused: number }> => {
  if (!options.enabled) return { considered: 0, fired: 0, held: 0, refused: 0 }

  const candidates = await deps.agentRuns.listTriggerCandidates(options.maxCandidates)
  let fired = 0
  let held = 0
  let refused = 0

  for (const candidate of candidates) {
    if (fired >= options.maxStartsPerTick) break

    /**
     * The envelope, read from the candidate's own markdown before anything is counted.
     *
     * A persona nothing may rewrite is not a candidate, and checking it here rather than
     * letting `startVariantProposer` refuse means the counts a held verdict reports are counts
     * for personas the trigger could actually act on. An unparseable document is skipped the
     * way every other reader skips one — a row a human has to fix is not the sweep's business.
     */
    let envelopeAllowsEditing: boolean
    try {
      envelopeAllowsEditing = maySelfModify(parsePersonaMarkdown(candidate.markdownSource).envelope)
    } catch {
      continue
    }
    if (!envelopeAllowsEditing) continue

    /**
     * A session already working on this persona means the trigger has fired and not yet been
     * answered. Checked before the window is read, because the counts do not matter yet.
     */
    if (
      await deps.personaVariants.hasRunningProposerSession(
        candidate.workspaceId,
        candidate.personaId,
      )
    ) {
      continue
    }

    const settledAt = await deps.personaVariants.lastMeasurementSettledAt(
      candidate.workspaceId,
      candidate.personaId,
    )
    const population = await deps.agentRuns.triggerPopulation(
      candidate.workspaceId,
      candidate.personaName,
      settledAt,
    )

    const verdict = evolutionTriggerVerdict({
      personaName: candidate.personaName,
      population,
      ...(options.thresholds ? { thresholds: options.thresholds } : {}),
    })
    if (!verdict.fire) {
      held += 1
      continue
    }

    const started = await deps.startProposer({
      workspaceId: candidate.workspaceId,
      actor: systemActor(),
      threadId: candidate.threadId,
      repositoryId: candidate.repositoryId,
      personaId: candidate.personaId,
      source: verdict.source,
    })

    if (!started.ok) {
      /**
       * Recorded rather than swallowed, and audited rather than logged.
       *
       * A trigger that decided a session was due and then could not start one is the most
       * interesting thing this sweep produces: it means the gate and the use case disagree
       * about the same persona, and the reason names which. Silence here would make the loop's
       * failure indistinguishable from a quiet workspace.
       */
      refused += 1
      await deps.audit.record({
        workspaceId: candidate.workspaceId,
        actor: systemActor(),
        action: 'persona.trigger_refused',
        subjectType: 'agent_persona',
        subjectId: candidate.personaId,
        metadata: {
          personaName: candidate.personaName,
          signal: verdict.signal,
          reason: started.reason,
          triggerReason: verdict.reason,
        },
      })
      continue
    }

    fired += 1
    await deps.audit.record({
      workspaceId: candidate.workspaceId,
      actor: systemActor(),
      action: 'persona.trigger_fired',
      subjectType: 'agent_persona',
      subjectId: candidate.personaId,
      metadata: {
        personaName: candidate.personaName,
        proposerRunId: started.run.id,
        signal: verdict.signal,
        source: verdict.source,
        reason: verdict.reason,
        /**
         * The population, in the row.
         *
         * The thresholds this fires on are a stated prior rather than a measurement — there was
         * no traffic to mine when they were chosen — so the only way they ever get corrected is
         * if every firing carries what it fired on. A month of these rows is the mining that
         * could not be done up front.
         */
        decided: population.decided,
        discarded: population.discarded,
        recurringCheck: population.recurringCheck?.name ?? null,
        recurringCheckFailures: population.recurringCheck?.failures ?? null,
      },
    })
  }

  return { considered: candidates.length, fired, held, refused }
}
