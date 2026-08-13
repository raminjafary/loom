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
export const PROPOSE_LINK_TOOL_NAME = `mcp__${ATLAS_SERVER_NAME}__propose_cross_project_link`

export const ATLAS_TOOL_NAMES = [LOOK_ACROSS_TOOL_NAME, PROPOSE_LINK_TOOL_NAME] as const

/** What an agent may claim one concept is to another. Mirrors the domain's closed set. */
export const ATLAS_RELATION_NAMES = ['same_concept', 'analogous_to', 'contradicts'] as const

export interface AtlasLinkProposal {
 readonly mine: string
 readonly theirs: string
 readonly theirSubject?: string
 readonly relation: string
 readonly rationale: string
}

export interface AtlasToolCallbacks {
 /** Asks the server; the string it returns is already rendered and fenced. */
 readonly lookAcross: (topic: string) => Promise<{ ok: true; leads: string } | { ok: false; error: string }>
 /**
 * Proposes a relation. The server resolves both ends, checks them, and returns the
 * sentence the agent is shown — including every refusal, which is why this has no
 * separate error shape for a rejected proposal: "that is not a concept" is an answer,
 * not a failure of the channel.
 */
 readonly proposeLink: (
 proposal: AtlasLinkProposal,
) => Promise<{ ok: true; outcome: string } | { ok: false; error: string }>
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

 /**
 * The write side, and the description is doing the hardest work in this
 * file.
 *
 * **The failure mode is enthusiasm, not reticence.** A model handed a tool called
 * "propose a link" will find links: two things described in similar words look related
 * to a reader who cannot open either, and a queue of forty plausible relations is worse
 * than an empty one because a human stops reading it. So the description spends its
 * length on the bar rather than on the mechanics — you went and looked, you found the
 * thing, you can say what would make it false — and on the one gesture that is always
 * wrong here, which is proposing a relation between two subjects this run cannot open.
 *
 * It also says plainly that nothing happens next. A model told its proposal was
 * recorded will treat the relation as established and reason from it for the rest of
 * the run; the point of the sentence is that its own task is unchanged.
 */
 const proposeLink = tool(
 'propose_cross_project_link',
 'Propose that a concept in THIS project and one in another project here are related. ' +
 'Only worth calling after you have actually looked: you asked look_across_projects, ' +
 'you opened what it pointed at, and the thing was really there. A relation you infer ' +
 'from two similar-sounding summaries is a guess, and it costs a human real time to ' +
 'read. If you cannot say what would make the relation false, you have not established ' +
 'it yet. ' +
 'Name both concepts exactly as they were written — yours as your own map named it, ' +
 'theirs as the lead named it. Nothing is decided by this call: a person reviews the ' +
 'proposal, and until they do, nothing in the system treats the relation as true. Your ' +
 'own task is unaffected either way, so propose it and move on. One per finding; never ' +
 'call this speculatively.',
 {
 mine: z
.string
.min(1)
.max(200)
.describe('The concept in the project you are working on, exactly as your map named it.'),
 theirs: z
.string
.min(1)
.max(200)
.describe('The concept in the other project, exactly as the lead named it.'),
 their_subject: z
.string
.max(200)
.optional
.describe(
 'Which project theirs is in — the name shown beside the lead. Give it whenever ' +
 'you have it; it is what tells two identically-named concepts apart.',
),
 relation: z
.enum(ATLAS_RELATION_NAMES)
.describe(
 'same_concept: one idea implemented twice. analogous_to: different ideas whose ' +
 'shape transfers. contradicts: the two projects decided the same question ' +
 'opposite ways — the most valuable and the least obvious.',
),
 why: z
.string
.min(1)
.max(600)
.describe(
 'What you checked and what it showed. This is what a human reads when deciding; ' +
 '"they both handle refunds" is not an argument.',
),
 },
 async (args) => {
 const result = await callbacks.proposeLink({
 mine: args.mine,
 theirs: args.theirs,
...(args.their_subject === undefined ? {}: { theirSubject: args.their_subject }),
 relation: args.relation,
 rationale: args.why,
 })
 return {
 content: [
 {
 type: 'text' as const,
 text: result.ok ? result.outcome: `The proposal could not be recorded: ${result.error}`,
 },
 ],
...(result.ok ? {}: { isError: true }),
 }
 },
)

 return createSdkMcpServer({
 name: ATLAS_SERVER_NAME,
 version: '1.0.0',
 tools: [lookAcross, proposeLink],
 })
}
