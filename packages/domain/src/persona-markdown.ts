/**
 * Markdown+frontmatter persona format, Phase 1 subset only:
 * `name`/`description`/`model`/`tools` plus `harness.effort`/`harness.maxTurns`/
 * `harness.autoApprove`/`harness.budgetCapUsd`. MCP/skills/harness.subagentDepth
 * need the capability registry that doesn't land until Phase 2 (the own
 * phasing note) — not parsed here.
 *
 * `harness.budgetCapUsd` (default null = uncapped) is enforced, not advisory
 *: the egress proxy meters real spend against it and refuses
 * further model calls once it is passed, and the Runner kills the run. Enforcement
 * lives at the proxy because that is the only place that sees what a run actually
 * cost rather than what it reports about itself.
 *
 * `harness.autoApprove` (default false, opt-in per persona): skips the human
 * approval round-trip for risky tools this persona's run hits — the
 * path-scoped write boundary still applies unconditionally,
 * since that's a hard boundary, not a judgment call. Only use on personas
 * you actually trust to run unattended.
 *
 * Hand-rolled rather than a YAML dependency: the format is this one fixed
 * shape, not general YAML, so a real parser would accept (and silently
 * mis-handle) far more than this ever needs to.
 */

/** `[A, B]` → `['A','B']`; anything else → `[]`. Shared by `tools` and `harness.delegates`. */
const parseToolList = (value: string): string[] => {
 const inner = /^\[(.*)\]$/.exec(value)?.[1]
 if (inner === undefined) return []
 return inner
.split(',')
.map((tool) => tool.trim)
.filter((tool) => tool.length > 0)
}

export interface ParsedPersonaMarkdown {
 readonly name: string
 readonly description: string
 readonly model: string
 readonly tools: string[]
 readonly harnessEffort: string | null
 readonly harnessMaxTurns: number | null
 readonly harnessAutoApprove: boolean
 /** `harness.planner: true` — see PersonaSpec.planner. */
 readonly harnessPlanner: boolean
 /** `harness.delegates: [Tool,...]` — a planner's delegation envelope. */
 readonly harnessDelegates: string[]
 readonly harnessBudgetCapUsd: number | null
 readonly systemPrompt: string
}

const DELIM = '---'

export const parsePersonaMarkdown = (source: string): ParsedPersonaMarkdown => {
 const lines = source.replace(/^﻿/, '').split('\n')
 if (lines[0]?.trim !== DELIM) {
 throw new Error('Persona markdown must start with a --- frontmatter block')
 }
 const endIndex = lines.findIndex((line, i) => i > 0 && line.trim === DELIM)
 if (endIndex === -1) {
 throw new Error('Persona markdown frontmatter is not closed with a second ---')
 }

 let name: string | null = null
 let description: string | null = null
 let model: string | null = null
 let tools: string[] = []
 let harnessEffort: string | null = null
 let harnessMaxTurns: number | null = null
 let harnessAutoApprove = false
 let harnessPlanner = false
 let harnessDelegates: string[] = []
 let harnessBudgetCapUsd: number | null = null
 let inHarness = false

 for (const rawLine of lines.slice(1, endIndex)) {
 if (rawLine.trim.length === 0) continue

 if (/^\s/.test(rawLine)) {
 if (!inHarness) continue
 const match = /^\s*(effort|maxTurns|autoApprove|budgetCapUsd|planner|delegates):\s*(.+?)\s*$/.exec(rawLine)
 if (!match?.[1] || match[2] === undefined) continue
 const key = match[1]
 const value = match[2]
 if (key === 'effort') harnessEffort = value
 if (key === 'maxTurns') harnessMaxTurns = Number(value)
 if (key === 'autoApprove') harnessAutoApprove = value === 'true'
 if (key === 'planner') harnessPlanner = value === 'true'
 if (key === 'delegates') harnessDelegates = parseToolList(value)
 if (key === 'budgetCapUsd') {
 const parsed = Number(value)
 // A malformed cap is dropped rather than defaulted to a number: a wrong
 // cap either throttles work nobody asked to throttle or fails to stop a
 // runaway, and null (uncapped) at least matches what the text says.
 harnessBudgetCapUsd = Number.isFinite(parsed) && parsed > 0 ? parsed: null
 }
 continue
 }
 inHarness = false

 if (rawLine.trim === 'harness:') {
 inHarness = true
 continue
 }

 const match = /^(name|description|model|tools):\s*(.*?)\s*$/.exec(rawLine)
 if (!match?.[1] || match[2] === undefined) continue
 const key = match[1]
 const value = match[2]
 if (key === 'name') name = value
 else if (key === 'description') description = value
 else if (key === 'model') model = value
 else if (key === 'tools') tools = parseToolList(value)
 }

 if (!name) throw new Error('Persona markdown frontmatter missing required "name"')
 if (!description) throw new Error('Persona markdown frontmatter missing required "description"')
 if (!model) throw new Error('Persona markdown frontmatter missing required "model"')

 const systemPrompt = lines.slice(endIndex + 1).join('\n').trim
 if (!systemPrompt) {
 throw new Error('Persona markdown must have a non-empty body (the system prompt)')
 }

 return {
 name,
 description,
 model,
 tools,
 harnessEffort,
 harnessMaxTurns,
 harnessAutoApprove,
 harnessPlanner,
 harnessDelegates,
 harnessBudgetCapUsd,
 systemPrompt,
 }
}

export const serializePersonaMarkdown = (persona: ParsedPersonaMarkdown): string => {
 const lines = [
 DELIM,
 `name: ${persona.name}`,
 `description: ${persona.description}`,
 `model: ${persona.model}`,
 `tools: [${persona.tools.join(', ')}]`,
 ]
 if (
 persona.harnessEffort !== null ||
 persona.harnessMaxTurns !== null ||
 persona.harnessAutoApprove ||
 persona.harnessPlanner ||
 persona.harnessDelegates.length > 0 ||
 persona.harnessBudgetCapUsd !== null
) {
 lines.push('harness:')
 if (persona.harnessEffort !== null) lines.push(` effort: ${persona.harnessEffort}`)
 if (persona.harnessMaxTurns !== null) lines.push(` maxTurns: ${persona.harnessMaxTurns}`)
 if (persona.harnessAutoApprove) lines.push(` autoApprove: true`)
 if (persona.harnessPlanner) lines.push(` planner: true`)
 if (persona.harnessDelegates.length > 0) lines.push(` delegates: [${persona.harnessDelegates.join(', ')}]`)
 if (persona.harnessBudgetCapUsd !== null) {
 lines.push(` budgetCapUsd: ${persona.harnessBudgetCapUsd}`)
 }
 }
 lines.push(DELIM, '', persona.systemPrompt)
 return lines.join('\n')
}
