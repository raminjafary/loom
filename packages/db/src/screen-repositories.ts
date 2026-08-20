import {
  asAgentPersonaId,
  asAgentRunId,
  asPersonaVariantId,
  asPersonaVariantSetId,
  asReplayItemId,
  asReplaySetId,
  asRepositoryId,
  asVariantScreenId,
  asWorkspaceId,
  type DecidedRunRecord,
  type ReplayItemRecord,
  type ReplayOutcome,
  type ReplaySetRecord,
  type ScreenDecision,
  type ScreenRunOutcome,
  type VariantScreenRecord,
  type VariantScreenRunRecord,
} from '@loom/domain'
import type { ScreenRepositoryPort } from '@loom/application'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Database } from './client.js'
import {
  agentRun,
  personaVariant,
  personaVariantSet,
  promptTrialUse,
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
  finishedAt: Date | null
}): VariantScreenRunRecord => ({
  id: row.id,
  screenId: asVariantScreenId(row.screenId),
  replayItemId: asReplayItemId(row.replayItemId),
  claimedAt: row.claimedAt,
  agentRunId: row.agentRunId === null ? null : asAgentRunId(row.agentRunId),
  outcome: row.outcome as ScreenRunOutcome,
  reason: row.reason,
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
      .set({ outcome: input.outcome, reason: input.reason, finishedAt: new Date() })
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
    const [rows, [counted]] = await Promise.all([
      db
        .select({
          variantId: personaVariant.id,
          markdownSource: personaVariant.markdownSource,
          rationale: personaVariant.rationale,
          reason: variantScreen.reason,
          decidedAt: variantScreen.decidedAt,
          createdAt: variantScreen.createdAt,
        })
        .from(variantScreen)
        .innerJoin(personaVariant, eq(personaVariant.id, variantScreen.variantId))
        .where(where)
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
        markdownSource: row.markdownSource,
        rationale: row.rationale,
        /**
         * A rejected screen always has a reason — `decideScreen` writes both in one
         * statement — but the column is nullable because an undecided row has neither, so
         * the fallback is here rather than a non-null assertion.
         */
        reason: row.reason ?? '',
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
