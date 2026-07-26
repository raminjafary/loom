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
