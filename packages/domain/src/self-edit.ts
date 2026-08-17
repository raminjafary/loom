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
 *
 * ## Why a prompt this persona *used* to have is a refusal too
 *
 * The self-improvement loop names the archive as one of the four pieces an evolutionary loop needs, and says
 * what it is for beyond the record: it "stops the loop re-proposing a failure it already
 * paid for". Nothing implemented that. `unchanged` below compares against the *live*
 * prompt and `proposeVariantSet`'s `duplicate` compares candidates against each other, so
 * a body byte-identical to a revision this persona already moved away from was accepted —
 * and, for a variant, opened an arm that costs five decided runs to re-derive a verdict the
 * history already holds.
 *
 * The refusal is also the cheapest feedback channel the loop has. A run cannot read the
 * revision history — `listPersonaRevisions` is reachable from the contract and never from
 * the agent path, deliberately, since it is a persona's whole editing lineage — so the one
 * moment where telling it "you already tried this, and here is what happened to it" costs
 * nothing extra is the moment it tries. That is why the reason names *who* replaced the
 * text and *when*, rather than only refusing.
 */

import type { PersonaRevisionAuthorKind } from './agents.js'
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
 /** Byte-identical to a prompt it *used* to have — see this file's header. */
 | 'already-tried'
 /** The round trip did not preserve the frontmatter — see this file's header. */
 | 'frontmatter-changed'
 /** The body opens with a frontmatter delimiter, so the document reads as two of them. */
 | 'looks-like-frontmatter'
 /** The resulting persona does not fit its own ceiling. */
 | 'envelope'
 /** The stored markdown could not be parsed, so there is nothing to edit safely. */
 | 'unparseable'
 /** A planner's own tools are read-only, at every tier. */
 | 'planner'

export type SelfEditVerdict =
 | { readonly ok: true; readonly markdown: string; readonly body: string }
 | { readonly ok: false; readonly rule: SelfEditRule; readonly reason: string }

/**
 * A prompt this persona used to have, as the archive check needs it.
 *
 * A body rather than a document, because that is what is being compared and the caller has
 * already had to parse the stored markdown to get it. `parsedPromptBody` is that parse, in
 * one place, so an unparseable old revision cannot break an edit to a persona that is fine
 * now — an archive entry nobody can read is a gap in the check and never a refusal.
 */
export interface SupersededPrompt {
 readonly body: string
 readonly replacedByKind: PersonaRevisionAuthorKind
 readonly replacedAt?: Date
}

/**
 * The body of a stored persona document, or `null` if it cannot be read as one.
 *
 * Deliberately swallowing: this is only ever used to build the archive to compare against,
 * where the honest failure is "this check saw one fewer entry" rather than "an edit was
 * refused because something unrelated in the history is malformed".
 */
export const parsedPromptBody = (markdownSource: string): string | null => {
 try {
 return parsePersonaMarkdown(markdownSource).systemPrompt.trim
 } catch {
 return null
 }
}

/** How the refusal names what the archive recorded. */
const describeSupersession = (entry: SupersededPrompt): string => {
 const who =
 entry.replacedByKind === 'human'
 ? 'a person replaced it'
: entry.replacedByKind === 'agent_run'
 ? "an agent's edit replaced it"
: 'the platform replaced it'
 const when = entry.replacedAt ? ` on ${entry.replacedAt.toISOString.slice(0, 10)}`: ''
 return `${who}${when}`
}

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
 /**
 * Every prompt this persona used to have, in any order.
 *
 * Optional, and absent means the caller is not checking — which is the right default for
 * the authoring paths a human drives, where re-proposing an old prompt is a revert
 * somebody chose. Not capped: the whole point is that the loop stops paying twice for a
 * failure, and a check that quietly stopped looking after N entries would be a check that
 * reports "new" about something the history holds.
 */
 readonly supersededPrompts?: readonly SupersededPrompt[]
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

 /**
 * The archive, immediately after the live prompt, because the two refusals are the same
 * sentence about different documents: this text is not new. After the envelope and the
 * per-run cap rather than before them, so a persona that may not edit at all hears only
 * that — a refusal naming a version of itself would tell a run something about the
 * persona's history that the permission check was about to deny it.
 */
 const alreadyTried = input.supersededPrompts?.find((entry) => entry.body.trim === body)
 if (alreadyTried) {
 return {
 ok: false,
 rule: 'already-tried',
 reason:
 `That is a prompt this persona already had — ${describeSupersession(alreadyTried)}, and ` +
 'it is in the revision history where a human can restore it. Nothing was recorded. ' +
 'Re-proposing it does not measure anything new: the platform would spend a fresh ' +
 'trial re-deriving a verdict the history already holds. If you believe that version ' +
 'was the better one, write a note saying so — restoring a revision is a human\'s ' +
 'call and they can see both.',
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

/**
 * Tier 2 — the agent changes its own tool list, within its envelope.
 *
 * **A structure, never markdown.** Tier 1 takes prose and refuses any frontmatter
 * movement; this takes a list of tool names and the platform writes the document. An
 * agent editing configuration must never be handed the text of the configuration: the
 * round-trip check in `revisePromptBody` exists because a body *could* contain
 * frontmatter, and the fix for the tier where frontmatter is the point is not a stricter
 * check but a narrower input. What crosses the wire here cannot express a model tier, a
 * budget cap, an approval mode or an envelope, so no rule is needed to refuse them.
 *
 * **Only tools.** the tier 2 is "tools and capabilities", and capability *selection* is
 * deliberately not here — see the caller. Model, budget and approval mode stay human-only
 * at every tier: they are what the envelope bounds, and a tier that could set them would
 * be an agent moving inside its ceiling by moving the ceiling's own axes.
 *
 * The envelope does the deciding. `envelopeAllows` is the same function the authoring
 * path calls, so a tool list this refuses is one a human could not have written either —
 * which is the property that keeps a self-edit from reaching a state no human could.
 */
export const reviseToolList = (input: {
 readonly currentMarkdown: string
 /** The complete list this persona should hold — not a delta. */
 readonly tools: string[]
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

 if (!maySelfModify(current.envelope)) {
 return {
 ok: false,
 rule: 'no-envelope',
 reason:
 `${current.name} has no self-modification envelope, so it may not change its own ` +
 'tools. An absent envelope is no permission, not an unlimited one — a human sets ' +
 'a ceiling first. Carry on with your task.',
 }
 }

 /**
 * A planner's own tools are read-only, and this is the one place that rule
 * could be walked around: a planner may read and may not act, and what it hands down is
 * `delegates`, which is not reachable from here at all. Refused with the reason rather
 * than silently ignored, because a planner told "done" would reason as though it had
 * gained a tool.
 */
 if (current.harnessPlanner) {
 return {
 ok: false,
 rule: 'planner',
 reason:
 'A planner\'s own tools are fixed: it may read and may never act, which is what ' +
 'makes handing work to a worker a boundary rather than a preference. What your ' +
 'children may hold is set by a human on your delegation envelope, not by you.',
 }
 }

 if (input.revisionsThisRun >= MAX_SELF_REVISIONS_PER_RUN) {
 return {
 ok: false,
 rule: 'cap',
 reason:
 'You have already changed this persona once in this run, which is the limit. A ' +
 'human reviews the first change; a second would overwrite it before anybody saw ' +
 'it.',
 }
 }

 const tools = [...new Set(input.tools.map((tool) => tool.trim).filter((t) => t.length > 0))]
 if (sameList(tools, current.tools)) {
 return {
 ok: false,
 rule: 'unchanged',
 reason:
 `That is the tool list you already hold (${current.tools.join(', ') || 'none'}). ` +
 'Nothing was recorded.',
 }
 }

 const markdown = serializePersonaMarkdown({...current, tools })

 let reparsed: ParsedPersonaMarkdown
 try {
 reparsed = parsePersonaMarkdown(markdown)
 } catch {
 return {
 ok: false,
 rule: 'frontmatter-changed',
 reason: 'That tool list cannot be written into a persona document. Nothing was changed.',
 }
 }
 /**
 * The same outcome check tier 1 makes, and it is not redundant here: a tool name
 * containing a comma or a bracket would round-trip into a *different* list, and the
 * whole point of this tier is that the envelope decided which list is allowed.
 */
 if (!sameList(reparsed.tools, tools)) {
 return {
 ok: false,
 rule: 'frontmatter-changed',
 reason:
 'Those tool names do not survive being written into a persona document — a name ' +
 'with a comma or a bracket in it cannot be stored. Nothing was changed.',
 }
 }
 if (frontmatterExceptTools(reparsed) !== frontmatterExceptTools(current)) {
 return {
 ok: false,
 rule: 'frontmatter-changed',
 reason: 'That change would move something other than the tool list. Nothing was changed.',
 }
 }

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
 reason: `That is outside your envelope. ${envelopeRefusalSummary(fits)}`,
 }
 }

 return { ok: true, markdown, body: reparsed.systemPrompt }
}

const sameList = (a: string[], b: string[]): boolean =>
 a.length === b.length && [...a].sort.join('\u0000') === [...b].sort.join('\u0000')

/** Everything `frontmatterOf` compares except the one field this tier is allowed to move. */
const frontmatterExceptTools = (parsed: ParsedPersonaMarkdown): string =>
 JSON.stringify({...JSON.parse(frontmatterOf(parsed)), tools: null })
