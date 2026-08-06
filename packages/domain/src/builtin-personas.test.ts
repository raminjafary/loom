import { describe, expect, it } from 'vitest'
import { BUILTIN_PERSONAS } from './builtin-personas.js'
import { parsePersonaMarkdown } from './persona-markdown.js'

describe('BUILTIN_PERSONAS', () => {
  it('has exactly seven roles with unique names', () => {
    expect(BUILTIN_PERSONAS).toHaveLength(7)
    expect(new Set(BUILTIN_PERSONAS.map((p) => p.name)).size).toBe(7)
  })

  it.each(BUILTIN_PERSONAS.map((p) => [p.name, p] as const))(
    '%s: markdownSource round-trips through parsePersonaMarkdown',
    (_name, persona) => {
      const parsed = parsePersonaMarkdown(persona.markdownSource)
      expect(parsed).toEqual({
        name: persona.name,
        description: persona.description,
        model: persona.model,
        tools: persona.tools,
        harnessEffort: persona.harnessEffort,
        harnessMaxTurns: persona.harnessMaxTurns,
        harnessAutoApprove: persona.harnessAutoApprove,
        harnessBudgetCapUsd: persona.harnessBudgetCapUsd,
        systemPrompt: persona.systemPrompt,
      })
    },
  )

  it('ships every built-in with an enforced budget cap', () => {
    // The seeded personas are the ones most likely to be @mentioned before anyone
    // has thought about spend, so an uncapped built-in would make the
    // out-of-the-box path the only uncapped one (PLAN.md §6/§9).
    for (const persona of BUILTIN_PERSONAS) {
      expect(persona.harnessBudgetCapUsd).toBeGreaterThan(0)
    }
  })

  it('security-reviewer is read-only', () => {
    const reviewer = BUILTIN_PERSONAS.find((p) => p.name === 'security-reviewer')
    expect(reviewer?.tools).toEqual(['Read', 'Grep', 'Glob'])
  })
})
