import { describe, expect, it } from 'vitest'
import {
  applyResponseStyle,
  describeResponseStyle,
  isResponseStyle,
  RESPONSE_STYLES,
  type ResponseStyle,
} from './response-styles.js'

const PERSONA = 'You are a Software Engineer. Make the smallest change that works.'

describe('applyResponseStyle', () => {
  it('leaves the persona untouched on the default style', () => {
    expect(applyResponseStyle(PERSONA, 'default')).toBe(PERSONA)
  })

  /**
   * The property that matters: a style is a dial an operator turns, and a dial that
   * could replace a system prompt would be a way to delete a persona's instructions
   * from a dropdown.
   */
  it('appends rather than substitutes, for every style', () => {
    for (const style of RESPONSE_STYLES) {
      expect(applyResponseStyle(PERSONA, style).startsWith(PERSONA)).toBe(true)
    }
  })

  it('marks the appended block so a reader can see where the persona stops', () => {
    const prompt = applyResponseStyle(PERSONA, 'caveman')
    expect(prompt).toContain('## Response style')
    expect(prompt).toContain('caveman')
  })

  /**
   * Style governs prose. An agent writing `git comit` because it was told to use
   * short words is a broken run, not a stylistic choice.
   */
  it('tells the caveman style to leave code and paths alone', () => {
    const directive = describeResponseStyle('caveman').directive
    expect(directive).toMatch(/code|paths|identifiers/i)
    expect(directive).toMatch(/prose only|governs your prose/i)
  })

  it('is idempotent in the sense that applying twice appends twice, not silently once', () => {
    const once = applyResponseStyle(PERSONA, 'concise')
    const twice = applyResponseStyle(once, 'concise')
    // Documenting the contract rather than defending it: callers apply this once,
    // at run start, and a silent dedupe would hide a caller that did not.
    expect(twice.split('## Response style')).toHaveLength(3)
  })
})

describe('isResponseStyle', () => {
  it('accepts every declared style and nothing else', () => {
    for (const style of RESPONSE_STYLES) expect(isResponseStyle(style)).toBe(true)
    expect(isResponseStyle('pirate')).toBe(false)
    expect(isResponseStyle(null)).toBe(false)
  })
})

describe('describeResponseStyle', () => {
  it('gives every style a label and a one-line description', () => {
    for (const style of RESPONSE_STYLES as readonly ResponseStyle[]) {
      const described = describeResponseStyle(style)
      expect(described.label.length).toBeGreaterThan(0)
      expect(described.description.length).toBeGreaterThan(0)
    }
  })
})
