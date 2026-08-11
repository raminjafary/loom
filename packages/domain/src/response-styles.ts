/**
 * How an agent *talks*, chosen per run.
 *
 * A persona says what an agent is for; a response style says how much prose it
 * produces getting there. They are separate because the same `swe` persona is
 * wanted terse on the fifth run of the afternoon and explanatory when a colleague
 * is reading over your shoulder — and forking the persona to change that would put
 * two "swe"s in the registry that differ only in tone.
 *
 * The directive is **appended**, never substituted. A style that could replace a
 * system prompt would be a way to overwrite a persona's safety instructions from a
 * dropdown, and the whole point of principle 11 is that instructions and their
 * source are not interchangeable. It also says nothing about which tools to use or
 * when to stop: style governs prose, never behaviour.
 */

export const RESPONSE_STYLES = ['default', 'concise', 'explanatory', 'caveman'] as const

export type ResponseStyle = (typeof RESPONSE_STYLES)[number]

export const DEFAULT_RESPONSE_STYLE: ResponseStyle = 'default'

export const isResponseStyle = (value: unknown): value is ResponseStyle =>
 typeof value === 'string' && (RESPONSE_STYLES as readonly string[]).includes(value)

interface StyleDefinition {
 readonly label: string
 /** One line, shown next to the control so the choice is not a guess. */
 readonly description: string
 /** Appended to the persona's system prompt; empty means "change nothing". */
 readonly directive: string
}

const STYLES: Record<ResponseStyle, StyleDefinition> = {
 default: {
 label: 'Default',
 description: 'The persona’s own voice, unmodified.',
 directive: '',
 },
 concise: {
 label: 'Concise',
 description: 'Short answers. No preamble, no summary of work already visible.',
 directive:
 'Keep prose to a minimum. Answer in as few words as the question allows, skip preamble and postamble, and do not restate work that is already visible in the thread. Never abbreviate the work itself — only what you say about it.',
 },
 explanatory: {
 label: 'Explanatory',
 description: 'Says why, not just what — useful when someone is learning the codebase.',
 directive:
 'Explain your reasoning as you go. When you make a non-obvious choice, say briefly what the alternatives were and why you rejected them, and point out anything in the codebase a reader would need to know to follow the change.',
 },
 caveman: {
 label: 'Caveman',
 description: 'Grug words only. Same work, fewer syllables.',
 directive:
 'Write all prose in terse caveman speech: short words, no articles, no filler. This governs your prose only. Code, file paths, commands, identifiers and tool arguments are written normally and correctly — never abbreviate, misspell or simplify those.',
 },
}

export const describeResponseStyle = (style: ResponseStyle): StyleDefinition => STYLES[style]

/**
 * Marked as a separate, labelled block for the reason every other appended text in
 * this system is: a reader of the assembled prompt has to be able to see where the
 * persona stops and an operator's dial starts.
 */
export const applyResponseStyle = (systemPrompt: string, style: ResponseStyle): string => {
 const directive = STYLES[style].directive
 if (directive === '') return systemPrompt
 return `${systemPrompt}\n\n## Response style\n\n${directive}`
}
