import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * A harness, as a tool — a graph a designer draws and a person decides about.
 *
 * **Offered only to a run the platform started as a designer**, the same way the answer tool is
 * offered only to a step of a workflow: the `start_run` frame carries the ask, and without it
 * this server is not built at all.
 *
 * ## Why the graph is loose here, when every other tool's arguments are tight
 *
 * Because the alternative is a second definition of what a workflow may be. The vocabulary's
 * rules are not per-field — a template may only read an *ancestor*, a verifier may not run the
 * persona that wrote what it verifies, a node fed by two fans has no lane — and a schema that
 * expressed the fields without those rules would accept graphs the server then refuses, which is
 * the worst of both: a shape that passed validation and cannot run.
 *
 * So the server owns validation, exactly as it does when a graph crosses the contract, and the
 * refusal comes back **as the tool result**: "Fan \"transform\" fans over \"discover.sites\",
 * which is a text and not a list." That is something a session can act on, and it has the rest
 * of its run in which to act. A tool that could only say *no* would be a tool that costs a run
 * per mistake.
 *
 * What the description carries instead of a schema is the shape of the call and the two rules a
 * model most needs restating at the moment it submits: that nothing here runs, and that a name
 * that already exists means a new version of that harness rather than a rival to it.
 */

export const DESIGN_SERVER_NAME = 'loom_design'
export const SUBMIT_WORKFLOW_DESIGN_TOOL_NAME = `mcp__${DESIGN_SERVER_NAME}__submit_workflow_design`

export interface DesignToolCallbacks {
  readonly submit: (input: {
    name: string
    description: string | null
    rationale: string
    graph: unknown
  }) => Promise<{ ok: true; outcome: string } | { ok: false; error: string }>
}

export const createDesignTool = (ask: string, callbacks: DesignToolCallbacks) => {
  const submit = tool(
    'submit_workflow_design',
    'Submit a harness — a reusable shape for a class of work — as a proposal. ' +
      `You were asked for: ${ask} ` +
      'Nothing you submit here runs, and nothing is configured by it: it becomes a drawing a ' +
      'person reads beside what it could spend, and they approve it or they do not. ' +
      'If they approve it, it becomes a version — so a name that already belongs to a harness ' +
      'in this workspace means the *next version of that one*, and a new name means a new ' +
      'harness beside it. ' +
      'The graph is nodes and edges in the vocabulary you were given, sent as JSON. It is ' +
      'validated when it arrives: if it is refused you are told exactly what is wrong, in ' +
      'words, and you can fix it and submit again in this same session. ' +
      'If a harness this workspace already has does the job, say so and do not submit — that ' +
      'is a useful answer and it costs nobody a decision.',
    {
      name: z
        .string()
        .min(1)
        .max(200)
        .describe(
          'What this harness is called. The name of an existing one means a new version of it.',
        ),
      description: z
        .string()
        .max(600)
        .nullable()
        .describe('One line on when to reach for this one rather than another.'),
      rationale: z
        .string()
        .min(1)
        .max(4_000)
        .describe(
          'What this shape would make happen that one run of one agent would not, and what ' +
            'outcome would show it worked. A person reads this to decide; "it is thorough" is ' +
            'not something they can check.',
        ),
      nodes: z
        .array(z.record(z.string().max(40), z.unknown()))
        .min(1)
        .max(24)
        .describe(
          'The nodes, each an object in the vocabulary you were given: kind, id, title, and ' +
            'whatever that kind requires.',
        ),
      edges: z
        .array(z.record(z.string().max(40), z.unknown()))
        .max(64)
        .describe(
          'The edges, each { from, to } — plus `when` out of a router, or `loop: { until }` on ' +
            'an edge pointing back at an ancestor.',
        ),
    },
    async (args) => {
      const result = await callbacks.submit({
        name: args.name,
        description: args.description ?? null,
        rationale: args.rationale,
        /**
         * Assembled here rather than accepted as one blob, because a model handed a single
         * `graph` argument sends a JSON *string* about half the time, and a parse failure on the
         * host reads to the session as the platform refusing its shape.
         */
        graph: { nodes: args.nodes, edges: args.edges },
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: result.ok ? result.outcome : `That shape was not proposed: ${result.error}`,
          },
        ],
        ...(result.ok ? {} : { isError: true }),
      }
    },
  )

  return createSdkMcpServer({
    name: DESIGN_SERVER_NAME,
    version: '1.0.0',
    tools: [submit],
  })
}
