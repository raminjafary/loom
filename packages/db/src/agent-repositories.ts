import type {
  AgentRunEventRepositoryPort,
  AgentRunRepositoryPort,
  ApprovalRepositoryPort,
  AtlasEdge,
  AtlasRepositoryPort,
  CapabilityRepositoryPort,
  ColosseumRepositoryPort,
  MergeQueueRepositoryPort,
  NotificationTargetRepositoryPort,
  PersonaGroupRepositoryPort,
  PersonaRepositoryPort,
  PersonaVariantRepositoryPort,
  PlanSubtaskRepositoryPort,
  RepositoryRepositoryPort,
  RunLiveActivity,
  NoteReadRepositoryPort,
  RunnerRepositoryPort,
  RunVerificationRepositoryPort,
  SubjectMapRepositoryPort,
  WorkerNoteRepositoryPort,
  WorkspaceRunControlRepositoryPort,
} from '@loom/application'
import {
  CONCEPT_NODE_KINDS,
  NotFoundError,
  asAgentRunId,
  asRunnerId,
  asThreadId,
  primaryToolArgument,
  asAgentPersonaId,
  asPersonaVariantId,
  asRepositoryId,
  asSubjectMapId,
  asWorkspaceId,
  type ColosseumClaim,
  type ColosseumSession,
  type ExpertiseArmTally,
  type MapNodeKind,
  type WorkspaceId,
  type WorkspaceRunControl,
} from '@loom/domain'
import { createHash, randomBytes } from 'node:crypto'
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Database } from './client.js'
import {
  toAgentPersona,
  toAgentRun,
  toMapEdge,
  toMapNode,
  toSubjectMap,
  toApprovalRequest,
  toCapability,
  toMergeQueueEntry,
  toPersonaCapability,
  toNotificationTarget,
  toPersonaGroup,
  toPersonaRevision,
  toPersonaVariant,
  toPersonaVariantSet,
  toPlanSubtask,
  toRepository,
  toRunner,
  toRunVerification,
  toWorkerNote,
  type AgentPersonaRow,
  type AgentRunRow,
  type ApprovalRequestRow,
  type CapabilityRow,
  type MergeQueueEntryRow,
  type PersonaCapabilityRow,
  type NotificationTargetRow,
  type PersonaGroupRow,
  type PersonaRevisionRow,
  type PersonaVariantRow,
  type PersonaVariantSetRow,
  type PlanSubtaskRow,
  type RepositoryRow,
  type RunnerRow,
  type RunVerificationRow,
  type SubjectMapEdgeRow,
  type SubjectMapNodeRow,
  type SubjectMapRow,
  type WorkerNoteRow,
} from './mappers.js'
import {
  agentPersona,
  agentRun,
  agentRunEvent,
  approvalRequest,
  atlasEdge,
  capability,
  channel,
  mergeQueueEntry,
  runVerification,
  personaCapability,
  notificationTarget,
  personaGroup,
  personaProposerSession,
  personaRevision,
  personaVariant,
  personaVariantSet,
  promptTrialUse,
  variantUse,
  planSubtask,
  repository,
  runner,
  thread,
  colosseumClaim,
  colosseumParticipant,
  colosseumSession,
  colosseumTurn,
  expertiseUse,
  expertiseUseNode,
  masteryCheckpoint,
  noteReadEdge,
  subjectMap,
  subjectMapEdge,
  subjectMapNode,
  workerNote,
  workspace,
} from './schema.js'

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const

/**
 * What both trials count as a run that has an outcome.
 *
 * Written once and used by `tallyTrialOutcomes` and `tallyExpertiseOutcomes`, because the
 * two are one query written twice: two definitions of "decided" would drift, and the arm
 * counts of the prompt trial and the map trial would stop being comparable numbers.
 *
 * Three ways a run is decided, and the third is the one verification harness added:
 *
 * 1. **A disposition.** Somebody merged, pushed or discarded the branch — the judgement.
 * 2. **The run failed.** An outcome, and the arm wears it.
 * 3. **The branch failed its repository's definition of done.** No human required. A
 *    branch that does not build is decided whether or not anyone has looked at it, and
 *    waiting for a reviewer to say so would mean the measurement only ever describes runs
 *    a human had time for. Only `failed` counts: `skipped`, `refused` and `error` are
 *    facts about the operator's setup or the Runner, not about the branch (see
 *    `VerificationStatus`), and a *pass* is not an outcome on its own — passing the checks
 *    is the floor, and only a human merging says the work was wanted.
 */
const decidedRun = sql`(${agentRun.branchDisposition} is not null or ${agentRun.status} = 'failed' or ${runVerification.status} = 'failed')`

/**
 * The check that failed most often on this arm.
 *
 * `jsonb_path_query_first` pulls the first `failed` entry out of the verification's
 * results — the first is the only one, since the harness short-circuits at the first
 * failure — and `mode()` picks the name that came up most. Extracted here rather than
 * counted in TypeScript so the aggregate stays one round trip per trial.
 */
const modalFailingCheck = sql<
  string | null
>`mode() within group (order by jsonb_path_query_first(${runVerification.checks}, '$[*] ? (@.status == "failed")') ->> 'name') filter (where ${runVerification.status} = 'failed')`

const verificationFailedCount = sql<
  number
>`count(*) filter (where ${runVerification.status} = 'failed')::int`

export const runnerRepository = (db: Database): RunnerRepositoryPort => ({
  async findById(workspaceId, id) {
    const [row] = await db
      .select()
      .from(runner)
      .where(and(eq(runner.workspaceId, workspaceId), eq(runner.id, id)))
      .limit(1)
    return row ? toRunner(row as RunnerRow) : null
  },

  async listByWorkspace(workspaceId) {
    const rows = await db.select().from(runner).where(eq(runner.workspaceId, workspaceId))
    return rows.map((row) => toRunner(row as RunnerRow))
  },

  async createPairing(input) {
    const { runnerId, rawToken } = await createRunnerPairing(db, {
      workspaceId: input.workspaceId,
      name: input.name,
    })
    return { runnerId: asRunnerId(runnerId), rawToken }
  },

  async delete(workspaceId, id) {
    // `deleteRunner` refuses while any repository is still bound, so the cascade
    // this could otherwise trigger has already been ruled out by the caller.
    await db.delete(runner).where(and(eq(runner.workspaceId, workspaceId), eq(runner.id, id)))
  },
})

export const repositoryRepository = (db: Database): RepositoryRepositoryPort => ({
  async create(input) {
    const [row] = await db
      .insert(repository)
      .values({
        workspaceId: input.workspaceId,
        runnerId: input.runnerId,
        displayName: input.displayName,
        absolutePath: input.absolutePath,
        defaultBranch: input.defaultBranch,
      })
      .returning()
    if (!row) throw new Error('repository insert returned no row')
    return toRepository(row as RepositoryRow)
  },

  async findById(workspaceId, id) {
    const [row] = await db
      .select()
      .from(repository)
      .where(and(eq(repository.workspaceId, workspaceId), eq(repository.id, id)))
      .limit(1)
    return row ? toRepository(row as RepositoryRow) : null
  },

  async listByWorkspace(workspaceId) {
    const rows = await db.select().from(repository).where(eq(repository.workspaceId, workspaceId))
    return rows.map((row) => toRepository(row as RepositoryRow))
  },

  async delete(workspaceId, id) {
    await db
      .delete(repository)
      .where(and(eq(repository.workspaceId, workspaceId), eq(repository.id, id)))
  },

  async countByRunner(workspaceId, runnerId) {
    const [row] = await db
      .select({ value: count() })
      .from(repository)
      .where(and(eq(repository.workspaceId, workspaceId), eq(repository.runnerId, runnerId)))
    return row?.value ?? 0
  },

  async setVerificationChecks(workspaceId, id, checks) {
    const [row] = await db
      .update(repository)
      .set({ verificationChecks: [...checks] })
      .where(and(eq(repository.workspaceId, workspaceId), eq(repository.id, id)))
      .returning()
    if (!row) throw new NotFoundError('Repository')
    return toRepository(row as RepositoryRow)
  },

  async setVerifyCommand(workspaceId, id, verifyCommand) {
    const [row] = await db
      .update(repository)
      .set({ verifyCommand })
      .where(and(eq(repository.workspaceId, workspaceId), eq(repository.id, id)))
      .returning()
    if (!row) throw new NotFoundError('Repository')
    return toRepository(row as RepositoryRow)
  },

  async setInstallCommand(workspaceId, id, installCommand) {
    const [row] = await db
      .update(repository)
      .set({ installCommand })
      .where(and(eq(repository.workspaceId, workspaceId), eq(repository.id, id)))
      .returning()
    if (!row) throw new NotFoundError('Repository')
    return toRepository(row as RepositoryRow)
  },

  async setReconcilerEnabled(workspaceId, id, enabled) {
    const [row] = await db
      .update(repository)
      .set({ reconcilerEnabled: enabled })
      .where(and(eq(repository.workspaceId, workspaceId), eq(repository.id, id)))
      .returning()
    if (!row) throw new NotFoundError('Repository')
    return toRepository(row as RepositoryRow)
  },
})

export const mergeQueueRepository = (db: Database): MergeQueueRepositoryPort => ({
  async enqueue(input) {
    const [row] = await db
      .insert(mergeQueueEntry)
      .values({
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        agentRunId: input.agentRunId,
        branchName: input.branchName,
        enqueuedByUserId: input.enqueuedByUserId,
        status: 'queued',
      })
      .returning()
    if (!row) throw new Error('merge_queue_entry insert returned no row')
    return toMergeQueueEntry(row as MergeQueueEntryRow)
  },

  async findById(workspaceId, id) {
    const [row] = await db
      .select()
      .from(mergeQueueEntry)
      .where(and(eq(mergeQueueEntry.workspaceId, workspaceId), eq(mergeQueueEntry.id, id)))
      .limit(1)
    return row ? toMergeQueueEntry(row as MergeQueueEntryRow) : null
  },

  async listByRepository(workspaceId, repositoryId) {
    const rows = await db
      .select()
      .from(mergeQueueEntry)
      .where(
        and(
          eq(mergeQueueEntry.workspaceId, workspaceId),
          eq(mergeQueueEntry.repositoryId, repositoryId),
        ),
      )
      .orderBy(mergeQueueEntry.position)
    return rows.map((row) => toMergeQueueEntry(row as MergeQueueEntryRow))
  },

  async listByWorkspace(workspaceId) {
    const rows = await db
      .select()
      .from(mergeQueueEntry)
      .where(eq(mergeQueueEntry.workspaceId, workspaceId))
      .orderBy(mergeQueueEntry.position)
    return rows.map((row) => toMergeQueueEntry(row as MergeQueueEntryRow))
  },

  async listAllOpen() {
    const rows = await db
      .select()
      .from(mergeQueueEntry)
      .where(inArray(mergeQueueEntry.status, ['queued', 'merging']))
      .orderBy(mergeQueueEntry.position)
    return rows.map((row) => toMergeQueueEntry(row as MergeQueueEntryRow))
  },

  /**
   * The claim, and the one place the queue's serialization is actually enforced.
   *
   * Two guards, both needed. The `status = 'queued'` predicate stops a second claim
   * of the *same* entry; the unique partial index on (repository_id) where
   * status = 'merging' stops a concurrent claim of a *different* entry in the same
   * repository — which no predicate on this row could see. The index raises, and a
   * raise here means "someone else is merging", not a failure to report upward.
   */
  async claim(workspaceId, id) {
    try {
      const [row] = await db
        .update(mergeQueueEntry)
        .set({ status: 'merging', startedAt: new Date() })
        .where(
          and(
            eq(mergeQueueEntry.workspaceId, workspaceId),
            eq(mergeQueueEntry.id, id),
            eq(mergeQueueEntry.status, 'queued'),
          ),
        )
        .returning()
      return row ? toMergeQueueEntry(row as MergeQueueEntryRow) : null
    } catch {
      return null
    }
  },

  async finish(workspaceId, id, patch) {
    const [row] = await db
      .update(mergeQueueEntry)
      .set({
        status: patch.status,
        finishedAt: new Date(),
        ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
        ...(patch.detail === undefined ? {} : { detail: patch.detail }),
        ...(patch.mergedCommitSha === undefined ? {} : { mergedCommitSha: patch.mergedCommitSha }),
        ...(patch.verified === undefined ? {} : { verified: patch.verified }),
      })
      .where(
        and(
          eq(mergeQueueEntry.workspaceId, workspaceId),
          eq(mergeQueueEntry.id, id),
          // First resolution wins — see the port's note on late Runner answers.
          inArray(mergeQueueEntry.status, ['queued', 'merging']),
        ),
      )
      .returning()
    return row ? toMergeQueueEntry(row as MergeQueueEntryRow) : null
  },
})

/**
 * The verification harness's rows.
 *
 * The same two-guard claim the merge queue uses, for the same reason — see `claim`
 * below, and `mergeQueueRepository.claim` for the argument in full.
 */
export const runVerificationRepository = (db: Database): RunVerificationRepositoryPort => ({
  /**
   * Upsert on the run, not an insert.
   *
   * A second enqueue for the same run is the same question asked again — a human
   * re-verifying after fixing something, or a sweep re-reading a run whose first
   * attempt errored. Resetting the row to `pending` is what makes that a re-run rather
   * than a second record whose reader has to work out which verdict is current, and the
   * previous checks are cleared with it: leaving them would show a passing check list
   * above a status that no longer refers to it.
   */
  async enqueue(input) {
    const [row] = await db
      .insert(runVerification)
      .values({
        workspaceId: input.workspaceId,
        agentRunId: input.agentRunId,
        repositoryId: input.repositoryId,
        branchName: input.branchName,
        status: 'pending',
      })
      .onConflictDoUpdate({
        target: runVerification.agentRunId,
        set: {
          repositoryId: input.repositoryId,
          branchName: input.branchName,
          status: 'pending',
          checks: [],
          reason: null,
          commitSha: null,
          startedAt: null,
          finishedAt: null,
        },
      })
      .returning()
    if (!row) throw new Error('run_verification insert returned no row')
    return toRunVerification(row as RunVerificationRow)
  },

  async findByRun(workspaceId, agentRunId) {
    const [row] = await db
      .select()
      .from(runVerification)
      .where(
        and(
          eq(runVerification.workspaceId, workspaceId),
          eq(runVerification.agentRunId, agentRunId),
        ),
      )
      .limit(1)
    return row ? toRunVerification(row as RunVerificationRow) : null
  },

  async listByRuns(workspaceId, agentRunIds) {
    if (agentRunIds.length === 0) return []
    const rows = await db
      .select()
      .from(runVerification)
      .where(
        and(
          eq(runVerification.workspaceId, workspaceId),
          inArray(runVerification.agentRunId, [...agentRunIds]),
        ),
      )
    return rows.map((row) => toRunVerification(row as RunVerificationRow))
  },

  async listAllPending() {
    const rows = await db
      .select()
      .from(runVerification)
      .where(eq(runVerification.status, 'pending'))
      .orderBy(runVerification.createdAt)
    return rows.map((row) => toRunVerification(row as RunVerificationRow))
  },

  /**
   * Two guards, both needed. The `started_at is null` predicate stops a second claim of
   * the *same* row; the unique partial index on (repository_id) stops a concurrent
   * claim of a *different* row in the same repository — which no predicate on this row
   * could see. The index raises, and a raise means "something else is verifying here",
   * not a failure to report upward.
   */
  async claim(workspaceId, id) {
    try {
      const [row] = await db
        .update(runVerification)
        .set({ startedAt: new Date() })
        .where(
          and(
            eq(runVerification.workspaceId, workspaceId),
            eq(runVerification.id, id),
            eq(runVerification.status, 'pending'),
            isNull(runVerification.startedAt),
          ),
        )
        .returning()
      return row ? toRunVerification(row as RunVerificationRow) : null
    } catch {
      return null
    }
  },

  async finish(workspaceId, id, patch) {
    const [row] = await db
      .update(runVerification)
      .set({
        status: patch.status,
        finishedAt: new Date(),
        ...(patch.commitSha === undefined ? {} : { commitSha: patch.commitSha }),
        ...(patch.checks === undefined ? {} : { checks: [...patch.checks] }),
        ...(patch.reason === undefined ? {} : { reason: patch.reason }),
      })
      .where(
        and(
          eq(runVerification.workspaceId, workspaceId),
          eq(runVerification.id, id),
          // First resolution wins — see the port's note on late Runner answers.
          eq(runVerification.status, 'pending'),
        ),
      )
      .returning()
    return row ? toRunVerification(row as RunVerificationRow) : null
  },
})

/**
 * The worker-notes ledger. Append-only by construction — there
 * is no update or delete method to call, for the reason the port states.
 */
export const workerNoteRepository = (db: Database): WorkerNoteRepositoryPort => ({
  async append(input) {
    const [row] = await db
      .insert(workerNote)
      .values({
        workspaceId: input.workspaceId,
        treeRunId: input.treeRunId,
        agentRunId: input.agentRunId,
        authorKind: input.authorKind,
        kind: input.kind,
        title: input.title,
        body: input.body,
        paths: input.paths,
      })
      .returning()
    if (!row) throw new Error('worker_note insert returned no row')
    return toWorkerNote(row as WorkerNoteRow)
  },

  /**
   * Ordered by `seq`, not `created_at`. A swarm's workers write notes in the same
   * millisecond, and the order a ledger renders in is what a reader takes as
   * recency — the same reason `message.seq` exists.
   */
  async listByTree(workspaceId, treeRunId) {
    const rows = await db
      .select()
      .from(workerNote)
      .where(and(eq(workerNote.workspaceId, workspaceId), eq(workerNote.treeRunId, treeRunId)))
      .orderBy(workerNote.seq)
    return rows.map((row) => toWorkerNote(row as WorkerNoteRow))
  },

  async countByRun(workspaceId, agentRunId) {
    const [row] = await db
      .select({ total: count() })
      .from(workerNote)
      .where(and(eq(workerNote.workspaceId, workspaceId), eq(workerNote.agentRunId, agentRunId)))
    return Number(row?.total ?? 0)
  },
})

/**
 * The DAG — the subtasks of a plan that have not started yet.
 *
 * See the `plan_subtask` table for why a waiting subtask is not an `agent_run`.
 */
export const planSubtaskRepository = (db: Database): PlanSubtaskRepositoryPort => ({
  /**
   * One statement, so a plan is either wholly recorded or not at all. A half-written
   * pipeline is a plan whose later stages can never be released and which has no
   * repair path — the planner that authored it has already stopped.
   */
  async recordPlan(input) {
    if (input.subtasks.length === 0) return []
    const rows = await db
      .insert(planSubtask)
      .values(
        input.subtasks.map((subtask) => ({
          workspaceId: input.workspaceId,
          plannerRunId: input.plannerRunId,
          position: subtask.position,
          title: subtask.title,
          task: subtask.task,
          personaName: subtask.personaName,
          paths: subtask.paths,
          dependsOn: subtask.dependsOn,
          reviews: subtask.reviews,
          repository: subtask.repository ?? null,
          status: subtask.status,
          agentRunId: subtask.agentRunId,
          detail: subtask.detail,
        })),
      )
      .returning()
    return rows.map((row) => toPlanSubtask(row as PlanSubtaskRow))
  },

  /** In plan order, because `dependsOn` indexes into exactly this ordering. */
  async listByPlanner(workspaceId, plannerRunId) {
    const rows = await db
      .select()
      .from(planSubtask)
      .where(
        and(eq(planSubtask.workspaceId, workspaceId), eq(planSubtask.plannerRunId, plannerRunId)),
      )
      .orderBy(planSubtask.position)
    return rows.map((row) => toPlanSubtask(row as PlanSubtaskRow))
  },

  async findByAgentRun(workspaceId, agentRunId) {
    const [row] = await db
      .select()
      .from(planSubtask)
      .where(and(eq(planSubtask.workspaceId, workspaceId), eq(planSubtask.agentRunId, agentRunId)))
      .limit(1)
    return row ? toPlanSubtask(row as PlanSubtaskRow) : null
  },

  /**
   * One conditional UPDATE whose `status = 'waiting'` predicate is evaluated under
   * the row lock it takes — the same shape as `claimAggregation`, and for the same
   * reason. Two siblings finishing in the same instant both evaluate the same
   * dependency set and both try to release the same successor; the loser gets no row
   * back and starts nothing. A read-then-write here would start it twice.
   */
  async claimWaiting(input) {
    const [row] = await db
      .update(planSubtask)
      .set({
        status: input.status,
        agentRunId: input.agentRunId,
        detail: input.detail,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(planSubtask.workspaceId, input.workspaceId),
          eq(planSubtask.id, input.id),
          eq(planSubtask.status, 'waiting'),
        ),
      )
      .returning()
    return row ? toPlanSubtask(row as PlanSubtaskRow) : null
  },

  /** See the port: the claim already made this caller exclusive, so this is a plain write. */
  async settleClaimed(input) {
    const [row] = await db
      .update(planSubtask)
      .set({
        status: input.status,
        agentRunId: input.agentRunId,
        detail: input.detail,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(planSubtask.workspaceId, input.workspaceId),
          eq(planSubtask.id, input.id),
          eq(planSubtask.status, 'started'),
        ),
      )
      .returning()
    return row ? toPlanSubtask(row as PlanSubtaskRow) : null
  },
})

export const capabilityRepository = (db: Database): CapabilityRepositoryPort => ({
  async create(input) {
    const [row] = await db
      .insert(capability)
      .values({
        workspaceId: input.workspaceId,
        kind: input.kind,
        name: input.name,
        description: input.description,
        transport: input.transport,
        command: input.command,
        args: input.args,
        url: input.url,
        content: input.content,
        egressHosts: input.egressHosts,
      })
      .returning()
    if (!row) throw new Error('capability insert returned no row')
    return toCapability(row as CapabilityRow)
  },

  async findById(workspaceId, id) {
    const [row] = await db
      .select()
      .from(capability)
      .where(and(eq(capability.workspaceId, workspaceId), eq(capability.id, id)))
      .limit(1)
    return row ? toCapability(row as CapabilityRow) : null
  },

  async listByWorkspace(workspaceId) {
    const rows = await db
      .select()
      .from(capability)
      .where(eq(capability.workspaceId, workspaceId))
      .orderBy(capability.name)
    return rows.map((row) => toCapability(row as CapabilityRow))
  },

  async update(workspaceId, id, patch) {
    const [row] = await db
      .update(capability)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(capability.workspaceId, workspaceId), eq(capability.id, id)))
      .returning()
    if (!row) throw new NotFoundError('Capability')
    return toCapability(row as CapabilityRow)
  },

  async pinToolListHash(workspaceId, id, toolListHash) {
    await db
      .update(capability)
      .set({ toolListHash, updatedAt: new Date() })
      .where(and(eq(capability.workspaceId, workspaceId), eq(capability.id, id)))
  },

  async delete(workspaceId, id) {
    await db
      .delete(capability)
      .where(and(eq(capability.workspaceId, workspaceId), eq(capability.id, id)))
  },

  async attach(input) {
    const [row] = await db
      .insert(personaCapability)
      .values({
        workspaceId: input.workspaceId,
        personaId: input.personaId,
        capabilityId: input.capabilityId,
        allowedTools: input.allowedTools,
      })
      .onConflictDoUpdate({
        target: [personaCapability.personaId, personaCapability.capabilityId],
        set: { allowedTools: input.allowedTools },
      })
      .returning()
    if (!row) throw new Error('persona_capability insert returned no row')
    return toPersonaCapability(row as PersonaCapabilityRow)
  },

  async detach(workspaceId, personaId, capabilityId) {
    await db
      .delete(personaCapability)
      .where(
        and(
          eq(personaCapability.workspaceId, workspaceId),
          eq(personaCapability.personaId, personaId),
          eq(personaCapability.capabilityId, capabilityId),
        ),
      )
  },

  async listByPersona(workspaceId, personaId) {
    const rows = await db
      .select()
      .from(personaCapability)
      .where(
        and(
          eq(personaCapability.workspaceId, workspaceId),
          eq(personaCapability.personaId, personaId),
        ),
      )
    return rows.map((row) => toPersonaCapability(row as PersonaCapabilityRow))
  },

  async listAttachments(workspaceId) {
    const rows = await db
      .select()
      .from(personaCapability)
      .where(eq(personaCapability.workspaceId, workspaceId))
    return rows.map((row) => toPersonaCapability(row as PersonaCapabilityRow))
  },
})

export const agentRunRepository = (db: Database): AgentRunRepositoryPort => ({
  async create(input) {
    const [row] = await db
      .insert(agentRun)
      .values({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        repositoryId: input.repositoryId,
        runnerId: input.runnerId,
        persona: input.persona,
        ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
        ...(input.relation === undefined ? {} : { relation: input.relation }),
        ...(input.task === undefined ? {} : { task: input.task }),
        status: 'pending',
      })
      .returning()
    if (!row) throw new Error('agent_run insert returned no row')
    return toAgentRun(row as AgentRunRow)
  },

  async findById(workspaceId, id) {
    const [row] = await db
      .select()
      .from(agentRun)
      .where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
      .limit(1)
    return row ? toAgentRun(row as AgentRunRow) : null
  },

  /**
   * One conditional UPDATE, and that is the entire mechanism: the `IS NULL` predicate
   * is evaluated under the row lock the UPDATE takes, so of two concurrent callers
   * exactly one sees a row returned. A `SELECT` followed by an `UPDATE` would be the
   * bug this exists to fix, one layer down.
   */
  async claimAggregation(workspaceId, id) {
    const rows = await db
      .update(agentRun)
      .set({ aggregatedAt: new Date() })
      .where(
        and(
          eq(agentRun.workspaceId, workspaceId),
          eq(agentRun.id, id),
          isNull(agentRun.aggregatedAt),
        ),
      )
      .returning({ id: agentRun.id })
    return rows.length === 1
  },

  async updateStatus(workspaceId, id, patch) {
    const [row] = await db
      .update(agentRun)
      .set({
        status: patch.status,
        ...(patch.totalCostUsd !== undefined ? { totalCostUsd: patch.totalCostUsd } : {}),
        ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
        ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      })
      .where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
      .returning()
    if (!row) throw new NotFoundError('AgentRun')
    return toAgentRun(row as AgentRunRow)
  },

  async recordWorkspace(workspaceId, id, patch) {
    const [row] = await db
      .update(agentRun)
      .set({
        clonePath: patch.clonePath,
        branchName: patch.branchName,
        // Only written when the Runner sent one: an absent sha must not overwrite a
        // recorded one, which is what a bare `patch.baseCommitSha ?? null` would do.
        ...(patch.baseCommitSha === undefined ? {} : { baseCommitSha: patch.baseCommitSha }),
      })
      .where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
      .returning()
    if (!row) throw new NotFoundError('AgentRun')
    return toAgentRun(row as AgentRunRow)
  },

  async findActiveByWorkspace(workspaceId) {
    const [row] = await db
      .select()
      .from(agentRun)
      .where(
        and(eq(agentRun.workspaceId, workspaceId), notInArray(agentRun.status, [...TERMINAL_STATUSES])),
      )
      .limit(1)
    return row ? toAgentRun(row as AgentRunRow) : null
  },

  async listByParent(workspaceId, parentRunId) {
    const rows = await db
      .select()
      .from(agentRun)
      .where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.parentRunId, parentRunId)))
      .orderBy(agentRun.createdAt)
    return rows.map((row) => toAgentRun(row as AgentRunRow))
  },

  /**
   * One recursive CTE rather than a walk in the use case: a tree read happens on
   * every board fetch and every ledger build, and N round-trips per generation is
   * exactly the per-card cost the discipline refuses.
   *
   * `depth < 32` bounds it the same way `resolveDelegationDepth` does — far past any
   * configured `MAX_DELEGATION_DEPTH`, so reaching it means the data has a cycle
   * rather than the tree being legitimately deep, and the query returns a truncated
   * answer instead of never returning one. `workspace_id` is matched at every hop,
   * not only at the root: a tree is not a tenancy boundary, and inheriting the root's
   * workspace would make a mis-parented row a cross-tenant read.
   */
  async listTree(workspaceId, rootRunId) {
    // The CTE returns ids only, and the rows come back through the same typed select
    // every other read here uses. Selecting `*` from the recursive term would hand
    // `toAgentRun` snake_case columns it does not accept, and re-mapping twenty of
    // them by hand is a silent-drift risk every time a column is added.
    const idRows = await db.execute<{ id: string }>(sql`
      with recursive tree as (
        select id, 0 as depth from agent_run
          where workspace_id = ${workspaceId} and id = ${rootRunId}
        union all
        select child.id, tree.depth + 1 from agent_run child
          join tree on child.parent_run_id = tree.id
          where child.workspace_id = ${workspaceId} and tree.depth < 32
      )
      select id from tree
    `)
    const ids = [...(idRows as unknown as Array<{ id: string }>)].map((row) => row.id)
    if (ids.length === 0) return []

    const rows = await db
      .select()
      .from(agentRun)
      .where(and(eq(agentRun.workspaceId, workspaceId), inArray(agentRun.id, ids)))
      .orderBy(agentRun.createdAt)
    return rows.map((row) => toAgentRun(row as AgentRunRow))
  },

  async countByRepository(workspaceId, repositoryId) {
    const [row] = await db
      .select({
        total: count(),
        // Counted in the same pass rather than by a second query: the two numbers
        // answer one question ("can this go, and what goes with it"), and reading
        // them apart lets a run finish between them.
        active: count(
          sql`case when ${notInArray(agentRun.status, [...TERMINAL_STATUSES])} then 1 end`,
        ),
      })
      .from(agentRun)
      .where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.repositoryId, repositoryId)))
    return { total: row?.total ?? 0, active: row?.active ?? 0 }
  },

  async countByChannel(workspaceId, channelId) {
    const [row] = await db
      .select({
        total: count(),
        active: count(
          sql`case when ${notInArray(agentRun.status, [...TERMINAL_STATUSES])} then 1 end`,
        ),
      })
      .from(agentRun)
      .innerJoin(thread, eq(agentRun.threadId, thread.id))
      .where(and(eq(agentRun.workspaceId, workspaceId), eq(thread.channelId, channelId)))
    return { total: row?.total ?? 0, active: row?.active ?? 0 }
  },

  async listActiveByWorkspace(workspaceId) {
    const rows = await db
      .select()
      .from(agentRun)
      .where(
        and(eq(agentRun.workspaceId, workspaceId), notInArray(agentRun.status, [...TERMINAL_STATUSES])),
      )
      // Ordered, and not just for tidiness: this list is rendered as clickable rows
      // that re-poll every second or so, and an unordered result reshuffles between
      // polls — so a human aiming at one run can click another. Found live.
      // `id` breaks ties, since several runs of a swarm are created in the same
      // millisecond.
      .orderBy(agentRun.createdAt, agentRun.id)
    return rows.map((row) => toAgentRun(row as AgentRunRow))
  },

  async setBranchDisposition(workspaceId, id, disposition) {
    const [row] = await db
      .update(agentRun)
      .set({ branchDisposition: disposition })
      .where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
      .returning()
    if (!row) throw new NotFoundError('AgentRun')
    return toAgentRun(row as AgentRunRow)
  },

  async recordCost(workspaceId, id, totalCostUsd) {
    await db
      .update(agentRun)
      .set({ totalCostUsd })
      .where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
  },

  /**
   * Grouped spend for the cost dashboard.
   *
   * Five aggregates in one round trip rather than five calls: they all read the same
   * rows under the same filter, and a dashboard that issued five queries would be able
   * to show a total that disagreed with the sum of its own groups.
   *
   * `persona` is a jsonb snapshot of what actually ran, so the grouping keys come out
   * of it rather than out of today's persona row — see `AgentRunCostRollup` on why that
   * distinction is the point of the feature rather than an implementation detail.
   *
   * `COALESCE(total_cost_usd, 0)`: a run that never reached the proxy has null spend,
   * and null is "we never metered it", not "it was free". Counted as zero in the sums
   * because that is the honest arithmetic, while `runCount` still counts the run — so a
   * workspace full of failed runs reads as many runs and little money, which is true.
   */
  async costRollup(workspaceId, input) {
    const scope = input.since
      ? and(eq(agentRun.workspaceId, workspaceId), gte(agentRun.createdAt, input.since))
      : eq(agentRun.workspaceId, workspaceId)
    const usd = sql<number>`coalesce(sum(coalesce(${agentRun.totalCostUsd}, 0)), 0)`
    const personaName = sql<string>`coalesce(${agentRun.persona}->>'name', 'unknown')`
    const model = sql<string>`coalesce(${agentRun.persona}->>'model', 'unknown')`

    const [totals] = await db
      .select({ runCount: count(), totalUsd: usd })
      .from(agentRun)
      .where(scope)

    const byPersona = await db
      .select({
        personaName,
        model,
        runCount: count(),
        totalUsd: usd,
        maxUsd: sql<number>`coalesce(max(coalesce(${agentRun.totalCostUsd}, 0)), 0)`,
      })
      .from(agentRun)
      .where(scope)
      .groupBy(personaName, model)
      .orderBy(desc(usd))

    const byModel = await db
      .select({ model, runCount: count(), totalUsd: usd })
      .from(agentRun)
      .where(scope)
      .groupBy(model)
      .orderBy(desc(usd))

    const byThread = await db
      .select({
        threadId: agentRun.threadId,
        channelName: sql<string>`coalesce(${channel.name}, 'unknown')`,
        runCount: count(),
        totalUsd: usd,
      })
      .from(agentRun)
      .leftJoin(thread, eq(thread.id, agentRun.threadId))
      .leftJoin(channel, eq(channel.id, thread.channelId))
      .where(scope)
      .groupBy(agentRun.threadId, channel.name)
      .orderBy(desc(usd))

    // Bounded deliberately: this is the "what was expensive" list a human scans, and an
    // unbounded one on a busy workspace is a page nobody reads and a payload nobody
    // needs. The groups above already account for every dollar.
    const topRuns = await db
      .select({
        agentRunId: agentRun.id,
        personaName,
        model,
        status: agentRun.status,
        relation: agentRun.relation,
        totalUsd: sql<number>`coalesce(${agentRun.totalCostUsd}, 0)`,
        createdAt: agentRun.createdAt,
      })
      .from(agentRun)
      .where(scope)
      .orderBy(desc(agentRun.totalCostUsd))
      .limit(10)

    const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))
    return {
      totals: { runCount: totals?.runCount ?? 0, totalUsd: num(totals?.totalUsd) },
      byPersona: byPersona.map((r) => ({ ...r, totalUsd: num(r.totalUsd), maxUsd: num(r.maxUsd) })),
      byModel: byModel.map((r) => ({ ...r, totalUsd: num(r.totalUsd) })),
      byThread: byThread.map((r) => ({
        ...r,
        threadId: asThreadId(r.threadId),
        totalUsd: num(r.totalUsd),
      })),
      topRuns: topRuns.map((r) => ({
        ...r,
        agentRunId: asAgentRunId(r.agentRunId),
        totalUsd: num(r.totalUsd),
      })),
    }
  },

  async recordHeartbeat(workspaceId, id, context) {
    await db
      .update(agentRun)
      .set({
        lastHeartbeatAt: new Date(),
        // Only written when the Runner actually sampled: a heartbeat that could not read
        // the window must leave the last known figure alone rather than blanking it.
        ...(context ? { contextTokens: context.tokens, contextMaxTokens: context.maxTokens } : {}),
      })
      .where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
  },

  /**
   * The claim, not a read-then-write. `returning()` being empty means somebody else got
   * there first — which for a heartbeat means the previous heartbeat, a few seconds ago.
   */
  async markHandoffSuggested(workspaceId, id) {
    const rows = await db
      .update(agentRun)
      .set({ handoffSuggestedAt: new Date() })
      .where(
        and(
          eq(agentRun.workspaceId, workspaceId),
          eq(agentRun.id, id),
          isNull(agentRun.handoffSuggestedAt),
        ),
      )
      .returning({ id: agentRun.id })
    return rows.length > 0
  },

  async recordEventActivity(workspaceId, id) {
    await db
      .update(agentRun)
      .set({ lastEventAt: new Date() })
      .where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
  },

  async listAllActive() {
    const rows = await db
      .select()
      .from(agentRun)
      .where(notInArray(agentRun.status, [...TERMINAL_STATUSES]))
    return rows.map((row) => toAgentRun(row as AgentRunRow))
  },

  async listNeedsAttention(workspaceId) {
    const rows = await db
      .select()
      .from(agentRun)
      .where(
        and(
          eq(agentRun.workspaceId, workspaceId),
          or(
            eq(agentRun.status, 'awaiting_approval'),
            and(
              inArray(agentRun.status, [...TERMINAL_STATUSES]),
              isNull(agentRun.branchDisposition),
              isNotNull(agentRun.clonePath),
            ),
          ),
        ),
      )
      // Same reason as listActiveByWorkspace: the Inbox renders these as clickable
      // rows and refreshes them, so an unordered result would move a row out from
      // under a human mid-click. Oldest first — the thing that has been waiting
      // longest is the thing most likely to be about to time out.
      .orderBy(agentRun.createdAt, agentRun.id)
    return rows.map((row) => toAgentRun(row as AgentRunRow))
  },

  async listSettled(workspaceId, limit) {
    const rows = await db
      .select()
      .from(agentRun)
      .where(and(eq(agentRun.workspaceId, workspaceId), isNotNull(agentRun.branchDisposition)))
      // Newest first, unlike the attention list: that one is ordered by who has waited
      // longest because the longest wait is closest to timing out, and this one is a
      // record of what happened — where the most recent thing is the interesting one.
      .orderBy(desc(agentRun.completedAt), desc(agentRun.createdAt))
      .limit(limit)
    return rows.map((row) => toAgentRun(row as AgentRunRow))
  },
})

export const agentRunEventRepository = (db: Database): AgentRunEventRepositoryPort => ({
  async append(input) {
    // `onConflictDoNothing` on the (agent_run_id, seq) unique index is the
    // idempotency primitive — an empty `returning` means this exact event was
    // already ingested, so the caller skips its side effects.
    const rows = await db
      .insert(agentRunEvent)
      .values({
        workspaceId: input.workspaceId,
        agentRunId: input.agentRunId,
        seq: input.seq,
        kind: input.kind,
        payload: input.payload,
      })
      .onConflictDoNothing({ target: [agentRunEvent.agentRunId, agentRunEvent.seq] })
      .returning({ id: agentRunEvent.id })
    return rows.length > 0
  },

  async highestSeq(workspaceId, agentRunId) {
    const [row] = await db
      .select({ seq: agentRunEvent.seq })
      .from(agentRunEvent)
      .where(and(eq(agentRunEvent.workspaceId, workspaceId), eq(agentRunEvent.agentRunId, agentRunId)))
      .orderBy(desc(agentRunEvent.seq))
      .limit(1)
    return row?.seq ?? 0
  },

  async writtenPaths(workspaceId, agentRunId) {
    /**
     * The writing tools only. A `Read` is not evidence of a change, and counting one
     * would make the check pass for a brief that claimed to have edited everything it
     * looked at — which is exactly the confusion this is meant to catch.
     */
    const rows = await db.execute<{ path: string | null }>(sql`
      select distinct payload->'input'->>'file_path' as path
      from agent_run_event
      where workspace_id = ${workspaceId}
        and agent_run_id = ${agentRunId}
        and kind = 'tool_call'
        and payload->>'toolName' in ('Write', 'Edit', 'NotebookEdit')
        and payload->'input'->>'file_path' is not null
    `)
    return [...rows].flatMap((row) => (row.path === null ? [] : [row.path]))
  },

  async liveActivity(workspaceId, agentRunIds) {
    if (agentRunIds.length === 0) return new Map()

    /**
     * One statement for the whole tree.
     *
     * A call is in flight when its `toolUseId` has no `tool_result` carrying the same
     * id — the correlation the events have always contained, and the only definition
     * that survives a model issuing calls in parallel. `distinct on` then takes the
     * newest open call per run, which is what a card shows; `open_count` is what keeps
     * a fourteen-way fan-out from reading as a single `Read`.
     */
    const rows = await db.execute<{
      agent_run_id: string
      last_event_at: Date | string | null
      tool_name: string | null
      input: Record<string, unknown> | null
      open_count: number | string
    }>(sql`
      with scoped as (
        select agent_run_id, seq, kind, payload, created_at
        from agent_run_event
        where workspace_id = ${workspaceId}
          and ${inArray(agentRunEvent.agentRunId, [...agentRunIds])}
      ),
      open_calls as (
        select c.agent_run_id, c.seq, c.payload
        from scoped c
        where c.kind = 'tool_call'
          and not exists (
            select 1 from scoped r
            where r.kind = 'tool_result'
              and r.agent_run_id = c.agent_run_id
              and r.payload->>'toolUseId' = c.payload->>'toolUseId'
          )
      ),
      newest_open as (
        select distinct on (agent_run_id)
          agent_run_id,
          payload->>'toolName' as tool_name,
          payload->'input' as input
        from open_calls
        order by agent_run_id, seq desc
      ),
      open_counts as (
        select agent_run_id, count(*) as open_count from open_calls group by agent_run_id
      ),
      last_seen as (
        select agent_run_id, max(created_at) as last_event_at from scoped group by agent_run_id
      )
      select
        l.agent_run_id,
        l.last_event_at,
        n.tool_name,
        n.input,
        coalesce(o.open_count, 0) as open_count
      from last_seen l
      left join newest_open n on n.agent_run_id = l.agent_run_id
      left join open_counts o on o.agent_run_id = l.agent_run_id
    `)

    const activity = new Map<string, RunLiveActivity>()
    for (const row of rows as unknown as Array<{
      agent_run_id: string
      last_event_at: Date | string | null
      tool_name: string | null
      input: Record<string, unknown> | null
      open_count: number | string
    }>) {
      activity.set(row.agent_run_id, {
        currentToolName: row.tool_name,
        currentToolTarget: primaryToolArgument(row.input),
        openCallCount: Number(row.open_count),
        lastEventAt: row.last_event_at === null ? null : new Date(row.last_event_at),
      })
    }
    return activity
  },
})

export const approvalRepository = (db: Database): ApprovalRepositoryPort => ({
  async create(input) {
    const [row] = await db
      .insert(approvalRequest)
      .values({
        workspaceId: input.workspaceId,
        agentRunId: input.agentRunId,
        toolUseId: input.toolUseId,
        toolName: input.toolName,
        input: input.input,
        status: 'pending',
        // Null on an ordinary tool gate, which is what distinguishes the two kinds.
        question: input.question ?? null,
      })
      .returning()
    if (!row) throw new Error('approval_request insert returned no row')
    return toApprovalRequest(row as ApprovalRequestRow)
  },

  async findById(workspaceId, id) {
    const [row] = await db
      .select()
      .from(approvalRequest)
      .where(and(eq(approvalRequest.workspaceId, workspaceId), eq(approvalRequest.id, id)))
      .limit(1)
    return row ? toApprovalRequest(row as ApprovalRequestRow) : null
  },

  async listPendingByRun(workspaceId, agentRunId) {
    const rows = await db
      .select()
      .from(approvalRequest)
      .where(
        and(
          eq(approvalRequest.workspaceId, workspaceId),
          eq(approvalRequest.agentRunId, agentRunId),
          eq(approvalRequest.status, 'pending'),
        ),
      )
    return rows.map((row) => toApprovalRequest(row as ApprovalRequestRow))
  },

  async listAllPending() {
    const rows = await db
      .select()
      .from(approvalRequest)
      .where(eq(approvalRequest.status, 'pending'))
    return rows.map((row) => toApprovalRequest(row as ApprovalRequestRow))
  },

  async resolve(workspaceId, id, patch) {
    const [row] = await db
      .update(approvalRequest)
      .set({
        status: patch.status,
        resolvedByUserId: patch.resolvedByUserId,
        // Only written when there is one: a tool gate resolves with no answer, and
        // spreading `undefined` here would blank a stored one on a re-resolve.
        ...(patch.answer === undefined ? {} : { answer: patch.answer }),
        resolvedAt: new Date(),
      })
      .where(and(eq(approvalRequest.workspaceId, workspaceId), eq(approvalRequest.id, id)))
      .returning()
    if (!row) throw new NotFoundError('ApprovalRequest')
    return toApprovalRequest(row as ApprovalRequestRow)
  },
})

/**
 * Kill-switch state. Columns live on `workspace` rather than a
 * dedicated table — it's strictly 1:1 with a workspace, so a separate row would
 * add a join and a "does the row exist yet?" case for nothing.
 */
/**
 * One column list and one mapper, because three methods return this row and a fourth copy
 * of the field list is how the pause and the handoff policy end up disagreeing.
 */
const CONTROL_COLUMNS = {
  runsPaused: workspace.runsPaused,
  runsPausedAt: workspace.runsPausedAt,
  runsPausedByUserId: workspace.runsPausedByUserId,
  handoffThreshold: workspace.handoffThreshold,
  handoffCapPerTree: workspace.handoffCapPerTree,
  planReviewRequired: workspace.planReviewRequired,
}

const toControl = (
  workspaceId: WorkspaceId,
  row: {
    runsPaused: boolean
    runsPausedAt: Date | null
    runsPausedByUserId: string | null
    handoffThreshold: number | null
    handoffCapPerTree: number | null
    planReviewRequired: boolean
  },
): WorkspaceRunControl => ({
  workspaceId,
  paused: row.runsPaused,
  pausedAt: row.runsPausedAt,
  pausedByUserId: row.runsPausedByUserId,
  planReviewRequired: row.planReviewRequired,
  handoff: { threshold: row.handoffThreshold, capPerTree: row.handoffCapPerTree },
})

export const workspaceRunControlRepository = (db: Database): WorkspaceRunControlRepositoryPort => ({
  async get(workspaceId) {
    const [row] = await db
      .select(CONTROL_COLUMNS)
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1)
    if (!row) throw new NotFoundError('Workspace')
    return toControl(workspaceId, row)
  },

  async set(workspaceId, patch) {
    const [row] = await db
      .update(workspace)
      .set({
        runsPaused: patch.paused,
        runsPausedAt: patch.paused ? new Date() : null,
        runsPausedByUserId: patch.pausedByUserId,
      })
      .where(eq(workspace.id, workspaceId))
      .returning(CONTROL_COLUMNS)
    if (!row) throw new NotFoundError('Workspace')
    return toControl(workspaceId, row)
  },

  async setHandoffPolicy(workspaceId, patch) {
    const [row] = await db
      .update(workspace)
      .set({ handoffThreshold: patch.threshold, handoffCapPerTree: patch.capPerTree })
      .where(eq(workspace.id, workspaceId))
      .returning(CONTROL_COLUMNS)
    if (!row) throw new NotFoundError('Workspace')
    return toControl(workspaceId, row)
  },

  async setPlanReviewRequired(workspaceId, required) {
    const [row] = await db
      .update(workspace)
      .set({ planReviewRequired: required })
      .where(eq(workspace.id, workspaceId))
      .returning(CONTROL_COLUMNS)
    if (!row) throw new NotFoundError('Workspace')
    return toControl(workspaceId, row)
  },
})

/**
 * Where a human can be reached. `register` upserts on
 * (workspace, endpoint) so a browser that re-subscribes — which it does on its
 * own schedule, whenever the push service rotates the subscription — refreshes
 * its credentials instead of leaving a dead row behind that every later delivery
 * would retry.
 */
export const notificationTargetRepository = (db: Database): NotificationTargetRepositoryPort => ({
  async register(input) {
    const [row] = await db
      .insert(notificationTarget)
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        transport: input.transport,
        endpoint: input.endpoint,
        credentials: input.credentials,
      })
      .onConflictDoUpdate({
        target: [notificationTarget.workspaceId, notificationTarget.endpoint],
        set: { userId: input.userId, transport: input.transport, credentials: input.credentials },
      })
      .returning()
    if (!row) throw new NotFoundError('NotificationTarget')
    return toNotificationTarget(row as NotificationTargetRow)
  },

  async unregister(workspaceId, endpoint) {
    await db
      .delete(notificationTarget)
      .where(
        and(
          eq(notificationTarget.workspaceId, workspaceId),
          eq(notificationTarget.endpoint, endpoint),
        ),
      )
  },

  async listByWorkspace(workspaceId) {
    const rows = await db
      .select()
      .from(notificationTarget)
      .where(eq(notificationTarget.workspaceId, workspaceId))
    return rows.map((row) => toNotificationTarget(row as NotificationTargetRow))
  },
})

export const personaRepository = (db: Database): PersonaRepositoryPort => ({
  async delete(workspaceId, id) {
    // Safe for history by design: a run stores its whole persona spec as JSON, so
    // nothing here is the source of a past run's persona, model or cost.
    await db
      .delete(agentPersona)
      .where(and(eq(agentPersona.workspaceId, workspaceId), eq(agentPersona.id, id)))
  },

  async create(input) {
    const [row] = await db
      .insert(agentPersona)
      .values({
        workspaceId: input.workspaceId,
        name: input.name,
        description: input.description,
        markdownSource: input.markdownSource,
        model: input.model,
        tools: input.tools,
        harnessEffort: input.harnessEffort,
        harnessMaxTurns: input.harnessMaxTurns,
        harnessApprovalMode: input.harnessApprovalMode,
        harnessPlanner: input.harnessPlanner,
        harnessDelegates: input.harnessDelegates,
        harnessBudgetCapUsd: input.harnessBudgetCapUsd,
        envelope: input.envelope,
        ...(input.builtinSource === undefined ? {} : { builtinSource: input.builtinSource }),
      })
      .returning()
    if (!row) throw new Error('agent_persona insert returned no row')
    return toAgentPersona(row as AgentPersonaRow)
  },

  async findById(workspaceId, id) {
    const [row] = await db
      .select()
      .from(agentPersona)
      .where(and(eq(agentPersona.workspaceId, workspaceId), eq(agentPersona.id, id)))
      .limit(1)
    return row ? toAgentPersona(row as AgentPersonaRow) : null
  },

  async listByWorkspace(workspaceId) {
    const rows = await db
      .select()
      .from(agentPersona)
      .where(eq(agentPersona.workspaceId, workspaceId))
    return rows.map((row) => toAgentPersona(row as AgentPersonaRow))
  },

  async listRevisions(workspaceId, personaId, limit) {
    const rows = await db
      .select()
      .from(personaRevision)
      .where(
        and(
          eq(personaRevision.workspaceId, workspaceId),
          eq(personaRevision.personaId, personaId),
        ),
      )
      .orderBy(desc(personaRevision.createdAt))
      .limit(limit ?? 50)
    return rows.map((row) => toPersonaRevision(row as PersonaRevisionRow))
  },

  async listRevisionsByWorkspace(workspaceId, limit) {
    const rows = await db
      .select()
      .from(personaRevision)
      .where(eq(personaRevision.workspaceId, workspaceId))
      .orderBy(desc(personaRevision.createdAt))
      .limit(limit ?? 200)
    return rows.map((row) => toPersonaRevision(row as PersonaRevisionRow))
  },

  async findRevisionOnTrial(workspaceId, personaId) {
    const [row] = await db
      .select()
      .from(personaRevision)
      .where(
        and(
          eq(personaRevision.workspaceId, workspaceId),
          eq(personaRevision.personaId, personaId),
          // Only an agent's edit is a hypothesis; a human's is a decision.
          eq(personaRevision.replacedByKind, 'agent_run'),
          isNull(personaRevision.trialDecidedAt),
        ),
      )
      .orderBy(desc(personaRevision.createdAt))
      .limit(1)
    return row ? toPersonaRevision(row as PersonaRevisionRow) : null
  },

  async decideTrial(workspaceId, revisionId) {
    await db
      .update(personaRevision)
      .set({ trialDecidedAt: new Date() })
      .where(
        and(eq(personaRevision.workspaceId, workspaceId), eq(personaRevision.id, revisionId)),
      )
  },

  async recordTrialUse(input) {
    await db
      .insert(promptTrialUse)
      .values({
        workspaceId: input.workspaceId,
        personaId: input.personaId,
        revisionId: input.revisionId,
        agentRunId: input.agentRunId,
        arm: input.arm,
      })
      // A run is on one side or it is not in the comparison — re-recording is a no-op
      // rather than a second vote.
      .onConflictDoNothing({ target: promptTrialUse.agentRunId })
  },

  async countTrialArms(workspaceId, revisionId) {
    const rows = await db
      .select({ arm: promptTrialUse.arm, value: count() })
      .from(promptTrialUse)
      .where(
        and(
          eq(promptTrialUse.workspaceId, workspaceId),
          eq(promptTrialUse.revisionId, revisionId),
        ),
      )
      .groupBy(promptTrialUse.arm)
    const of = (arm: string) => rows.find((row) => row.arm === arm)?.value ?? 0
    return { revised: of('revised'), previous: of('previous') }
  },

  /**
   * Mirrors `tallyExpertiseOutcomes` exactly — same joins, same `decidedRun`.
   *
   * The verification is a left join: a run whose repository has no definition of done, or
   * whose verification has not finished, is a row with a null status, which `decidedRun`
   * reads as "not decided by the harness" and leaves to the disposition.
   */
  async tallyTrialOutcomes(workspaceId, revisionId) {
    const rows = await db
      .select({
        arm: promptTrialUse.arm,
        decided: sql<number>`count(*) filter (where ${decidedRun})::int`,
        merged: sql<number>`count(*) filter (where ${agentRun.branchDisposition} in ('merged', 'pushed'))::int`,
        discarded: sql<number>`count(*) filter (where ${agentRun.branchDisposition} = 'discarded')::int`,
        failed: sql<number>`count(*) filter (where ${agentRun.status} = 'failed')::int`,
        verificationFailed: verificationFailedCount,
        failingCheck: modalFailingCheck,
        costUsdTotal: sql<number>`coalesce(sum(${agentRun.totalCostUsd}) filter (where ${decidedRun}), 0)::double precision`,
      })
      .from(promptTrialUse)
      .innerJoin(agentRun, eq(agentRun.id, promptTrialUse.agentRunId))
      .leftJoin(runVerification, eq(runVerification.agentRunId, agentRun.id))
      .where(
        and(
          eq(promptTrialUse.workspaceId, workspaceId),
          eq(promptTrialUse.revisionId, revisionId),
        ),
      )
      .groupBy(promptTrialUse.arm)

    return rows
      .filter((row) => row.arm === 'revised' || row.arm === 'previous')
      .map((row) => ({
        arm: row.arm as 'revised' | 'previous',
        decided: row.decided,
        merged: row.merged,
        discarded: row.discarded,
        failed: row.failed,
        verificationFailed: row.verificationFailed,
        failingCheck: row.failingCheck,
        costUsdTotal: row.costUsdTotal,
      }))
  },

  async countRevisionsByRun(workspaceId, agentRunId) {
    const [row] = await db
      .select({ value: count() })
      .from(personaRevision)
      .where(
        and(
          eq(personaRevision.workspaceId, workspaceId),
          eq(personaRevision.replacedByRunId, agentRunId),
        ),
      )
    return row?.value ?? 0
  },

  async findRevision(workspaceId, revisionId) {
    const [row] = await db
      .select()
      .from(personaRevision)
      .where(
        and(eq(personaRevision.workspaceId, workspaceId), eq(personaRevision.id, revisionId)),
      )
      .limit(1)
    return row ? toPersonaRevision(row as PersonaRevisionRow) : null
  },

  async update(workspaceId, id, patch, revision) {
    /**
     * One transaction when a revision comes with the save. See
     * `PersonaRepositoryPort.update` for why the two halves cannot be two calls: one
     * order invents history, the other loses it.
     */
    if (revision) {
      return db.transaction(async (tx) => {
        await tx.insert(personaRevision).values({
          workspaceId,
          personaId: id,
          markdownSource: revision.markdownSource,
          replacedByKind: revision.replacedByKind,
          replacedByRunId: revision.replacedByRunId ?? null,
          replacedByUserId: revision.replacedByUserId ?? null,
          rationale: revision.rationale ?? '',
        })
        const [updated] = await tx
          .update(agentPersona)
          .set({
            description: patch.description,
            markdownSource: patch.markdownSource,
            model: patch.model,
            tools: patch.tools,
            harnessEffort: patch.harnessEffort,
            harnessMaxTurns: patch.harnessMaxTurns,
            harnessApprovalMode: patch.harnessApprovalMode,
            harnessPlanner: patch.harnessPlanner,
            harnessDelegates: patch.harnessDelegates,
            harnessBudgetCapUsd: patch.harnessBudgetCapUsd,
            envelope: patch.envelope,
            ...(patch.builtinSource === undefined ? {} : { builtinSource: patch.builtinSource }),
            updatedAt: new Date(),
          })
          .where(and(eq(agentPersona.workspaceId, workspaceId), eq(agentPersona.id, id)))
          .returning()
        if (!updated) throw new NotFoundError('AgentPersona')
        return toAgentPersona(updated as AgentPersonaRow)
      })
    }

    const [row] = await db
      .update(agentPersona)
      .set({
        description: patch.description,
        markdownSource: patch.markdownSource,
        model: patch.model,
        tools: patch.tools,
        harnessEffort: patch.harnessEffort,
        harnessMaxTurns: patch.harnessMaxTurns,
        harnessApprovalMode: patch.harnessApprovalMode,
        harnessPlanner: patch.harnessPlanner,
        harnessDelegates: patch.harnessDelegates,
        harnessBudgetCapUsd: patch.harnessBudgetCapUsd,
        // Written on every save, including to null: a removed `envelope:` block is a
        // human withdrawing permission, and a patch that skipped null would make that
        // the one edit the platform ignores.
        envelope: patch.envelope,
        // Absent leaves the recorded seed alone: it is what makes "untouched"
        // answerable, and rewriting it on a human's save would make every persona
        // look untouched forever.
        ...(patch.builtinSource === undefined ? {} : { builtinSource: patch.builtinSource }),
        updatedAt: new Date(),
      })
      .where(and(eq(agentPersona.workspaceId, workspaceId), eq(agentPersona.id, id)))
      .returning()
    if (!row) throw new NotFoundError('AgentPersona')
    return toAgentPersona(row as AgentPersonaRow)
  },
})

/**
 * The searching half of the loop, in storage.
 *
 * Its own port rather than more methods on `PersonaRepositoryPort`, which is already the
 * largest one here: a search has its own lifecycle — opened by a run, measured by every
 * subsequent run, settled by a human — and none of it is a read or write of a persona row.
 */
export const personaVariantRepository = (db: Database): PersonaVariantRepositoryPort => ({
  /**
   * One transaction, because a set with no candidates is a persona's search slot held by
   * nothing. The unique partial index on `status = 'open'` is what refuses a second open
   * search, so a race between two runs proposing at once loses one of them here rather
   * than producing two searches nobody can settle.
   */
  async openSet(input) {
    return db.transaction(async (tx) => {
      const [setRow] = await tx
        .insert(personaVariantSet)
        .values({
          workspaceId: input.workspaceId,
          personaId: input.personaId,
          proposedByRunId: input.proposedByRunId ?? null,
        })
        .returning()
      if (!setRow) throw new Error('variant set insert returned nothing')
      const variantRows = await tx
        .insert(personaVariant)
        .values(
          input.candidates.map((candidate, index) => ({
            workspaceId: input.workspaceId,
            setId: setRow.id,
            personaId: input.personaId,
            markdownSource: candidate.markdownSource,
            rationale: candidate.rationale,
            position: index,
          })),
        )
        .returning()
      return {
        set: toPersonaVariantSet(setRow as PersonaVariantSetRow),
        variants: variantRows.map((row) => toPersonaVariant(row as PersonaVariantRow)),
      }
    })
  },

  async findOpenSet(workspaceId, personaId) {
    const [setRow] = await db
      .select()
      .from(personaVariantSet)
      .where(
        and(
          eq(personaVariantSet.workspaceId, workspaceId),
          eq(personaVariantSet.personaId, personaId),
          eq(personaVariantSet.status, 'open'),
        ),
      )
      .limit(1)
    if (!setRow) return null
    return {
      set: toPersonaVariantSet(setRow as PersonaVariantSetRow),
      variants: await listVariantsOf(db, workspaceId, setRow.id),
    }
  },

  async findSet(workspaceId, setId) {
    const [setRow] = await db
      .select()
      .from(personaVariantSet)
      .where(
        and(eq(personaVariantSet.workspaceId, workspaceId), eq(personaVariantSet.id, setId)),
      )
      .limit(1)
    if (!setRow) return null
    return {
      set: toPersonaVariantSet(setRow as PersonaVariantSetRow),
      variants: await listVariantsOf(db, workspaceId, setRow.id),
    }
  },

  async listOpenSets(workspaceId) {
    const setRows = await db
      .select()
      .from(personaVariantSet)
      .where(
        and(
          eq(personaVariantSet.workspaceId, workspaceId),
          eq(personaVariantSet.status, 'open'),
        ),
      )
      .orderBy(desc(personaVariantSet.createdAt))
    if (setRows.length === 0) return []
    /**
     * One query for every candidate of every open set, grouped in memory. A query per set
     * would be a round trip per persona being searched, which is the cost this method
     * exists to avoid.
     */
    const variantRows = await db
      .select()
      .from(personaVariant)
      .where(
        and(
          eq(personaVariant.workspaceId, workspaceId),
          inArray(
            personaVariant.setId,
            setRows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(personaVariant.position)
    return setRows.map((setRow) => ({
      set: toPersonaVariantSet(setRow as PersonaVariantSetRow),
      variants: variantRows
        .filter((row) => row.setId === setRow.id)
        .map((row) => toPersonaVariant(row as PersonaVariantRow)),
    }))
  },

  async openProposerSession(input) {
    await db
      .insert(personaProposerSession)
      .values({
        workspaceId: input.workspaceId,
        personaId: input.personaId,
        agentRunId: input.agentRunId,
        losingArmsShown: input.shown.losingArms,
        losingArmsWithheld: input.shown.losingArmsWithheld,
        refusalsShown: input.shown.refusedCandidates,
        refusalsWithheld: input.shown.refusedCandidatesWithheld,
      })
      /**
       * A second row for the same run would be two answers to "which persona may this
       * session propose for", so a repeat is a no-op rather than a second grant.
       */
      .onConflictDoNothing({ target: personaProposerSession.agentRunId })
  },

  async findProposerSession(workspaceId, agentRunId) {
    const [row] = await db
      .select()
      .from(personaProposerSession)
      .where(
        and(
          eq(personaProposerSession.workspaceId, workspaceId),
          eq(personaProposerSession.agentRunId, agentRunId),
        ),
      )
      .limit(1)
    if (!row) return null
    return {
      personaId: asAgentPersonaId(row.personaId),
      shown: {
        losingArms: row.losingArmsShown,
        refusedCandidates: row.refusalsShown,
        losingArmsWithheld: row.losingArmsWithheld,
        refusedCandidatesWithheld: row.refusalsWithheld,
      },
    }
  },

  async recordVerifierRun(workspaceId, setId, runId) {
    await db
      .update(personaVariantSet)
      .set({ verifierRunId: runId })
      .where(
        and(eq(personaVariantSet.workspaceId, workspaceId), eq(personaVariantSet.id, setId)),
      )
  },

  /**
   * The set a verifier session belongs to, by its run.
   *
   * The persona's *current* markdown comes back with it because the verdict has to be
   * mapped through the same blinding it was shown, and the incumbent option is the live
   * prompt. A human who edited that prompt mid-search changed what the verifier was
   * comparing against, which is their right — the mapping stays honest either way, since
   * the letters are assigned from ids rather than from text.
   */
  async findSetByVerifierRun(workspaceId, runId) {
    const [row] = await db
      .select({ set: personaVariantSet, markdownSource: agentPersona.markdownSource })
      .from(personaVariantSet)
      .innerJoin(agentPersona, eq(agentPersona.id, personaVariantSet.personaId))
      .where(
        and(
          eq(personaVariantSet.workspaceId, workspaceId),
          eq(personaVariantSet.verifierRunId, runId),
        ),
      )
      .limit(1)
    if (!row) return null
    return {
      set: toPersonaVariantSet(row.set as PersonaVariantSetRow),
      variants: await listVariantsOf(db, workspaceId, row.set.id),
      incumbentBody: row.markdownSource,
    }
  },

  async recordVerifierVerdict(workspaceId, setId, input) {
    await db
      .update(personaVariantSet)
      .set({
        verifierPickedVariantId: input.pickedVariantId ?? null,
        verifierReason: input.reason,
        verifierDecidedAt: new Date(),
      })
      .where(
        and(eq(personaVariantSet.workspaceId, workspaceId), eq(personaVariantSet.id, setId)),
      )
  },

  async recordVariantUse(input) {
    await db
      .insert(variantUse)
      .values({
        workspaceId: input.workspaceId,
        setId: input.setId,
        variantId: input.variantId ?? null,
        agentRunId: input.agentRunId,
      })
      // A run is on one arm or it is not in the comparison — re-recording is a no-op
      // rather than a second vote, exactly as `recordTrialUse` is.
      .onConflictDoNothing({ target: variantUse.agentRunId })
  },

  async listArmRunIds(workspaceId, setId) {
    const rows = await db
      .select({ agentRunId: variantUse.agentRunId })
      .from(variantUse)
      .where(and(eq(variantUse.workspaceId, workspaceId), eq(variantUse.setId, setId)))
    return rows.map((row) => asAgentRunId(row.agentRunId))
  },

  /**
   * Assigned runs per arm, in-flight included — the count `nextVariantArm` balances.
   *
   * Distinct from the tally, which counts only decided runs: alternation has to balance
   * what has been handed out, or a burst of concurrent starts all lands on the arm that
   * happens to have finished least.
   */
  async countVariantArms(workspaceId, setId) {
    const rows = await db
      .select({ variantId: variantUse.variantId, value: count() })
      .from(variantUse)
      .where(and(eq(variantUse.workspaceId, workspaceId), eq(variantUse.setId, setId)))
      .groupBy(variantUse.variantId)
    return rows.map((row) => ({
      variantId: row.variantId === null ? null : asPersonaVariantId(row.variantId),
      count: Number(row.value),
    }))
  },

  /** The same joins and the same `decidedRun` as both trials. See `decidedRun`. */
  async listLosingArms(workspaceId, personaId, limit) {
    /**
     * A settled search that promoted something else, or promoted nothing at all. Both are a
     * loss for this candidate, and `promoted_variant_id is distinct from` covers the null
     * case in one predicate rather than leaving a discarded search's arms out of the buffer.
     */
    const where = and(
      eq(personaVariant.workspaceId, workspaceId),
      eq(personaVariant.personaId, personaId),
      eq(personaVariantSet.status, 'settled'),
      sql`${personaVariantSet.promotedVariantId} is distinct from ${personaVariant.id}`,
    )
    const [rows, [counted]] = await Promise.all([
      db
        .select({
          variantId: personaVariant.id,
          markdownSource: personaVariant.markdownSource,
          rationale: personaVariant.rationale,
          settledAt: personaVariantSet.settledAt,
          createdAt: personaVariantSet.createdAt,
          decided: sql<number>`count(*) filter (where ${decidedRun})::int`,
          kept: sql<number>`count(*) filter (where ${agentRun.branchDisposition} in ('merged', 'pushed'))::int`,
        })
        .from(personaVariant)
        .innerJoin(personaVariantSet, eq(personaVariantSet.id, personaVariant.setId))
        /**
         * Left joins all the way down: an arm that was never dealt a run is still a losing
         * arm, and it is arguably the most useful kind for a proposer — a candidate a human
         * discarded without spending anything on it. Inner joins would silently drop it.
         */
        .leftJoin(variantUse, eq(variantUse.variantId, personaVariant.id))
        .leftJoin(agentRun, eq(agentRun.id, variantUse.agentRunId))
        .leftJoin(runVerification, eq(runVerification.agentRunId, agentRun.id))
        .where(where)
        .groupBy(
          personaVariant.id,
          personaVariant.markdownSource,
          personaVariant.rationale,
          personaVariantSet.settledAt,
          personaVariantSet.createdAt,
          personaVariant.position,
        )
        .orderBy(desc(personaVariantSet.settledAt), personaVariant.position)
        .limit(limit),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(personaVariant)
        .innerJoin(personaVariantSet, eq(personaVariantSet.id, personaVariant.setId))
        .where(where),
    ])

    return {
      arms: rows.map((row) => ({
        variantId: asPersonaVariantId(row.variantId),
        markdownSource: row.markdownSource,
        rationale: row.rationale,
        decided: row.decided,
        kept: row.kept,
        settledAt: row.settledAt ?? row.createdAt,
      })),
      total: counted?.total ?? 0,
    }
  },

  async tallyVariantOutcomes(workspaceId, setId) {
    const rows = await db
      .select({
        variantId: variantUse.variantId,
        decided: sql<number>`count(*) filter (where ${decidedRun})::int`,
        merged: sql<number>`count(*) filter (where ${agentRun.branchDisposition} in ('merged', 'pushed'))::int`,
        discarded: sql<number>`count(*) filter (where ${agentRun.branchDisposition} = 'discarded')::int`,
        failed: sql<number>`count(*) filter (where ${agentRun.status} = 'failed')::int`,
        verificationFailed: verificationFailedCount,
        failingCheck: modalFailingCheck,
        costUsdTotal: sql<number>`coalesce(sum(${agentRun.totalCostUsd}) filter (where ${decidedRun}), 0)::double precision`,
      })
      .from(variantUse)
      .innerJoin(agentRun, eq(agentRun.id, variantUse.agentRunId))
      .leftJoin(runVerification, eq(runVerification.agentRunId, agentRun.id))
      .where(and(eq(variantUse.workspaceId, workspaceId), eq(variantUse.setId, setId)))
      .groupBy(variantUse.variantId)

    return rows.map((row) => ({
      variantId: row.variantId === null ? null : asPersonaVariantId(row.variantId),
      decided: row.decided,
      merged: row.merged,
      discarded: row.discarded,
      failed: row.failed,
      verificationFailed: row.verificationFailed,
      failingCheck: row.failingCheck,
      costUsdTotal: row.costUsdTotal,
    }))
  },

  /**
   * Settles a search, and only one that is open.
   *
   * The `status = 'open'` predicate is what makes a double settle a no-op rather than a
   * second decision: two humans clicking promote on two candidates at once would otherwise
   * both write, and the set would record the loser.
   */
  async settleSet(workspaceId, setId, input) {
    const [row] = await db
      .update(personaVariantSet)
      .set({
        status: 'settled',
        promotedVariantId: input.promotedVariantId ?? null,
        settledByUserId: input.settledByUserId ?? null,
        settledAt: new Date(),
      })
      .where(
        and(
          eq(personaVariantSet.workspaceId, workspaceId),
          eq(personaVariantSet.id, setId),
          eq(personaVariantSet.status, 'open'),
        ),
      )
      .returning()
    return row ? toPersonaVariantSet(row as PersonaVariantSetRow) : null
  },
})

const listVariantsOf = async (db: Database, workspaceId: WorkspaceId, setId: string) => {
  const rows = await db
    .select()
    .from(personaVariant)
    .where(and(eq(personaVariant.workspaceId, workspaceId), eq(personaVariant.setId, setId)))
    .orderBy(personaVariant.position)
  return rows.map((row) => toPersonaVariant(row as PersonaVariantRow))
}

export const personaGroupRepository = (db: Database): PersonaGroupRepositoryPort => ({
  async create(input) {
    const [row] = await db
      .insert(personaGroup)
      .values({ workspaceId: input.workspaceId, name: input.name, personaIds: input.personaIds })
      .returning()
    if (!row) throw new Error('persona_group insert returned no row')
    return toPersonaGroup(row as PersonaGroupRow)
  },

  async listByWorkspace(workspaceId) {
    const rows = await db.select().from(personaGroup).where(eq(personaGroup.workspaceId, workspaceId))
    return rows.map((row) => toPersonaGroup(row as PersonaGroupRow))
  },

  async update(workspaceId, id, patch) {
    const [row] = await db
      .update(personaGroup)
      .set({
        name: patch.name,
        personaIds: patch.personaIds,
        // Absent leaves the stored positions alone — see PersonaGroupRepositoryPort.
        ...(patch.layout === undefined ? {} : { layout: patch.layout }),
        // Same for the fleet: a client that does not draw widths means "leave them".
        ...(patch.fleet === undefined ? {} : { fleet: patch.fleet }),
        ...(patch.reviewers === undefined ? {} : { reviewers: patch.reviewers }),
        ...(patch.reportsTo === undefined ? {} : { reportsTo: patch.reportsTo }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.extraRepositoryIds === undefined
          ? {}
          : { extraRepositoryIds: patch.extraRepositoryIds }),
        // Null is a real value here — "nobody has chosen" — so absent and null differ:
        // absent leaves the stored root alone, null clears it back to picked-by-reach.
        ...(patch.orchestratorId === undefined ? {} : { orchestratorId: patch.orchestratorId }),
        // Absent and null differ here too — absent leaves the team's repository alone,
        // null is an operator un-choosing it.
        ...(patch.repositoryId === undefined ? {} : { repositoryId: patch.repositoryId }),
        updatedAt: new Date(),
      })
      .where(and(eq(personaGroup.workspaceId, workspaceId), eq(personaGroup.id, id)))
      .returning()
    if (!row) throw new NotFoundError('PersonaGroup')
    return toPersonaGroup(row as PersonaGroupRow)
  },

  async delete(workspaceId, id) {
    await db.delete(personaGroup).where(and(eq(personaGroup.workspaceId, workspaceId), eq(personaGroup.id, id)))
  },

  async prunePersona(workspaceId, personaId) {
    // `jsonb - text` drops every matching element of a jsonb array, so this is one
    // statement rather than a read of every group followed by a write of the matches.
    // The `jsonb_exists` guard keeps `updatedAt` honest: a group that never listed the
    // persona has not changed, and should not claim it did.
    const rows = await db
      .update(personaGroup)
      .set({
        personaIds: sql`${personaGroup.personaIds} - ${personaId}::text`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(personaGroup.workspaceId, workspaceId),
          sql`jsonb_exists(${personaGroup.personaIds}, ${personaId})`,
        ),
      )
      .returning({ id: personaGroup.id })
    return rows.length
  },
})

// --- Runner pairing (infra-only concern: not behind a port — see the replaceability
// note in agent-ports.ts. Node's crypto is a language builtin, not swappable vendor
// infra, so it doesn't need one). ---

const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex')

export const createRunnerPairing = async (
  db: Database,
  input: { workspaceId: string; name: string },
): Promise<{ runnerId: string; rawToken: string }> => {
  const rawToken = randomBytes(32).toString('base64url')
  const [row] = await db
    .insert(runner)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      pairingTokenHash: hashToken(rawToken),
      allowedRoots: [],
      connected: false,
    })
    .returning({ id: runner.id })
  if (!row) throw new Error('runner insert returned no row')
  return { runnerId: row.id, rawToken }
}

export const resolveRunnerByToken = async (
  db: Database,
  rawToken: string,
): Promise<{ id: string; workspaceId: string } | null> => {
  const [row] = await db
    .select({ id: runner.id, workspaceId: runner.workspaceId })
    .from(runner)
    .where(eq(runner.pairingTokenHash, hashToken(rawToken)))
    .limit(1)
  return row ?? null
}

/**
 * Called once at server boot. `runner.connected` is only cleared by the socket
 * close/error handler, so a server killed uncleanly (SIGKILL, crash) leaves
 * every flag stale-true while the next process starts with an empty in-memory
 * `connections` map — the UI then shows "connected" for a Runner that no
 * dispatch can reach. A fresh process has zero live connections by definition,
 * so resetting is always correct here; anything genuinely alive re-sets its own
 * flag through the Runner's existing auto-reconnect.
 *
 * Assumes a single server instance owns /ws/runner (true today). Horizontal
 * scaling would need per-instance connection ownership
 * instead, since this reset is global.
 */
export const clearAllRunnerConnections = async (db: Database): Promise<void> => {
  await db.update(runner).set({ connected: false }).where(eq(runner.connected, true))
}

export const setRunnerConnection = async (
  db: Database,
  runnerId: string,
  input: { connected: boolean; allowedRoots?: string[] },
): Promise<void> => {
  await db
    .update(runner)
    .set({
      connected: input.connected,
      lastSeenAt: new Date(),
      ...(input.allowedRoots !== undefined ? { allowedRoots: input.allowedRoots } : {}),
    })
    .where(eq(runner.id, runnerId))
}

/**
 * A persona's expertise in a subject.
 *
 * The one method worth reading is `writeFragment`, and the thing it is careful about is
 * bi-temporality: a claim is never overwritten and never deleted, so the map can answer
 * *when* it stopped believing something and not only what it believes now.
 */
export const subjectMapRepository = (db: Database): SubjectMapRepositoryPort => ({
  async upsertMap(input) {
    const [row] = await db
      .insert(subjectMap)
      .values({
        workspaceId: input.workspaceId,
        personaId: input.personaId,
        subjectKind: input.subjectKind,
        repositoryId: input.repositoryId,
        subjectRef: input.subjectRef,
        revision: input.revision,
        status: input.status,
        masteryRunId: input.masteryRunId,
      })
      .onConflictDoUpdate({
        target: [
          subjectMap.workspaceId,
          subjectMap.personaId,
          subjectMap.subjectKind,
          subjectMap.subjectRef,
        ],
        set: {
          revision: input.revision,
          status: input.status,
          masteryRunId: input.masteryRunId,
          repositoryId: input.repositoryId,
          updatedAt: new Date(),
        },
      })
      .returning()
    if (!row) throw new Error('subject_map upsert returned no row')
    return toSubjectMap(row as SubjectMapRow)
  },

  async setStatus(workspaceId, mapId, status) {
    const [row] = await db
      .update(subjectMap)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(subjectMap.workspaceId, workspaceId), eq(subjectMap.id, mapId)))
      .returning()
    return row ? toSubjectMap(row as SubjectMapRow) : null
  },

  async getMap(workspaceId, mapId) {
    const [row] = await db
      .select()
      .from(subjectMap)
      .where(and(eq(subjectMap.workspaceId, workspaceId), eq(subjectMap.id, mapId)))
    return row ? toSubjectMap(row as SubjectMapRow) : null
  },

  async findMapByRun(workspaceId, masteryRunId) {
    const [row] = await db
      .select()
      .from(subjectMap)
      .where(and(eq(subjectMap.workspaceId, workspaceId), eq(subjectMap.masteryRunId, masteryRunId)))
    return row ? toSubjectMap(row as SubjectMapRow) : null
  },

  async listMapsForPersona(workspaceId, personaId) {
    const rows = await db
      .select()
      .from(subjectMap)
      .where(and(eq(subjectMap.workspaceId, workspaceId), eq(subjectMap.personaId, personaId)))
      .orderBy(subjectMap.subjectKind, subjectMap.subjectRef)
    return rows.map((row) => toSubjectMap(row as SubjectMapRow))
  },

  async listWorkspacesWithMaps() {
    const rows = await db
      .selectDistinct({ workspaceId: subjectMap.workspaceId })
      .from(subjectMap)
      .where(eq(subjectMap.status, 'ready'))
    return rows.map((row) => row.workspaceId as WorkspaceId)
  },

  async listAllMaps(workspaceId) {
    const rows = await db
      .select()
      .from(subjectMap)
      .where(eq(subjectMap.workspaceId, workspaceId))
      .orderBy(subjectMap.subjectRef)
    return rows.map((row) => toSubjectMap(row as SubjectMapRow))
  },

  async listMapsForRepository(workspaceId, repositoryId) {
    const rows = await db
      .select()
      .from(subjectMap)
      .where(
        and(eq(subjectMap.workspaceId, workspaceId), eq(subjectMap.repositoryId, repositoryId)),
      )
      .orderBy(subjectMap.subjectRef)
    return rows.map((row) => toSubjectMap(row as SubjectMapRow))
  },

  /**
   * One transaction, and it is the only one in this file.
   *
   * Superseding is an invalidate *then* an insert, and a crash between the two would
   * leave the map with neither the old claim nor the new one — a node silently missing
   * from an artifact whose whole value is that a worker can rely on it. Every other
   * write in this repository is a single statement, which is why none of them needed
   * this.
   */
  async writeFragment(input) {
    return db.transaction(async (tx) => {
      let nodesWritten = 0
      let edgesWritten = 0
      let superseded = 0

      for (const node of input.nodes) {
        const [live] = await tx
          .select()
          .from(subjectMapNode)
          .where(
            and(
              eq(subjectMapNode.mapId, input.mapId),
              eq(subjectMapNode.key, node.key),
              isNull(subjectMapNode.invalidatedAt),
            ),
          )

        if (live) {
          const unchanged =
            live.kind === node.kind &&
            live.label === node.label &&
            live.summary === node.summary &&
            live.provenance === node.provenance &&
            live.observationCount === node.observationCount &&
            JSON.stringify(live.paths ?? []) === JSON.stringify(node.paths)

          if (unchanged) {
            // Re-confirmed, not rewritten. Without this branch a re-mastering would
            // invalidate every node and write it again, and the history would record
            // churn rather than change.
            await tx
              .update(subjectMapNode)
              .set({ derivedAtRevision: input.revision })
              .where(eq(subjectMapNode.id, live.id))
            continue
          }

          await tx
            .update(subjectMapNode)
            .set({ invalidatedAt: new Date(), invalidatedReason: 'superseded' })
            .where(eq(subjectMapNode.id, live.id))
          superseded += 1
        }

        await tx.insert(subjectMapNode).values({
          workspaceId: input.workspaceId,
          mapId: input.mapId,
          key: node.key,
          kind: node.kind,
          label: node.label,
          summary: node.summary,
          provenance: node.provenance,
          paths: node.paths,
          observationCount: node.observationCount,
          derivedAtRevision: input.revision,
        })
        nodesWritten += 1
      }

      for (const edge of input.edges) {
        // An edge carries no content beyond its identity, so a repeat is a
        // re-confirmation and never a supersession — `onConflictDoNothing` against the
        // live partial index is the whole of it.
        const inserted = await tx
          .insert(subjectMapEdge)
          .values({
            workspaceId: input.workspaceId,
            mapId: input.mapId,
            fromKey: edge.fromKey,
            toKey: edge.toKey,
            kind: edge.kind,
            provenance: edge.provenance,
            derivedAtRevision: input.revision,
          })
          .onConflictDoNothing()
          .returning()
        if (inserted.length > 0) edgesWritten += 1
      }

      return { nodesWritten, edgesWritten, superseded }
    })
  },

  async listNodes(workspaceId, mapId) {
    const rows = await db
      .select()
      .from(subjectMapNode)
      .where(and(eq(subjectMapNode.workspaceId, workspaceId), eq(subjectMapNode.mapId, mapId)))
      .orderBy(subjectMapNode.createdAt, subjectMapNode.key)
    return rows.map((row) => toMapNode(row as SubjectMapNodeRow))
  },

  /**
   * The atlas's read side — every live concept in the workspace, joined to
   * the subject and persona it came from, in one statement.
   *
   * One query rather than a map list plus a node read per map: this backs a *tool* a run
   * can reach for at any moment, and the number of maps grows with the number of projects,
   * so a loop would put an unbounded number of round-trips behind one model call.
   *
   * `ready` maps only. A map still being mastered is a partial reading of its subject, and
   * a lead drawn from one would point at a conclusion its own author had not finished.
   */
  async listConceptsAcrossSubjects(workspaceId, options) {
    const rows = await db
      .select({
        nodeId: subjectMapNode.id,
        mapId: subjectMapNode.mapId,
        label: subjectMapNode.label,
        summary: subjectMapNode.summary,
        subjectRef: subjectMap.subjectRef,
        personaName: agentPersona.name,
        createdAt: subjectMapNode.createdAt,
      })
      .from(subjectMapNode)
      .innerJoin(subjectMap, eq(subjectMapNode.mapId, subjectMap.id))
      .innerJoin(agentPersona, eq(subjectMap.personaId, agentPersona.id))
      .where(
        and(
          eq(subjectMapNode.workspaceId, workspaceId),
          isNull(subjectMapNode.invalidatedAt),
          inArray(subjectMapNode.kind, [...CONCEPT_NODE_KINDS]),
          eq(subjectMap.status, 'ready'),
          options.excludeRepositoryId === undefined
            ? sql`true`
            : sql`(${subjectMap.repositoryId} is null or ${subjectMap.repositoryId} <> ${options.excludeRepositoryId})`,
        ),
      )
      .orderBy(desc(subjectMapNode.createdAt))
      .limit(options.limit)
    return rows.map((row) => ({
      nodeId: row.nodeId,
      mapId: asSubjectMapId(row.mapId),
      label: row.label,
      summary: row.summary ?? '',
      subjectRef: row.subjectRef,
      personaName: row.personaName,
      createdAt: row.createdAt,
    }))
  },

  async findConceptsByLabel(workspaceId, input) {
    const rows = await db
      .select({
        nodeId: subjectMapNode.id,
        mapId: subjectMapNode.mapId,
        kind: subjectMapNode.kind,
        label: subjectMapNode.label,
        summary: subjectMapNode.summary,
        subjectRef: subjectMap.subjectRef,
        repositoryId: subjectMap.repositoryId,
        personaId: subjectMap.personaId,
        personaName: agentPersona.name,
        updatedAt: subjectMap.updatedAt,
      })
      .from(subjectMapNode)
      .innerJoin(subjectMap, eq(subjectMapNode.mapId, subjectMap.id))
      .innerJoin(agentPersona, eq(subjectMap.personaId, agentPersona.id))
      .where(
        and(
          eq(subjectMapNode.workspaceId, workspaceId),
          isNull(subjectMapNode.invalidatedAt),
          inArray(subjectMapNode.kind, [...CONCEPT_NODE_KINDS]),
          eq(subjectMap.status, 'ready'),
          sql`lower(${subjectMapNode.label}) = lower(${input.label})`,
          input.repositoryId === undefined
            ? sql`true`
            : eq(subjectMap.repositoryId, input.repositoryId),
          input.subjectRef === undefined ? sql`true` : eq(subjectMap.subjectRef, input.subjectRef),
        ),
      )
      // Most recently mastered first: when one label appears in two maps of one subject,
      // the newer reading is the one a proposal should be about.
      .orderBy(desc(subjectMap.updatedAt))
    return rows.map((row) => ({
      nodeId: row.nodeId,
      mapId: asSubjectMapId(row.mapId),
      kind: row.kind as MapNodeKind,
      label: row.label,
      summary: row.summary ?? '',
      subjectRef: row.subjectRef,
      repositoryId: row.repositoryId === null ? null : asRepositoryId(row.repositoryId),
      personaId: asAgentPersonaId(row.personaId),
      personaName: row.personaName,
    }))
  },

  async listEdges(workspaceId, mapId) {
    const rows = await db
      .select()
      .from(subjectMapEdge)
      .where(and(eq(subjectMapEdge.workspaceId, workspaceId), eq(subjectMapEdge.mapId, mapId)))
      .orderBy(subjectMapEdge.createdAt, subjectMapEdge.fromKey)
    return rows.map((row) => toMapEdge(row as SubjectMapEdgeRow))
  },

  async countLive(workspaceId, mapId) {
    const [nodeRow] = await db
      .select({ total: count() })
      .from(subjectMapNode)
      .where(
        and(
          eq(subjectMapNode.workspaceId, workspaceId),
          eq(subjectMapNode.mapId, mapId),
          isNull(subjectMapNode.invalidatedAt),
        ),
      )
    const [edgeRow] = await db
      .select({ total: count() })
      .from(subjectMapEdge)
      .where(
        and(
          eq(subjectMapEdge.workspaceId, workspaceId),
          eq(subjectMapEdge.mapId, mapId),
          isNull(subjectMapEdge.invalidatedAt),
        ),
      )
    return { nodes: Number(nodeRow?.total ?? 0), edges: Number(edgeRow?.total ?? 0) }
  },

  /**
   * Stamps rather than deletes, and only ever a live row: `isNull(invalidatedAt)` in
   * the predicate is what stops a second pass moving an existing invalidation forward
   * and losing the answer to "when did we stop believing this".
   */
  async invalidateNodes(workspaceId, nodeIds, reason) {
    if (nodeIds.length === 0) return 0
    const rows = await db
      .update(subjectMapNode)
      .set({ invalidatedAt: new Date(), invalidatedReason: reason })
      .where(
        and(
          eq(subjectMapNode.workspaceId, workspaceId),
          inArray(subjectMapNode.id, [...nodeIds]),
          isNull(subjectMapNode.invalidatedAt),
        ),
      )
      .returning({ id: subjectMapNode.id })
    return rows.length
  },

  async proposeRetirement(workspaceId, nodeIds, reason) {
    if (nodeIds.length === 0) return 0
    const rows = await db
      .update(subjectMapNode)
      .set({
        retirementProposedAt: reason === null ? null : new Date(),
        retirementReason: reason,
      })
      .where(
        and(
          eq(subjectMapNode.workspaceId, workspaceId),
          inArray(subjectMapNode.id, [...nodeIds]),
          // Never re-stamps a claim already retired: a proposal to retire something that
          // is gone would keep resurfacing in every report as work nobody can do.
          isNull(subjectMapNode.invalidatedAt),
        ),
      )
      .returning({ id: subjectMapNode.id })
    return rows.length
  },

  async appendCheckpoint(input) {
    const [row] = await db
      .insert(masteryCheckpoint)
      .values({
        workspaceId: input.workspaceId,
        mapId: input.mapId,
        agentRunId: input.agentRunId,
        filesRead: input.filesRead,
        filesInScope: input.filesInScope,
        nodeCount: input.nodeCount,
        edgeCount: input.edgeCount,
        spendUsd: input.spendUsd,
      })
      .returning()
    if (!row) throw new Error('mastery_checkpoint insert returned no row')
    return {
      at: row.createdAt,
      filesRead: row.filesRead,
      filesInScope: row.filesInScope,
      nodeCount: row.nodeCount,
      edgeCount: row.edgeCount,
      spendUsd: row.spendUsd,
    }
  },

  async listCheckpoints(workspaceId, mapId) {
    const rows = await db
      .select()
      .from(masteryCheckpoint)
      .where(
        and(eq(masteryCheckpoint.workspaceId, workspaceId), eq(masteryCheckpoint.mapId, mapId)),
      )
      .orderBy(masteryCheckpoint.seq)
    return rows.map((row) => ({
      at: row.createdAt,
      filesRead: row.filesRead,
      filesInScope: row.filesInScope,
      nodeCount: row.nodeCount,
      edgeCount: row.edgeCount,
      spendUsd: row.spendUsd,
    }))
  },

  async setRetrievalOverride(workspaceId, mapId, override) {
    const [row] = await db
      .update(subjectMap)
      .set({ retrievalOverride: override, updatedAt: new Date() })
      .where(and(eq(subjectMap.workspaceId, workspaceId), eq(subjectMap.id, mapId)))
      .returning()
    return row ? toSubjectMap(row as SubjectMapRow) : null
  },

  async recordExpertiseUse(input) {
    const rows = await db
      .insert(expertiseUse)
      .values({
        workspaceId: input.workspaceId,
        mapId: input.mapId,
        agentRunId: input.agentRunId,
        arm: input.arm,
        nodesShown: input.nodesShown,
        edgesShown: input.edgesShown,
      })
      /**
       * A run is on one arm. `doNothing` rather than an update because the first
       * assignment is the real one: a retry that re-recorded a different arm would move a
       * run between the groups it is being counted in, which is the way an A/B
       * measurement quietly stops being one.
       */
      .onConflictDoNothing({
        target: [expertiseUse.workspaceId, expertiseUse.agentRunId, expertiseUse.mapId],
      })
      .returning({ id: expertiseUse.id })

    /**
     * The citations, on the row that was just written.
     *
     * `returning()` is empty exactly when `doNothing` fired — a retry of a run already
     * assigned an arm — and then there is nothing to cite either: the first assignment is
     * the real one, and its node list was written with it. Writing a second set here would
     * attribute the same run's citations twice.
     */
    const useId = rows[0]?.id
    if (useId === undefined || input.nodeIds.length === 0) return

    await db
      .insert(expertiseUseNode)
      .values(
        input.nodeIds.map((nodeId) => ({
          workspaceId: input.workspaceId,
          useId,
          nodeId,
          mapId: input.mapId,
        })),
      )
      .onConflictDoNothing({ target: [expertiseUseNode.useId, expertiseUseNode.nodeId] })
  },

  async tallyNodeOutcomes(workspaceId, mapId) {
    /**
     * Joined against the run at read time, like `tallyExpertiseOutcomes` and for the same
     * reason: a disposition is set long after the run started, and a copy onto the
     * citation row would be a second write that can be missed.
     */
    const rows = await db
      .select({
        nodeId: expertiseUseNode.nodeId,
        decided: sql<number>`count(*) filter (where ${agentRun.branchDisposition} is not null or ${agentRun.status} = 'failed')::int`,
        merged: sql<number>`count(*) filter (where ${agentRun.branchDisposition} in ('merged', 'pushed'))::int`,
        discarded: sql<number>`count(*) filter (where ${agentRun.branchDisposition} = 'discarded')::int`,
        failed: sql<number>`count(*) filter (where ${agentRun.status} = 'failed')::int`,
      })
      .from(expertiseUseNode)
      .innerJoin(expertiseUse, eq(expertiseUse.id, expertiseUseNode.useId))
      .innerJoin(agentRun, eq(agentRun.id, expertiseUse.agentRunId))
      .where(
        and(eq(expertiseUseNode.workspaceId, workspaceId), eq(expertiseUseNode.mapId, mapId)),
      )
      .groupBy(expertiseUseNode.nodeId)

    const byNode: Record<
      string,
      { decided: number; merged: number; discarded: number; failed: number }
    > = {}
    for (const row of rows) {
      byNode[row.nodeId] = {
        decided: row.decided,
        merged: row.merged,
        discarded: row.discarded,
        failed: row.failed,
      }
    }
    return byNode
  },

  async countExpertiseUses(workspaceId, mapId) {
    const rows = await db
      .select({ arm: expertiseUse.arm, count: sql<number>`count(*)::int` })
      .from(expertiseUse)
      .where(and(eq(expertiseUse.workspaceId, workspaceId), eq(expertiseUse.mapId, mapId)))
      .groupBy(expertiseUse.arm)

    const find = (arm: string) => rows.find((row) => row.arm === arm)?.count ?? 0
    return { retrieved: find('retrieved'), withheld: find('withheld') }
  },

  async tallyExpertiseOutcomes(workspaceId, mapIds) {
    if (mapIds.length === 0) return {}

    /**
     * Joined against the run rather than copied onto the use row, because a disposition
     * is set long after the run started — a copy would be a second write that can be
     * missed, which is how a measurement ends up describing runs nobody decided about.
     *
     * `decided` is `decidedRun`, shared with the prompt trial: a run a human ruled on, a
     * run that failed outright, or a branch that failed its repository's definition of
     * done. A run still in flight is not evidence either way, and counting it as an
     * unmerged one would make every arm look worse the busier the workspace is.
     */
    const rows = await db
      .select({
        mapId: expertiseUse.mapId,
        arm: expertiseUse.arm,
        decided: sql<number>`count(*) filter (where ${decidedRun})::int`,
        merged: sql<number>`count(*) filter (where ${agentRun.branchDisposition} in ('merged', 'pushed'))::int`,
        discarded: sql<number>`count(*) filter (where ${agentRun.branchDisposition} = 'discarded')::int`,
        failed: sql<number>`count(*) filter (where ${agentRun.status} = 'failed')::int`,
        verificationFailed: verificationFailedCount,
        failingCheck: modalFailingCheck,
        costUsdTotal: sql<number>`coalesce(sum(${agentRun.totalCostUsd}) filter (where ${decidedRun}), 0)::double precision`,
      })
      .from(expertiseUse)
      .innerJoin(agentRun, eq(agentRun.id, expertiseUse.agentRunId))
      .leftJoin(runVerification, eq(runVerification.agentRunId, agentRun.id))
      .where(
        and(
          eq(expertiseUse.workspaceId, workspaceId),
          inArray(expertiseUse.mapId, [...mapIds]),
        ),
      )
      .groupBy(expertiseUse.mapId, expertiseUse.arm)

    const byMap: Record<string, ExpertiseArmTally[]> = {}
    for (const row of rows) {
      if (row.arm !== 'retrieved' && row.arm !== 'withheld') continue
      byMap[row.mapId] = [
        ...(byMap[row.mapId] ?? []),
        {
          arm: row.arm,
          decided: row.decided,
          merged: row.merged,
          discarded: row.discarded,
          failed: row.failed,
          verificationFailed: row.verificationFailed,
          failingCheck: row.failingCheck,
          costUsdTotal: row.costUsdTotal,
        },
      ]
    }
    return byMap
  },

  async listExpertiseUsesForRuns(workspaceId, agentRunIds) {
    if (agentRunIds.length === 0) return []
    const rows = await db
      .select()
      .from(expertiseUse)
      .where(
        and(
          eq(expertiseUse.workspaceId, workspaceId),
          inArray(expertiseUse.agentRunId, [...agentRunIds]),
        ),
      )
    return rows
      .filter((row) => row.arm === 'retrieved' || row.arm === 'withheld')
      .map((row) => ({
        agentRunId: row.agentRunId,
        mapId: row.mapId,
        arm: row.arm as 'retrieved' | 'withheld',
        nodesShown: row.nodesShown,
        edgesShown: row.edgesShown,
      }))
  },
})

/**
 * The Colosseum. Convening writes the roster once and never again — the
 * fixed roster is not a rule enforced at read time, it is the absence of an add method.
 */
export const colosseumRepository = (db: Database): ColosseumRepositoryPort => {
  const toSession = (row: typeof colosseumSession.$inferSelect): ColosseumSession => ({
    id: row.id,
    workspaceId: asWorkspaceId(row.workspaceId),
    threadId: asThreadId(row.threadId),
    repositoryId: row.repositoryId === null ? null : asRepositoryId(row.repositoryId),
    purpose: row.purpose as ColosseumSession['purpose'],
    subject: row.subject,
    question: row.question,
    status: row.status as ColosseumSession['status'],
    turnCap: row.turnCap,
    spendCapUsd: row.spendCapUsd,
    distinctSubjects: row.distinctSubjects,
    distinctModels: row.distinctModels,
    speakingRunId: row.speakingRunId,
    speakingPersonaId:
      row.speakingPersonaId === null ? null : asAgentPersonaId(row.speakingPersonaId),
    createdAt: row.createdAt,
    concludedAt: row.concludedAt,
  })

  const toClaim = (row: typeof colosseumClaim.$inferSelect): ColosseumClaim => ({
    id: row.id,
    statement: row.statement,
    originalHolderPersonaId: asAgentPersonaId(row.originalHolderPersonaId),
    verdict: row.verdict as ColosseumClaim['verdict'],
    citation: row.citation,
    droppedAt: row.droppedAt,
  })

  return {
    async convene(input) {
      const [row] = await db
        .insert(colosseumSession)
        .values({
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          repositoryId: input.repositoryId,
          purpose: input.purpose,
          subject: input.subject,
          question: input.question,
          turnCap: input.turnCap,
          spendCapUsd: input.spendCapUsd,
          distinctSubjects: input.diversity.subjects,
          distinctModels: input.diversity.models,
        })
        .returning()
      if (!row) throw new Error('colosseum_session insert returned no row')

      await db.insert(colosseumParticipant).values(
        input.participants.map((participant) => ({
          workspaceId: input.workspaceId,
          sessionId: row.id,
          personaId: participant.personaId,
          personaName: participant.personaName,
          mapId: participant.mapId,
          model: participant.model,
          subjectRef: participant.subjectRef,
        })),
      )
      return toSession(row)
    },

    async getSession(workspaceId, sessionId) {
      const [row] = await db
        .select()
        .from(colosseumSession)
        .where(
          and(eq(colosseumSession.workspaceId, workspaceId), eq(colosseumSession.id, sessionId)),
        )
      return row ? toSession(row) : null
    },

    async listSessions(workspaceId) {
      const rows = await db
        .select()
        .from(colosseumSession)
        .where(eq(colosseumSession.workspaceId, workspaceId))
        .orderBy(desc(colosseumSession.createdAt))
      return rows.map(toSession)
    },

    async listParticipants(workspaceId, sessionId) {
      const rows = await db
        .select()
        .from(colosseumParticipant)
        .where(
          and(
            eq(colosseumParticipant.workspaceId, workspaceId),
            eq(colosseumParticipant.sessionId, sessionId),
          ),
        )
      return rows.map((row) => ({
        personaId: asAgentPersonaId(row.personaId),
        personaName: row.personaName,
        mapId: row.mapId === null ? null : asSubjectMapId(row.mapId),
        model: row.model,
        subjectRef: row.subjectRef,
      }))
    },

    async setStatus(workspaceId, sessionId, status) {
      const [row] = await db
        .update(colosseumSession)
        .set({
          status,
          // Stamped by the transition rather than by a caller: "when did this end" has
          // exactly one right answer and it is not a parameter.
          ...(status === 'concluded' || status === 'abandoned' ? { concludedAt: new Date() } : {}),
        })
        .where(
          and(eq(colosseumSession.workspaceId, workspaceId), eq(colosseumSession.id, sessionId)),
        )
        .returning()
      return row ? toSession(row) : null
    },

    /**
     * Claims the floor for one run, or refuses.
     *
     * Conditional on the floor being free, in the update itself rather than in a read
     * beforehand: two turn requests racing would both read `null` and both start a run,
     * and the second one's answer would land in a transcript that had already moved on.
     * The `returning()` being empty *is* the refusal.
     */
    async claimFloor(workspaceId, sessionId, input) {
      const rows = await db
        .update(colosseumSession)
        .set({ speakingRunId: input.agentRunId, speakingPersonaId: input.personaId })
        .where(
          and(
            eq(colosseumSession.workspaceId, workspaceId),
            eq(colosseumSession.id, sessionId),
            isNull(colosseumSession.speakingRunId),
          ),
        )
        .returning()
      return rows.length > 0
    },

    async releaseFloor(workspaceId, sessionId) {
      await db
        .update(colosseumSession)
        .set({ speakingRunId: null, speakingPersonaId: null })
        .where(
          and(eq(colosseumSession.workspaceId, workspaceId), eq(colosseumSession.id, sessionId)),
        )
    },

    async findSessionSpeakingFor(workspaceId, agentRunId) {
      const [row] = await db
        .select()
        .from(colosseumSession)
        .where(
          and(
            eq(colosseumSession.workspaceId, workspaceId),
            eq(colosseumSession.speakingRunId, agentRunId),
          ),
        )
      return row ? toSession(row) : null
    },

    async recordClaim(input) {
      const [row] = await db
        .insert(colosseumClaim)
        .values({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          statement: input.statement,
          originalHolderPersonaId: input.originalHolderPersonaId,
        })
        .returning()
      if (!row) throw new Error('colosseum_claim insert returned no row')
      return toClaim(row)
    },

    async listClaims(workspaceId, sessionId) {
      const rows = await db
        .select()
        .from(colosseumClaim)
        .where(
          and(eq(colosseumClaim.workspaceId, workspaceId), eq(colosseumClaim.sessionId, sessionId)),
        )
        .orderBy(colosseumClaim.createdAt)
      return rows.map(toClaim)
    },

    async settleClaim(input) {
      const [row] = await db
        .update(colosseumClaim)
        .set({ verdict: input.verdict, citation: input.citation })
        .where(
          and(
            eq(colosseumClaim.workspaceId, input.workspaceId),
            eq(colosseumClaim.id, input.claimId),
          ),
        )
        .returning()
      return row ? toClaim(row) : null
    },

    async dropClaim(workspaceId, claimId) {
      const [row] = await db
        .update(colosseumClaim)
        .set({ droppedAt: new Date() })
        .where(and(eq(colosseumClaim.workspaceId, workspaceId), eq(colosseumClaim.id, claimId)))
        .returning()
      return row ? toClaim(row) : null
    },

    async appendTurn(input) {
      /**
       * The sequence is taken from what is already there rather than from a counter the
       * caller keeps: two turns racing would otherwise both be "turn 3", and the unique
       * index would reject one — which is the right failure, but a caller-side counter
       * makes it a failure at all.
       */
      const [existing] = await db
        .select({ max: sql<number>`coalesce(max(${colosseumTurn.seq}), 0)::int` })
        .from(colosseumTurn)
        .where(
          and(
            eq(colosseumTurn.workspaceId, input.workspaceId),
            eq(colosseumTurn.sessionId, input.sessionId),
          ),
        )
      const seq = (existing?.max ?? 0) + 1

      await db.insert(colosseumTurn).values({
        seq,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        personaId: input.personaId,
        personaName: input.personaName,
        agentRunId: input.agentRunId,
        text: input.text,
      })
      return { seq }
    },

    async listTurns(workspaceId, sessionId) {
      const rows = await db
        .select()
        .from(colosseumTurn)
        .where(
          and(eq(colosseumTurn.workspaceId, workspaceId), eq(colosseumTurn.sessionId, sessionId)),
        )
        .orderBy(colosseumTurn.seq)
      return rows.map((row) => ({
        seq: row.seq,
        personaName: row.personaName,
        agentRunId: row.agentRunId,
        text: row.text,
        createdAt: row.createdAt,
      }))
    },

    async countTurns(workspaceId, sessionId) {
      const [row] = await db
        .select({ total: count() })
        .from(colosseumTurn)
        .where(
          and(eq(colosseumTurn.workspaceId, workspaceId), eq(colosseumTurn.sessionId, sessionId)),
        )
      return row?.total ?? 0
    },
  }
}

/**
 * Note-read edges. See the `note_read_edge` table for why this is an edge
 * per pair rather than a row per read.
 */
export const noteReadRepository = (db: Database): NoteReadRepositoryPort => ({
  async recordReads(input) {
    if (input.authorRunIds.length === 0) return
    const now = new Date()
    await db
      .insert(noteReadEdge)
      .values(
        [...new Set(input.authorRunIds)].map((authorRunId) => ({
          workspaceId: input.workspaceId,
          treeRunId: input.treeRunId,
          readerRunId: input.readerRunId,
          authorRunId,
          lastReadAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [noteReadEdge.workspaceId, noteReadEdge.readerRunId, noteReadEdge.authorRunId],
        // `firstReadAt` is deliberately untouched: "when did this run first learn from
        // that one" is the answer the edge exists to keep, and an upsert that moved it
        // would replace it with "most recently".
        set: { readCount: sql`${noteReadEdge.readCount} + 1`, lastReadAt: now },
      })
  },

  async listByTree(workspaceId, treeRunId) {
    const rows = await db
      .select()
      .from(noteReadEdge)
      .where(and(eq(noteReadEdge.workspaceId, workspaceId), eq(noteReadEdge.treeRunId, treeRunId)))
      .orderBy(noteReadEdge.firstReadAt)
    return rows.map((row) => ({
      readerRunId: asAgentRunId(row.readerRunId),
      authorRunId: asAgentRunId(row.authorRunId),
      readCount: row.readCount,
      lastReadAt: row.lastReadAt,
    }))
  },
})

/**
 * The atlas's write side.
 *
 * Every read joins both endpoints through to the persona that learned them, because an
 * atlas edge is unreadable without them: "these two concepts are the same" names nothing
 * a human can check unless it also says which subjects and whose expertise. Two aliased
 * joins per end rather than labels copied onto the row — a copied label is the label as it
 * was when the relation was proposed, and a curation pass that rewords a concept would
 * leave the atlas quoting a sentence its own map no longer contains.
 */
export const atlasRepository = (db: Database): AtlasRepositoryPort => {
  const fromNode = alias(subjectMapNode, 'from_node')
  const toNode = alias(subjectMapNode, 'to_node')
  const fromMap = alias(subjectMap, 'from_map')
  const toMap = alias(subjectMap, 'to_map')
  const fromPersona = alias(agentPersona, 'from_persona')
  const toPersona = alias(agentPersona, 'to_persona')
  const proposer = alias(agentPersona, 'proposer')

  const selection = {
    id: atlasEdge.id,
    relation: atlasEdge.relation,
    rationale: atlasEdge.rationale,
    status: atlasEdge.status,
    proposedByRunId: atlasEdge.proposedByRunId,
    proposerName: proposer.name,
    sessionId: atlasEdge.sessionId,
    decidedByName: atlasEdge.decidedByName,
    decidedAt: atlasEdge.decidedAt,
    decisionNote: atlasEdge.decisionNote,
    createdAt: atlasEdge.createdAt,
    fromNodeId: fromNode.id,
    fromMapId: fromNode.mapId,
    fromLabel: fromNode.label,
    fromSummary: fromNode.summary,
    fromInvalidatedAt: fromNode.invalidatedAt,
    fromSubjectRef: fromMap.subjectRef,
    fromPersonaName: fromPersona.name,
    toNodeId: toNode.id,
    toMapId: toNode.mapId,
    toLabel: toNode.label,
    toSummary: toNode.summary,
    toInvalidatedAt: toNode.invalidatedAt,
    toSubjectRef: toMap.subjectRef,
    toPersonaName: toPersona.name,
  }

  type Row = { [K in keyof typeof selection]: unknown }

  const joined = () =>
    db
      .select(selection)
      .from(atlasEdge)
      .innerJoin(fromNode, eq(atlasEdge.fromNodeId, fromNode.id))
      .innerJoin(toNode, eq(atlasEdge.toNodeId, toNode.id))
      .innerJoin(fromMap, eq(fromNode.mapId, fromMap.id))
      .innerJoin(toMap, eq(toNode.mapId, toMap.id))
      .innerJoin(fromPersona, eq(fromMap.personaId, fromPersona.id))
      .innerJoin(toPersona, eq(toMap.personaId, toPersona.id))
      .leftJoin(proposer, eq(atlasEdge.proposedByPersonaId, proposer.id))

  const toEdge = (row: Row): AtlasEdge => ({
    id: row.id as string,
    relation: row.relation as AtlasEdge['relation'],
    rationale: row.rationale as string,
    status: row.status as AtlasEdge['status'],
    from: {
      nodeId: row.fromNodeId as string,
      mapId: asSubjectMapId(row.fromMapId as string),
      label: row.fromLabel as string,
      summary: (row.fromSummary as string | null) ?? '',
      subjectRef: row.fromSubjectRef as string,
      personaName: row.fromPersonaName as string,
      live: row.fromInvalidatedAt === null,
    },
    to: {
      nodeId: row.toNodeId as string,
      mapId: asSubjectMapId(row.toMapId as string),
      label: row.toLabel as string,
      summary: (row.toSummary as string | null) ?? '',
      subjectRef: row.toSubjectRef as string,
      personaName: row.toPersonaName as string,
      live: row.toInvalidatedAt === null,
    },
    // Empty rather than null when the persona is gone: the claim outlives its author, and
    // every reader of this field is rendering a sentence.
    proposedByPersonaName: (row.proposerName as string | null) ?? '',
    proposedByRunId: (row.proposedByRunId as string | null) ?? null,
    sessionId: (row.sessionId as string | null) ?? null,
    decidedByName: row.decidedByName as string,
    decidedAt: (row.decidedAt as Date | null) ?? null,
    decisionNote: row.decisionNote as string,
    createdAt: row.createdAt as Date,
  })

  const byId = async (workspaceId: WorkspaceId, edgeId: string): Promise<AtlasEdge | null> => {
    const rows = await joined().where(
      and(eq(atlasEdge.workspaceId, workspaceId), eq(atlasEdge.id, edgeId)),
    )
    return rows[0] ? toEdge(rows[0]) : null
  }

  return {
    async propose(input) {
      const [row] = await db
        .insert(atlasEdge)
        .values({
          workspaceId: input.workspaceId,
          fromNodeId: input.fromNodeId,
          toNodeId: input.toNodeId,
          relation: input.relation,
          rationale: input.rationale,
          proposedByPersonaId: input.proposedByPersonaId,
          proposedByRunId: input.proposedByRunId,
        })
        /**
         * Nothing is written on conflict, and that is the point rather than laziness: a
         * second agent proposing the same relation must not overwrite the first one's
         * rationale, and it certainly must not reset a decided row to `proposed`. The
         * caller is told `created: false` and reports where the existing one got to.
         */
        .onConflictDoNothing({
          target: [
            atlasEdge.workspaceId,
            atlasEdge.fromNodeId,
            atlasEdge.toNodeId,
            atlasEdge.relation,
          ],
        })
        .returning({ id: atlasEdge.id })

      if (row) {
        const created = await byId(input.workspaceId, row.id)
        if (!created) throw new Error('atlas_edge insert returned no readable row')
        return { edge: created, created: true }
      }

      const rows = await joined().where(
        and(
          eq(atlasEdge.workspaceId, input.workspaceId),
          eq(atlasEdge.fromNodeId, input.fromNodeId),
          eq(atlasEdge.toNodeId, input.toNodeId),
          eq(atlasEdge.relation, input.relation),
        ),
      )
      const existing = rows[0]
      if (!existing) throw new Error('atlas_edge conflicted with a row that cannot be read')
      return { edge: toEdge(existing), created: false }
    },

    get: byId,

    async list(workspaceId, options) {
      const statuses = options?.statuses
      const rows = await joined()
        .where(
          and(
            eq(atlasEdge.workspaceId, workspaceId),
            statuses === undefined ? sql`true` : inArray(atlasEdge.status, [...statuses]),
          ),
        )
        .orderBy(desc(atlasEdge.createdAt))
      return rows.map(toEdge)
    },

    async countByStatus(workspaceId, statuses) {
      if (statuses.length === 0) return 0
      const [row] = await db
        .select({ total: count() })
        .from(atlasEdge)
        .where(
          and(eq(atlasEdge.workspaceId, workspaceId), inArray(atlasEdge.status, [...statuses])),
        )
      return Number(row?.total ?? 0)
    },

    async listPromotedTouching(workspaceId, nodeIds) {
      if (nodeIds.length === 0) return []
      const ids = [...new Set(nodeIds)]
      const rows = await joined()
        .where(
          and(
            eq(atlasEdge.workspaceId, workspaceId),
            eq(atlasEdge.status, 'promoted'),
            or(inArray(atlasEdge.fromNodeId, ids), inArray(atlasEdge.toNodeId, ids)),
          ),
        )
        .orderBy(desc(atlasEdge.decidedAt))
      return rows.map(toEdge)
    },

    async attachSession(workspaceId, edgeId, sessionId) {
      const [row] = await db
        .update(atlasEdge)
        .set({ sessionId, status: 'contended' })
        .where(
          and(
            eq(atlasEdge.workspaceId, workspaceId),
            eq(atlasEdge.id, edgeId),
            // Only an undecided proposal enters a venue. A promoted relation sent back to
            // be argued over would silently un-confirm what a human confirmed.
            eq(atlasEdge.status, 'proposed'),
          ),
        )
        .returning({ id: atlasEdge.id })
      return row ? byId(workspaceId, row.id) : null
    },

    async decide(input) {
      const [row] = await db
        .update(atlasEdge)
        .set({
          status: input.status,
          decidedByUserId: input.decidedByUserId,
          decidedByName: input.decidedByName,
          decidedAt: new Date(),
          decisionNote: input.note,
        })
        .where(
          and(
            eq(atlasEdge.workspaceId, input.workspaceId),
            eq(atlasEdge.id, input.edgeId),
            inArray(atlasEdge.status, ['proposed', 'contended']),
          ),
        )
        .returning({ id: atlasEdge.id })
      return row ? byId(input.workspaceId, row.id) : null
    },
  }
}
