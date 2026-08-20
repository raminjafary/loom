import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { MAX_PROMPT_BODY_CHARS } from '@loom/domain'
import { z } from 'zod'

/**
 * The proposer, as a tool — candidates for a persona this session is not.
 *
 * **Offered only to a run the platform started as a proposer**, the way the verdict tool is
 * offered only to a verifier: the `start_run` frame names the subject, and without it this
 * server is not built at all. It is deliberately *not* part of `loom_self`, and the reason is
 * the whole difference between this piece and the one it replaces. `loom_self` is an agent
 * changing its own configuration, gated on that persona's envelope; this is a session writing
 * candidates for a persona it has never run as, granted for one session by the platform. A
 * tool bundled with `revise_own_prompt` would hand a proposer the two tiers it must not have —
 * it would be able to edit *itself* while proposing for somebody else.
 *
 * Nothing here decides what is allowed. The submission goes back through the same validator
 * every candidate has always gone through, so a proposer cannot reach a configuration a
 * tier-1 edit could not: the subject's envelope, the round trip, the archive rule, the
 * "identical to the prompt in use" check. What this file decides is what a model is *told*,
 * and its failure mode is specific: a session handed a record of failures will summarise the
 * record. A candidate that recites what went wrong is not an instruction — so the description
 * spends its length on the difference between a diagnosis and a prompt.
 */

export const PROPOSAL_SERVER_NAME = 'loom_proposal'
export const SUBMIT_PROPOSALS_TOOL_NAME = `mcp__${PROPOSAL_SERVER_NAME}__submit_variant_proposals`

export interface ProposalToolCallbacks {
  readonly submit: (input: {
    variants: { body: string; rationale: string }[]
  }) => Promise<{ ok: true; outcome: string } | { ok: false; error: string }>
}

export const createProposalTool = (personaName: string, callbacks: ProposalToolCallbacks) => {
  const submit = tool(
    'submit_variant_proposals',
    `Submit two or three candidate prompts for the persona "${personaName}" — the complete ` +
      'standing instructions every future run of it would be given. This is the one thing ' +
      'this session exists to produce, and you call it once. ' +
      'Nothing goes live. Later runs of that persona are dealt out between your candidates ' +
      'and the prompt it has now, a held-out screen may refuse one before it costs a live ' +
      'run, and a human promotes whichever produced the better outcomes — or discards all of ' +
      'them. ' +
      'Write instructions, not findings. You were shown a record of what has already failed ' +
      'for this persona; a candidate that describes those failures is a diagnosis, and a ' +
      'future run cannot act on a diagnosis. Say what to do. ' +
      'Each candidate must be the COMPLETE prompt as prose — it replaces the text rather ' +
      'than adding to it, so anything you leave out is gone — and they must differ in what ' +
      'they would make a run **do**: a different order of work, a different default, a ' +
      'different thing to check first. Three rewordings of one instruction are three arms ' +
      'measuring the same behaviour, and they settle nothing at three times the cost. ' +
      'Do not re-send a body the record listed as already carried or already rejected: that ' +
      'is refused when it arrives and it costs a candidate slot for nothing.',
    {
      variants: z
        .array(
          z.object({
            prompt: z
              .string()
              .min(1)
              .max(MAX_PROMPT_BODY_CHARS)
              .describe(
                'One complete candidate prompt for that persona, as prose. Not a diff, not ' +
                  'an addition, and not a critique of the prompt it would replace.',
              ),
            why: z
              .string()
              .min(1)
              .max(600)
              .describe(
                'What this candidate would make a run do differently, and what outcome would ' +
                  'show it worked. A human reads this beside the measured results, so name ' +
                  'something checkable rather than calling it clearer.',
              ),
          }),
        )
        .min(2)
        .max(3)
        .describe('Two or three candidates. They must be genuinely different instructions.'),
    },
    async (args) => {
      const result = await callbacks.submit({
        variants: args.variants.map((variant) => ({
          body: variant.prompt,
          rationale: variant.why,
        })),
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: result.ok ? result.outcome : `No search was opened: ${result.error}`,
          },
        ],
        ...(result.ok ? {} : { isError: true }),
      }
    },
  )

  return createSdkMcpServer({
    name: PROPOSAL_SERVER_NAME,
    version: '1.0.0',
    tools: [submit],
  })
}
