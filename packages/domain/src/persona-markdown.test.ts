import { describe, expect, it } from 'vitest'
import { parsePersonaMarkdown, serializePersonaMarkdown } from './persona-markdown.js'

const SAMPLE = `---
name: backend-worker
description: Implements scoped backend changes from an explicit spec.
model: claude-sonnet-5
tools: [Read, Edit, Bash, Grep]
harness:
  effort: medium
  maxTurns: 40
---

You are backend-worker. Implement exactly what the spec says, nothing more.`

describe('parsePersonaMarkdown', () => {
  it('parses frontmatter and body', () => {
    const parsed = parsePersonaMarkdown(SAMPLE)
    expect(parsed).toEqual({
      name: 'backend-worker',
      description: 'Implements scoped backend changes from an explicit spec.',
      model: 'claude-sonnet-5',
      tools: ['Read', 'Edit', 'Bash', 'Grep'],
      harnessEffort: 'medium',
      harnessMaxTurns: 40,
      systemPrompt: 'You are backend-worker. Implement exactly what the spec says, nothing more.',
    })
  })

  it('defaults tools to empty and harness fields to null when absent', () => {
    const parsed = parsePersonaMarkdown(
      '---\nname: read-only\ndescription: Reads things.\nmodel: claude-haiku-4-5-20251001\n---\nBe read-only.',
    )
    expect(parsed.tools).toEqual([])
    expect(parsed.harnessEffort).toBeNull()
    expect(parsed.harnessMaxTurns).toBeNull()
  })

  it('throws when frontmatter is missing a required field', () => {
    expect(() =>
      parsePersonaMarkdown('---\nname: no-description\nmodel: x\n---\nbody'),
    ).toThrow(/description/)
  })

  it('throws when the frontmatter block is never closed', () => {
    expect(() => parsePersonaMarkdown('---\nname: unclosed\nbody')).toThrow(/not closed/)
  })

  it('throws when the body is empty', () => {
    expect(() =>
      parsePersonaMarkdown('---\nname: empty\ndescription: d\nmodel: m\n---\n'),
    ).toThrow(/non-empty body/)
  })
})

describe('serializePersonaMarkdown', () => {
  it('round-trips through parse', () => {
    const parsed = parsePersonaMarkdown(SAMPLE)
    const serialized = serializePersonaMarkdown(parsed)
    expect(parsePersonaMarkdown(serialized)).toEqual(parsed)
  })

  it('omits the harness block when both fields are null', () => {
    const serialized = serializePersonaMarkdown({
      name: 'n',
      description: 'd',
      model: 'm',
      tools: ['Read'],
      harnessEffort: null,
      harnessMaxTurns: null,
      systemPrompt: 'body',
    })
    expect(serialized).not.toMatch(/harness:/)
  })
})
