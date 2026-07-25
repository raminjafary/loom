import { describe, expect, it } from 'vitest'
import { normalizeChannelName, validateMessageText } from './channel-rules.js'
import { ValidationError } from './errors.js'

describe('normalizeChannelName', () => {
  it('lowercases and hyphenates', () => {
    expect(normalizeChannelName('  Backend Team ')).toBe('backend-team')
  })

  it('rejects leading hyphen and too-short names', () => {
    expect(() => normalizeChannelName('-nope')).toThrow(ValidationError)
    expect(() => normalizeChannelName('a')).toThrow(ValidationError)
  })
})

describe('validateMessageText', () => {
  it('trims and returns', () => {
    expect(validateMessageText('  hi  ')).toBe('hi')
  })

  it('rejects empty and oversized', () => {
    expect(() => validateMessageText('   ')).toThrow(ValidationError)
    expect(() => validateMessageText('x'.repeat(16_001))).toThrow(ValidationError)
  })
})
