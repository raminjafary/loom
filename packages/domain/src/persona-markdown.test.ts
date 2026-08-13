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

describe('parsePersonaMarkdown', => {
 it('parses frontmatter and body', => {
 const parsed = parsePersonaMarkdown(SAMPLE)
 expect(parsed).toEqual({
 name: 'backend-worker',
 description: 'Implements scoped backend changes from an explicit spec.',
 model: 'claude-sonnet-5',
 tools: ['Read', 'Edit', 'Bash', 'Grep'],
 harnessEffort: 'medium',
 harnessMaxTurns: 40,
 harnessApprovalMode: 'ask' as const,
 harnessPlanner: false,
 harnessDelegates: [],
 harnessBudgetCapUsd: null,
 envelope: null,
 systemPrompt: 'You are backend-worker. Implement exactly what the spec says, nothing more.',
 })
 })

 /**
 * Both spellings, and the reason both exist: `autoApprove: true` is what this
 * format shipped with and what personas on disk still say, so it is read as the
 * mode it meant (`approval-modes.ts`).
 */
 it('reads harness.approvalMode', => {
 const parsed = parsePersonaMarkdown(
 [
 '---',
 'name: unattended',
 'description: Runs without a human in the loop.',
 'model: claude-sonnet-5',
 'harness:',
 ' approvalMode: accept-edits',
 '---',
 'Go.',
 ].join('\n'),
)
 expect(parsed.harnessApprovalMode).toBe('accept-edits')
 })

 it('reads the legacy harness.autoApprove as auto', => {
 const parsed = parsePersonaMarkdown(
 [
 '---',
 'name: unattended',
 'description: Runs without a human in the loop.',
 'model: claude-sonnet-5',
 'harness:',
 ' autoApprove: true',
 '---',
 'Go.',
 ].join('\n'),
)
 expect(parsed.harnessApprovalMode).toBe('auto')
 })

 it('defaults to ask, which is the narrowest mode', => {
 const parsed = parsePersonaMarkdown(
 ['---', 'name: plain', 'description: d', 'model: m', '---', 'Go.'].join('\n'),
)
 expect(parsed.harnessApprovalMode).toBe('ask')
 })

 /** A save writes one spelling, so an edited persona migrates by being edited. */
 it('serializes the mode and never the boolean', => {
 const source = serializePersonaMarkdown({
 name: 'unattended',
 description: 'd',
 model: 'm',
 tools: [],
 harnessEffort: null,
 harnessMaxTurns: null,
 harnessApprovalMode: 'auto',
 harnessPlanner: false,
 harnessDelegates: [],
 harnessBudgetCapUsd: null,
 envelope: null,
 systemPrompt: 'Go.',
 })
 expect(source).toContain(' approvalMode: auto')
 expect(source).not.toContain('autoApprove')
 expect(parsePersonaMarkdown(source).harnessApprovalMode).toBe('auto')
 })

 it('defaults tools to empty and harness fields to null/false when absent', => {
 const parsed = parsePersonaMarkdown(
 '---\nname: read-only\ndescription: Reads things.\nmodel: claude-haiku-4-5-20251001\n---\nBe read-only.',
)
 expect(parsed.tools).toEqual([])
 expect(parsed.harnessEffort).toBeNull
 expect(parsed.harnessMaxTurns).toBeNull
 expect(parsed.harnessApprovalMode).toBe('ask')
 })

 it('throws when frontmatter is missing a required field', => {
 expect( =>
 parsePersonaMarkdown('---\nname: no-description\nmodel: x\n---\nbody'),
).toThrow(/description/)
 })

 it('throws when the frontmatter block is never closed', => {
 expect( => parsePersonaMarkdown('---\nname: unclosed\nbody')).toThrow(/not closed/)
 })

 it('throws when the body is empty', => {
 expect( =>
 parsePersonaMarkdown('---\nname: empty\ndescription: d\nmodel: m\n---\n'),
).toThrow(/non-empty body/)
 })
})

describe('serializePersonaMarkdown', => {
 it('round-trips through parse', => {
 const parsed = parsePersonaMarkdown(SAMPLE)
 const serialized = serializePersonaMarkdown(parsed)
 expect(parsePersonaMarkdown(serialized)).toEqual(parsed)
 })

 it('omits the harness block when every harness field is at its default', => {
 const serialized = serializePersonaMarkdown({
 name: 'n',
 description: 'd',
 model: 'm',
 tools: ['Read'],
 harnessEffort: null,
 harnessMaxTurns: null,
 harnessApprovalMode: 'ask' as const,
 harnessPlanner: false,
 harnessDelegates: [],
 harnessBudgetCapUsd: null,
 envelope: null,
 systemPrompt: 'body',
 })
 expect(serialized).not.toMatch(/harness:/)
 })

 it('includes the harness block when only the approval mode is set', => {
 const serialized = serializePersonaMarkdown({
 name: 'n',
 description: 'd',
 model: 'm',
 tools: ['Read'],
 harnessEffort: null,
 harnessMaxTurns: null,
 harnessApprovalMode: 'auto' as const,
 harnessPlanner: false,
 harnessDelegates: [],
 harnessBudgetCapUsd: null,
 envelope: null,
 systemPrompt: 'body',
 })
 expect(serialized).toMatch(/harness:\n approvalMode: auto/)
 })

 it('includes the harness block when only a budget cap is set', => {
 const serialized = serializePersonaMarkdown({
 name: 'n',
 description: 'd',
 model: 'm',
 tools: ['Read'],
 harnessEffort: null,
 harnessMaxTurns: null,
 harnessApprovalMode: 'ask' as const,
 harnessPlanner: false,
 harnessDelegates: [],
 harnessBudgetCapUsd: 2.5,
 envelope: null,
 systemPrompt: 'body',
 })
 expect(serialized).toMatch(/harness:\n budgetCapUsd: 2\.5/)
 })
})

describe('harness.budgetCapUsd', => {
 const withHarness = (line: string): string =>
 `---\nname: n\ndescription: d\nmodel: m\ntools: [Read]\nharness:\n ${line}\n---\n\nbody`

 it('parses a numeric cap', => {
 expect(parsePersonaMarkdown(withHarness('budgetCapUsd: 5.00')).harnessBudgetCapUsd).toBe(5)
 })

 it('is null when absent — uncapped, matching the cost model defaults', => {
 expect(parsePersonaMarkdown(SAMPLE).harnessBudgetCapUsd).toBeNull
 })

 it('drops a malformed or non-positive cap rather than inventing a number', => {
 // A wrong cap either throttles work nobody asked to throttle or fails to stop
 // a runaway. Null at least matches what the frontmatter's author can see.
 expect(parsePersonaMarkdown(withHarness('budgetCapUsd: not-a-number')).harnessBudgetCapUsd).toBeNull
 expect(parsePersonaMarkdown(withHarness('budgetCapUsd: 0')).harnessBudgetCapUsd).toBeNull
 expect(parsePersonaMarkdown(withHarness('budgetCapUsd: -3')).harnessBudgetCapUsd).toBeNull
 })

 it('round-trips a cap through serialize', => {
 const parsed = parsePersonaMarkdown(withHarness('budgetCapUsd: 1.25'))
 expect(parsePersonaMarkdown(serializePersonaMarkdown(parsed))).toEqual(parsed)
 })
})
