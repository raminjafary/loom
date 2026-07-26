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
      harnessAutoApprove: false,
      systemPrompt: 'You are backend-worker. Implement exactly what the spec says, nothing more.',
    })
  })

  it('parses harness.autoApprove', () => {
    const parsed = parsePersonaMarkdown(
      '---\nname: unattended\ndescription: Runs without a human in the loop.\nmodel: claude-sonnet-5\nharness:\n  autoApprove: true\n---\nGo.',
    )
    expect(parsed.harnessAutoApprove).toBe(true)
  })

  it('defaults tools to empty and harness fields to null/false when absent', () => {
    const parsed = parsePersonaMarkdown(
      '---\nname: read-only\ndescription: Reads things.\nmodel: claude-haiku-4-5-20251001\n---\nBe read-only.',
    )
    expect(parsed.tools).toEqual([])
    expect(parsed.harnessEffort).toBeNull()
    expect(parsed.harnessMaxTurns).toBeNull()
    expect(parsed.harnessAutoApprove).toBe(false)
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

  it('omits the harness block when effort/maxTurns are null and autoApprove is false', () => {
    const serialized = serializePersonaMarkdown({
      name: 'n',
      description: 'd',
      model: 'm',
      tools: ['Read'],
      harnessEffort: null,
      harnessMaxTurns: null,
      harnessAutoApprove: false,
      systemPrompt: 'body',
    })
    expect(serialized).not.toMatch(/harness:/)
  })

  it('includes the harness block when only autoApprove is set', () => {
    const serialized = serializePersonaMarkdown({
      name: 'n',
      description: 'd',
      model: 'm',
      tools: ['Read'],
      harnessEffort: null,
      harnessMaxTurns: null,
      harnessAutoApprove: true,
      systemPrompt: 'body',
    })
    expect(serialized).toMatch(/harness:\n  autoApprove: true/)
  })
})
