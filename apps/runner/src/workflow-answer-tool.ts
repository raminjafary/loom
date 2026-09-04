import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * One workflow step's answer, as a tool whose arguments are the fields its node declared.
 *
 * **Offered only to a run the platform started as a step of a drawn workflow**, the same way
 * `record_map` is a mastery-run-only tool: the `start_run` frame carries the schema, and
 * without it this server is not built at all.
 *
 * The schema is built from the frame rather than fixed, and that is the whole point of the
 * channel. Everything downstream of a step reads its answer as *data* — a fan fans over a list
 * here, a loop stops on a flag here, a later step interpolates a value here — so an answer that
 * arrived as prose would make every one of those a guess. Handing the model the exact fields
 * turns "did it answer in the right shape" from something the server discovers afterwards into
 * something the tool call itself enforces, and a mis-shaped call comes back as a tool error the
 * model still has time to fix.
 *
 * No step id, no node id, no workflow id. The server resolves which step this is from the run
 * it started, and a step able to name itself would be a step able to answer for a sibling —
 * which, in a graph that deals eight lanes at once, is not a hypothetical.
 */

export const WORKFLOW_SERVER_NAME = 'loom_workflow'
export const SUBMIT_WORKFLOW_ANSWER_TOOL_NAME = `mcp__${WORKFLOW_SERVER_NAME}__submit_workflow_answer`

export interface WorkflowAnswerField {
  readonly kind: 'text' | 'flag' | 'list'
  readonly name: string
  /**
   * The whole vocabulary this field admits, where the platform owns it rather than the author —
   * a bracket's `winner`, a router's `choice`.
   *
   * Rendered as an enum, so a value outside it comes back as a tool error the model still has
   * time to fix. Without this the same mistake arrives at the server as a well-shaped string,
   * and the honest thing the server can do with it is refuse the step — a refusal the model
   * never saw and could not have corrected.
   */
  readonly choices?: readonly string[] | undefined
}

export interface WorkflowAnswerToolCallbacks {
  readonly submit: (
    answer: Record<string, unknown>,
  ) => Promise<{ ok: true; outcome: string } | { ok: false; error: string }>
}

const shapeOf = (fields: readonly WorkflowAnswerField[]): z.ZodRawShape => {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const field of fields) {
    const choices = field.choices ?? []
    if (choices.length >= 2) {
      shape[field.name] = z
        .enum(choices as [string, ...string[]])
        .describe(
          `"${field.name}": exactly one of ${choices.join(', ')}. Nothing else is an answer ` +
            'here — a description of what you preferred is not one of these words.',
        )
      continue
    }
    shape[field.name] =
      field.kind === 'text'
        ? z.string().min(1).max(20_000).describe(`The "${field.name}" your step was asked for.`)
        : field.kind === 'flag'
          ? z.boolean().describe(`"${field.name}": true or false, and nothing in between.`)
          : z
              .array(z.string().min(1).max(4_000))
              .max(64)
              .describe(
                `"${field.name}", as a list. One entry per thing — the workflow runs the next ` +
                  'step once per entry, so a single entry holding several is a single step.',
              )
  }
  return shape
}

export const createWorkflowAnswerTool = (
  fields: readonly WorkflowAnswerField[],
  callbacks: WorkflowAnswerToolCallbacks,
) => {
  const submit = tool(
    'submit_workflow_answer',
    'Submit this step\'s answer to the workflow it belongs to. ' +
      'Call this exactly once, when you have finished the work you were asked for — not ' +
      'before, and not instead of doing it. ' +
      'What you send here is the only thing the rest of the workflow sees: the steps after ' +
      'yours are given these fields and nothing else from your session, so an answer that ' +
      'points at work you did without describing it leaves them with nothing. ' +
      'A list field is a list of separate things, because the workflow may run the next step ' +
      'once per entry — putting three findings in one entry buys one run where three were ' +
      'drawn. ' +
      'If you could not do what you were asked, say so in the fields you were given rather ' +
      'than inventing a plausible answer: a step that reports success it did not have is ' +
      'worse than one that reports failure, because everything below it is then built on it.',
    shapeOf(fields),
    async (args) => {
      const result = await callbacks.submit(args as Record<string, unknown>)
      return {
        content: [
          {
            type: 'text' as const,
            text: result.ok ? result.outcome : `The answer was not recorded: ${result.error}`,
          },
        ],
        ...(result.ok ? {} : { isError: true }),
      }
    },
  )

  return createSdkMcpServer({
    name: WORKFLOW_SERVER_NAME,
    version: '1.0.0',
    tools: [submit],
  })
}
