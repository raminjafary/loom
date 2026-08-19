import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * The surrogate verifier, as a tool — one letter and one assertion.
 *
 * **Offered only to a run the platform started as a verifier**, the same way `record_map` is
 * a mastery-run-only tool: the `start_run` frame carries the option letters, and without them
 * this server is not built at all. A tool every run held would let any agent file a verdict
 * on a search it was never shown.
 *
 * The argument is an **enum of the letters that were actually offered**, which is the
 * point. The self-improvement loop needs a verdict that is a choice among blinded options;
 * a free-text answer would let a model reply "the second one" or invent an option, and the
 * server would then be guessing what it meant about the one fact this whole session exists
 * to produce.
 *
 * The description spends its length on what a bad verdict is, because that is this tool's
 * failure mode: a model comparing two documents will find one "clearer" and stop, and a
 * preference dressed as a finding is worse than no verdict — a human reads it as evidence.
 */

export const VERDICT_SERVER_NAME = 'loom_verdict'
export const SUBMIT_VERDICT_TOOL_NAME = `mcp__${VERDICT_SERVER_NAME}__submit_variant_verdict`

export interface VerdictToolCallbacks {
  readonly submit: (input: {
    choice: string
    reason: string
  }) => Promise<{ ok: true; outcome: string } | { ok: false; error: string }>
}

export const createVerdictTool = (
  optionKeys: readonly string[],
  callbacks: VerdictToolCallbacks,
) => {
  const submit = tool(
    'submit_variant_verdict',
    'Submit your verdict on the candidate instructions you were shown: the letter of the one ' +
      'option you would want every future run of that agent to be given, and why. ' +
      'Call this exactly once, after you have read enough of this repository to have a real ' +
      'opinion — not before. ' +
      'Your reason has to be an assertion rather than a preference: name one concrete thing a ' +
      'run following an option you rejected would get wrong in this repository, and how ' +
      'somebody could check that. "Clearer", "more thorough" and "better structured" are not ' +
      'reasons, and a verdict resting on one is worse than no verdict, because a human will ' +
      'read it as a finding. ' +
      'You are not told which option is the one currently in use, and you should not guess: ' +
      'the question is which would serve this repository, not which looks incumbent.',
    {
      choice: z
        .enum(optionKeys as [string, ...string[]])
        .describe('The letter of the option you would keep. One of the letters you were shown.'),
      reason: z
        .string()
        .min(1)
        .max(2_000)
        .describe(
          'The concrete failure you are asserting — what a run following a rejected option ' +
            'would get wrong here, and how to check it.',
        ),
    },
    async (args) => {
      const result = await callbacks.submit({ choice: args.choice, reason: args.reason })
      return {
        content: [
          {
            type: 'text' as const,
            text: result.ok ? result.outcome : `The verdict was not recorded: ${result.error}`,
          },
        ],
        ...(result.ok ? {} : { isError: true }),
      }
    },
  )

  return createSdkMcpServer({
    name: VERDICT_SERVER_NAME,
    version: '1.0.0',
    tools: [submit],
  })
}
