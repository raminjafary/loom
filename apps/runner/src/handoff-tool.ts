import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { MAX_BRIEF_ITEMS } from '@loom/domain'
import { z } from 'zod'

/**
 * The handover channel.
 *
 * One tool, `hand_over`, and it is offered to **every** run rather than only to one the
 * platform has asked to hand off. That is a deliberate difference from `record_map`,
 * which is given only to a mastery run, and the reason is what the two write: a map is
 * persona-level state every later run reads, so any worker able to write one would make
 * The poisoning risk structural. A brief is read by exactly one successor, in one tree,
 * and is fenced as untrusted when it gets there — so the blast radius is a single run,
 * and the cost of *not* offering it is worse: an agent that realizes it is running out of
 * room and has no way to say what it knows.
 *
 * The description is written for a model that is, by hypothesis, low on context. It says
 * what a brief is *for* rather than what its fields are, because the failure mode here is
 * a summary — a beautifully written account of the work that leaves the next agent
 * deciding what to do, which is the expensive part the handoff was supposed to carry.
 */

export const HANDOFF_SERVER_NAME = 'loom_handoff'
export const HAND_OVER_TOOL_NAME = `mcp__${HANDOFF_SERVER_NAME}__hand_over`

export const HANDOFF_TOOL_NAMES = [HAND_OVER_TOOL_NAME] as const

export interface HandoffToolCallbacks {
 readonly handOver: (brief: {
 done: string[]
 branchState: string
 openQuestions: string[]
 nextStep: string
 changedPaths: string[]
 }) => Promise<{ ok: true } | { ok: false; reason: string }>
}

export const createHandoffTool = (callbacks: HandoffToolCallbacks) => {
 const handOver = tool(
 'hand_over',
 'Hand this work to a fresh agent, when your context is filling up and you are getting ' +
 'worse at the task rather than better. Write what the next agent needs to continue ' +
 'without reading everything you read: what is done, where the branch stands, what is ' +
 'still open, and — required — the single next thing to do. It is a handover, not a ' +
 'report: an account of your work that leaves the next agent deciding what to do next ' +
 'has carried across the cheap part and left the expensive one behind. The platform ' +
 'checks what you say about changed files against what it actually saw written, so be ' +
 'accurate rather than complete.',
 {
 done: z
.array(z.string)
.max(MAX_BRIEF_ITEMS)
.optional
.describe('What is finished. Short lines, the ones that change what happens next.'),
 branchState: z
.string
.optional
.describe('What is committed and what is half-finished, in one or two sentences.'),
 openQuestions: z
.array(z.string)
.max(MAX_BRIEF_ITEMS)
.optional
.describe(
 'What you did not resolve. This is the part a transcript buries and the part ' +
 'the next agent will otherwise rediscover.',
),
 nextStep: z
.string
.describe('The single next thing to do. Required — without it this is a summary.'),
 changedPaths: z
.array(z.string)
.max(MAX_BRIEF_ITEMS)
.optional
.describe(
 'Repository-relative paths you changed. Checked against what the platform saw ' +
 'written, and a mismatch is shown to your successor rather than hidden.',
),
 },
 async (args) => {
 const result = await callbacks.handOver({
 done: args.done ?? [],
 branchState: args.branchState ?? '',
 openQuestions: args.openQuestions ?? [],
 nextStep: args.nextStep,
 changedPaths: args.changedPaths ?? [],
 })

 if (!result.ok) {
 return {
 content: [{ type: 'text' as const, text: `Not handed over: ${result.reason}` }],
 isError: true,
 }
 }
 return {
 content: [
 {
 type: 'text' as const,
 text:
 'Handed over. A successor is starting in this same tree, on this same branch, ' +
 'with your brief and with what the platform observed. Stop here — finish your ' +
 'turn without starting anything new.',
 },
 ],
 }
 },
)

 return createSdkMcpServer({
 name: HANDOFF_SERVER_NAME,
 version: '1.0.0',
 tools: [handOver],
 })
}
