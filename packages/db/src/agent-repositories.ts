import type {
 AgentRunEventRepositoryPort,
 AgentRunRepositoryPort,
 ApprovalRepositoryPort,
 CapabilityRepositoryPort,
 MergeQueueRepositoryPort,
 NotificationTargetRepositoryPort,
 PersonaGroupRepositoryPort,
 PersonaRepositoryPort,
 PlanSubtaskRepositoryPort,
 RepositoryRepositoryPort,
 RunLiveActivity,
 RunnerRepositoryPort,
 WorkerNoteRepositoryPort,
 WorkspaceRunControlRepositoryPort,
} from '@loom/application'
import { NotFoundError, asAgentRunId, asRunnerId, asThreadId, primaryToolArgument } from '@loom/domain'
import { createHash, randomBytes } from 'node:crypto'
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm'
import type { Database } from './client.js'
import {
 toAgentPersona,
 toAgentRun,
 toApprovalRequest,
 toCapability,
 toMergeQueueEntry,
 toPersonaCapability,
 toNotificationTarget,
 toPersonaGroup,
 toPlanSubtask,
 toRepository,
 toRunner,
 toWorkerNote,
 type AgentPersonaRow,
 type AgentRunRow,
 type ApprovalRequestRow,
 type CapabilityRow,
 type MergeQueueEntryRow,
 type PersonaCapabilityRow,
 type NotificationTargetRow,
 type PersonaGroupRow,
 type PlanSubtaskRow,
 type RepositoryRow,
 type RunnerRow,
 type WorkerNoteRow,
} from './mappers.js'
import {
 agentPersona,
 agentRun,
 agentRunEvent,
 approvalRequest,
 capability,
 channel,
 mergeQueueEntry,
 personaCapability,
 notificationTarget,
 personaGroup,
 planSubtask,
 repository,
 runner,
 thread,
 workerNote,
 workspace,
} from './schema.js'

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const

export const runnerRepository = (db: Database): RunnerRepositoryPort => ({
 async findById(workspaceId, id) {
 const [row] = await db
.select
.from(runner)
.where(and(eq(runner.workspaceId, workspaceId), eq(runner.id, id)))
.limit(1)
 return row ? toRunner(row as RunnerRow): null
 },

 async listByWorkspace(workspaceId) {
 const rows = await db.select.from(runner).where(eq(runner.workspaceId, workspaceId))
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
.returning
 if (!row) throw new Error('repository insert returned no row')
 return toRepository(row as RepositoryRow)
 },

 async findById(workspaceId, id) {
 const [row] = await db
.select
.from(repository)
.where(and(eq(repository.workspaceId, workspaceId), eq(repository.id, id)))
.limit(1)
 return row ? toRepository(row as RepositoryRow): null
 },

 async listByWorkspace(workspaceId) {
 const rows = await db.select.from(repository).where(eq(repository.workspaceId, workspaceId))
 return rows.map((row) => toRepository(row as RepositoryRow))
 },

 async delete(workspaceId, id) {
 await db
.delete(repository)
.where(and(eq(repository.workspaceId, workspaceId), eq(repository.id, id)))
 },

 async countByRunner(workspaceId, runnerId) {
 const [row] = await db
.select({ value: count })
.from(repository)
.where(and(eq(repository.workspaceId, workspaceId), eq(repository.runnerId, runnerId)))
 return row?.value ?? 0
 },

 async setVerifyCommand(workspaceId, id, verifyCommand) {
 const [row] = await db
.update(repository)
.set({ verifyCommand })
.where(and(eq(repository.workspaceId, workspaceId), eq(repository.id, id)))
.returning
 if (!row) throw new NotFoundError('Repository')
 return toRepository(row as RepositoryRow)
 },

 async setInstallCommand(workspaceId, id, installCommand) {
 const [row] = await db
.update(repository)
.set({ installCommand })
.where(and(eq(repository.workspaceId, workspaceId), eq(repository.id, id)))
.returning
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
.returning
 if (!row) throw new Error('merge_queue_entry insert returned no row')
 return toMergeQueueEntry(row as MergeQueueEntryRow)
 },

 async findById(workspaceId, id) {
 const [row] = await db
.select
.from(mergeQueueEntry)
.where(and(eq(mergeQueueEntry.workspaceId, workspaceId), eq(mergeQueueEntry.id, id)))
.limit(1)
 return row ? toMergeQueueEntry(row as MergeQueueEntryRow): null
 },

 async listByRepository(workspaceId, repositoryId) {
 const rows = await db
.select
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
.select
.from(mergeQueueEntry)
.where(eq(mergeQueueEntry.workspaceId, workspaceId))
.orderBy(mergeQueueEntry.position)
 return rows.map((row) => toMergeQueueEntry(row as MergeQueueEntryRow))
 },

 async listAllOpen {
 const rows = await db
.select
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
.set({ status: 'merging', startedAt: new Date })
.where(
 and(
 eq(mergeQueueEntry.workspaceId, workspaceId),
 eq(mergeQueueEntry.id, id),
 eq(mergeQueueEntry.status, 'queued'),
),
)
.returning
 return row ? toMergeQueueEntry(row as MergeQueueEntryRow): null
 } catch {
 return null
 }
 },

 async finish(workspaceId, id, patch) {
 const [row] = await db
.update(mergeQueueEntry)
.set({
 status: patch.status,
 finishedAt: new Date,
...(patch.failureReason === undefined ? {}: { failureReason: patch.failureReason }),
...(patch.detail === undefined ? {}: { detail: patch.detail }),
...(patch.mergedCommitSha === undefined ? {}: { mergedCommitSha: patch.mergedCommitSha }),
...(patch.verified === undefined ? {}: { verified: patch.verified }),
 })
.where(
 and(
 eq(mergeQueueEntry.workspaceId, workspaceId),
 eq(mergeQueueEntry.id, id),
 // First resolution wins — see the port's note on late Runner answers.
 inArray(mergeQueueEntry.status, ['queued', 'merging']),
),
)
.returning
 return row ? toMergeQueueEntry(row as MergeQueueEntryRow): null
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
.returning
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
.select
.from(workerNote)
.where(and(eq(workerNote.workspaceId, workspaceId), eq(workerNote.treeRunId, treeRunId)))
.orderBy(workerNote.seq)
 return rows.map((row) => toWorkerNote(row as WorkerNoteRow))
 },

 async countByRun(workspaceId, agentRunId) {
 const [row] = await db
.select({ total: count })
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
 status: subtask.status,
 agentRunId: subtask.agentRunId,
 detail: subtask.detail,
 })),
)
.returning
 return rows.map((row) => toPlanSubtask(row as PlanSubtaskRow))
 },

 /** In plan order, because `dependsOn` indexes into exactly this ordering. */
 async listByPlanner(workspaceId, plannerRunId) {
 const rows = await db
.select
.from(planSubtask)
.where(
 and(eq(planSubtask.workspaceId, workspaceId), eq(planSubtask.plannerRunId, plannerRunId)),
)
.orderBy(planSubtask.position)
 return rows.map((row) => toPlanSubtask(row as PlanSubtaskRow))
 },

 async findByAgentRun(workspaceId, agentRunId) {
 const [row] = await db
.select
.from(planSubtask)
.where(and(eq(planSubtask.workspaceId, workspaceId), eq(planSubtask.agentRunId, agentRunId)))
.limit(1)
 return row ? toPlanSubtask(row as PlanSubtaskRow): null
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
 updatedAt: new Date,
 })
.where(
 and(
 eq(planSubtask.workspaceId, input.workspaceId),
 eq(planSubtask.id, input.id),
 eq(planSubtask.status, 'waiting'),
),
)
.returning
 return row ? toPlanSubtask(row as PlanSubtaskRow): null
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
 })
.returning
 if (!row) throw new Error('capability insert returned no row')
 return toCapability(row as CapabilityRow)
 },

 async findById(workspaceId, id) {
 const [row] = await db
.select
.from(capability)
.where(and(eq(capability.workspaceId, workspaceId), eq(capability.id, id)))
.limit(1)
 return row ? toCapability(row as CapabilityRow): null
 },

 async listByWorkspace(workspaceId) {
 const rows = await db
.select
.from(capability)
.where(eq(capability.workspaceId, workspaceId))
.orderBy(capability.name)
 return rows.map((row) => toCapability(row as CapabilityRow))
 },

 async update(workspaceId, id, patch) {
 const [row] = await db
.update(capability)
.set({...patch, updatedAt: new Date })
.where(and(eq(capability.workspaceId, workspaceId), eq(capability.id, id)))
.returning
 if (!row) throw new NotFoundError('Capability')
 return toCapability(row as CapabilityRow)
 },

 async pinToolListHash(workspaceId, id, toolListHash) {
 await db
.update(capability)
.set({ toolListHash, updatedAt: new Date })
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
.returning
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
.select
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
.select
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
...(input.parentRunId === undefined ? {}: { parentRunId: input.parentRunId }),
...(input.relation === undefined ? {}: { relation: input.relation }),
...(input.task === undefined ? {}: { task: input.task }),
 status: 'pending',
 })
.returning
 if (!row) throw new Error('agent_run insert returned no row')
 return toAgentRun(row as AgentRunRow)
 },

 async findById(workspaceId, id) {
 const [row] = await db
.select
.from(agentRun)
.where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
.limit(1)
 return row ? toAgentRun(row as AgentRunRow): null
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
.set({ aggregatedAt: new Date })
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
...(patch.totalCostUsd !== undefined ? { totalCostUsd: patch.totalCostUsd }: {}),
...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage }: {}),
...(patch.completedAt !== undefined ? { completedAt: patch.completedAt }: {}),
 })
.where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
.returning
 if (!row) throw new NotFoundError('AgentRun')
 return toAgentRun(row as AgentRunRow)
 },

 async recordWorkspace(workspaceId, id, patch) {
 const [row] = await db
.update(agentRun)
.set({ clonePath: patch.clonePath, branchName: patch.branchName })
.where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
.returning
 if (!row) throw new NotFoundError('AgentRun')
 return toAgentRun(row as AgentRunRow)
 },

 async findActiveByWorkspace(workspaceId) {
 const [row] = await db
.select
.from(agentRun)
.where(
 and(eq(agentRun.workspaceId, workspaceId), notInArray(agentRun.status, [...TERMINAL_STATUSES])),
)
.limit(1)
 return row ? toAgentRun(row as AgentRunRow): null
 },

 async listByParent(workspaceId, parentRunId) {
 const rows = await db
.select
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
.select
.from(agentRun)
.where(and(eq(agentRun.workspaceId, workspaceId), inArray(agentRun.id, ids)))
.orderBy(agentRun.createdAt)
 return rows.map((row) => toAgentRun(row as AgentRunRow))
 },

 async countByRepository(workspaceId, repositoryId) {
 const [row] = await db
.select({
 total: count,
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
 total: count,
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
.select
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
.returning
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
.select({ runCount: count, totalUsd: usd })
.from(agentRun)
.where(scope)

 const byPersona = await db
.select({
 personaName,
 model,
 runCount: count,
 totalUsd: usd,
 maxUsd: sql<number>`coalesce(max(coalesce(${agentRun.totalCostUsd}, 0)), 0)`,
 })
.from(agentRun)
.where(scope)
.groupBy(personaName, model)
.orderBy(desc(usd))

 const byModel = await db
.select({ model, runCount: count, totalUsd: usd })
.from(agentRun)
.where(scope)
.groupBy(model)
.orderBy(desc(usd))

 const byThread = await db
.select({
 threadId: agentRun.threadId,
 channelName: sql<string>`coalesce(${channel.name}, 'unknown')`,
 runCount: count,
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

 const num = (value: unknown): number => (typeof value === 'number' ? value: Number(value ?? 0))
 return {
 totals: { runCount: totals?.runCount ?? 0, totalUsd: num(totals?.totalUsd) },
 byPersona: byPersona.map((r) => ({...r, totalUsd: num(r.totalUsd), maxUsd: num(r.maxUsd) })),
 byModel: byModel.map((r) => ({...r, totalUsd: num(r.totalUsd) })),
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
 lastHeartbeatAt: new Date,
 // Only written when the Runner actually sampled: a heartbeat that could not read
 // the window must leave the last known figure alone rather than blanking it.
...(context ? { contextTokens: context.tokens, contextMaxTokens: context.maxTokens }: {}),
 })
.where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
 },

 async recordEventActivity(workspaceId, id) {
 await db
.update(agentRun)
.set({ lastEventAt: new Date })
.where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
 },

 async listAllActive {
 const rows = await db
.select
.from(agentRun)
.where(notInArray(agentRun.status, [...TERMINAL_STATUSES]))
 return rows.map((row) => toAgentRun(row as AgentRunRow))
 },

 async listNeedsAttention(workspaceId) {
 const rows = await db
.select
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

 async liveActivity(workspaceId, agentRunIds) {
 if (agentRunIds.length === 0) return new Map

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

 const activity = new Map<string, RunLiveActivity>
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
 lastEventAt: row.last_event_at === null ? null: new Date(row.last_event_at),
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
 // Null on an ordinary tool gate, which is what distinguishes the two kinds
 //.
 question: input.question ?? null,
 })
.returning
 if (!row) throw new Error('approval_request insert returned no row')
 return toApprovalRequest(row as ApprovalRequestRow)
 },

 async findById(workspaceId, id) {
 const [row] = await db
.select
.from(approvalRequest)
.where(and(eq(approvalRequest.workspaceId, workspaceId), eq(approvalRequest.id, id)))
.limit(1)
 return row ? toApprovalRequest(row as ApprovalRequestRow): null
 },

 async listPendingByRun(workspaceId, agentRunId) {
 const rows = await db
.select
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

 async listAllPending {
 const rows = await db
.select
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
...(patch.answer === undefined ? {}: { answer: patch.answer }),
 resolvedAt: new Date,
 })
.where(and(eq(approvalRequest.workspaceId, workspaceId), eq(approvalRequest.id, id)))
.returning
 if (!row) throw new NotFoundError('ApprovalRequest')
 return toApprovalRequest(row as ApprovalRequestRow)
 },
})

/**
 * Kill-switch state. Columns live on `workspace` rather than a
 * dedicated table — it's strictly 1:1 with a workspace, so a separate row would
 * add a join and a "does the row exist yet?" case for nothing.
 */
export const workspaceRunControlRepository = (db: Database): WorkspaceRunControlRepositoryPort => ({
 async get(workspaceId) {
 const [row] = await db
.select({
 runsPaused: workspace.runsPaused,
 runsPausedAt: workspace.runsPausedAt,
 runsPausedByUserId: workspace.runsPausedByUserId,
 })
.from(workspace)
.where(eq(workspace.id, workspaceId))
.limit(1)
 if (!row) throw new NotFoundError('Workspace')
 return {
 workspaceId,
 paused: row.runsPaused,
 pausedAt: row.runsPausedAt,
 pausedByUserId: row.runsPausedByUserId,
 }
 },

 async set(workspaceId, patch) {
 const [row] = await db
.update(workspace)
.set({
 runsPaused: patch.paused,
 runsPausedAt: patch.paused ? new Date: null,
 runsPausedByUserId: patch.pausedByUserId,
 })
.where(eq(workspace.id, workspaceId))
.returning({
 runsPaused: workspace.runsPaused,
 runsPausedAt: workspace.runsPausedAt,
 runsPausedByUserId: workspace.runsPausedByUserId,
 })
 if (!row) throw new NotFoundError('Workspace')
 return {
 workspaceId,
 paused: row.runsPaused,
 pausedAt: row.runsPausedAt,
 pausedByUserId: row.runsPausedByUserId,
 }
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
.returning
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
.select
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
 harnessAutoApprove: input.harnessAutoApprove,
 harnessPlanner: input.harnessPlanner,
 harnessDelegates: input.harnessDelegates,
 harnessBudgetCapUsd: input.harnessBudgetCapUsd,
 })
.returning
 if (!row) throw new Error('agent_persona insert returned no row')
 return toAgentPersona(row as AgentPersonaRow)
 },

 async findById(workspaceId, id) {
 const [row] = await db
.select
.from(agentPersona)
.where(and(eq(agentPersona.workspaceId, workspaceId), eq(agentPersona.id, id)))
.limit(1)
 return row ? toAgentPersona(row as AgentPersonaRow): null
 },

 async listByWorkspace(workspaceId) {
 const rows = await db
.select
.from(agentPersona)
.where(eq(agentPersona.workspaceId, workspaceId))
 return rows.map((row) => toAgentPersona(row as AgentPersonaRow))
 },

 async update(workspaceId, id, patch) {
 const [row] = await db
.update(agentPersona)
.set({
 description: patch.description,
 markdownSource: patch.markdownSource,
 model: patch.model,
 tools: patch.tools,
 harnessEffort: patch.harnessEffort,
 harnessMaxTurns: patch.harnessMaxTurns,
 harnessAutoApprove: patch.harnessAutoApprove,
 harnessPlanner: patch.harnessPlanner,
 harnessDelegates: patch.harnessDelegates,
 harnessBudgetCapUsd: patch.harnessBudgetCapUsd,
 updatedAt: new Date,
 })
.where(and(eq(agentPersona.workspaceId, workspaceId), eq(agentPersona.id, id)))
.returning
 if (!row) throw new NotFoundError('AgentPersona')
 return toAgentPersona(row as AgentPersonaRow)
 },
})

export const personaGroupRepository = (db: Database): PersonaGroupRepositoryPort => ({
 async create(input) {
 const [row] = await db
.insert(personaGroup)
.values({ workspaceId: input.workspaceId, name: input.name, personaIds: input.personaIds })
.returning
 if (!row) throw new Error('persona_group insert returned no row')
 return toPersonaGroup(row as PersonaGroupRow)
 },

 async listByWorkspace(workspaceId) {
 const rows = await db.select.from(personaGroup).where(eq(personaGroup.workspaceId, workspaceId))
 return rows.map((row) => toPersonaGroup(row as PersonaGroupRow))
 },

 async update(workspaceId, id, patch) {
 const [row] = await db
.update(personaGroup)
.set({
 name: patch.name,
 personaIds: patch.personaIds,
 // Absent leaves the stored positions alone — see PersonaGroupRepositoryPort.
...(patch.layout === undefined ? {}: { layout: patch.layout }),
 updatedAt: new Date,
 })
.where(and(eq(personaGroup.workspaceId, workspaceId), eq(personaGroup.id, id)))
.returning
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
 updatedAt: new Date,
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

// --- Runner pairing (infra-only concern: not behind a port, see the replaceability contract — replaceability
// note in agent-ports.ts — Node's crypto is a language builtin, not swappable
// vendor infra, so it doesn't need one). ---

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
 lastSeenAt: new Date,
...(input.allowedRoots !== undefined ? { allowedRoots: input.allowedRoots }: {}),
 })
.where(eq(runner.id, runnerId))
}
