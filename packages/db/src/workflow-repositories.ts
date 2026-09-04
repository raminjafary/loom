import {
  asAgentRunId,
  asRepositoryId,
  asThreadId,
  asWorkflowId,
  asWorkflowRunId,
  asWorkflowStepRunId,
  asWorkflowVersionId,
  asWorkspaceId,
  type WorkflowGraph,
  type WorkflowRecord,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowStepRunRecord,
  type WorkflowStepStatus,
  type WorkflowVersionRecord,
} from '@loom/domain'
import type { WorkflowRepositoryPort } from '@loom/application'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from './client.js'
import { workflow, workflowRun, workflowStepRun, workflowVersion } from './schema.js'

const toWorkflow = (row: {
  id: string
  workspaceId: string
  name: string
  description: string | null
  createdByUserId: string | null
  createdAt: Date
  archivedAt: Date | null
}): WorkflowRecord => ({
  id: asWorkflowId(row.id),
  workspaceId: asWorkspaceId(row.workspaceId),
  name: row.name,
  description: row.description,
  createdByUserId: row.createdByUserId,
  createdAt: row.createdAt,
  archivedAt: row.archivedAt,
})

const toVersion = (row: {
  id: string
  workflowId: string
  version: number
  graph: unknown
  digest: string
  createdByUserId: string | null
  createdAt: Date
}): WorkflowVersionRecord => ({
  id: asWorkflowVersionId(row.id),
  workflowId: asWorkflowId(row.workflowId),
  version: row.version,
  graph: row.graph as WorkflowGraph,
  digest: row.digest,
  createdByUserId: row.createdByUserId,
  createdAt: row.createdAt,
})

const toRun = (row: {
  id: string
  workspaceId: string
  workflowVersionId: string
  repositoryId: string
  threadId: string
  input: string
  status: string
  capUsd: number | null
  startedByUserId: string | null
  haltReason: string | null
  createdAt: Date
  finishedAt: Date | null
}): WorkflowRunRecord => ({
  id: asWorkflowRunId(row.id),
  workspaceId: asWorkspaceId(row.workspaceId),
  workflowVersionId: asWorkflowVersionId(row.workflowVersionId),
  repositoryId: asRepositoryId(row.repositoryId),
  threadId: asThreadId(row.threadId),
  input: row.input,
  status: row.status as WorkflowRunStatus,
  capUsd: row.capUsd,
  startedByUserId: row.startedByUserId,
  haltReason: row.haltReason,
  createdAt: row.createdAt,
  finishedAt: row.finishedAt,
})

const toStep = (row: {
  id: string
  workflowRunId: string
  nodeId: string
  pass: number
  itemIndex: number
  item: string | null
  claimedAt: Date | null
  agentRunId: string | null
  status: string
  answer: unknown
  reason: string | null
  costUsd: number | null
  finishedAt: Date | null
}): WorkflowStepRunRecord => ({
  id: asWorkflowStepRunId(row.id),
  workflowRunId: asWorkflowRunId(row.workflowRunId),
  nodeId: row.nodeId,
  pass: row.pass,
  itemIndex: row.itemIndex,
  item: row.item,
  claimedAt: row.claimedAt,
  agentRunId: row.agentRunId === null ? null : asAgentRunId(row.agentRunId),
  status: row.status as WorkflowStepStatus,
  answer: (row.answer as Readonly<Record<string, unknown>> | null) ?? null,
  reason: row.reason,
  costUsd: row.costUsd,
  finishedAt: row.finishedAt,
})

export const workflowRepository = (db: Database): WorkflowRepositoryPort => ({
  async create(input) {
    return db.transaction(async (tx) => {
      const [workflowRow] = await tx
        .insert(workflow)
        .values({
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description,
          createdByUserId: input.createdByUserId,
        })
        .returning()
      if (!workflowRow) throw new Error('workflow insert returned nothing')

      const [versionRow] = await tx
        .insert(workflowVersion)
        .values({
          workspaceId: input.workspaceId,
          workflowId: workflowRow.id,
          version: 1,
          graph: input.graph,
          digest: input.digest,
          createdByUserId: input.createdByUserId,
        })
        .returning()
      if (!versionRow) throw new Error('workflow_version insert returned nothing')

      return { workflow: toWorkflow(workflowRow), version: toVersion(versionRow) }
    })
  },

  async addVersion(input) {
    return db.transaction(async (tx) => {
      /**
       * The next number is read inside the transaction and under a lock on the workflow row,
       * so two people drawing at once serialize here rather than colliding on the unique
       * index. A caller that had to retry an index violation would be a caller that has to
       * know how versions are numbered.
       */
      const [owner] = await tx
        .select({ id: workflow.id })
        .from(workflow)
        .where(and(eq(workflow.workspaceId, input.workspaceId), eq(workflow.id, input.workflowId)))
        .for('update')
        .limit(1)
      if (!owner) return null

      const [highest] = await tx
        .select({ version: workflowVersion.version })
        .from(workflowVersion)
        .where(eq(workflowVersion.workflowId, input.workflowId))
        .orderBy(desc(workflowVersion.version))
        .limit(1)

      const [row] = await tx
        .insert(workflowVersion)
        .values({
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          version: (highest?.version ?? 0) + 1,
          graph: input.graph,
          digest: input.digest,
          createdByUserId: input.createdByUserId,
        })
        .returning()
      return row ? toVersion(row) : null
    })
  },

  async findById(workspaceId, workflowId) {
    const [row] = await db
      .select()
      .from(workflow)
      .where(and(eq(workflow.workspaceId, workspaceId), eq(workflow.id, workflowId)))
      .limit(1)
    return row ? toWorkflow(row) : null
  },

  async listWorkflows(workspaceId, limit) {
    const rows = await db
      .select()
      .from(workflow)
      .where(and(eq(workflow.workspaceId, workspaceId), isNull(workflow.archivedAt)))
      .orderBy(desc(workflow.createdAt))
      .limit(limit)
    return rows.map(toWorkflow)
  },

  async latestVersion(workspaceId, workflowId) {
    const [row] = await db
      .select()
      .from(workflowVersion)
      .where(
        and(
          eq(workflowVersion.workspaceId, workspaceId),
          eq(workflowVersion.workflowId, workflowId),
        ),
      )
      .orderBy(desc(workflowVersion.version))
      .limit(1)
    return row ? toVersion(row) : null
  },

  async findVersion(workspaceId, versionId) {
    const [row] = await db
      .select()
      .from(workflowVersion)
      .where(and(eq(workflowVersion.workspaceId, workspaceId), eq(workflowVersion.id, versionId)))
      .limit(1)
    return row ? toVersion(row) : null
  },

  async listVersions(workspaceId, workflowId, limit) {
    const rows = await db
      .select()
      .from(workflowVersion)
      .where(
        and(
          eq(workflowVersion.workspaceId, workspaceId),
          eq(workflowVersion.workflowId, workflowId),
        ),
      )
      .orderBy(desc(workflowVersion.version))
      .limit(limit)
    return rows.map(toVersion)
  },

  async archive(workspaceId, workflowId) {
    const [row] = await db
      .update(workflow)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(workflow.workspaceId, workspaceId),
          eq(workflow.id, workflowId),
          isNull(workflow.archivedAt),
        ),
      )
      .returning()
    return row ? toWorkflow(row) : null
  },

  async openRun(input) {
    const [row] = await db
      .insert(workflowRun)
      .values({
        workspaceId: input.workspaceId,
        workflowVersionId: input.workflowVersionId,
        repositoryId: input.repositoryId,
        threadId: input.threadId,
        input: input.input,
        capUsd: input.capUsd,
        startedByUserId: input.startedByUserId,
      })
      .returning()
    if (!row) throw new Error('workflow_run insert returned nothing')
    return toRun(row)
  },

  async findRun(workspaceId, runId) {
    const [row] = await db
      .select()
      .from(workflowRun)
      .where(and(eq(workflowRun.workspaceId, workspaceId), eq(workflowRun.id, runId)))
      .limit(1)
    return row ? toRun(row) : null
  },

  async listRunningWorkflowRuns() {
    const rows = await db
      .select({ workspaceId: workflowRun.workspaceId, id: workflowRun.id })
      .from(workflowRun)
      .where(eq(workflowRun.status, 'running'))
    return rows.map((row) => ({
      workspaceId: asWorkspaceId(row.workspaceId),
      runId: asWorkflowRunId(row.id),
    }))
  },

  async listRunsByWorkflow(workspaceId, workflowId, limit) {
    const rows = await db
      .select()
      .from(workflowRun)
      .innerJoin(workflowVersion, eq(workflowVersion.id, workflowRun.workflowVersionId))
      .where(
        and(
          eq(workflowRun.workspaceId, workspaceId),
          eq(workflowVersion.workflowId, workflowId),
        ),
      )
      .orderBy(desc(workflowRun.createdAt))
      .limit(limit)
    return rows.map((row) => toRun(row.workflow_run))
  },

  async stepsForRun(workspaceId, runId) {
    const rows = await db
      .select()
      .from(workflowStepRun)
      .where(
        and(
          eq(workflowStepRun.workspaceId, workspaceId),
          eq(workflowStepRun.workflowRunId, runId),
        ),
      )
      .orderBy(asc(workflowStepRun.createdAt), asc(workflowStepRun.id))
    return rows.map(toStep)
  },

  async claimStep(input) {
    /**
     * `on conflict do nothing` *is* the claim: the unique index on (run, node, pass, item)
     * decides which of two executors reaching this node at once gets to deal it, and the loser
     * gets no row back rather than a row it has to remember to release.
     */
    const [row] = await db
      .insert(workflowStepRun)
      .values({
        workspaceId: input.workspaceId,
        workflowRunId: input.workflowRunId,
        nodeId: input.nodeId,
        pass: input.pass,
        itemIndex: input.itemIndex,
        item: input.item,
        status: 'running',
        claimedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning()
    return row ? toStep(row) : null
  },

  async attachStepRun(workspaceId, stepId, agentRunId) {
    await db
      .update(workflowStepRun)
      .set({ agentRunId })
      .where(
        and(eq(workflowStepRun.workspaceId, workspaceId), eq(workflowStepRun.id, stepId)),
      )
  },

  async releaseStep(workspaceId, stepId) {
    /**
     * The row goes rather than reverting to pending. A step is written *at* the moment it is
     * dealt, so a start that failed leaves nothing worth keeping — and leaving a pending row
     * behind would make the unique index refuse the retry it exists to allow.
     */
    await db
      .delete(workflowStepRun)
      .where(
        and(
          eq(workflowStepRun.workspaceId, workspaceId),
          eq(workflowStepRun.id, stepId),
          isNull(workflowStepRun.agentRunId),
        ),
      )
  },

  async finishStep(workspaceId, stepId, input) {
    await db
      .update(workflowStepRun)
      .set({
        status: input.status,
        answer: input.answer,
        reason: input.reason,
        costUsd: input.costUsd,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(workflowStepRun.workspaceId, workspaceId),
          eq(workflowStepRun.id, stepId),
          // Only a step still in flight: a settled step is one a reader has already been shown.
          eq(workflowStepRun.status, 'running'),
        ),
      )
  },

  async spentOnRun(workspaceId, runId) {
    const [row] = await db
      .select({
        spent: sql<number>`coalesce(sum(${workflowStepRun.costUsd}), 0)::double precision`,
      })
      .from(workflowStepRun)
      .where(
        and(
          eq(workflowStepRun.workspaceId, workspaceId),
          eq(workflowStepRun.workflowRunId, runId),
        ),
      )
    return row?.spent ?? 0
  },

  async closeRun(workspaceId, runId, input) {
    const [row] = await db
      .update(workflowRun)
      .set({ status: input.status, haltReason: input.reason, finishedAt: new Date() })
      .where(
        and(
          eq(workflowRun.workspaceId, workspaceId),
          eq(workflowRun.id, runId),
          // First close wins, so two executors cannot write two endings.
          eq(workflowRun.status, 'running'),
        ),
      )
      .returning()
    return row ? toRun(row) : null
  },
})
