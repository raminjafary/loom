import type { Actor, Channel, Message, ServerEvent, Thread } from '@loom/api-contract'
import type { LoomApi } from './api.js'
import { messageInView, DEFAULT_THREAD_VIEW, type ThreadView } from './thread-view.js'
import {
  connectRealtime,
  type ConnectionState,
  type RealtimeConnection,
  type RealtimeOptions,
} from './realtime.js'

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
   * workspace at a glance. Null until `init()` resolves.
   */
  readonly currentActor: Actor | null
  /**
   * Workspace limits, read from the session for the same reason identity is. The
   * composition canvas needs `maxDelegationDepth` to say which of the edges it draws a plan
   * could actually use, and a client that assumed 2 would be hard-coding server
   * configuration into a surface whose whole job is not to.
   *
   * Null until `init()` resolves.
   */
  readonly limits: { maxDelegationDepth: number; maxConcurrentRunsPerWorkspace: number } | null
  readonly channels: Channel[]
  /**
   * Unread count per channel id.
   *
   * Absent means nothing unread, which is why this is a record rather than a field on
   * `Channel`: a channel list arrives from one call and its counts from another, and
   * merging them would make a stale count look like a fact about the channel.
   */
  readonly unread: Record<string, number>
  readonly activeChannelId: string | null
  readonly activeThread: Thread | null
  /**
   * Every thread in the active channel, so a message can show that a conversation
   * hangs off it.
   *
   * Fetched with the channel rather than per message: threads are keyed by
   * `parentMessageId`, so one call answers it for the whole page, and a swarm has a
   * handful of areas rather than a thread per line.
   */
  readonly channelThreads: Thread[]
  readonly messages: Message[]
  /**
   * Whether older messages exist behind the ones loaded.
   *
   * A thread's first page is the newest 50, and an agent run alone can post several
   * hundred events — so for any run worth reading about, the beginning of the
   * conversation is off the top and there was previously no way back to it. The
   * contract has always been paginated; this is the client finally saying so.
   */
  readonly hasMoreHistory: boolean
  /**
   * What the thread is showing.
   *
   * `headline` by default: a swarm's workers share their planner's thread, so the
   * unfiltered view is five interleaved streams and the line a human must act on scrolls
   * past between two file reads. Every blocking thing is system-authored, so the quiet
   * view cannot hide one.
   */
  readonly threadView: ThreadView
  /** The run whose stream is being read, when the view is `run`. Set by clicking a node. */
  readonly focusRunId: string | null
  readonly loadingHistory: boolean
  readonly connection: ConnectionState
  readonly loading: boolean
  readonly error: string | null
}

export interface WorkspaceSession {
  snapshot(): WorkspaceSnapshot
  onChange(listener: (snapshot: WorkspaceSnapshot) => void): () => void
  /**
   * Every realtime frame, as it arrives. Distinct from `onChange`, which reports
   * this session's own state: a frame is a fact about the *workspace*, and the agent
   * session needs it to know its structured state is stale.
   */
  onServerEvent(listener: (event: ServerEvent) => void): () => void
  init(): Promise<void>
  selectChannel(channelId: string): Promise<void>
  /**
   * Changes what the thread shows. Reloads, because the filter is applied in
   * the query — a client-side filter over a fetched page would render three of fifty rows
   * and report that there was nothing more to load.
   */
  setThreadView(view: ThreadView, focusRunId?: string): Promise<void>
  /**
   * Moves the conversation to one of this channel's threads — an area thread, or back
   * to the root.
   *
   * Deliberately not a channel switch: an area belongs to the goal it was split from,
   * and `channelThreads` stays as it is so the way back is still on screen.
   */
  openThread(threadId: string): Promise<void>
  createChannel(name: string): Promise<void>
  /**
   * Deletes a channel and everything said in it. Returns the server's refusal rather
   * than raising it, because the refusal is a question for the human ("this also
   * deletes 12 runs"), which a caller re-asks with `acknowledge`.
   */
  deleteChannel(input: {
    channelId: string
    acknowledge?: boolean
  }): Promise<{ ok: boolean; reason: string | null }>
  send(text: string): Promise<void>
  /**
   * Prepends the next older page. A no-op when a page is already in flight or the
   * beginning has been reached, so a scroll handler can call it freely.
   */
  loadOlderMessages(): Promise<void>
  /**
   * Replays what a dropped socket missed. Called by the realtime layer on
   * resubscribe, and exposed because it is the path that decides whether a
   * reconnect leaves a hole in the thread.
   */
  refreshAfterReconnect(): Promise<void>
  dispose(): void
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const createWorkspaceSession = (options: {
  api: LoomApi
  wsUrl: string
  /** Test seam, forwarded to `connectRealtime`; production passes nothing. */
  socketFactory?: RealtimeOptions['socketFactory']
}): WorkspaceSession => {
  let state: WorkspaceSnapshot = {
    currentActor: null,
    limits: null,
    channels: [],
    unread: {},
    activeChannelId: null,
    activeThread: null,
    channelThreads: [],
    messages: [],
    hasMoreHistory: false,
    threadView: DEFAULT_THREAD_VIEW,
    focusRunId: null,
    loadingHistory: false,
    connection: 'connecting',
    loading: false,
    error: null,
  }

  const listeners = new Set<(snapshot: WorkspaceSnapshot) => void>()
  const eventListeners = new Set<(event: ServerEvent) => void>()
  let realtime: RealtimeConnection | null = null
  /** Opaque cursor for the next *older* page; null once the beginning is reached. */
  let historyCursor: string | null = null

  const patch = (next: Partial<WorkspaceSnapshot>) => {
    state = { ...state, ...next }
    for (const listener of listeners) listener(state)
  }

  /**
   * Raises the unread badge for a message that landed somewhere else.
   *
   * Which channel a thread belongs to is not on the frame — a message carries a thread —
   * so this resolves it from the threads already loaded and gives up quietly when it
   * cannot. Giving up is safe: `channel.unread` re-reads the truth on the next refresh,
   * and the alternative — one lookup per delivered message — is a request per message on
   * a socket that carries a whole run's transcript.
   */
  const bumpUnreadFor = async (message: Message): Promise<void> => {
    if (message.threadId === state.activeThread?.id) return
    const thread = state.channelThreads.find((entry) => entry.id === message.threadId)
    const channelId = thread?.channelId
    if (!channelId || channelId === state.activeChannelId) return
    patch({ unread: { ...state.unread, [channelId]: (state.unread[channelId] ?? 0) + 1 } })
  }

  /**
   * Messages arrive from two races — the initial fetch and the live socket — so
   * insertion is deduplicated by id and kept in ascending order rather than
   * assuming arrival order is correct.
   */
  const mergeMessages = (incoming: readonly Message[]) => {
    const threadId = state.activeThread?.id
    if (threadId === undefined) return
    const known = new Set(state.messages.map((m) => m.id))
    // One patch for the whole batch: a reconnect can replay hundreds of events, and
    // notifying every listener per message would re-render the thread once per event.
    /**
     * The live half of the filter, and the reason `messageInView` is in the domain rather
     * than in the query: messages arrive from two places, and a socket that ignored the
     * view would refill a quiet thread with the firehose the moment anything happened.
     */
    const fresh = incoming.filter(
      (m) =>
        m.threadId === threadId &&
        !known.has(m.id) &&
        messageInView(m, state.threadView, state.focusRunId ?? undefined),
    )
    if (fresh.length === 0) return
    const next = [...state.messages, ...fresh].sort((a, b) =>
      a.createdAt.getTime() === b.createdAt.getTime()
        ? a.id.localeCompare(b.id)
        : a.createdAt.getTime() - b.createdAt.getTime(),
    )
    patch({ messages: next })
  }

  const mergeMessage = (incoming: Message) => mergeMessages([incoming])

  const handleEvent = (event: ServerEvent) => {
    for (const listener of eventListeners) listener(event)
    switch (event.type) {
      case 'message.created':
        mergeMessage(event.message)
        /**
         * A message in a channel the human is not looking at raises its count locally,
         * rather than waiting for the next refresh — the badge is the one thing in the
         * sidebar whose whole value is arriving at the moment the message does.
         *
         * The active channel is deliberately skipped: it is being read, and marking it
         * unread while somebody watches the text appear is the badge nobody trusts.
         */
        void bumpUnreadFor(event.message)
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
      /**
       * Handled by whoever subscribes via `onEvent` — the agent session turns it into
       * a board nudge, and the canvas turns it into an animation. Nothing to merge into
       * *this* session's state: a run's activity is not chat.
       */
      case 'run.activity':
        break
    }
  }

  const PAGE_SIZE = 50

  /** The view, as the wire arguments — one place, so every fetch path agrees. */
  const viewArgs = () => ({
    view: state.threadView,
    ...(state.focusRunId === null ? {} : { focusRunId: state.focusRunId }),
  })

  const loadMessages = async (threadId: string) => {
    const page = await options.api.message.list({ threadId, limit: PAGE_SIZE, ...viewArgs() })
    historyCursor = page.nextCursor
    // Server returns newest-first; the view renders oldest-first.
    patch({ messages: [...page.messages].reverse(), hasMoreHistory: page.nextCursor !== null })
  }

  /**
   * Catches up after a dropped socket.
   *
   * Refetching the newest page was the old answer, and it was wrong twice over: it
   * threw away every older page the reader had already pulled in, and a run that
   * posted more than a page's worth while the socket was down left a hole in the
   * middle that nothing would ever fill. `message.backfill` asks the only question
   * worth asking — what happened after the last message I hold — and existed unused
   * for exactly this.
   */
  const refreshActive = async () => {
    const thread = state.activeThread
    if (!thread) return
    const newest = state.messages[state.messages.length - 1]
    if (!newest) {
      await loadMessages(thread.id)
      return
    }

    let after = newest.id
    try {
      // Bounded: a socket down long enough to miss several pages must still converge,
      // and the server caps each call at 100.
      for (let page = 0; page < 20; page += 1) {
        const missed = await options.api.message.backfill({
          threadId: thread.id,
          afterMessageId: after,
          limit: 100,
        })
        mergeMessages(missed)
        const last = missed[missed.length - 1]
        if (missed.length < 100 || !last) return
        after = last.id
      }
    } catch {
      // The anchor is unknown to the server (a thread switched under us, a message
      // that never committed). Falling back to the newest page loses history a
      // reader had paged in, which is worth it against showing nothing new at all.
      await loadMessages(thread.id)
    }
  }

  return {
    snapshot: () => state,

    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    onServerEvent(listener) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },

    async init() {
      patch({ loading: true, error: null })
      try {
        // Identity comes from the session, never from client config.
        const me = await options.api.session.me()
        const [channels, unread] = await Promise.all([
          options.api.channel.list(),
          options.api.channel.unread(),
        ])
        patch({
          currentActor: me.actor,
          limits: me.limits,
          channels,
          unread: Object.fromEntries(unread.map((row) => [row.channelId, row.unread])),
        })

        realtime = connectRealtime({
          wsUrl: options.wsUrl,
          // Fetched per connect, not held from `me` — see `RealtimeOptions.mintToken`.
          mintToken: async () => (await options.api.session.subscriptionToken()).token,
          onEvent: handleEvent,
          onState: (connection) => patch({ connection }),
          // A dropped socket means missed frames; replay rather than assume.
          onResubscribe: () => {
            void refreshActive()
          },
          ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
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
      historyCursor = null
      /**
       * Cleared locally the moment the channel opens, and told to the server in the
       * background. Waiting for the round trip would leave a badge on the channel the
       * human is already reading, and the marker is idempotent — a failed call means the
       * count comes back on the next refresh, which is the honest outcome rather than a
       * silent lie.
       */
      patch({ unread: { ...state.unread, [channelId]: 0 } })
      void options.api.channel
        .markRead({ channelId })
        .catch(() => {})
      patch({
        loading: true,
        error: null,
        activeChannelId: channelId,
        messages: [],
        channelThreads: [],
        hasMoreHistory: false,
      })
      try {
        const [thread, channelThreads] = await Promise.all([
          options.api.channel.rootThread({ channelId }),
          options.api.channel.threads({ channelId }),
        ])
        patch({ activeThread: thread, channelThreads })
        await loadMessages(thread.id)
      } catch (error) {
        patch({ error: errorMessage(error) })
      } finally {
        patch({ loading: false })
      }
    },

    async setThreadView(view, focusRunId) {
      patch({
        threadView: view,
        focusRunId: view === 'run' ? (focusRunId ?? null) : null,
        messages: [],
        hasMoreHistory: false,
      })
      historyCursor = null
      const thread = state.activeThread
      if (!thread) return
      patch({ loading: true, error: null })
      try {
        await loadMessages(thread.id)
      } catch (error) {
        patch({ error: errorMessage(error) })
      } finally {
        patch({ loading: false })
      }
    },

    async openThread(threadId) {
      const thread = state.channelThreads.find((candidate) => candidate.id === threadId)
      if (!thread || thread.id === state.activeThread?.id) return
      patch({ loading: true, error: null, activeThread: thread, messages: [], hasMoreHistory: false })
      try {
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

    async deleteChannel(input) {
      patch({ error: null })
      try {
        await options.api.channel.delete({
          channelId: input.channelId,
          ...(input.acknowledge ? { acknowledgeRunHistoryLoss: true } : {}),
        })
        const channels = await options.api.channel.list()
        patch({ channels })
        // The deleted channel may be the one on screen, and a view left pointing at a
        // channel that no longer exists shows an empty thread with no explanation.
        if (state.activeChannelId === input.channelId) {
          const next = channels[0]
          if (next) await this.selectChannel(next.id)
          else patch({ activeChannelId: null, activeThread: null, messages: [] })
        }
        return { ok: true, reason: null }
      } catch (error) {
        return { ok: false, reason: errorMessage(error) }
      }
    },

    async send(text) {
      const thread = state.activeThread
      if (!thread || text.trim().length === 0) return
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

    refreshAfterReconnect: refreshActive,

    async loadOlderMessages() {
      const thread = state.activeThread
      const cursor = historyCursor
      if (!thread || cursor === null || state.loadingHistory) return
      patch({ loadingHistory: true })
      try {
        const page = await options.api.message.list({
          threadId: thread.id,
          limit: PAGE_SIZE,
          cursor,
          ...viewArgs(),
        })
        historyCursor = page.nextCursor
        // Prepended rather than merged: this page is strictly older than everything
        // held, and re-sorting a thousand-message thread on every "load earlier" is
        // work with no result to show for it.
        patch({
          messages: [...[...page.messages].reverse(), ...state.messages],
          hasMoreHistory: page.nextCursor !== null,
        })
      } catch (error) {
        patch({ error: errorMessage(error) })
      } finally {
        patch({ loadingHistory: false })
      }
    },

    dispose() {
      realtime?.close()
      realtime = null
      listeners.clear()
      eventListeners.clear()
    },
  }
}
