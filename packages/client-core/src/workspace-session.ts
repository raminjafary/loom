import type { Actor, Channel, Message, ServerEvent, Thread } from '@loom/api-contract'
import type { LoomApi } from './api.js'
import { connectRealtime, type ConnectionState, type RealtimeConnection } from './realtime.js'

/**
 * All non-rendering client logic. A view layer — Vue, React, a
 * TUI — subscribes to `onChange` and renders; it holds no logic of its own,
 * which is what makes the framework a swappable detail rather than a rewrite.
 */

export interface WorkspaceSnapshot {
 /**
 * Who this client is signed in as.
 *
 * Kept on the snapshot because the thread has to be able to tell *your* messages from
 * someone else's: without it every message rendered its raw opaque user id as the
 * author's name, which is unreadable and, worse, identical for every human in the
 * workspace at a glance. Null until `init` resolves.
 */
 readonly currentActor: Actor | null
 readonly channels: Channel[]
 readonly activeChannelId: string | null
 readonly activeThread: Thread | null
 readonly messages: Message[]
 readonly connection: ConnectionState
 readonly loading: boolean
 readonly error: string | null
}

export interface WorkspaceSession {
 snapshot: WorkspaceSnapshot
 onChange(listener: (snapshot: WorkspaceSnapshot) => void): => void
 init: Promise<void>
 selectChannel(channelId: string): Promise<void>
 createChannel(name: string): Promise<void>
 send(text: string): Promise<void>
 dispose: void
}

const errorMessage = (error: unknown): string =>
 error instanceof Error ? error.message: String(error)

export const createWorkspaceSession = (options: {
 api: LoomApi
 wsUrl: string
}): WorkspaceSession => {
 let state: WorkspaceSnapshot = {
 currentActor: null,
 channels: [],
 activeChannelId: null,
 activeThread: null,
 messages: [],
 connection: 'connecting',
 loading: false,
 error: null,
 }

 const listeners = new Set<(snapshot: WorkspaceSnapshot) => void>
 let realtime: RealtimeConnection | null = null

 const patch = (next: Partial<WorkspaceSnapshot>) => {
 state = {...state,...next }
 for (const listener of listeners) listener(state)
 }

 /**
 * Messages arrive from two races — the initial fetch and the live socket — so
 * insertion is deduplicated by id and kept in ascending order rather than
 * assuming arrival order is correct.
 */
 const mergeMessage = (incoming: Message) => {
 if (incoming.threadId !== state.activeThread?.id) return
 if (state.messages.some((m) => m.id === incoming.id)) return
 const next = [...state.messages, incoming].sort((a, b) =>
 a.createdAt.getTime === b.createdAt.getTime
 ? a.id.localeCompare(b.id)
: a.createdAt.getTime - b.createdAt.getTime,
)
 patch({ messages: next })
 }

 const handleEvent = (event: ServerEvent) => {
 switch (event.type) {
 case 'message.created':
 mergeMessage(event.message)
 break
 case 'channel.created':
 if (!state.channels.some((c) => c.id === event.channel.id)) {
 patch({
 channels: [...state.channels, event.channel].sort((a, b) =>
 a.name.localeCompare(b.name),
),
 })
 }
 break
 case 'thread.created':
 break
 }
 }

 const loadMessages = async (threadId: string) => {
 const page = await options.api.message.list({ threadId, limit: 50 })
 // Server returns newest-first; the view renders oldest-first.
 patch({ messages: [...page.messages].reverse })
 }

 const refreshActive = async => {
 if (!state.activeThread) return
 await loadMessages(state.activeThread.id)
 }

 return {
 snapshot: => state,

 onChange(listener) {
 listeners.add(listener)
 return => listeners.delete(listener)
 },

 async init {
 patch({ loading: true, error: null })
 try {
 // Identity comes from the session, never from client config.
 const me = await options.api.session.me
 const channels = await options.api.channel.list
 patch({ currentActor: me.actor, channels })

 realtime = connectRealtime({
 wsUrl: options.wsUrl,
 workspaceId: me.workspaceId,
 onEvent: handleEvent,
 onState: (connection) => patch({ connection }),
 // A dropped socket means missed frames; refetch rather than assume.
 onResubscribe: => {
 void refreshActive
 },
 })

 const first = channels[0]
 if (first) await this.selectChannel(first.id)
 } catch (error) {
 patch({ error: errorMessage(error) })
 } finally {
 patch({ loading: false })
 }
 },

 async selectChannel(channelId) {
 patch({ loading: true, error: null, activeChannelId: channelId, messages: [] })
 try {
 const thread = await options.api.channel.rootThread({ channelId })
 patch({ activeThread: thread })
 await loadMessages(thread.id)
 } catch (error) {
 patch({ error: errorMessage(error) })
 } finally {
 patch({ loading: false })
 }
 },

 async createChannel(name) {
 patch({ error: null })
 try {
 const created = await options.api.channel.create({ name })
 if (!state.channels.some((c) => c.id === created.channel.id)) {
 patch({
 channels: [...state.channels, created.channel].sort((a, b) =>
 a.name.localeCompare(b.name),
),
 })
 }
 await this.selectChannel(created.channel.id)
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async send(text) {
 const thread = state.activeThread
 if (!thread || text.trim.length === 0) return
 patch({ error: null })
 try {
 // No optimistic insert: the realtime frame is authoritative and arrives
 // in single-digit ms locally. Optimism here would need reconciliation
 // logic that buys nothing at this latency.
 const message = await options.api.message.post({ threadId: thread.id, text })
 mergeMessage(message)
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 dispose {
 realtime?.close
 realtime = null
 listeners.clear
 },
 }
}
