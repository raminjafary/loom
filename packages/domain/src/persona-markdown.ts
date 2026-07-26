/**
 * Markdown+frontmatter persona format (PLAN.md §4e), Phase 1 subset only:
 * `name`/`description`/`model`/`tools` plus `harness.effort`/`harness.maxTurns`/
 * `harness.autoApprove`. MCP/skills/harness.subagentDepth/budgetCapUsd need the
 * capability registry that doesn't land until Phase 2 (§4e's own phasing
 * note) — not parsed here.
 *
 * `harness.autoApprove` (default false, opt-in per persona): skips the human
 * approval round-trip for risky tools this persona's run hits — the
 * path-scoped write boundary (PLAN.md §6 A3) still applies unconditionally,
 * since that's a hard boundary, not a judgment call. Only use on personas
 * you actually trust to run unattended.
 *
 * Hand-rolled rather than a YAML dependency: the format is this one fixed
 * shape, not general YAML, so a real parser would accept (and silently
 * mis-handle) far more than this ever needs to.
 */

export interface ParsedPersonaMarkdown {
  readonly name: string
  readonly description: string
  readonly model: string
  readonly tools: string[]
  readonly harnessEffort: string | null
  readonly harnessMaxTurns: number | null
  readonly harnessAutoApprove: boolean
  readonly systemPrompt: string
}

const DELIM = '---'

export const parsePersonaMarkdown = (source: string): ParsedPersonaMarkdown => {
  const lines = source.replace(/^﻿/, '').split('\n')
  if (lines[0]?.trim() !== DELIM) {
    throw new Error('Persona markdown must start with a --- frontmatter block')
  }
  const endIndex = lines.findIndex((line, i) => i > 0 && line.trim() === DELIM)
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
  let inHarness = false

  for (const rawLine of lines.slice(1, endIndex)) {
    if (rawLine.trim().length === 0) continue

    if (/^\s/.test(rawLine)) {
      if (!inHarness) continue
      const match = /^\s*(effort|maxTurns|autoApprove):\s*(.+?)\s*$/.exec(rawLine)
      if (!match?.[1] || match[2] === undefined) continue
      const key = match[1]
      const value = match[2]
      if (key === 'effort') harnessEffort = value
      if (key === 'maxTurns') harnessMaxTurns = Number(value)
      if (key === 'autoApprove') harnessAutoApprove = value === 'true'
      continue
    }
    inHarness = false

    if (rawLine.trim() === 'harness:') {
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
    else if (key === 'tools') {
      const arrayMatch = /^\[(.*)\]$/.exec(value)
      const inner = arrayMatch?.[1]
      tools = inner
        ? inner
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
        : []
    }
  }

  if (!name) throw new Error('Persona markdown frontmatter missing required "name"')
  if (!description) throw new Error('Persona markdown frontmatter missing required "description"')
  if (!model) throw new Error('Persona markdown frontmatter missing required "model"')

  const systemPrompt = lines.slice(endIndex + 1).join('\n').trim()
  if (!systemPrompt) {
    throw new Error('Persona markdown must have a non-empty body (the system prompt)')
  }

  return { name, description, model, tools, harnessEffort, harnessMaxTurns, harnessAutoApprove, systemPrompt }
}

export const serializePersonaMarkdown = (persona: ParsedPersonaMarkdown): string => {
  const lines = [
    DELIM,
    `name: ${persona.name}`,
    `description: ${persona.description}`,
    `model: ${persona.model}`,
    `tools: [${persona.tools.join(', ')}]`,
  ]
  if (persona.harnessEffort !== null || persona.harnessMaxTurns !== null || persona.harnessAutoApprove) {
    lines.push('harness:')
    if (persona.harnessEffort !== null) lines.push(`  effort: ${persona.harnessEffort}`)
    if (persona.harnessMaxTurns !== null) lines.push(`  maxTurns: ${persona.harnessMaxTurns}`)
    if (persona.harnessAutoApprove) lines.push(`  autoApprove: true`)
  }
  lines.push(DELIM, '', persona.systemPrompt)
  return lines.join('\n')
}
