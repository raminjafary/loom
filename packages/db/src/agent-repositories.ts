import type {
  AgentRunRepositoryPort,
  ApprovalRepositoryPort,
  PersonaRepositoryPort,
  RepositoryRepositoryPort,
  RunnerRepositoryPort,
} from '@loom/application'
import { NotFoundError, asRunnerId } from '@loom/domain'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Database } from './client.js'
import {
  toAgentPersona,
  toAgentRun,
  toApprovalRequest,
  toRepository,
  toRunner,
  type AgentPersonaRow,
  type AgentRunRow,
  type ApprovalRequestRow,
  type RepositoryRow,
  type RunnerRow,
} from './mappers.js'
import { agentPersona, agentRun, approvalRequest, repository, runner } from './schema.js'

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
        updatedAt: new Date(),
      })
      .where(and(eq(agentPersona.workspaceId, workspaceId), eq(agentPersona.id, id)))
      .returning()
    if (!row) throw new NotFoundError('AgentPersona')
    return toAgentPersona(row as AgentPersonaRow)
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
