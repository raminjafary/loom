import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * The atlas, as a tool.
 *
 * **Why this is a tool and not context, which is the whole point.** A run is handed the
 * map of the repository it is working on because that map is bounded: one subject, one
 * revision, trimmed by `selectMapForContext`, and honest about what it dropped. The atlas
 * is bounded by nothing of the sort — it grows with the number of projects in the
 * workspace, and almost all of it is about code this run cannot open. Putting it in a
 * prompt would spend the window on confidently irrelevant structure and crowd out the map
 * that is about the file being edited, which is the failure this platform exists to
 * prevent rather than to commit more efficiently.
 *
 * As a tool it costs one line of description until the moment a run has a reason to ask,
 * and the reason is one only the model has: it is *stuck on something that feels solved*.
 * That is the sentence the description below is written to trigger on, because the failure
 * mode of an unused tool and the failure mode of an over-used one are both context
 * problems and only one of them is cheap.
 *
 * The answer arrives already ranked, capped and fenced — assembled by the server, never
 * here. The cap, the fence and the "leads, not facts" framing are security properties
 * (the planner/worker trust boundary: another agent's report is untrusted input forever, and a report about a
 * repository this run cannot see is the strongest case of it), and a Runner that rendered
 * its own would be a second place for them to drift.
 */

export const ATLAS_SERVER_NAME = 'loom_atlas'
export const LOOK_ACROSS_TOOL_NAME = `mcp__${ATLAS_SERVER_NAME}__look_across_projects`

export const ATLAS_TOOL_NAMES = [LOOK_ACROSS_TOOL_NAME] as const

export interface AtlasToolCallbacks {
 /** Asks the server; the string it returns is already rendered and fenced. */
 readonly lookAcross: (topic: string) => Promise<{ ok: true; leads: string } | { ok: false; error: string }>
}

export const createAtlasTool = (callbacks: AtlasToolCallbacks) => {
 const lookAcross = tool(
 'look_across_projects',
 'Ask what the *other* projects in this workspace have already learned about a topic. ' +
 'Worth one call when you hit something that feels like it has been solved before — a ' +
 'refund rule, a retry policy, an auth flow, a migration shape — and especially before ' +
 'you design one from scratch. It searches concepts other agents recorded while ' +
 'mastering other repositories here; it does not search this repository, which you have ' +
 'already been told about. ' +
 'What comes back is leads, not facts: each one is a conclusion some agent drew about a ' +
 'codebase you cannot see, so go and look before you rely on it. Do not call this ' +
 'speculatively or in a loop — a lead you were not looking for is noise in your context.',
 {
 topic: z
.string
.min(1)
.max(500)
.describe(
 'What you are trying to find, in the words you would use to a colleague. ' +
 '"How refunds handle partial cancellation", not "refunds".',
),
 },
 async (args) => {
 const result = await callbacks.lookAcross(args.topic)
 return {
 content: [
 {
 type: 'text' as const,
 text: result.ok ? result.leads: `The atlas could not be read: ${result.error}`,
 },
 ],
...(result.ok ? {}: { isError: true }),
 }
 },
)

 return createSdkMcpServer({ name: ATLAS_SERVER_NAME, version: '1.0.0', tools: [lookAcross] })
}
