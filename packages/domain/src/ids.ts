declare const brand: unique symbol

type Brand<T, B extends string> = T & { readonly [brand]: B }

export type WorkspaceId = Brand<string, 'WorkspaceId'>
export type UserId = Brand<string, 'UserId'>
export type ChannelId = Brand<string, 'ChannelId'>
export type ThreadId = Brand<string, 'ThreadId'>
export type MessageId = Brand<string, 'MessageId'>
export type AgentRunId = Brand<string, 'AgentRunId'>
export type AuditEventId = Brand<string, 'AuditEventId'>
export type RunnerId = Brand<string, 'RunnerId'>
export type RepositoryId = Brand<string, 'RepositoryId'>
export type ApprovalRequestId = Brand<string, 'ApprovalRequestId'>
export type AgentPersonaId = Brand<string, 'AgentPersonaId'>
export type PersonaGroupId = Brand<string, 'PersonaGroupId'>
export type MergeQueueEntryId = Brand<string, 'MergeQueueEntryId'>
export type RunVerificationId = Brand<string, 'RunVerificationId'>
export type CapabilityId = Brand<string, 'CapabilityId'>
export type WorkerNoteId = Brand<string, 'WorkerNoteId'>
export type SubjectMapId = Brand<string, 'SubjectMapId'>
export type PersonaRevisionId = Brand<string, 'PersonaRevisionId'>
/** One candidate prompt in a variant search. */
export type PersonaVariantId = Brand<string, 'PersonaVariantId'>
/** The search a set of candidates belongs to — the thing that is open or settled. */
export type PersonaVariantSetId = Brand<string, 'PersonaVariantSetId'>
/** A versioned held-out set. */
export type ReplaySetId = Brand<string, 'ReplaySetId'>
/** One replayable `(repository @ commit, task, observed outcome)` in a held-out set. */
export type ReplayItemId = Brand<string, 'ReplayItemId'>
/** One arm's screening against a held-out set — a candidate, or the prompt in use. */
export type VariantScreenId = Brand<string, 'VariantScreenId'>
/** A campaign: vintages of one persona replayed against one set, at real cost. */
export type ReplayCampaignId = Brand<string, 'ReplayCampaignId'>
/** One vintage in a campaign, optionally forced onto a model. */
export type ReplayCampaignArmId = Brand<string, 'ReplayCampaignArmId'>

export const asWorkspaceId = (v: string): WorkspaceId => v as WorkspaceId
export const asUserId = (v: string): UserId => v as UserId
export const asChannelId = (v: string): ChannelId => v as ChannelId
export const asThreadId = (v: string): ThreadId => v as ThreadId
export const asMessageId = (v: string): MessageId => v as MessageId
export const asAgentRunId = (v: string): AgentRunId => v as AgentRunId
export const asAuditEventId = (v: string): AuditEventId => v as AuditEventId
export const asRunnerId = (v: string): RunnerId => v as RunnerId
export const asRepositoryId = (v: string): RepositoryId => v as RepositoryId
export const asApprovalRequestId = (v: string): ApprovalRequestId => v as ApprovalRequestId
export const asAgentPersonaId = (v: string): AgentPersonaId => v as AgentPersonaId
export const asPersonaGroupId = (v: string): PersonaGroupId => v as PersonaGroupId
export const asMergeQueueEntryId = (v: string): MergeQueueEntryId => v as MergeQueueEntryId
export const asRunVerificationId = (v: string): RunVerificationId => v as RunVerificationId
export const asCapabilityId = (v: string): CapabilityId => v as CapabilityId
export const asWorkerNoteId = (v: string): WorkerNoteId => v as WorkerNoteId
export const asSubjectMapId = (v: string): SubjectMapId => v as SubjectMapId
export const asPersonaRevisionId = (v: string): PersonaRevisionId => v as PersonaRevisionId
export const asPersonaVariantId = (v: string): PersonaVariantId => v as PersonaVariantId
export const asPersonaVariantSetId = (v: string): PersonaVariantSetId => v as PersonaVariantSetId
export const asReplaySetId = (v: string): ReplaySetId => v as ReplaySetId
export const asReplayItemId = (v: string): ReplayItemId => v as ReplayItemId
export const asVariantScreenId = (v: string): VariantScreenId => v as VariantScreenId
export const asReplayCampaignId = (v: string): ReplayCampaignId => v as ReplayCampaignId
export const asReplayCampaignArmId = (v: string): ReplayCampaignArmId =>
  v as ReplayCampaignArmId
