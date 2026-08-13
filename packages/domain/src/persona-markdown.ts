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
 * `harness.approvalMode` (default `ask`): how much this persona may do without
 * asking — `ask`, `accept-edits`, or `auto`. See `approval-modes.ts` for the ordering
 * and for what no mode changes (the path-scoped write boundary of effect-based classification, the
 * denied Bash effects, and the sandbox).
 *
 * `harness.autoApprove: true` is the spelling this format shipped with and is still
 * read, as `auto`. It is never written back — a save re-serializes the mode, which is
 * how a persona on disk migrates by being edited.
 *
 * Hand-rolled rather than a YAML dependency: the format is this one fixed
 * shape, not general YAML, so a real parser would accept (and silently
 * mis-handle) far more than this ever needs to.
 */

import { DEFAULT_APPROVAL_MODE, isApprovalMode, type ApprovalMode } from './approval-modes.js'
import type { Envelope } from './envelope.js'

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
 readonly harnessApprovalMode: ApprovalMode
 /** `harness.planner: true` — see PersonaSpec.planner. */
 readonly harnessPlanner: boolean
 /** `harness.delegates: [Tool,...]` — a planner's delegation envelope. */
 readonly harnessDelegates: string[]
 readonly harnessBudgetCapUsd: number | null
 /**
 * The self-modification envelope, from a top-level `envelope:` block.
 *
 * **Null and empty are different, and the difference is the permission.** No block at
 * all means this persona may not rewrite itself — see `maySelfModify` for why that is
 * the right reading of absence rather than "no ceiling". A block with nothing under it
 * is an envelope permitting a persona to rewrite its own prompt and nothing else, which
 * is the tier 1 exactly.
 *
 * A sibling of `harness:` rather than a key inside it, because `harness` is what this
 * persona *is* and the envelope is what it may *become* — nesting the ceiling inside
 * the thing it bounds is how the two get edited as though they were one.
 */
 readonly envelope: Envelope | null
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
 let harnessApprovalMode: ApprovalMode | null = null
 let legacyAutoApprove = false
 let harnessPlanner = false
 let harnessDelegates: string[] = []
 let harnessBudgetCapUsd: number | null = null
 /**
 * Which indented block we are inside. Was a boolean when `harness:` was the only one;
 * a second block makes it a name, and the two must not share keys by accident — an
 * `approvalMode:` under `envelope:` is a ceiling, and under `harness:` it is a setting.
 */
 let section: 'harness' | 'envelope' | null = null
 let envelope: Envelope | null = null

 for (const rawLine of lines.slice(1, endIndex)) {
 if (rawLine.trim.length === 0) continue

 if (/^\s/.test(rawLine)) {
 if (section === null) continue

 if (section === 'envelope') {
 const envelopeMatch =
 /^\s*(tools|model|budgetCapUsd|capabilities|subagentDepth|approvalMode):\s*(.+?)\s*$/.exec(
 rawLine,
)
 if (envelope === null) continue
 const current: Envelope = envelope
 if (!envelopeMatch?.[1] || envelopeMatch[2] === undefined) continue
 const envelopeKey = envelopeMatch[1]
 const envelopeValue = envelopeMatch[2]
 if (envelopeKey === 'tools') envelope = {...current, tools: parseToolList(envelopeValue) }
 if (envelopeKey === 'capabilities') {
 envelope = {...current, capabilities: parseToolList(envelopeValue) }
 }
 if (envelopeKey === 'model') envelope = {...current, model: envelopeValue }
 if (envelopeKey === 'approvalMode' && isApprovalMode(envelopeValue)) {
 envelope = {...current, approvalMode: envelopeValue }
 }
 /**
 * A malformed ceiling is dropped to null rather than defaulted to a number, the
 * same call `harness.budgetCapUsd` makes and for a sharper reason: a *ceiling*
 * misread as a number is either a bound nobody asked for or one that fails to
 * bind, and null at least means what the absent line means.
 */
 if (envelopeKey === 'budgetCapUsd') {
 const parsed = Number(envelopeValue)
 envelope = {
...current,
 budgetCapUsd: Number.isFinite(parsed) && parsed > 0 ? parsed: null,
 }
 }
 if (envelopeKey === 'subagentDepth') {
 const parsed = Number(envelopeValue)
 envelope = {
...current,
 subagentDepth: Number.isInteger(parsed) && parsed >= 0 ? parsed: null,
 }
 }
 continue
 }

 const match =
 /^\s*(effort|maxTurns|autoApprove|approvalMode|budgetCapUsd|planner|delegates):\s*(.+?)\s*$/.exec(
 rawLine,
)
 if (!match?.[1] || match[2] === undefined) continue
 const key = match[1]
 const value = match[2]
 if (key === 'effort') harnessEffort = value
 if (key === 'maxTurns') harnessMaxTurns = Number(value)
 /**
 * `autoApprove: true` is the spelling this format shipped with, and personas
 * on disk still say it. Read as `auto`, which is what it meant — see
 * `approval-modes.ts`. `approvalMode` wins when both appear, because it is the
 * one that can express the middle.
 */
 if (key === 'autoApprove') legacyAutoApprove = value === 'true'
 if (key === 'approvalMode' && isApprovalMode(value)) harnessApprovalMode = value
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
 section = null

 if (rawLine.trim === 'harness:') {
 section = 'harness'
 continue
 }

 if (rawLine.trim === 'envelope:') {
 section = 'envelope'
 // The block existing is the permission; every field then says how far.
 envelope = {
 tools: [],
 model: null,
 budgetCapUsd: null,
 capabilities: [],
 subagentDepth: null,
 approvalMode: null,
 }
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
 harnessApprovalMode:
 harnessApprovalMode ?? (legacyAutoApprove ? 'auto': DEFAULT_APPROVAL_MODE),
 harnessPlanner,
 harnessDelegates,
 harnessBudgetCapUsd,
 envelope,
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
 persona.harnessApprovalMode !== DEFAULT_APPROVAL_MODE ||
 persona.harnessPlanner ||
 persona.harnessDelegates.length > 0 ||
 persona.harnessBudgetCapUsd !== null
) {
 lines.push('harness:')
 if (persona.harnessEffort !== null) lines.push(` effort: ${persona.harnessEffort}`)
 if (persona.harnessMaxTurns !== null) lines.push(` maxTurns: ${persona.harnessMaxTurns}`)
 // Written as the mode, never as the boolean: one spelling out, two in.
 if (persona.harnessApprovalMode !== DEFAULT_APPROVAL_MODE) {
 lines.push(` approvalMode: ${persona.harnessApprovalMode}`)
 }
 if (persona.harnessPlanner) lines.push(` planner: true`)
 if (persona.harnessDelegates.length > 0) lines.push(` delegates: [${persona.harnessDelegates.join(', ')}]`)
 if (persona.harnessBudgetCapUsd !== null) {
 lines.push(` budgetCapUsd: ${persona.harnessBudgetCapUsd}`)
 }
 }
 /**
 * Written whenever it exists, including when it is empty — `envelope:` with nothing
 * under it is a real state (rewrite your prompt and nothing else), and a serializer
 * that dropped the empty block would silently turn "may change itself" into "may not"
 * on every save. That is the failure `persona-form.conformance.test.ts` exists to catch.
 */
 if (persona.envelope !== null) {
 lines.push('envelope:')
 lines.push(` tools: [${persona.envelope.tools.join(', ')}]`)
 if (persona.envelope.model !== null) lines.push(` model: ${persona.envelope.model}`)
 if (persona.envelope.budgetCapUsd !== null) {
 lines.push(` budgetCapUsd: ${persona.envelope.budgetCapUsd}`)
 }
 if (persona.envelope.capabilities.length > 0) {
 lines.push(` capabilities: [${persona.envelope.capabilities.join(', ')}]`)
 }
 if (persona.envelope.subagentDepth !== null) {
 lines.push(` subagentDepth: ${persona.envelope.subagentDepth}`)
 }
 if (persona.envelope.approvalMode !== null) {
 lines.push(` approvalMode: ${persona.envelope.approvalMode}`)
 }
 }
 lines.push(DELIM, '', persona.systemPrompt)
 return lines.join('\n')
}
