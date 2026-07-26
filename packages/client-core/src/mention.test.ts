import { describe, expect, it } from 'vitest'
import { parseMention } from './mention.js'

const PERSONAS = [
  { id: 'p1', name: 'qa-engineer' },
  { id: 'p2', name: 'backend-worker' },
]

describe('parseMention', () => {
  it('matches an existing persona and extracts the remaining text as the task', () => {
    expect(parseMention('@qa-engineer run the test suite', PERSONAS)).toEqual({
      personaId: 'p1',
      personaName: 'qa-engineer',
      task: 'run the test suite',
    })
  })

  it('falls back to the full text as the task when nothing follows the mention', () => {
    expect(parseMention('@backend-worker', PERSONAS)).toEqual({
      personaId: 'p2',
      personaName: 'backend-worker',
      task: '@backend-worker',
    })
  })

  it('returns null when the mentioned name does not match any persona', () => {
    expect(parseMention('@unknown-persona do something', PERSONAS)).toBeNull()
  })

  it('returns null for plain text with no leading mention', () => {
    expect(parseMention('just a normal message', PERSONAS)).toBeNull()
  })
})
