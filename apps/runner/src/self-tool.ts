import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { MAX_PROMPT_BODY_CHARS } from '@loom/domain'
import { z } from 'zod'

/**
 * Tier 1 of continuity mode, as a tool — a run rewrites the prompt of the
 * persona it is.
 *
 * **Offered only to a persona whose envelope permits it.** Absence of an envelope is a
 * refusal, so most runs never see this tool at all — which is the honest way to
 * express "off by default" to a model. The server refuses the frame as well, and the
 * duplication is deliberate: the Runner decides what is *offered*, the server decides what
 * is *allowed*, and this repository has shipped "a tool exists everywhere except the list
 * the model sees" three times in the other direction.
 *
 * **The description is the hard part, and its failure mode is enthusiasm.** A model handed
 * a tool for editing its own instructions will find something to improve on almost every
 * run — usually a restatement of the task it happens to be doing, which is the single
 * worst thing to leave in a prompt that every future run of this persona pays for. So the
 * description spends its length on the bar (a lesson that would have changed how you
 * started, not a summary of what you did) and on the two facts a model reliably gets wrong
 * about this operation: it replaces the whole prompt rather than appending to it, and it
 * does not change the run that calls it.
 */

export const SELF_SERVER_NAME = 'loom_self'
export const REVISE_PROMPT_TOOL_NAME = `mcp__${SELF_SERVER_NAME}__revise_own_prompt`

export const SELF_TOOL_NAMES = [REVISE_PROMPT_TOOL_NAME] as const

export interface SelfToolCallbacks {
 /**
 * Sends the rewrite. The string that comes back is the whole answer — every refusal
 * included, because a refused self-modification is a request a human could grant and
 * the server is the only side that knows what to ask for.
 */
 readonly revisePrompt: (input: {
 body: string
 rationale: string
 }) => Promise<{ ok: true; outcome: string } | { ok: false; error: string }>
}

export const createSelfTool = (callbacks: SelfToolCallbacks) => {
 const revisePrompt = tool(
 'revise_own_prompt',
 'Rewrite your own persona prompt — the standing instructions every future run of this ' +
 'persona is given, including runs on other tasks and other repositories. ' +
 'Worth calling at most once, near the end, and only for something a future run would ' +
 'be wrong without: a convention this codebase actually enforces, a trap you fell into ' +
 'that the instructions did not warn about, a step that turns out to be mandatory here. ' +
 'Not for a summary of this task, not for what you did today, and not for anything ' +
 'specific to one repository unless this persona only ever works in one — a note ' +
 '(write_note) is where task-specific findings go, and it costs nobody future context. ' +
 'Send the COMPLETE new prompt: this replaces the text, it does not append to it, so ' +
 'anything you leave out is gone. Your own instructions do not change — you keep the ' +
 'ones you started with for the rest of this run. A human reviews the change against ' +
 'the version it replaced and can put the old one back, so write something you could ' +
 'defend to them.',
 {
 prompt: z
.string
.min(1)
.max(MAX_PROMPT_BODY_CHARS)
.describe(
 'The complete new prompt, as prose. Not a diff, not an addition — the whole ' +
 'document body, which will be everything the next run of this persona is told.',
),
 why: z
.string
.min(1)
.max(600)
.describe(
 'What you learned that made this worth changing, in one or two sentences. This ' +
 'is what a human reads first when deciding whether to keep it.',
),
 },
 async (args) => {
 const result = await callbacks.revisePrompt({ body: args.prompt, rationale: args.why })
 return {
 content: [
 {
 type: 'text' as const,
 text: result.ok ? result.outcome: `The prompt was not changed: ${result.error}`,
 },
 ],
...(result.ok ? {}: { isError: true }),
 }
 },
)

 return createSdkMcpServer({
 name: SELF_SERVER_NAME,
 version: '1.0.0',
 tools: [revisePrompt],
 })
}
