import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * The prosecutor's channel: tests it wrote against another run's diff, and what happened.
 *
 * **Offered only to a run the platform started as a prosecutor**, the same gating the answer
 * and design tools have: the `start_run` frame says so, and without it this server is not
 * built at all.
 *
 * ## The wording is the feature
 *
 * A model handed a tool called `report_prosecution` with a `passed`/`failed` field will write
 * a verdict, because that is what those words are for. This pass does not have a verdict to
 * give — the repository's definition of done is the arbiter, and a generated test that could
 * refuse a merge would be a model writing its own gate. So the vocabulary is `held` and
 * `broke`, the description says outright that nothing here blocks anything, and the tool asks
 * for what the prosecutor *ran* rather than what it concluded.
 *
 * The second thing the description has to carry is what makes this pass worth its tokens at
 * all: the repository's standing suite is the set this change is least likely to be caught by,
 * because it was written before the change existed. A prosecutor that re-runs the suite has
 * done nothing. It has to write something new, aimed at this diff, and run it.
 */

export const PROSECUTION_SERVER_NAME = 'loom_prosecution'
export const REPORT_PROSECUTION_TOOL_NAME = `mcp__${PROSECUTION_SERVER_NAME}__report_prosecution`

export interface ProsecutionToolCallbacks {
  readonly report: (input: {
    observations: { name: string; outcome: 'held' | 'broke'; detail: string | null }[]
    inconclusive: string | null
  }) => Promise<{ ok: true; outcome: string } | { ok: false; error: string }>
}

export const createProsecutionTool = (callbacks: ProsecutionToolCallbacks) => {
  const report = tool(
    'report_prosecution',
    'Report the tests you wrote against this diff and what happened when you ran them. ' +
      'This is evidence for the person reviewing the change. It is not a verdict: nothing you ' +
      'report here blocks a merge, fails the branch, or enters the repository\'s definition of ' +
      'done — the repository\'s own checks decide that, and they have already run. ' +
      'What is useful here is a probe that did not exist before this diff did. The standing ' +
      'suite was written by people who had never seen this change, so it is exactly the set ' +
      'least likely to catch it; re-running it tells the reviewer nothing they do not have. ' +
      'Write the test that this change makes worth writing, run it, and say what you saw. ' +
      'If your own tests would not run at all, say that in `inconclusive` rather than ' +
      'reporting an empty list — "I found nothing" and "I could not look" are different ' +
      'sentences and the reviewer needs the true one.',
    {
      observations: z
        .array(
          z.object({
            name: z
              .string()
              .min(1)
              .max(200)
              .describe('What this probe was checking, in your own words.'),
            outcome: z
              .enum(['held', 'broke'])
              .describe(
                '`held` — the diff survived this probe. `broke` — it did not. Not pass/fail: ' +
                  'this is an observation, and a broken probe is sometimes a bad probe.',
              ),
            detail: z
              .string()
              .max(4_000)
              .nullable()
              .describe(
                'What you saw — the assertion, the output, the values. A reviewer should be ' +
                  'able to decide whether to care without re-running it.',
              ),
          }),
        )
        .max(20)
        .describe('One entry per test you actually ran. An empty list means you found nothing worth reporting.'),
      inconclusive: z
        .string()
        .max(600)
        .nullable()
        .describe(
          'Set this only if you could not produce usable observations — your tests would not ' +
            'compile, the harness would not start. Leave it null if you looked and found nothing.',
        ),
    },
    async (args) => {
      const result = await callbacks.report({
        observations: args.observations.map((entry) => ({
          name: entry.name,
          outcome: entry.outcome,
          detail: entry.detail ?? null,
        })),
        inconclusive: args.inconclusive ?? null,
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: result.ok ? result.outcome : `That report was not recorded: ${result.error}`,
          },
        ],
        ...(result.ok ? {} : { isError: true }),
      }
    },
  )

  return createSdkMcpServer({
    name: PROSECUTION_SERVER_NAME,
    version: '1.0.0',
    tools: [report],
  })
}
