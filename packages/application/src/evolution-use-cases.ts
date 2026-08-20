import {
  NotFoundError,
  buildLineage,
  type AgentPersonaId,
  type EvolutionArm,
  type PersonaLineage,
  type SearchEntry,
  type WorkspaceId,
} from '@loom/domain'
import type {
  PersonaRepositoryPort,
  PersonaVariantRepositoryPort,
  ScreenRepositoryPort,
} from './agent-ports.js'

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
