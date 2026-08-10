import type {
  AgentRunEventRepositoryPort,
  AgentRunRepositoryPort,
  ApprovalRepositoryPort,
  MergeQueueRepositoryPort,
  NotificationTargetRepositoryPort,
  PersonaGroupRepositoryPort,
  PersonaRepositoryPort,
  RepositoryRepositoryPort,
  RunnerRepositoryPort,
  WorkspaceRunControlRepositoryPort,
} from '@loom/application'
import { NotFoundError, asRunnerId } from '@loom/domain'
import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm'
import type { Database } from './client.js'
import {
  toAgentPersona,
  toAgentRun,
  toApprovalRequest,
  toMergeQueueEntry,
  toNotificationTarget,
  toPersonaGroup,
  toRepository,
  toRunner,
  type AgentPersonaRow,
  type AgentRunRow,
  type ApprovalRequestRow,
  type MergeQueueEntryRow,
  type NotificationTargetRow,
  type PersonaGroupRow,
  type RepositoryRow,
  type RunnerRow,
} from './mappers.js'
import {
  agentPersona,
  agentRun,
  agentRunEvent,
  approvalRequest,
  mergeQueueEntry,
  notificationTarget,
  personaGroup,
  repository,
  runner,
  workspace,
} from './schema.js'

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const

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

  async setVerifyCommand(workspaceId, id, verifyCommand) {
    const [row] = await db
      .update(repository)
      .set({ verifyCommand })
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
      .set({ clonePath: patch.clonePath, branchName: patch.branchName })
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

  async recordHeartbeat(workspaceId, id) {
    await db
      .update(agentRun)
      .set({ lastHeartbeatAt: new Date() })
      .where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
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
      // longest is the thing most likely to be about to time out (PLAN.md §6's
      // approval SLA).
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
        resolvedAt: new Date(),
      })
      .where(and(eq(approvalRequest.workspaceId, workspaceId), eq(approvalRequest.id, id)))
      .returning()
    if (!row) throw new NotFoundError('ApprovalRequest')
    return toApprovalRequest(row as ApprovalRequestRow)
  },
})

/**
 * Kill-switch state (PLAN.md §6). Columns live on `workspace` rather than a
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
        runsPausedAt: patch.paused ? new Date() : null,
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
 * Where a human can be reached (PLAN.md §3/§4a). `register` upserts on
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
        harnessBudgetCapUsd: input.harnessBudgetCapUsd,
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
        harnessBudgetCapUsd: patch.harnessBudgetCapUsd,
        updatedAt: new Date(),
      })
      .where(and(eq(agentPersona.workspaceId, workspaceId), eq(agentPersona.id, id)))
      .returning()
    if (!row) throw new NotFoundError('AgentPersona')
    return toAgentPersona(row as AgentPersonaRow)
  },
})

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
      .set({ name: patch.name, personaIds: patch.personaIds, updatedAt: new Date() })
      .where(and(eq(personaGroup.workspaceId, workspaceId), eq(personaGroup.id, id)))
      .returning()
    if (!row) throw new NotFoundError('PersonaGroup')
    return toPersonaGroup(row as PersonaGroupRow)
  },

  async delete(workspaceId, id) {
    await db.delete(personaGroup).where(and(eq(personaGroup.workspaceId, workspaceId), eq(personaGroup.id, id)))
  },
})

// --- Runner pairing (infra-only concern: not behind a port, see PLAN.md §4a
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
 * scaling (PLAN.md §7 Phase 4) would need per-instance connection ownership
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
