import type { AgentPersona, ApprovalMode, PersonaDraft } from '@loom/api-contract'

/**
 * The persona form (the product shape — product shape: "Phase 1 ships a persona form
 * (name, description, model, tools, prompt) writing the same markdown, with a
 * raw-markdown toggle"). This is the "writing the same markdown" half.
 *
 * **Only the serialize direction lives here.** Reading a markdown back into fields
 * goes through `persona.parse` on the contract, so the form is always populated by
 * the same parser the write path uses — a client that parsed the format itself
 * would eventually show a human fields that a save would not store. `models.ts`
 * states the rule this follows (a client depends on the contract, never on the
 * domain) and duplicates a four-entry price list to keep it; a parser is too large
 * a thing to duplicate that way, so it is reached through the contract instead.
 *
 * Serializing is the one direction that cannot be a procedure without a round trip
 * per keystroke, so it *is* duplicated — and `persona-form.conformance.test.ts` in
 * `apps/web` asserts that the domain's own parser reads back exactly what this
 * writes, over every field, so the copy cannot drift in silence.
 */

export interface PersonaFormState {
 readonly name: string
 readonly description: string
 readonly model: string
 readonly tools: readonly string[]
 readonly systemPrompt: string
 readonly planner: boolean
 readonly delegates: readonly string[]
 readonly approvalMode: ApprovalMode
 readonly effort: string | null
 readonly maxTurns: number | null
 readonly budgetCapUsd: number | null
}

/**
 * The tools the form offers as checkboxes. Not an authority — the wire accepts any
 * string and the Runner's allowlist is what decides — but a human authoring a
 * persona should not have to remember the SDK's exact spelling of `NotebookEdit`.
 *
 * `acting` is what `PLANNER_READABLE_TOOLS` calls the other side of the line: a
 * planner may hold only the read-only ones, and the form greys the rest out
 * rather than letting a human type a persona the server will refuse.
 */
export const SELECTABLE_TOOLS: ReadonlyArray<{
 readonly name: string
 readonly acting: boolean
 readonly summary: string
}> = [
 { name: 'Read', acting: false, summary: 'Open a file' },
 { name: 'Grep', acting: false, summary: 'Search file contents' },
 { name: 'Glob', acting: false, summary: 'Find files by name' },
 { name: 'Edit', acting: true, summary: 'Change an existing file' },
 { name: 'Write', acting: true, summary: 'Create or overwrite a file' },
 { name: 'NotebookEdit', acting: true, summary: 'Change a notebook cell' },
 { name: 'Bash', acting: true, summary: 'Run a shell command' },
 { name: 'WebFetch', acting: true, summary: 'Fetch a URL' },
 { name: 'WebSearch', acting: true, summary: 'Search the web' },
]

/** Mirrors `PLANNER_READABLE_TOOLS`; the server refuses anything else on a planner. */
export const isActingTool = (tool: string): boolean =>
 SELECTABLE_TOOLS.find((entry) => entry.name === tool)?.acting ?? true

export const EMPTY_PERSONA_FORM: PersonaFormState = {
 name: '',
 description: '',
 model: 'claude-haiku-4-5-20251001',
 tools: ['Read', 'Grep', 'Glob'],
 systemPrompt: '',
 planner: false,
 delegates: [],
 approvalMode: 'ask',
 effort: null,
 maxTurns: null,
 budgetCapUsd: null,
}

const DELIM = '---'

/**
 * Everything after the closing `---`. The single piece of persona-format reading
 * this module does, and it is here rather than behind `persona.parse` because it
 * runs on a stored persona at the moment the form opens — a round trip there would
 * make opening the editor wait on the network to show text the client already holds.
 *
 * Falls back to the whole source when there is no closing delimiter, so a persona
 * whose markdown was hand-edited into an unparseable state still shows its body
 * instead of an empty box.
 */
const bodyOf = (markdownSource: string): string => {
 const lines = markdownSource.replace(/^﻿/, '').split('\n')
 if (lines[0]?.trim !== DELIM) return markdownSource.trim
 const end = lines.findIndex((line, index) => index > 0 && line.trim === DELIM)
 if (end === -1) return markdownSource.trim
 return lines.slice(end + 1).join('\n').trim
}

/**
 * A stored persona as form state, from the columns the server already parsed —
 * so opening the editor shows the server's reading, not the client's.
 */
export const personaFormFromPersona = (persona: AgentPersona): PersonaFormState => ({
 name: persona.name,
 description: persona.description,
 model: persona.model,
 tools: persona.tools,
 systemPrompt: bodyOf(persona.markdownSource),
 planner: persona.harnessPlanner,
 delegates: persona.harnessDelegates,
 approvalMode: persona.harnessApprovalMode,
 effort: persona.harnessEffort,
 maxTurns: persona.harnessMaxTurns,
 budgetCapUsd: persona.harnessBudgetCapUsd,
})

/** A `persona.parse` result as form state — used when a human returns from the raw tab. */
export const personaFormFromDraft = (draft: PersonaDraft): PersonaFormState | null => {
 if (!draft.parsed) return null
 const parsed = draft.parsed
 return {
 name: parsed.name,
 description: parsed.description,
 model: parsed.model,
 tools: parsed.tools,
 systemPrompt: parsed.systemPrompt,
 planner: parsed.harnessPlanner,
 delegates: parsed.harnessDelegates,
 approvalMode: parsed.harnessApprovalMode,
 effort: parsed.harnessEffort,
 maxTurns: parsed.harnessMaxTurns,
 budgetCapUsd: parsed.harnessBudgetCapUsd,
 }
}

/**
 * Form state as the markdown that is actually stored. Field order and the
 * conditional `harness:` block match `serializePersonaMarkdown` in the domain,
 * which is what the conformance test pins.
 */
export const personaFormToMarkdown = (form: PersonaFormState): string => {
 const lines = [
 DELIM,
 `name: ${form.name}`,
 `description: ${form.description}`,
 `model: ${form.model}`,
 `tools: [${form.tools.join(', ')}]`,
 ]
 const harness =
 form.effort !== null ||
 form.maxTurns !== null ||
 form.approvalMode !== 'ask' ||
 form.planner ||
 form.delegates.length > 0 ||
 form.budgetCapUsd !== null
 if (harness) {
 lines.push('harness:')
 if (form.effort !== null) lines.push(` effort: ${form.effort}`)
 if (form.maxTurns !== null) lines.push(` maxTurns: ${form.maxTurns}`)
 if (form.approvalMode !== 'ask') lines.push(` approvalMode: ${form.approvalMode}`)
 if (form.planner) lines.push(' planner: true')
 if (form.delegates.length > 0) lines.push(` delegates: [${form.delegates.join(', ')}]`)
 if (form.budgetCapUsd !== null) lines.push(` budgetCapUsd: ${form.budgetCapUsd}`)
 }
 lines.push(DELIM, '', form.systemPrompt)
 return lines.join('\n')
}

/**
 * What a save would refuse, said before the human presses it.
 *
 * Deliberately a *mirror* of the server's rules and not a second authority: every
 * message here has a counterpart in `createPersona`/`updatePersona`, and the server
 * still checks all of them. Showing them early is the difference between a form a
 * human can fill in and one that rejects them after the fact.
 */
export const personaFormProblems = (
 form: PersonaFormState,
 context: { readonly existingNames?: readonly string[]; readonly editing?: boolean } = {},
): string[] => {
 const problems: string[] = []
 if (!form.name.trim) problems.push('A persona needs a name.')
 if (!form.description.trim) problems.push('A persona needs a one-line description.')
 if (!form.model.trim) problems.push('A persona needs a model.')
 if (!form.systemPrompt.trim) {
 problems.push('A persona needs a system prompt — the body below the frontmatter.')
 }
 if (/\n/.test(form.name) || /\n/.test(form.description)) {
 problems.push('Name and description are single frontmatter lines and cannot contain a newline.')
 }
 if (!context.editing && context.existingNames?.includes(form.name.trim)) {
 problems.push(`Persona "${form.name.trim}" already exists.`)
 }

 const acting = form.tools.filter(isActingTool)
 if (form.planner && acting.length > 0) {
 problems.push(
 `A planner may only read — Read, Grep, Glob. Remove: ${acting.join(', ')}`,
)
 }
 if (!form.planner && form.delegates.length > 0) {
 problems.push(
 'Only a planner may declare a delegation envelope — it is what its children are attenuated against.',
)
 }
 if (form.budgetCapUsd !== null && !(form.budgetCapUsd > 0)) {
 problems.push('A budget cap must be greater than zero, or absent for uncapped.')
 }
 if (form.maxTurns !== null && !(Number.isInteger(form.maxTurns) && form.maxTurns > 0)) {
 problems.push('Max turns must be a whole number greater than zero, or absent.')
 }
 return problems
}

/**
 * Whether what came back from a save matches what the form intended.
 *
 * This is the guard on the one duplicated direction. `personaFormToMarkdown` writes
 * the format; the server parses it with the real parser and returns what it stored.
 * If those two ever disagree the human is looking at a persona that is not the one
 * they authored, and the honest thing is to say so rather than to render the
 * server's answer as though it had been the request.
 */
export const personaSaveDiscrepancies = (
 intended: PersonaFormState,
 stored: AgentPersona,
): string[] => {
 const problems: string[] = []
 const compare = (label: string, want: unknown, got: unknown) => {
 const a = JSON.stringify(want)
 const b = JSON.stringify(got)
 if (a !== b) problems.push(`${label}: asked for ${a}, stored ${b}`)
 }
 compare('name', intended.name.trim, stored.name)
 compare('description', intended.description.trim, stored.description)
 compare('model', intended.model.trim, stored.model)
 compare('tools', [...intended.tools], stored.tools)
 compare('planner', intended.planner, stored.harnessPlanner)
 compare('delegates', [...intended.delegates], stored.harnessDelegates)
 compare('approval mode', intended.approvalMode, stored.harnessApprovalMode)
 compare('effort', intended.effort, stored.harnessEffort)
 compare('max turns', intended.maxTurns, stored.harnessMaxTurns)
 compare('budget cap', intended.budgetCapUsd, stored.harnessBudgetCapUsd)
 return problems
}
