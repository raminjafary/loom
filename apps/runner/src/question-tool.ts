import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * `ask_human` — an agent asking a question and blocking on the answer
 *.
 *
 * Mid-flight steering calls this "the smallest real piece of steering", and the design is that it is
 * **not a new mechanism**: "a clarifying question is that same gate carrying a prompt
 * and returning a string. Reuse it rather than build a second blocking channel." So
 * this round-trips exactly like `read_notes` and the approval gate — server, human,
 * back — and inherits the SLA, the auto-deny, the notification and the identity
 * binding rather than re-implementing any of them.
 *
 * Given to every run including a Planner. Asking a question is not a capability: a
 * `tools: []` Planner still holds no filesystem and no shell, and the question has no
 * effect the platform does not then decide for itself.
 *
 * **The description is doing real work.** A model that asks whenever it is slightly
 * unsure turns a swarm into a queue of interruptions, which is the failure mode that
 * makes a human stop reading them — so it says when *not* to ask, and says that
 * guessing-and-recording is the cheaper default. The whole justification is reducing
 * the human attention the riskiest assumption measured as the real cost, and a chatty tool spends exactly
 * that.
 */

export const QUESTION_SERVER_NAME = 'loom_ask'
export const ASK_HUMAN_TOOL_NAME = `mcp__${QUESTION_SERVER_NAME}__ask_human`

export interface QuestionToolCallbacks {
 /**
 * Sends the question and resolves when a human answers, the gate is denied, or the
 * SLA expires. `answer: null` is "nobody answered" — never an error, because mid-flight steering
 * requires the run to continue either way: "a run blocked forever on a question
 * nobody saw is worse than a run that guessed and said so."
 */
 readonly askHuman: (question: string) => Promise<{ answer: string | null }>
}

export const createQuestionTool = (callbacks: QuestionToolCallbacks) => {
 const askHuman = tool(
 'ask_human',
 'Ask the human supervising this work a question, and wait for their answer. Use ' +
 'this only when the answer would change what you build and you cannot determine ' +
 'it from the repository, your task, or the shared notes — an ambiguous ' +
 'requirement, or a choice between two designs that are both defensible. Do not ' +
 'use it to confirm something you already believe, to report progress, or to ask ' +
 'permission for a tool call: risky calls are gated separately and automatically. ' +
 'If you can pick a reasonable answer and record it as a decision note instead, ' +
 'do that — it is cheaper for everyone. Asking blocks you until someone replies, ' +
 'and if nobody does within the review window you will be told so and must ' +
 'proceed on your own judgement.',
 {
 question: z
.string
.min(1)
.max(2_000)
.describe(
 'The question, written so someone who has not read your task can answer it. ' +
 'State the options you are choosing between and what you will do by default.',
),
 },
 async (args) => {
 const { answer } = await callbacks.askHuman(args.question)
 return {
 content: [
 {
 type: 'text' as const,
 // The no-answer case says what happened *and* what to do about it. "No
 // answer" alone invites the model to ask again, which is the loop this
 // must not create.
 text:
 answer === null
 ? 'Nobody answered within the review window. Proceed on your own ' +
 'judgement, record the choice you made as a decision note, and do not ' +
 'ask this question again.'
: answer,
 },
 ],
 }
 },
)

 return {
 server: createSdkMcpServer({
 name: QUESTION_SERVER_NAME,
 version: '1.0.0',
 tools: [askHuman],
 }),
 }
}
