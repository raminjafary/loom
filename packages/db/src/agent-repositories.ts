import type {
 AgentRunRepositoryPort,
 ApprovalRepositoryPort,
 PersonaGroupRepositoryPort,
 PersonaRepositoryPort,
 RepositoryRepositoryPort,
 RunnerRepositoryPort,
} from '@loom/application'
import { NotFoundError, asRunnerId } from '@loom/domain'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm'
import type { Database } from './client.js'
import {
 toAgentPersona,
 toAgentRun,
 toApprovalRequest,
 toPersonaGroup,
 toRepository,
 toRunner,
 type AgentPersonaRow,
 type AgentRunRow,
 type ApprovalRequestRow,
 type PersonaGroupRow,
 type RepositoryRow,
 type RunnerRow,
} from './mappers.js'
import { agentPersona, agentRun, approvalRequest, personaGroup, repository, runner } from './schema.js'

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

 async setBranchDisposition(workspaceId, id, disposition) {
 const [row] = await db
.update(agentRun)
.set({ branchDisposition: disposition })
.where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.id, id)))
.returning
 if (!row) throw new NotFoundError('AgentRun')
 return toAgentRun(row as AgentRunRow)
 },

 async recordHeartbeat(workspaceId, id) {
 await db
.update(agentRun)
.set({ lastHeartbeatAt: new Date })
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
 return rows.map((row) => toAgentRun(row as AgentRunRow))
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

 async resolve(workspaceId, id, patch) {
 const [row] = await db
.update(approvalRequest)
.set({
 status: patch.status,
 resolvedByUserId: patch.resolvedByUserId,
 resolvedAt: new Date,
 })
.where(and(eq(approvalRequest.workspaceId, workspaceId), eq(approvalRequest.id, id)))
.returning
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
 harnessAutoApprove: input.harnessAutoApprove,
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
.set({ name: patch.name, personaIds: patch.personaIds, updatedAt: new Date })
.where(and(eq(personaGroup.workspaceId, workspaceId), eq(personaGroup.id, id)))
.returning
 if (!row) throw new NotFoundError('PersonaGroup')
 return toPersonaGroup(row as PersonaGroupRow)
 },

 async delete(workspaceId, id) {
 await db.delete(personaGroup).where(and(eq(personaGroup.workspaceId, workspaceId), eq(personaGroup.id, id)))
 },
})

// --- Runner pairing (infra-only concern: not behind a port, see the replaceability contract
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
