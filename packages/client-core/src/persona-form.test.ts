import { describe, expect, it } from 'vitest'
import type { AgentPersona } from '@loom/api-contract'
import {
  EMPTY_PERSONA_FORM,
  personaFormFromPersona,
  personaFormProblems,
  personaFormToMarkdown,
  personaSaveDiscrepancies,
  type PersonaFormState,
} from './persona-form.js'

const form = (overrides: Partial<PersonaFormState> = {}): PersonaFormState => ({
  ...EMPTY_PERSONA_FORM,
  name: 'swe',
  description: 'Writes code',
  systemPrompt: 'You write code.',
  ...overrides,
})

const persona = (overrides: Partial<AgentPersona> = {}): AgentPersona => ({
  id: 'p1',
  workspaceId: 'w1',
  name: 'swe',
  description: 'Writes code',
  markdownSource: '---\nname: swe\n---\n\nYou write code.',
  model: 'claude-haiku-4-5-20251001',
  tools: ['Read', 'Grep', 'Glob'],
  harnessEffort: null,
  harnessMaxTurns: null,
  harnessAutoApprove: false,
  harnessPlanner: false,
  harnessDelegates: [],
  harnessBudgetCapUsd: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
})

describe('personaFormToMarkdown', () => {
  it('omits the harness block entirely when nothing in it is set', () => {
    expect(personaFormToMarkdown(form())).toBe(
      [
        '---',
        'name: swe',
        'description: Writes code',
        'model: claude-haiku-4-5-20251001',
        'tools: [Read, Grep, Glob]',
        '---',
        '',
        'You write code.',
      ].join('\n'),
    )
  })

  it('writes only the harness keys that are set', () => {
    const markdown = personaFormToMarkdown(
      form({ planner: true, delegates: ['Bash'], budgetCapUsd: 2.5 }),
    )
    expect(markdown).toContain('  planner: true')
    expect(markdown).toContain('  delegates: [Bash]')
    expect(markdown).toContain('  budgetCapUsd: 2.5')
    expect(markdown).not.toContain('autoApprove')
    expect(markdown).not.toContain('effort')
  })
})

describe('personaFormFromPersona', () => {
  it('takes the body from the markdown and every other field from the parsed columns', () => {
    const state = personaFormFromPersona(
      persona({
        markdownSource: '---\nname: swe\nmodel: x\n---\n\nLine one.\n\nLine two.\n',
        harnessPlanner: true,
        harnessDelegates: ['Bash'],
      }),
    )
    expect(state.systemPrompt).toBe('Line one.\n\nLine two.')
    expect(state.planner).toBe(true)
    expect(state.delegates).toEqual(['Bash'])
  })

  it('shows the whole source as the body when the frontmatter is unclosed', () => {
    // A hand-edited persona that no longer parses must still render its text — an
    // empty box reads as "this persona has no prompt", which is a different claim.
    const state = personaFormFromPersona(persona({ markdownSource: '---\nname: swe\nbroken' }))
    expect(state.systemPrompt).toBe('---\nname: swe\nbroken')
  })
})

describe('personaFormProblems', () => {
  it('accepts a complete persona', () => {
    expect(personaFormProblems(form())).toEqual([])
  })

  it('refuses an acting tool on a planner, naming it', () => {
    const problems = personaFormProblems(form({ planner: true, tools: ['Read', 'Bash'] }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('Bash')
  })

  it('refuses a delegation envelope on a non-planner', () => {
    expect(personaFormProblems(form({ delegates: ['Bash'] }))[0]).toContain('Only a planner')
  })

  it('refuses a duplicate name when creating but not when editing', () => {
    const context = { existingNames: ['swe'] }
    expect(personaFormProblems(form(), context)).toHaveLength(1)
    expect(personaFormProblems(form(), { ...context, editing: true })).toEqual([])
  })

  it('refuses a zero or negative budget cap rather than storing an uncappable cap', () => {
    expect(personaFormProblems(form({ budgetCapUsd: 0 }))[0]).toContain('greater than zero')
  })

  it('refuses a newline in a single-line frontmatter field', () => {
    // The parser reads frontmatter line by line, so an embedded newline silently
    // truncates the value and turns the rest into an unrecognized key.
    expect(personaFormProblems(form({ description: 'one\ntwo' }))[0]).toContain('newline')
  })
})

describe('personaSaveDiscrepancies', () => {
  it('is silent when the stored row matches what was asked for', () => {
    expect(personaSaveDiscrepancies(form(), persona())).toEqual([])
  })

  it('names every field the server stored differently', () => {
    const problems = personaSaveDiscrepancies(
      form({ tools: ['Read', 'Bash'], budgetCapUsd: 5 }),
      persona(),
    )
    expect(problems).toHaveLength(2)
    expect(problems.join(' ')).toContain('tools')
    expect(problems.join(' ')).toContain('budget cap')
  })
})
