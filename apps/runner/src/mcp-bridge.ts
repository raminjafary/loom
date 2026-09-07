/**
 * A platform channel, read off the in-process server that already holds it.
 *
 * The channels back to the platform — a planner's `submit_plan`, a mastery run's `record_map`,
 * a verifier's verdict, a workflow step's answer, `ask_human`, the notes ledger — are built by
 * the Runner as in-process MCP servers, because one backend's SDK mounts MCP servers. That made
 * them look like a feature of that SDK. They are not: each one is a name, a description, an
 * argument schema and a callback the Runner is already holding, and MCP is one way to hand that
 * to a model.
 *
 * So the second backend does not get twelve hand-written function declarations beside the twelve
 * that already exist. It asks each server what it holds, over the protocol the server already
 * speaks, and renders the answer as chat-completions function declarations. The consequence that
 * matters is not the line count: **a channel cannot be silently missing from this backend**, the
 * way it can when a second list has to be kept in step with the first. This repository has
 * shipped that exact defect three times, most recently a sandboxed designer handed the planner's
 * tool because one optional field was not forwarded — and none of the three failed anything, they
 * just produced runs that could not do their job.
 *
 * Spoken directly as JSON-RPC over a transport written here, rather than with the MCP SDK's
 * client: the server is in this process and already implements the protocol, so what is needed
 * is a pipe with an `initialize` on it. Depending on the client library to talk to an object two
 * scopes away would be a dependency bought for a handshake.
 */

/** One tool a bridged server offers, in the terms a function declaration needs. */
export interface BridgedTool {
  /**
   * The name a model calls it by — `mcp__<server>__<tool>`, which is the name the other
   * backend's SDK exposes for an in-process server's tool.
   *
   * Deliberately identical rather than a shorter alias: the server matches on these names when
   * it reads a run's messages back, `SUBMIT_WORKFLOW_ANSWER_TOOL_NAME` and its siblings are
   * exported constants, and a live driver asserts on the head of the line. A backend that
   * renamed the channels would make every one of those true on one backend and false on the
   * other.
   */
  readonly name: string
  readonly description: string
  /** JSON Schema for the arguments, as the server declares it. */
  readonly parameters: unknown
}

export interface BridgedServer {
  readonly tools: readonly BridgedTool[]
  /** Calls one of them and returns what the channel answered, as text. */
  readonly call: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ readonly text: string; readonly isError: boolean }>
  readonly close: () => Promise<void>
}

/** What `createSdkMcpServer` returns, in the shape this needs and no more. */
export interface SdkServerLike {
  readonly name: string
  readonly instance: {
    connect: (transport: unknown) => Promise<void>
    close?: () => Promise<void>
  }
}

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * The name an in-process server's tool is offered under.
 *
 * One function, exported, because it is a fact about the *platform* rather than about either
 * backend, and two spellings of it would be a channel that exists twice under different names.
 */
export const bridgedToolName = (serverName: string, toolName: string): string =>
  `mcp__${serverName}__${toolName}`

/**
 * Connects to an in-process MCP server and lists what it holds.
 *
 * The transport is a pair of queues: this side's `send` is the server's receive and vice versa.
 * Nothing is serialized to bytes — the SDK's transport contract is message-shaped, so a pipe
 * that hands objects across is a legal transport and a JSON round trip here would only be
 * theatre.
 */
export const bridgeMcpServer = async (server: SdkServerLike): Promise<BridgedServer> => {
  let nextId = 1
  const pending = new Map<number, (message: JsonRpcMessage) => void>()

  /** The server's end of the pipe, as the SDK's `Transport` interface. */
  const transport = {
    onmessage: undefined as ((message: JsonRpcMessage) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    sessionId: undefined as string | undefined,
    async start(): Promise<void> {},
    async send(message: JsonRpcMessage): Promise<void> {
      // A reply to something asked here, or a notification the server sent unprompted. The
      // second is ignored on purpose: nothing this bridge does subscribes to anything.
      if (message.id === undefined) return
      const resolve = pending.get(Number(message.id))
      if (resolve === undefined) return
      pending.delete(Number(message.id))
      resolve(message)
    },
    async close(): Promise<void> {
      this.onclose?.()
    },
  }

  await server.instance.connect(transport)

  const request = async (method: string, params: unknown): Promise<JsonRpcMessage> => {
    const id = nextId++
    const answered = new Promise<JsonRpcMessage>((resolve) => pending.set(id, resolve))
    transport.onmessage?.({ jsonrpc: '2.0', id, method, params })
    return await answered
  }

  const notify = (method: string, params: unknown): void => {
    transport.onmessage?.({ jsonrpc: '2.0', method, params })
  }

  /**
   * The handshake, in full, because the server enforces it: a `tools/list` before `initialize`
   * is answered with an error rather than a list, and the failure would read as a channel that
   * holds nothing.
   */
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'loom-runner-bridge', version: '1.0.0' },
  })
  if (initialized.error) {
    throw new Error(`the ${server.name} channel refused the handshake: ${initialized.error.message}`)
  }
  notify('notifications/initialized', {})

  const listed = await request('tools/list', {})
  if (listed.error) {
    throw new Error(`the ${server.name} channel would not list its tools: ${listed.error.message}`)
  }
  const declared = (listed.result as { tools?: { name: string; description?: string; inputSchema?: unknown }[] })
    .tools ?? []

  const tools: BridgedTool[] = declared.map((entry) => ({
    name: bridgedToolName(server.name, entry.name),
    description: entry.description ?? '',
    parameters: withoutSchemaKeyword(entry.inputSchema),
  }))
  const byName = new Map(tools.map((tool, at) => [tool.name, declared[at]?.name ?? tool.name]))

  return {
    tools,
    async call(name, args) {
      const bare = byName.get(name)
      if (bare === undefined) {
        return { text: `There is no ${name} on this channel.`, isError: true }
      }
      const answered = await request('tools/call', { name: bare, arguments: args })
      if (answered.error) return { text: answered.error.message, isError: true }
      const result = answered.result as {
        content?: { type?: string; text?: string }[]
        isError?: boolean
      }
      /**
       * Text content only, joined. The channels answer in text — a refusal in the validator's
       * own words, a recorded id, an outcome sentence — and a channel that answered an image
       * would be one this backend has no way to show a model anyway, so dropping it here is
       * honest rather than lossy.
       */
      const text = (result.content ?? [])
        .filter((part) => part.type === undefined || part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
        .trim()
      return { text: text === '' ? 'Done.' : text, isError: result.isError === true }
    },
    async close() {
      await server.instance.close?.()
    },
  }
}

/**
 * The schema as a function declaration wants it: no `$schema` keyword.
 *
 * The SDK emits draft-07's, which is correct for a schema document and is rejected outright by
 * some servers that speak this protocol — they validate the declaration against their own
 * subset. Dropped rather than translated: everything else the SDK emits is already the subset.
 */
const withoutSchemaKeyword = (schema: unknown): unknown => {
  if (typeof schema !== 'object' || schema === null) return { type: 'object', properties: {} }
  const { $schema: _dropped, ...rest } = schema as Record<string, unknown>
  return rest
}
