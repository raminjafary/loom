import {
  asAgentPersonaId,
  asAgentRunId,
  asPersonaVariantId,
  asPersonaVariantSetId,
  asReplayCampaignArmId,
  asReplayCampaignId,
  asReplayItemId,
  asReplaySetId,
  asRepositoryId,
  asVariantScreenId,
  asWorkspaceId,
  type DecidedRunRecord,
  type CampaignStatus,
  type PersonaRevisionId,
  type ReplayCampaignArmRecord,
  type ReplayCampaignRecord,
  type ReplayCampaignRunRecord,
  type ReplayItemRecord,
  type ReplayOutcome,
  type ReplaySetRecord,
  type RefusedCandidateRecord,
  type ScreenDecision,
  type ScreenRunOutcome,
  type VariantScreenRecord,
  type VariantScreenRunRecord,
} from '@loom/domain'
import type { CampaignRepositoryPort, ScreenRepositoryPort } from '@loom/application'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { Database } from './client.js'
import {
  agentPersona,
  agentRun,
  personaVariant,
  personaVariantSet,
  promptTrialUse,
  replayCampaign,
  replayCampaignArm,
  replayCampaignRun,
  replayItem,
  replaySet,
  runVerification,
  variantScreen,
  variantScreenRun,
  variantUse,
} from './schema.js'

/**
 * The held-out screen's storage.
 *
 * In its own file rather than appended to `agent-repositories.ts` because its rows outlive
 * the search they were written for: a rejected candidate and the reason it was rejected are
 * the buffer the piece 3 hands to a proposer, and that is a different lifetime from "which
 * arm is this run on".
 */

const toReplaySet = (row: {
  id: string
  workspaceId: string
  personaId: string
  version: number
  considered: number
  eligible: number
  detail: string
  createdAt: Date
}): ReplaySetRecord => ({
  id: asReplaySetId(row.id),
  workspaceId: asWorkspaceId(row.workspaceId),
  personaId: asAgentPersonaId(row.personaId),
  version: row.version,
  considered: row.considered,
  eligible: row.eligible,
  detail: row.detail,
  createdAt: row.createdAt,
})

const toReplayItem = (row: {
  id: string
  replaySetId: string
  position: number
  sourceRunId: string | null
  repositoryId: string
  commitSha: string
  task: string
  observedOutcome: string
}): ReplayItemRecord => ({
  id: asReplayItemId(row.id),
  replaySetId: asReplaySetId(row.replaySetId),
  position: row.position,
  sourceRunId: row.sourceRunId === null ? null : asAgentRunId(row.sourceRunId),
  repositoryId: asRepositoryId(row.repositoryId),
  commitSha: row.commitSha,
  task: row.task,
  observedOutcome: row.observedOutcome as ReplayOutcome,
})

const toScreen = (row: {
  id: string
  workspaceId: string
  setId: string
  replaySetId: string
  variantId: string | null
  decision: string | null
  reason: string | null
  decidedAt: Date | null
  createdAt: Date
}): VariantScreenRecord => ({
  id: asVariantScreenId(row.id),
  workspaceId: asWorkspaceId(row.workspaceId),
  setId: asPersonaVariantSetId(row.setId),
  replaySetId: asReplaySetId(row.replaySetId),
  variantId: row.variantId === null ? null : asPersonaVariantId(row.variantId),
  decision: row.decision === null ? null : (row.decision as ScreenDecision),
  reason: row.reason,
  decidedAt: row.decidedAt,
  createdAt: row.createdAt,
})

const toScreenRun = (row: {
  id: string
  screenId: string
  replayItemId: string
  claimedAt: Date | null
  agentRunId: string | null
  outcome: string
  reason: string | null
  model: string | null
  finishedAt: Date | null
}): VariantScreenRunRecord => ({
  id: row.id,
  screenId: asVariantScreenId(row.screenId),
  replayItemId: asReplayItemId(row.replayItemId),
  claimedAt: row.claimedAt,
  agentRunId: row.agentRunId === null ? null : asAgentRunId(row.agentRunId),
  outcome: row.outcome as ScreenRunOutcome,
  reason: row.reason,
  model: row.model,
  finishedAt: row.finishedAt,
})

const toCampaign = (row: {
  id: string
  workspaceId: string
  personaId: string
  replaySetId: string
  label: string
  status: string
  capUsd: number | null
  openedByUserId: string | null
  haltReason: string | null
  createdAt: Date
  finishedAt: Date | null
}): ReplayCampaignRecord => ({
  id: asReplayCampaignId(row.id),
  workspaceId: asWorkspaceId(row.workspaceId),
  personaId: asAgentPersonaId(row.personaId),
  replaySetId: asReplaySetId(row.replaySetId),
  label: row.label,
  status: row.status as CampaignStatus,
  capUsd: row.capUsd,
  openedByUserId: row.openedByUserId,
  haltReason: row.haltReason,
  createdAt: row.createdAt,
  finishedAt: row.finishedAt,
})

const toCampaignArm = (row: {
  id: string
  campaignId: string
  position: number
  revisionId: string | null
  markdownSource: string
  label: string
  model: string | null
}): ReplayCampaignArmRecord => ({
  id: asReplayCampaignArmId(row.id),
  campaignId: asReplayCampaignId(row.campaignId),
  position: row.position,
  revisionId: row.revisionId === null ? null : (row.revisionId as PersonaRevisionId),
  markdownSource: row.markdownSource,
  label: row.label,
  model: row.model,
})

const toCampaignRun = (row: {
  id: string
  armId: string
  replayItemId: string
  claimedAt: Date | null
  agentRunId: string | null
  outcome: string
  reason: string | null
  model: string | null
  costUsd: number | null
  finishedAt: Date | null
}): ReplayCampaignRunRecord => ({
  id: row.id,
  armId: asReplayCampaignArmId(row.armId),
  replayItemId: asReplayItemId(row.replayItemId),
  claimedAt: row.claimedAt,
  agentRunId: row.agentRunId === null ? null : asAgentRunId(row.agentRunId),
  outcome: row.outcome as ScreenRunOutcome,
  reason: row.reason,
  model: row.model,
  costUsd: row.costUsd,
  finishedAt: row.finishedAt,
})

/**
 * A run whose branch a human decided about, or that failed, or whose branch failed its
 * repository's definition of done — `agent-repositories.ts`'s `decidedRun`, restated here
 * against the same three columns.
 *
 * Restated rather than imported because that one is a module-private `sql` fragment bound
 * to its own join shape. If a fourth definition of "decided" ever appears, this is the
 * second and they must be reconciled rather than allowed to drift — which is exactly what
 * the roadmap says about two definitions of done.
 */
const decided = sql`(${agentRun.branchDisposition} is not null or ${agentRun.status} = 'failed' or ${runVerification.status} = 'failed')`

export const screenRepository = (db: Database): ScreenRepositoryPort => ({
  async listDecidedRunsForPersona(workspaceId, personaName, limit) {
    const rows = await db
      .select({
        runId: agentRun.id,
        repositoryId: agentRun.repositoryId,
        baseCommitSha: agentRun.baseCommitSha,
        task: agentRun.task,
        branchDisposition: agentRun.branchDisposition,
        status: agentRun.status,
        decidedAt: sql<Date>`coalesce(${agentRun.completedAt}, ${agentRun.createdAt})`,
        /**
         * Whether this run was itself an arm. Two left joins rather than a subquery so the
         * whole eligibility question is one round trip — a set is assembled while an agent
         * waits on the tool call that opened the search.
         */
        wasMeasured: sql<boolean>`(${variantUse.id} is not null or ${promptTrialUse.id} is not null)`,
        /**
         * How many candidates this run's task has already gated, across every set version it
         * has been an item of.
         *
         * A scalar subquery rather than a join, because the two left joins above already
         * multiply rows and a third would make this a count of the product. Derived rather
         * than a counter column: the screens are the record, and a counter is a second copy
         * of a fact that can be missed — the reason `agent_run.branch_disposition` is read
         * rather than copied onto an arm.
         *
         * Only *decided* candidate screens count. An open screen has gated nothing yet, and
         * the incumbent's screen is not a gate at all — it is the control the gate compares
         * against, so counting it would retire every set one candidate early.
         */
        gatedCandidates: sql<number>`(
          select count(*)::int
          from ${replayItem} as gated_item
          join ${variantScreen} as gating_screen
            on gating_screen.replay_set_id = gated_item.replay_set_id
           and gating_screen.variant_id is not null
           and gating_screen.decision is not null
          where gated_item.source_run_id = ${agentRun.id}
        )`,
      })
      .from(agentRun)
      .leftJoin(runVerification, eq(runVerification.agentRunId, agentRun.id))
      .leftJoin(variantUse, eq(variantUse.agentRunId, agentRun.id))
      .leftJoin(promptTrialUse, eq(promptTrialUse.agentRunId, agentRun.id))
      .where(
        and(
          eq(agentRun.workspaceId, workspaceId),
          sql`${agentRun.persona} ->> 'name' = ${personaName}`,
          /**
           * A screening run is never material for a later set. Its outcome is a fact about a
           * candidate that may have been rejected, and replaying it would fold the screen's
           * own output back into its input.
           */
          sql`(${agentRun.relation} is null or ${agentRun.relation} <> 'screen')`,
          decided,
        ),
      )
      .orderBy(desc(sql`coalesce(${agentRun.completedAt}, ${agentRun.createdAt})`), asc(agentRun.id))
      .limit(limit)

    return rows.map(
      (row): DecidedRunRecord => ({
        runId: row.runId,
        repositoryId: row.repositoryId,
        baseCommitSha: row.baseCommitSha,
        task: row.task,
        wasMeasured: row.wasMeasured,
        gatedCandidates: row.gatedCandidates,
        /**
         * Context, never the score — see `ReplayOutcome`. Three values, and the one
         * collapse worth naming: a run decided only by a *failing definition of done*, with
         * no human involved, lands in `discarded`. For a reader deciding what kind of tasks
         * a set is made of, "the branch was not taken" is the fact, and `failed` is
         * reserved for a run that did not finish.
         */
        outcome:
          row.status === 'failed'
            ? 'failed'
            : row.branchDisposition === 'merged' || row.branchDisposition === 'pushed'
              ? 'merged'
              : 'discarded',
        decidedAt: new Date(row.decidedAt),
      }),
    )
  },

  async openReplaySet(input) {
    return db.transaction(async (tx) => {
      const [previous] = await tx
        .select({ version: replaySet.version })
        .from(replaySet)
        .where(eq(replaySet.personaId, input.personaId))
        .orderBy(desc(replaySet.version))
        .limit(1)

      const [setRow] = await tx
        .insert(replaySet)
        .values({
          workspaceId: input.workspaceId,
          personaId: input.personaId,
          version: (previous?.version ?? 0) + 1,
          considered: input.draft.considered,
          eligible: input.draft.eligible,
          detail: input.detail,
        })
        .returning()
      if (!setRow) throw new Error('replay set insert returned nothing')

      const itemRows =
        input.draft.items.length === 0
          ? []
          : await tx
              .insert(replayItem)
              .values(
                input.draft.items.map((item, index) => ({
                  workspaceId: input.workspaceId,
                  replaySetId: setRow.id,
                  position: index,
                  sourceRunId: item.sourceRunId,
                  repositoryId: item.repositoryId,
                  commitSha: item.commitSha,
                  task: item.task,
                  observedOutcome: item.observedOutcome,
                })),
              )
              .returning()

      return { set: toReplaySet(setRow), items: itemRows.map(toReplayItem) }
    })
  },

  async openScreens(input) {
    await db.transaction(async (tx) => {
      /** The incumbent first — `null` — then each candidate. The control is not optional. */
      const arms: (string | null)[] = [null, ...input.variantIds]
      const screenRows = await tx
        .insert(variantScreen)
        .values(
          arms.map((variantId) => ({
            workspaceId: input.workspaceId,
            setId: input.setId,
            replaySetId: input.replaySetId,
            variantId,
          })),
        )
        .returning({ id: variantScreen.id })

      if (input.itemIds.length === 0) return
      await tx.insert(variantScreenRun).values(
        screenRows.flatMap((screenRow) =>
          input.itemIds.map((itemId) => ({
            workspaceId: input.workspaceId,
            screenId: screenRow.id,
            replayItemId: itemId,
          })),
        ),
      )
    })
  },

  async screensForSet(workspaceId, setId) {
    const screenRows = await db
      .select()
      .from(variantScreen)
      .where(and(eq(variantScreen.workspaceId, workspaceId), eq(variantScreen.setId, setId)))
      .orderBy(asc(variantScreen.createdAt), asc(variantScreen.id))
    if (screenRows.length === 0) return []

    const runRows = await db
      .select()
      .from(variantScreenRun)
      .where(
        inArray(
          variantScreenRun.screenId,
          screenRows.map((row) => row.id),
        ),
      )
      .orderBy(asc(variantScreenRun.createdAt), asc(variantScreenRun.id))

    return screenRows.map((screenRow) => ({
      screen: toScreen(screenRow),
      runs: runRows.filter((row) => row.screenId === screenRow.id).map(toScreenRun),
    }))
  },

  async listSetsWithOpenScreens() {
    const rows = await db
      .selectDistinct({ workspaceId: variantScreen.workspaceId, setId: variantScreen.setId })
      .from(variantScreen)
      .innerJoin(personaVariantSet, eq(personaVariantSet.id, variantScreen.setId))
      .where(
        and(
          isNull(variantScreen.decision),
          // A settled search has nothing left to gate; its undecided screens are history.
          eq(personaVariantSet.status, 'open'),
        ),
      )
    return rows.map((row) => ({
      workspaceId: asWorkspaceId(row.workspaceId),
      setId: asPersonaVariantSetId(row.setId),
    }))
  },

  async findReplaySet(workspaceId, replaySetId) {
    const [row] = await db
      .select()
      .from(replaySet)
      .where(and(eq(replaySet.workspaceId, workspaceId), eq(replaySet.id, replaySetId)))
      .limit(1)
    return row ? toReplaySet(row) : null
  },

  async listReplayItems(workspaceId, replaySetId) {
    const rows = await db
      .select()
      .from(replayItem)
      .where(and(eq(replayItem.workspaceId, workspaceId), eq(replayItem.replaySetId, replaySetId)))
      .orderBy(asc(replayItem.position))
    return rows.map(toReplayItem)
  },

  async claimScreenRun(workspaceId, screenRunId) {
    /**
     * The claim is the `claimed_at is null` predicate, not a read-then-write. Two sweeps
     * ticking at once is the ordinary case, and a double claim would start two runs against
     * one item — the second of which would then overwrite the first's outcome.
     */
    const [row] = await db
      .update(variantScreenRun)
      .set({ claimedAt: new Date() })
      .where(
        and(
          eq(variantScreenRun.workspaceId, workspaceId),
          eq(variantScreenRun.id, screenRunId),
          isNull(variantScreenRun.claimedAt),
        ),
      )
      .returning({ id: variantScreenRun.id })
    return row !== undefined
  },

  async attachScreenRun(workspaceId, screenRunId, agentRunId) {
    await db
      .update(variantScreenRun)
      .set({ agentRunId })
      .where(
        and(eq(variantScreenRun.workspaceId, workspaceId), eq(variantScreenRun.id, screenRunId)),
      )
  },

  async releaseScreenRun(workspaceId, screenRunId) {
    await db
      .update(variantScreenRun)
      .set({ claimedAt: null })
      .where(
        and(
          eq(variantScreenRun.workspaceId, workspaceId),
          eq(variantScreenRun.id, screenRunId),
          isNull(variantScreenRun.agentRunId),
        ),
      )
  },

  async recordScreenRunOutcome(workspaceId, screenRunId, input) {
    await db
      .update(variantScreenRun)
      .set({
        outcome: input.outcome,
        reason: input.reason,
        /**
         * Written beside the outcome in one statement, because a score and the model that
         * produced it are one fact — two statements could leave a row that says a prompt
         * failed and nothing about what ran it.
         */
        model: input.model,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(variantScreenRun.workspaceId, workspaceId),
          eq(variantScreenRun.id, screenRunId),
          // Only a pending row: a recorded outcome is what the gate has already read.
          eq(variantScreenRun.outcome, 'pending'),
        ),
      )
  },

  async decideScreen(workspaceId, screenId, input) {
    await db
      .update(variantScreen)
      .set({ decision: input.decision, reason: input.reason, decidedAt: new Date() })
      .where(
        and(
          eq(variantScreen.workspaceId, workspaceId),
          eq(variantScreen.id, screenId),
          isNull(variantScreen.decision),
        ),
      )
  },

  async listRefusedCandidates(workspaceId, personaId, limit) {
    /**
     * By persona id here, unlike `listDecidedRunsForPersona`'s name: a candidate is a row
     * that belongs to a persona row, not a snapshot carried by a run, so the id is the
     * thing that identifies it and a rename does not orphan its own history.
     */
    const where = and(
      eq(variantScreen.workspaceId, workspaceId),
      eq(personaVariant.personaId, personaId),
      eq(variantScreen.decision, 'rejected'),
    )
    const [rows, [counted], itemRows] = await Promise.all([
      db
        .select({
          variantId: personaVariant.id,
          markdownSource: personaVariant.markdownSource,
          rationale: personaVariant.rationale,
          reason: variantScreen.reason,
          decidedAt: variantScreen.decidedAt,
          createdAt: variantScreen.createdAt,
          /**
           * The models the screening runs behind that sentence ran on. Aggregated here
           * rather than joined out and reduced in the use case, because the interesting
           * answer is "one" and the query can say that in one round trip.
           */
          models: sql<
            string[] | null
          >`array_remove(array_agg(distinct ${variantScreenRun.model}), null)`,
        })
        .from(variantScreen)
        .innerJoin(personaVariant, eq(personaVariant.id, variantScreen.variantId))
        .leftJoin(variantScreenRun, eq(variantScreenRun.screenId, variantScreen.id))
        .where(where)
        .groupBy(
          personaVariant.id,
          personaVariant.markdownSource,
          personaVariant.rationale,
          variantScreen.reason,
          variantScreen.decidedAt,
          variantScreen.createdAt,
        )
        .orderBy(desc(variantScreen.decidedAt))
        .limit(limit),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(variantScreen)
        .innerJoin(personaVariant, eq(personaVariant.id, variantScreen.variantId))
        .where(where),
      /**
       * What each refused candidate did item by item — the difference between "passed 2 of 6"
       * and something a rewrite can act on.
       *
       * A second query rather than more aggregation on the first: the rows are per item, the
       * first query is per candidate, and `array_agg` over four columns to rebuild an ordered
       * list in TypeScript anyway is worse than a join the database is good at. Unbounded by
       * design — the item count is bounded by `MAX_REPLAY_ITEMS`, so this is at most eight
       * rows per refusal shown.
       */
      db
        .select({
          variantId: personaVariant.id,
          position: replayItem.position,
          task: replayItem.task,
          outcome: variantScreenRun.outcome,
          /**
           * The check the definition of done failed this item on, from the screening run's
           * own verification. Null when nothing ran, when nothing failed, or when the
           * repository names no checks — all of which read the same way in the brief: no
           * check is named.
           */
          failingCheck: sql<
            string | null
          >`jsonb_path_query_first(${runVerification.checks}, '$[*] ? (@.status == "failed")') ->> 'name'`,
        })
        .from(variantScreen)
        .innerJoin(personaVariant, eq(personaVariant.id, variantScreen.variantId))
        .innerJoin(variantScreenRun, eq(variantScreenRun.screenId, variantScreen.id))
        .innerJoin(replayItem, eq(replayItem.id, variantScreenRun.replayItemId))
        .leftJoin(runVerification, eq(runVerification.agentRunId, variantScreenRun.agentRunId))
        .where(where)
        .orderBy(asc(replayItem.position)),
    ])

    const itemsByVariant = new Map<string, RefusedCandidateRecord['items'][number][]>()
    for (const row of itemRows) {
      const outcome =
        row.outcome === 'passed' || row.outcome === 'failed' ? row.outcome : 'not-scored'
      itemsByVariant.set(row.variantId, [
        ...(itemsByVariant.get(row.variantId) ?? []),
        {
          // From one for a reader; the stored `position` is zero-based.
          position: row.position + 1,
          outcome,
          task: row.task,
          failingCheck: row.failingCheck,
        },
      ])
    }

    return {
      candidates: rows.map((row) => ({
        variantId: asPersonaVariantId(row.variantId),
        markdownSource: row.markdownSource,
        rationale: row.rationale,
        /**
         * A rejected screen always has a reason — `decideScreen` writes both in one
         * statement — but the column is nullable because an undecided row has neither, so
         * the fallback is here rather than a non-null assertion.
         */
        reason: row.reason ?? '',
        models: [...(row.models ?? [])].sort(),
        items: itemsByVariant.get(row.variantId) ?? [],
        refusedAt: row.decidedAt ?? row.createdAt,
      })),
      total: counted?.total ?? 0,
    }
  },

  async listSiblingRefusals(workspaceId, excludePersonaId, limit) {
    /**
     * Every refusal in the workspace except this persona's own.
     *
     * Deliberately not the per-item detail `listRefusedCandidates` gathers. A sibling refusal
     * is evidence about the *shape* of a prompt that failed here, and the items it failed
     * belong to another persona's held-out set — positions a proposer cannot compare across
     * and tasks that are not its own work. Quoting them would spend the brief's length making
     * somebody else's set look like this persona's.
     */
    const where = and(
      eq(variantScreen.workspaceId, workspaceId),
      eq(variantScreen.decision, 'rejected'),
      ne(personaVariant.personaId, excludePersonaId),
    )
    const [rows, [counted]] = await Promise.all([
      db
        .select({
          variantId: personaVariant.id,
          personaName: agentPersona.name,
          markdownSource: personaVariant.markdownSource,
          rationale: personaVariant.rationale,
          reason: variantScreen.reason,
          decidedAt: variantScreen.decidedAt,
          createdAt: variantScreen.createdAt,
          models: sql<
            string[] | null
          >`array_remove(array_agg(distinct ${variantScreenRun.model}), null)`,
        })
        .from(variantScreen)
        .innerJoin(personaVariant, eq(personaVariant.id, variantScreen.variantId))
        .innerJoin(agentPersona, eq(agentPersona.id, personaVariant.personaId))
        .leftJoin(variantScreenRun, eq(variantScreenRun.screenId, variantScreen.id))
        .where(where)
        .groupBy(
          personaVariant.id,
          agentPersona.name,
          personaVariant.markdownSource,
          personaVariant.rationale,
          variantScreen.reason,
          variantScreen.decidedAt,
          variantScreen.createdAt,
        )
        .orderBy(desc(variantScreen.decidedAt))
        .limit(limit),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(variantScreen)
        .innerJoin(personaVariant, eq(personaVariant.id, variantScreen.variantId))
        .where(where),
    ])

    return {
      candidates: rows.map((row) => ({
        variantId: asPersonaVariantId(row.variantId),
        personaName: row.personaName,
        markdownSource: row.markdownSource,
        rationale: row.rationale,
        reason: row.reason ?? '',
        models: [...(row.models ?? [])].sort(),
        items: [],
        refusedAt: row.decidedAt ?? row.createdAt,
      })),
      total: counted?.total ?? 0,
    }
  },

  async admittedVariantIds(workspaceId, setId) {
    const rows = await db
      .select({ variantId: variantScreen.variantId, decision: variantScreen.decision })
      .from(variantScreen)
      .where(and(eq(variantScreen.workspaceId, workspaceId), eq(variantScreen.setId, setId)))
    // No screen at all is not "none admitted" — see the port's note.
    if (rows.length === 0) return null
    return rows
      .filter((row) => row.variantId !== null && row.decision === 'admitted')
      .map((row) => asPersonaVariantId(row.variantId as string))
  },
})

/**
 * The campaign's storage.
 *
 * In this file rather than a fourth one because it shares the machinery it was generalized
 * from: the same replay sets, the same claim-then-attach two-step, the same `screenOutcomeFor`
 * scoring. What it does not share is the gate — a campaign decides nothing — which is why the
 * rows live in their own tables and not in `variant_screen`.
 */
export const campaignRepository = (db: Database): CampaignRepositoryPort => ({
  async open(input) {
    return db.transaction(async (tx) => {
      const [campaignRow] = await tx
        .insert(replayCampaign)
        .values({
          workspaceId: input.workspaceId,
          personaId: input.personaId,
          replaySetId: input.replaySetId,
          label: input.label,
          capUsd: input.capUsd,
          openedByUserId: input.openedByUserId,
        })
        .returning()
      if (!campaignRow) throw new Error('replay_campaign insert returned nothing')

      const armRows = await tx
        .insert(replayCampaignArm)
        .values(
          input.arms.map((arm, index) => ({
            workspaceId: input.workspaceId,
            campaignId: campaignRow.id,
            position: index,
            revisionId: arm.revisionId,
            markdownSource: arm.markdownSource,
            label: arm.label,
            model: arm.model,
          })),
        )
        .returning()

      if (input.itemIds.length > 0) {
        await tx.insert(replayCampaignRun).values(
          armRows.flatMap((armRow) =>
            input.itemIds.map((itemId) => ({
              workspaceId: input.workspaceId,
              armId: armRow.id,
              replayItemId: itemId,
            })),
          ),
        )
      }

      return {
        campaign: toCampaign(campaignRow),
        arms: armRows.map(toCampaignArm),
      }
    })
  },

  async findById(workspaceId, campaignId) {
    const [row] = await db
      .select()
      .from(replayCampaign)
      .where(
        and(eq(replayCampaign.workspaceId, workspaceId), eq(replayCampaign.id, campaignId)),
      )
      .limit(1)
    return row ? toCampaign(row) : null
  },

  async listByPersona(workspaceId, personaId, limit) {
    const rows = await db
      .select()
      .from(replayCampaign)
      .where(
        and(eq(replayCampaign.workspaceId, workspaceId), eq(replayCampaign.personaId, personaId)),
      )
      .orderBy(desc(replayCampaign.createdAt))
      .limit(limit)
    return rows.map(toCampaign)
  },

  async listRunning() {
    const rows = await db
      .select({ workspaceId: replayCampaign.workspaceId, id: replayCampaign.id })
      .from(replayCampaign)
      .where(eq(replayCampaign.status, 'running'))
    return rows.map((row) => ({
      workspaceId: asWorkspaceId(row.workspaceId),
      campaignId: asReplayCampaignId(row.id),
    }))
  },

  async armsForCampaign(workspaceId, campaignId) {
    const armRows = await db
      .select()
      .from(replayCampaignArm)
      .where(
        and(
          eq(replayCampaignArm.workspaceId, workspaceId),
          eq(replayCampaignArm.campaignId, campaignId),
        ),
      )
      .orderBy(asc(replayCampaignArm.position))
    if (armRows.length === 0) return []

    const runRows = await db
      .select()
      .from(replayCampaignRun)
      .where(
        inArray(
          replayCampaignRun.armId,
          armRows.map((row) => row.id),
        ),
      )
      .orderBy(asc(replayCampaignRun.createdAt), asc(replayCampaignRun.id))

    return armRows.map((armRow) => ({
      arm: toCampaignArm(armRow),
      runs: runRows.filter((row) => row.armId === armRow.id).map(toCampaignRun),
    }))
  },

  async claimCampaignRun(workspaceId, campaignRunId) {
    /** The screen's claim, for its reason: two sweeps ticking at once is the ordinary case. */
    const [row] = await db
      .update(replayCampaignRun)
      .set({ claimedAt: new Date() })
      .where(
        and(
          eq(replayCampaignRun.workspaceId, workspaceId),
          eq(replayCampaignRun.id, campaignRunId),
          isNull(replayCampaignRun.claimedAt),
        ),
      )
      .returning({ id: replayCampaignRun.id })
    return row !== undefined
  },

  async attachCampaignRun(workspaceId, campaignRunId, agentRunId) {
    await db
      .update(replayCampaignRun)
      .set({ agentRunId })
      .where(
        and(
          eq(replayCampaignRun.workspaceId, workspaceId),
          eq(replayCampaignRun.id, campaignRunId),
        ),
      )
  },

  async releaseCampaignRun(workspaceId, campaignRunId) {
    await db
      .update(replayCampaignRun)
      .set({ claimedAt: null })
      .where(
        and(
          eq(replayCampaignRun.workspaceId, workspaceId),
          eq(replayCampaignRun.id, campaignRunId),
          isNull(replayCampaignRun.agentRunId),
        ),
      )
  },

  async recordCampaignRunOutcome(workspaceId, campaignRunId, input) {
    await db
      .update(replayCampaignRun)
      .set({
        outcome: input.outcome,
        reason: input.reason,
        model: input.model,
        costUsd: input.costUsd,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(replayCampaignRun.workspaceId, workspaceId),
          eq(replayCampaignRun.id, campaignRunId),
          // Only a pending row: a recorded outcome is one a reader has already been shown.
          eq(replayCampaignRun.outcome, 'pending'),
        ),
      )
  },

  async spentOnCampaign(workspaceId, campaignId) {
    /**
     * Summed from the campaign's own rows rather than from the runs' table: a run deleted
     * later must not make a campaign look cheaper than it was, which is the same reason
     * `replay_item` snapshots its commit and its task.
     */
    const [row] = await db
      .select({ spent: sql<number>`coalesce(sum(${replayCampaignRun.costUsd}), 0)::double precision` })
      .from(replayCampaignRun)
      .innerJoin(replayCampaignArm, eq(replayCampaignArm.id, replayCampaignRun.armId))
      .where(
        and(
          eq(replayCampaignRun.workspaceId, workspaceId),
          eq(replayCampaignArm.campaignId, campaignId),
        ),
      )
    return row?.spent ?? 0
  },

  async close(workspaceId, campaignId, input) {
    const [row] = await db
      .update(replayCampaign)
      .set({ status: input.status, haltReason: input.reason, finishedAt: new Date() })
      .where(
        and(
          eq(replayCampaign.workspaceId, workspaceId),
          eq(replayCampaign.id, campaignId),
          // First close wins, so two sweeps cannot write two endings.
          eq(replayCampaign.status, 'running'),
        ),
      )
      .returning()
    return row ? toCampaign(row) : null
  },
})
