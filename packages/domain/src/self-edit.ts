/**
 * Tier 1 of continuity mode — an agent rewrites its own prompt.
 *
 * Continuity mode calls this "the cheapest and most useful tier", and the cheapness is real: the
 * persona *is* the artifact, so a self-edit is a text replacement rather than a new
 * mechanism. What is not cheap is the part this file exists for — an agent editing the
 * document that decides what it is has a route to editing what it may *do*, and the two
 * are the same file.
 *
 * ## The one rule everything here serves: the body, and only the body
 *
 * A persona's markdown is frontmatter plus a system prompt. The frontmatter is the
 * configuration — tools, model, approval mode, the delegation envelope, the
 * self-modification envelope itself — and the body is the prompt. Tier 1 is the body.
 * Tier 2 (tools and capabilities, within the envelope) is a separate tier for a reason,
 * and tier 0 — rewriting your own ceiling — is not a tier at all: only a human widens an
 * envelope, through the contract.
 *
 * So a self-edit here never *patches* the document. It takes the stored markdown, swaps
 * the body, re-serializes, and then **re-parses the result and refuses if any frontmatter
 * field moved**. That last step is the guard, and it is deliberately a check on the
 * outcome rather than on the input: an input filter has to anticipate what a model might
 * send, and this has to be right against inputs nobody thought of. If the round trip does
 * not produce the same configuration it started with, the edit does not happen — no
 * matter which of the two sides was surprising.
 *
 * ## Why a no-op is a refusal, and a second edit in one run is too
 *
 * Both are cheap guards against a loop. A model that rewrites its prompt, reads it back,
 * and rewrites it again is iterating in the one place where iteration is invisible to
 * whoever has to review it — and unlike a note or a map fragment, every revision here
 * changes what *every future run* of this persona is told.
 *
 * The verdict is a value rather than an exception because every refusal is shown to the
 * model, and continuity mode is explicit that a refusal must arrive as a request a human could grant:
 * "rejected and surfaced to a human as a request, not silently clamped — clamping teaches
 * an agent to probe."
 */

import { envelopeAllows, envelopeRefusalSummary, maySelfModify } from './envelope.js'
import {
 parsePersonaMarkdown,
 serializePersonaMarkdown,
 type ParsedPersonaMarkdown,
} from './persona-markdown.js'

/**
 * The longest system prompt a self-edit may write.
 *
 * Generous against what the built-ins are (a few kilobytes) and small against what a
 * model will produce if nothing stops it. The cost of an over-long prompt is not storage:
 * it is charged to the context window of every future run of this persona, which is the
 * budget this whole platform is careful with everywhere else.
 */
export const MAX_PROMPT_BODY_CHARS = 20_000

/**
 * How many times one run may rewrite its own prompt. One.
 *
 * A second edit in the same run means the first was wrong, and it overwrites a revision
 * no human has seen yet with another one from a model that has learned nothing new since.
 * The value of tier 1 is a durable lesson written once, not a scratchpad — a run with
 * more to say has the notes ledger, which is read by its
 * siblings and costs nobody's future context.
 */
export const MAX_SELF_REVISIONS_PER_RUN = 1

export type SelfEditRule =
 /** No envelope: this persona has no permission to rewrite itself at all. */
 | 'no-envelope'
 /** Already rewritten once in this run. */
 | 'cap'
 | 'empty'
 | 'too-long'
 /** Byte-identical to the prompt it already has. */
 | 'unchanged'
 /** The round trip did not preserve the frontmatter — see this file's header. */
 | 'frontmatter-changed'
 /** The body opens with a frontmatter delimiter, so the document reads as two of them. */
 | 'looks-like-frontmatter'
 /** The resulting persona does not fit its own ceiling. */
 | 'envelope'
 /** The stored markdown could not be parsed, so there is nothing to edit safely. */
 | 'unparseable'

export type SelfEditVerdict =
 | { readonly ok: true; readonly markdown: string; readonly body: string }
 | { readonly ok: false; readonly rule: SelfEditRule; readonly reason: string }

/** Every frontmatter field, compared as a whole. Adding a field to the format adds it here. */
const frontmatterOf = (parsed: ParsedPersonaMarkdown): string =>
 JSON.stringify({
 name: parsed.name,
 description: parsed.description,
 model: parsed.model,
 tools: parsed.tools,
 harnessEffort: parsed.harnessEffort,
 harnessMaxTurns: parsed.harnessMaxTurns,
 harnessApprovalMode: parsed.harnessApprovalMode,
 harnessPlanner: parsed.harnessPlanner,
 harnessDelegates: parsed.harnessDelegates,
 harnessBudgetCapUsd: parsed.harnessBudgetCapUsd,
 envelope: parsed.envelope,
 })

/**
 * The result of an agent rewriting its own system prompt, or the reason it may not.
 *
 * `currentMarkdown` is the stored persona — the source of truth, not the run's snapshot.
 * A run edits the persona as it is *now*, because what it is writing is for whoever runs
 * next; its own snapshot is deliberately frozen and stays that way for the rest of the
 * run.
 */
export const revisePromptBody = (input: {
 readonly currentMarkdown: string
 readonly body: string
 /** How many times this run has already done this. */
 readonly revisionsThisRun: number
}): SelfEditVerdict => {
 let current: ParsedPersonaMarkdown
 try {
 current = parsePersonaMarkdown(input.currentMarkdown)
 } catch (error) {
 return {
 ok: false,
 rule: 'unparseable',
 reason:
 'Your persona could not be read as a persona document, so it cannot be edited ' +
 `safely: ${error instanceof Error ? error.message: String(error)}. A human has ` +
 'to fix it. Carry on with your task.',
 }
 }

 /**
 * The permission check, first, and phrased as the request continuity mode asks for. Before the
 * shape checks on purpose: a persona with no envelope should hear the same sentence
 * whether or not what it tried to write was well-formed, or the refusal doubles as a
 * probe for how long a prompt it could have written.
 */
 if (!maySelfModify(current.envelope)) {
 return {
 ok: false,
 rule: 'no-envelope',
 reason:
 `${current.name} has no self-modification envelope, so it may not rewrite its own ` +
 'prompt. An absent envelope is no permission, not an unlimited one — a human sets ' +
 'a ceiling first, through the workspace, and it is theirs to set rather than yours ' +
 'to ask for repeatedly. Carry on with your task.',
 }
 }

 if (input.revisionsThisRun >= MAX_SELF_REVISIONS_PER_RUN) {
 return {
 ok: false,
 rule: 'cap',
 reason:
 `You have already rewritten this prompt once in this run, which is the limit. The ` +
 'first version is what a human will review; a second would overwrite it with the ' +
 'judgement of a run that has learned nothing since. If you have more to record, ' +
 'write a note — your siblings read those and nobody pays for them twice.',
 }
 }

 const body = input.body.trim
 if (body.length === 0) {
 return {
 ok: false,
 rule: 'empty',
 reason:
 'An empty prompt is not an edit — it would leave the next run of this persona with ' +
 'no instructions at all. Send the whole prompt you want it to have.',
 }
 }
 if (body.length > MAX_PROMPT_BODY_CHARS) {
 return {
 ok: false,
 rule: 'too-long',
 reason:
 `That prompt is ${body.length} characters and the limit is ${MAX_PROMPT_BODY_CHARS}. ` +
 'Every future run of this persona pays for this text out of its context window, so ' +
 'the limit is about their room to work rather than about storage.',
 }
 }
 /**
 * A body whose first line is the frontmatter delimiter, refused — and the reason is
 * about the *reviewer* rather than about the parser, which is why it is a rule of its
 * own rather than a case of the round-trip check below.
 *
 * The parser is not fooled: the frontmatter ends at the first closing `---`, so a second
 * block after it is prose and the configuration is unchanged. That is exactly what makes
 * this worth refusing. The control on tier 1 is that a human can read the revision and
 * see what it did, and a document that opens with two frontmatter blocks — the second
 * one granting Bash, say — is built to be misread by the person whose job is to catch
 * it. A markdown rule *inside* the prose is ordinary writing and stays allowed; opening
 * with one is not a thing a system prompt does.
 */
 if (body.split('\n')[0]?.trim === '---') {
 return {
 ok: false,
 rule: 'looks-like-frontmatter',
 reason:
 'A prompt may not begin with "---". Nothing about your configuration would have ' +
 'changed — the platform reads it from the block a human wrote — but the document ' +
 'would then show two frontmatter blocks to whoever reviews this edit, and a ' +
 'revision built to be misread is one that gets reverted. Start with the prose.',
 }
 }

 if (body === current.systemPrompt.trim) {
 return {
 ok: false,
 rule: 'unchanged',
 reason:
 'That is the prompt you already have, character for character. Nothing was ' +
 'recorded — a revision a human has to read should be one that says something new.',
 }
 }

 const markdown = serializePersonaMarkdown({...current, systemPrompt: body })

 /**
 * The guard. Everything above is about the body; this is the only check that would
 * catch a body that turned out not to be one — a document whose text re-parses into a
 * different configuration than the one it was built from.
 *
 * Checked on the output rather than the input, because the failure being guarded is
 * "something crossed from the body into the frontmatter", and the only place that is
 * observable is after a round trip.
 */
 let reparsed: ParsedPersonaMarkdown
 try {
 reparsed = parsePersonaMarkdown(markdown)
 } catch (error) {
 return {
 ok: false,
 rule: 'frontmatter-changed',
 reason:
 'That prompt does not survive being written into a persona document — it would no ' +
 `longer parse (${error instanceof Error ? error.message: String(error)}). Nothing ` +
 'was changed. Send the prompt as plain prose.',
 }
 }
 if (frontmatterOf(reparsed) !== frontmatterOf(current)) {
 return {
 ok: false,
 rule: 'frontmatter-changed',
 reason:
 'That text would change this persona\'s configuration — its tools, model, approval ' +
 'mode or envelope — and not only its prompt. Only a human changes those. Nothing ' +
 'was changed; send prose for the prompt itself.',
 }
 }
 if (reparsed.systemPrompt.trim !== body) {
 return {
 ok: false,
 rule: 'frontmatter-changed',
 reason:
 'That text does not come back the same way it went in, so it cannot be stored ' +
 'safely. Nothing was changed. Send the prompt as plain prose.',
 }
 }

 /**
 * Defence in depth, and it should be unreachable: the frontmatter is byte-identical to
 * a persona that was already checked against its own envelope where it was authored.
 * It stays because "unreachable" is a property of today's serializer, and the cost of
 * being wrong about it is an agent reaching a configuration a human could not have
 * written — the own reason for `envelopeAllows` being one function rather than two.
 */
 const fits = envelopeAllows(reparsed.envelope, {
 name: reparsed.name,
 tools: reparsed.tools,
 model: reparsed.model,
 budgetCapUsd: reparsed.harnessBudgetCapUsd,
 approvalMode: reparsed.harnessApprovalMode,
 planner: reparsed.harnessPlanner,
 delegates: reparsed.harnessDelegates,
 })
 if (!fits.ok) {
 return {
 ok: false,
 rule: 'envelope',
 reason: `That would put this persona outside its envelope. ${envelopeRefusalSummary(fits)}`,
 }
 }

 return { ok: true, markdown, body }
}
