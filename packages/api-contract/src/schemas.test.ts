import { describe, expect, it } from 'vitest'
import { ActorSchema, MessageSchema, PersonaSpecSchema, ServerEventSchema } from './schemas.js'

describe('ActorSchema', => {
 it('accepts each actor kind', => {
 expect(ActorSchema.parse({ kind: 'user', userId: 'u1' })).toEqual({
 kind: 'user',
 userId: 'u1',
 })
 expect(ActorSchema.parse({ kind: 'agent_run', agentRunId: 'r1' }).kind).toBe('agent_run')
 expect(ActorSchema.parse({ kind: 'system' }).kind).toBe('system')
 })

 it('rejects an unknown kind and a user actor missing its id', => {
 expect(ActorSchema.safeParse({ kind: 'robot' }).success).toBe(false)
 expect(ActorSchema.safeParse({ kind: 'user' }).success).toBe(false)
 })

 it('rejects a user actor carrying an agent id — the kinds must not blur', => {
 expect(ActorSchema.safeParse({ kind: 'user', agentRunId: 'r1' }).success).toBe(false)
 })
})

describe('MessageSchema', => {
 const valid = {
 id: 'm1',
 workspaceId: 'w1',
 threadId: 't1',
 author: { kind: 'user' as const, userId: 'u1' },
 body: { kind: 'text' as const, text: 'hi' },
 toolUseId: null,
 createdAt: new Date('2026-01-01T00:00:00Z'),
 editedAt: null,
 }

 it('accepts a well-formed message', => {
 expect(MessageSchema.parse(valid).body.text).toBe('hi')
 })

 /**
 * This assertion used to be its opposite — "requires a Date, not an ISO string, the
 * wire codec must preserve type" — and that sentence is only true of the RPC path.
 * The realtime path is `JSON.stringify` at the publisher and raw bytes through the
 * gateway, so insisting on a `Date` there rejected every frame silently. The
 * timestamp is normalised to a `Date` either way; what a caller must never have to
 * know is which transport delivered it.
 */
 it('accepts an ISO string and normalises it, because the socket cannot send a Date', => {
 const parsed = MessageSchema.parse({...valid, createdAt: '2026-01-01T00:00:00Z' })
 expect(parsed.createdAt).toBeInstanceOf(Date)
 expect(parsed.createdAt.toISOString).toBe('2026-01-01T00:00:00.000Z')
 })

 it('still rejects a timestamp that is not a date at all', => {
 expect(MessageSchema.safeParse({...valid, createdAt: 'yesterday' }).success).toBe(false)
 expect(MessageSchema.safeParse({...valid, createdAt: {} }).success).toBe(false)
 })

 it('rejects an unknown body kind', => {
 expect(MessageSchema.safeParse({...valid, body: { kind: 'html', text: '<b>' } }).success).toBe(
 false,
)
 })
})

describe('ServerEventSchema', => {
 const message = {
 id: 'm1',
 workspaceId: 'w1',
 threadId: 't1',
 author: { kind: 'system' as const },
 body: { kind: 'system' as const, text: 'joined' },
 toolUseId: null,
 createdAt: new Date('2026-02-03T04:05:06Z'),
 editedAt: null,
 }

 const FRAMES = [
 { type: 'message.created' as const, threadId: 't1', message },
 {
 type: 'channel.created' as const,
 channel: {
 id: 'c1',
 workspaceId: 'w1',
 name: 'general',
 topic: null,
 isPrivate: false,
 createdAt: new Date('2026-02-03T04:05:06Z'),
 },
 },
 {
 type: 'thread.created' as const,
 thread: {
 id: 't1',
 workspaceId: 'w1',
 channelId: 'c1',
 parentMessageId: null,
 isRoot: true,
 createdAt: new Date('2026-02-03T04:05:06Z'),
 },
 },
 /**
 * The live-activity frame. It belongs in this list for the same
 * reason the others do, and for one more: `at` is a `Date` that crosses the socket
 * as an ISO string, which is precisely the bug the round-trip test above exists to
 * catch — `MessageSchema.createdAt` was `z.date` and silently dropped every
 * frame for four sessions while the indicator said "Live".
 */
 {
 type: 'run.activity' as const,
 treeRunId: 'r0',
 agentRunId: 'r1',
 parentRunId: 'r0',
 kind: 'tool_call' as const,
 label: 'Read',
 status: 'running',
 at: new Date('2026-02-03T04:05:06Z'),
 },
 ]

 it('accepts a message.created frame', => {
 expect(ServerEventSchema.parse(FRAMES[0]).type).toBe('message.created')
 })

 /**
 * The regression that matters, and the one that was missing.
 *
 * `connectRealtime` drops any frame this schema does not recognise — the right
 * behaviour for control frames, and a silent failure for a domain event that merely
 * lost a type in transit. Every frame therefore has to survive the exact trip it
 * really takes: `JSON.stringify` in apps/server/src/events.ts, Valkey, a gateway
 * that forwards bytes untouched, and `JSON.parse` in the client. Feeding this
 * schema a hand-built object with live `Date`s tests a journey no frame ever makes.
 */
 it.each(FRAMES.map((frame) => [frame.type, frame] as const))(
 'survives the JSON round trip a real %s frame makes',
 (_type, frame) => {
 const result = ServerEventSchema.safeParse(JSON.parse(JSON.stringify(frame)))
 expect(result.success).toBe(true)
 },
)

 /**
 * Guards the list above against a fourth frame type being added without one: the
 * union is the only place that knows how many there are.
 */
 it('covers every frame type the union declares', => {
 expect(FRAMES).toHaveLength(ServerEventSchema.options.length)
 })

 it('rejects control frames, which are transport-level and not domain events', => {
 expect(ServerEventSchema.safeParse({ type: 'subscribed', workspaceId: 'w1' }).success).toBe(
 false,
)
 expect(ServerEventSchema.safeParse({ type: 'error', message: 'nope' }).success).toBe(false)
 })
})

/**
 * The frame carries the envelope.
 *
 * This test exists because of a failure this repository has now paid for four times: **a
 * Zod schema strips what it does not name.** A field added to a domain type and forgotten
 * on the frame crosses the wire as `undefined`, every typecheck passes, and the value
 * simply is not there. An envelope lost that way is a ceiling that stops applying one
 * delegation hop down, which is silent and is the whole thing continuity mode exists to prevent.
 */
describe('PersonaSpecSchema carries the self-modification envelope', => {
 const spec = {
 name: 'swe',
 systemPrompt: 'body',
 model: 'claude-sonnet-5',
 tools: ['Read'],
 approvalMode: 'ask' as const,
 budgetCapUsd: 5,
 envelope: {
 tools: ['Read', 'Edit'],
 model: 'claude-sonnet-5',
 budgetCapUsd: 10,
 capabilities: ['github'],
 subagentDepth: 1,
 approvalMode: 'accept-edits' as const,
 },
 }

 it('round-trips every field of the envelope rather than stripping it', => {
 const parsed = PersonaSpecSchema.parse(spec)
 expect(parsed.envelope).toEqual(spec.envelope)
 })

 /** Absence has to survive too, and mean what it means: no permission, not no ceiling. */
 it('accepts a spec with no envelope', => {
 const { envelope: _dropped,...without } = spec
 expect(PersonaSpecSchema.parse(without).envelope).toBeUndefined
 expect(PersonaSpecSchema.parse({...without, envelope: null }).envelope).toBeNull
 })

 it('refuses an envelope missing a field, rather than defaulting it', => {
 const { tools: _dropped,...partial } = spec.envelope
 expect(PersonaSpecSchema.safeParse({...spec, envelope: partial }).success).toBe(false)
 })
})
