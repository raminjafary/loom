import type { PersonaRevision } from '@loom/api-contract'
import { describe, expect, it } from 'vitest'
import {
  currentPromptAuthor,
  describeRevision,
  personaHistory,
  promptWrittenByAgent,
} from './persona-history.js'

const revision = (over: Partial<PersonaRevision> = {}): PersonaRevision => ({
  id: 'r1',
  personaId: 'p1',
  markdownSource: '---\nname: swe\n---\n\nold',
  replacedByKind: 'agent_run',
  replacedByRunId: 'run-1',
  rationale: 'A lesson.',
  createdAt: '2026-08-16T10:00:00.000Z',
  ...over,
})

describe('persona history', () => {
  /**
   * The reading that runs backwards: a revision stores what was *replaced*, so the newest
   * one names the author of the prompt that is live. Getting this wrong makes a badge say
   * an agent wrote a prompt a human has since replaced.
   */
  it('names the author of the live prompt, which is the newest revision"s replacer', () => {
    const revisions = [
      revision({ id: 'r1', replacedByKind: 'agent_run', createdAt: '2026-08-16T10:00:00.000Z' }),
      revision({ id: 'r2', replacedByKind: 'human', createdAt: '2026-08-16T12:00:00.000Z' }),
    ]
    expect(currentPromptAuthor(revisions, 'p1')).toBe('human')
    expect(promptWrittenByAgent(revisions, 'p1')).toBe(false)
  })

  it('badges a persona whose live prompt an agent wrote', () => {
    const revisions = [
      revision({ id: 'r1', replacedByKind: 'human', createdAt: '2026-08-16T10:00:00.000Z' }),
      revision({ id: 'r2', replacedByKind: 'agent_run', createdAt: '2026-08-16T12:00:00.000Z' }),
    ]
    expect(promptWrittenByAgent(revisions, 'p1')).toBe(true)
  })

  it('says nothing about a persona nobody has rewritten', () => {
    expect(currentPromptAuthor([], 'p1')).toBeNull()
    expect(promptWrittenByAgent([revision({ personaId: 'other' })], 'p1')).toBe(false)
  })

  it('keeps one persona"s history out of another"s', () => {
    const revisions = [revision({ id: 'r1' }), revision({ id: 'r2', personaId: 'p2' })]
    expect(personaHistory(revisions, 'p1').map((entry) => entry.id)).toEqual(['r1'])
  })

  it('orders newest first regardless of how they arrived', () => {
    const revisions = [
      revision({ id: 'older', createdAt: '2026-08-15T10:00:00.000Z' }),
      revision({ id: 'newer', createdAt: '2026-08-16T10:00:00.000Z' }),
    ]
    expect(personaHistory(revisions, 'p1').map((entry) => entry.id)).toEqual(['newer', 'older'])
  })

  it('says plainly when an agent was the one who replaced it', () => {
    expect(describeRevision(revision())).toContain('an agent')
    expect(describeRevision(revision({ replacedByKind: 'human' }))).toContain('a person')
  })
})
